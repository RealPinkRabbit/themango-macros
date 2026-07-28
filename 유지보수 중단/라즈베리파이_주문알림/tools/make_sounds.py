"""효과음 생성 — 외부 음원 파일 없이 wav 3개를 만든다. (setup.sh 가 호출)

    python3 tools/make_sounds.py /opt/tmg-alert/sounds
"""
from __future__ import annotations

import math
import os
import struct
import sys
import wave

RATE = 44100


def tone(freq, ms, vol=0.35, fade=0.15):
    n = int(RATE * ms / 1000.0)
    out = []
    for i in range(n):
        env = 1.0
        f = int(n * fade)
        if f:
            if i < f:
                env = i / f
            elif i > n - f:
                env = (n - i) / f
        out.append(int(32767 * vol * env * math.sin(2 * math.pi * freq * i / RATE)))
    return out


def silence(ms):
    return [0] * int(RATE * ms / 1000.0)


def write(path, samples, repeat=1):
    data = samples * repeat
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", s) for s in data))
    print("생성:", path)


def main(out_dir="/opt/tmg-alert/sounds"):
    os.makedirs(out_dir, exist_ok=True)
    # 주문: 밝은 상승 3음 (돈 들어오는 소리)
    order = tone(784, 120) + silence(40) + tone(988, 120) + silence(40) + tone(1319, 260)
    write(os.path.join(out_dir, "order.wav"), order + silence(300), repeat=2)
    # CS: 차분한 2음
    cs = tone(660, 160) + silence(60) + tone(880, 240)
    write(os.path.join(out_dir, "cs.wav"), cs + silence(300), repeat=2)
    # 오류: 낮은 경고음 3회
    err = (tone(300, 200) + silence(120)) * 3
    write(os.path.join(out_dir, "error.wav"), err)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/opt/tmg-alert/sounds")
