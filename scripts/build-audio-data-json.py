# -*- coding: utf-8 -*-
"""从 public/audio-data.js（WAV base64 源）生成 public/audio-data.json（WAV base64）。

用 ffmpeg 把每段源 WAV 标准化为 mono / 32kHz / 16bit PCM WAV，直接 base64 写入。
浏览器 decodeAudioData 对未压缩 WAV 近乎零成本（基本是内存映射），避开 mp3 解压
（霍夫曼 + IMDCT）在 iOS Safari 上 1~2 秒的解码耗时——iOS 冻结非手势 Web Audio
context，解码无法提前到点击之前，只能在 start() 手势后进行，故解码本身越快越好。
详见 memory: ios-webaudio-gesture-rule。

代价：数据包体积约为 mp3 版的 5 倍（~260KB vs 50KB），但 iOS 省 1~2 秒解码，配合
main.js 的并行 decodeAudioData，移动端点击后近即时出声。main.js 无需改动
（decodeAudioData 对 WAV 与 MP3 同样工作）。

同时用 YIN 对比「源 WAV」与「标准化 WAV」的基频，确认重采样未改变音高
（项目靠 playbackRate 对齐 A 小调五声音阶，相邻半音 = 6%，故偏差 < 0.5% 即安全）。

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

AR = 32000   # 输出采样率（与历史 mp3 方案一致，控制体积；mono 16bit = 64KB/s）


def run_ffmpeg(input_bytes, *args):
    """ffmpeg 从 stdin 读、stdout 写。"""
    proc = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *args, "pipe:1"],
        input=input_bytes, capture_output=True, check=True,
    )
    return proc.stdout


def normalize_wav(wav_bytes):
    """源 WAV -> mono / 32kHz / 16bit PCM WAV（无损、decodeAudioData 零成本）。"""
    return run_ffmpeg(
        wav_bytes, "-ac", "1", "-ar", str(AR), "-c:a", "pcm_s16le", "-f", "wav"
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
    print(f"{'key':<18}{'源WAV':>9}{'PCM WAV':>9}{'比':>6}   基频 源->标准化 (偏差)")
    print("-" * 64)
    for k, b64 in pairs.items():
        src_wav = base64.b64decode(b64)
        pcm_wav = normalize_wav(src_wav)
        out[k] = base64.b64encode(pcm_wav).decode()
        total_in += len(src_wav)
        total_out += len(pcm_wav)

        p_in = detect_pitch(decode_mono_f32(src_wav), AR)
        p_out = detect_pitch(decode_mono_f32(pcm_wav), AR)
        if p_in and p_out:
            drift = (p_out - p_in) / p_in * 100
            pitch_str = f"{p_in:6.0f}->{p_out:6.0f}Hz  {drift:+.2f}%"
        else:
            pitch_str = "(基频不稳定，跳过)"

        print(f"{k:<18}{len(src_wav)/1024:7.0f}KB{len(pcm_wav)/1024:6.0f}KB"
              f"{len(pcm_wav)/len(src_wav)*100:5.0f}%   {pitch_str}")

    OUT.write_text(json.dumps(out), encoding="utf-8")
    print("-" * 64)
    print(f"源 WAV 合计 {total_in/1024:.0f}KB -> PCM WAV {total_out/1024:.0f}KB "
          f"({total_out/total_in*100:.0f}%)")
    print(f"audio-data.json (base64): {OUT.stat().st_size/1024:.0f}KB")


if __name__ == "__main__":
    main()
