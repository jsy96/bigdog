# -*- coding: utf-8 -*-
"""从 public/audio-data.js（WAV base64 源）生成 public/audio-data.json（m4a/AAC base64）。

iOS Safari 对 Web Audio 的限制很严：非手势创建的 AudioContext/OfflineAudioContext
会被冻结，不能在点击前预解码；同时 Safari 对 WAV 的 decodeAudioData 兼容性不稳定。
因此本项目把音频包生成为 iOS 原生更友好的 m4a/AAC（AAC-LC in MP4/M4A 容器），
在 start() 用户手势内并行 decodeAudioData，兼顾 iOS 可用性、速度和包体积。

输出格式：mono / 32kHz / AAC-LC / 96kbps / .m4a 容器。
main.js 无需区分格式：decodeAudioData 会根据 ArrayBuffer 头部解码。

同时用 YIN 对比「源 WAV」与「m4a/AAC 往返解码后」的基频，确认有损编码未改变音高
（项目靠 playbackRate 对齐 A 小调五声音阶，相邻半音 = 6%，故偏差 < 0.5% 即安全）。

运行：uv run --no-project --with numpy scripts/build-audio-data-json.py
依赖：ffmpeg（本机已装 7.1）。
"""
import base64
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "audio-data.js"
OUT = ROOT / "public" / "audio-data.json"

AR = 32000   # 输出采样率（控制体积；足够覆盖狗叫/拟声音效）
BR = "96k"   # AAC-LC 码率（短音效保守取 96kbps，避免嘴音/辅音被压糊）


def run_ffmpeg(input_bytes, *args):
    """ffmpeg 从 stdin 读、stdout 写。"""
    proc = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *args, "pipe:1"],
        input=input_bytes, capture_output=True, check=True,
    )
    return proc.stdout


def wav_to_m4a(wav_bytes):
    """源 WAV -> mono / 32kHz / AAC-LC / m4a。

    MP4/M4A muxer 需要可 seek 的输出，不能可靠写 stdout；用临时文件生成。
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        src = tmp / "in.wav"
        out = tmp / "out.m4a"
        src.write_bytes(wav_bytes)
        subprocess.run(
            [
                "ffmpeg", "-loglevel", "error", "-y",
                "-i", str(src),
                "-ac", "1",
                "-ar", str(AR),
                "-c:a", "aac",
                "-profile:a", "aac_low",
                "-b:a", BR,
                "-movflags", "+faststart",
                str(out),
            ],
            check=True,
        )
        return out.read_bytes()


def decode_mono_f32(audio_bytes):
    """任意音频 → mono float32 PCM（统一交给 ffmpeg 解码，规避容器差异）。"""
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
    print(f"{'key':<18}{'源WAV':>9}{'M4A':>9}{'比':>6}   基频 源->M4A (偏差)")
    print("-" * 64)
    for k, b64 in pairs.items():
        src_wav = base64.b64decode(b64)
        m4a = wav_to_m4a(src_wav)
        out[k] = base64.b64encode(m4a).decode()
        total_in += len(src_wav)
        total_out += len(m4a)

        p_in = detect_pitch(decode_mono_f32(src_wav), AR)
        p_out = detect_pitch(decode_mono_f32(m4a), AR)
        if p_in and p_out:
            drift = (p_out - p_in) / p_in * 100
            pitch_str = f"{p_in:6.0f}->{p_out:6.0f}Hz  {drift:+.2f}%"
        else:
            pitch_str = "(基频不稳定，跳过)"

        print(f"{k:<18}{len(src_wav)/1024:7.0f}KB{len(m4a)/1024:6.0f}KB"
              f"{len(m4a)/len(src_wav)*100:5.0f}%   {pitch_str}")

    OUT.write_text(json.dumps(out), encoding="utf-8")
    print("-" * 64)
    print(f"源 WAV 合计 {total_in/1024:.0f}KB -> M4A/AAC {total_out/1024:.0f}KB "
          f"({total_out/total_in*100:.0f}%)")
    print(f"audio-data.json (base64): {OUT.stat().st_size/1024:.0f}KB")


if __name__ == "__main__":
    main()
