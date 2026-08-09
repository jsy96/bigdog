# -*- coding: utf-8 -*-
"""从 public/audio-data.js（WAV base64 源）生成 public/audio-data.json（MP3 base64）。

用 ffmpeg 把每段 WAV 压成 mono / 32kHz / 96kbps MP3，大幅缩小前端 fetch 体积
（移动端点击后出声更快）。浏览器 decodeAudioData 原生支持 MP3，前端 main.js 无需改动。

同时用自相关法对比「原 WAV」与「MP3 往返解码后」的基频，量化有损编码对音高的影响：
项目靠 playbackRate 精确对齐 A 小调五声音阶，相邻半音 = 6%，故偏差 < 0.5% 即安全。

运行：uv run --no-project --with numpy scripts/build-audio-data-json.py
依赖：ffmpeg（本机已装 7.1）。
"""
import base64
import json
import re
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "audio-data.js"
OUT = ROOT / "public" / "audio-data.json"

AR = 32000   # 输出采样率（与源一致）
BR = "96k"   # MP3 码率（mono 短音效足够）


def run_ffmpeg(input_bytes, *args):
    """ffmpeg 从 stdin 读、stdout 写。"""
    proc = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *args, "pipe:1"],
        input=input_bytes, capture_output=True, check=True,
    )
    return proc.stdout


def wav_to_mp3(wav_bytes):
    return run_ffmpeg(
        wav_bytes, "-ac", "1", "-ar", str(AR), "-c:a", "libmp3lame", "-b:a", BR, "-f", "mp3"
    )


def decode_mono_f32(audio_bytes):
    """任意音频 → mono float32 PCM（统一交给 ffmpeg 解码，规避非标准 WAV 头）。"""
    return np.frombuffer(
        run_ffmpeg(audio_bytes, "-ac", "1", "-ar", str(AR), "-f", "f32le"),
        dtype=np.float32,
    )


def detect_pitch(sig, sr, fmin=70, fmax=1200, threshold=0.15):
    """YIN 基频检测（差分函数 + 累积均值归一化 + 抛物线插值）。

    比纯自相关更抗谐波倍频误判：先用绝对阈值找首个清晰基频谷，再插值精化。
    """
    tau_max = int(sr / fmin)
    tau_min = int(sr / fmax)
    if sig.size < tau_max + 2:
        return None
    sig = sig - sig.mean()
    peak = float(np.max(np.abs(sig)))
    if peak < 1e-4:
        return None
    sig = sig / peak

    # 取能量最集中的窗（避开首尾静音）
    win = int(sr * 0.05)
    if sig.size <= win:
        return None
    step = max(1, win // 2)
    energies = np.array(
        [float(np.sum(sig[i:i + win] ** 2)) for i in range(0, sig.size - win, step)]
    )
    if energies.size == 0:
        return None
    start = int(np.argmax(energies)) * step
    frame = sig[start:start + min(sig.size - start, int(sr * 0.4))]
    w = frame.size
    if w < tau_max + 2:
        return None

    # YIN 差分函数 d(tau) = sum (x[j] - x[j+tau])^2
    d = np.empty(tau_max + 1)
    d[0] = 0.0
    for tau in range(1, tau_max + 1):
        diff = frame[:w - tau] - frame[tau:w]
        d[tau] = float(np.dot(diff, diff))
    # 累积均值归一化
    d_cmnd = np.empty(tau_max + 1)
    d_cmnd[0] = 1.0
    running = 0.0
    for tau in range(1, tau_max + 1):
        running += d[tau]
        d_cmnd[tau] = d[tau] * tau / running if running > 0 else 1.0
    # 绝对阈值法：找首个低于 threshold 的谷
    tau = None
    for t in range(tau_min, tau_max + 1):
        if d_cmnd[t] < threshold:
            while t + 1 <= tau_max and d_cmnd[t + 1] < d_cmnd[t]:
                t += 1
            tau = t
            break
    if tau is None:
        tau = tau_min + int(np.argmin(d_cmnd[tau_min:tau_max + 1]))
    # 抛物线插值精化
    if tau_min < tau < tau_max:
        s0, s1, s2 = d_cmnd[tau - 1], d_cmnd[tau], d_cmnd[tau + 1]
        denom = s0 + s2 - 2 * s1
        if denom != 0:
            return sr / (tau + (s0 - s2) / (2 * denom))
    return sr / tau


def main():
    code = SRC.read_text(encoding="utf-8")
    pairs = dict(re.findall(r"(\w+):\s*'([A-Za-z0-9+/=]+)'", code))
    if not pairs:
        raise SystemExit(f"[err] 未能从 {SRC.name} 提取音频数据")

    out = {}
    total_in = total_out = 0
    print(f"{'key':<18}{'WAV':>9}{'MP3':>9}{'压缩':>7}   基频 WAV→MP3 (偏差)")
    print("-" * 64)
    for k, b64 in pairs.items():
        wav = base64.b64decode(b64)
        mp3 = wav_to_mp3(wav)
        out[k] = base64.b64encode(mp3).decode()
        total_in += len(wav)
        total_out += len(mp3)

        p_in = detect_pitch(decode_mono_f32(wav), AR)
        p_out = detect_pitch(decode_mono_f32(mp3), AR)
        if p_in and p_out:
            drift = (p_out - p_in) / p_in * 100
            pitch_str = f"{p_in:6.0f}→{p_out:6.0f}Hz  {drift:+.2f}%"
        else:
            pitch_str = "（基频不稳定，跳过）"

        print(f"{k:<18}{len(wav)/1024:7.0f}KB{len(mp3)/1024:6.0f}KB"
              f"{len(mp3)/len(wav)*100:6.0f}%   {pitch_str}")

    OUT.write_text(json.dumps(out), encoding="utf-8")
    print("-" * 64)
    print(f"PCM 合计 {total_in/1024:.0f}KB -> MP3 {total_out/1024:.0f}KB "
          f"({total_out/total_in*100:.0f}%)")
    print(f"audio-data.json (base64): {OUT.stat().st_size/1024:.0f}KB")


if __name__ == "__main__":
    main()
