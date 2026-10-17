#!/usr/bin/env python3
"""
verify_wav.py — 用 Python 标准库 wave 模块回读 JS 端生成的 WAV，
交叉校验文件头字段、静音间隔与信号完整性。

前置：先运行 `node test/core.test.js` 生成 test/output/merge-test.wav
用法：python test/verify_wav.py
"""
import array
import json
import sys
import wave
from pathlib import Path


def main() -> int:
    out_dir = Path(__file__).resolve().parent / "output"
    meta = json.loads((out_dir / "merge-test.json").read_text(encoding="utf-8"))
    wav_path = out_dir / "merge-test.wav"

    assert wav_path.exists(), f"缺少 {wav_path}，请先运行 node test/core.test.js"

    expected_size = 44 + meta["frames"] * meta["channels"] * (meta["bitDepth"] // 8)
    actual_size = wav_path.stat().st_size
    assert actual_size == expected_size, f"文件大小不符: {actual_size} != {expected_size}"

    with wave.open(str(wav_path), "rb") as w:
        assert w.getnchannels() == meta["channels"], "声道数不符"
        assert w.getframerate() == meta["sampleRate"], "采样率不符"
        assert w.getsampwidth() == meta["bitDepth"] // 8, "位深不符"
        assert w.getnframes() == meta["frames"], "帧数不符"
        raw = w.readframes(w.getnframes())

    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()

    peak = max(abs(s) for s in samples) / 32768.0
    assert abs(peak - meta["peakExpected"]) < 0.01, f"峰值不符: {peak:.4f}"

    # 间隔区应为静音（取左声道）
    ch0 = samples[0::2]
    g0, g1 = meta["gapStartFrame"], meta["gapEndFrame"]
    gap_peak = max(abs(s) for s in ch0[g0:g1]) / 32768.0
    assert gap_peak < 0.001, f"间隔区非静音: {gap_peak:.6f}"

    # B 段应有有效信号（880Hz 正弦，归一化后 RMS 约 0.25）
    b_start = meta["segmentBStartFrame"]
    seg_b = ch0[b_start:b_start + 44100]
    rms_b = (sum(s * s for s in seg_b) / len(seg_b)) ** 0.5 / 32768.0
    assert rms_b > 0.01, f"B 段信号异常: {rms_b:.4f}"

    print("校验通过: " + wav_path.name)
    print(f"  声道={meta['channels']}  采样率={meta['sampleRate']}  位深=16  "
          f"帧数={meta['frames']}  时长={meta['durationSec']}s")
    print(f"  文件大小={actual_size} B  峰值={peak:.4f}  "
          f"间隔区峰值={gap_peak:.6f}  B段RMS={rms_b:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
