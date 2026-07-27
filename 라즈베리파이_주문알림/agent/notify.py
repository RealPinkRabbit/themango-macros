"""알림 — 블루투스 스피커 소리 + (대시보드는 web.py 가 담당).

- 알림은 '확인(ACK)' 전까지 일정 간격으로 반복 재생한다. 자리를 비웠다 돌아와도 놓치지 않게.
- 조용한 시간대(quiet_hours)에는 소리만 끄고 화면 알림은 유지한다.
- 블루투스 스피커는 절전으로 잘 끊긴다 → ① 주기적 연결 확인 ② 무음 킵얼라이브 재생.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import logging
import os
import shlex
import struct
import subprocess
import threading
import time
import wave

from .events import ALERT_KINDS, ERROR, NEW_CS, NEW_ORDER, Event

log = logging.getLogger("notify")

SILENCE_WAV = "/dev/shm/tmg-silence.wav"


def _make_silence(path: str = SILENCE_WAV, seconds: float = 0.6):
    if os.path.exists(path):
        return path
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        # 완전 무음이면 일부 스피커가 무시하므로 아주 작은 잡음을 섞는다
        frames = b"".join(struct.pack("<h", (1 if i % 2 else -1)) for i in range(int(44100 * seconds)))
        w.writeframes(frames)
    return path


def _in_quiet_hours(ranges) -> bool:
    if not ranges:
        return False
    now = dt.datetime.now().time()
    for r in ranges:
        try:
            a, b = str(r).split("-")
            start = dt.time(*map(int, a.strip().split(":")))
            end = dt.time(*map(int, b.strip().split(":")))
        except Exception:
            continue
        if start <= end:
            if start <= now < end:
                return True
        else:                       # 자정을 넘는 구간
            if now >= start or now < end:
                return True
    return False


class Notifier:
    def __init__(self, cfg, bus, state):
        self.cfg = cfg
        self.bus = bus
        self.state = state
        self.active = None            # 확인 대기 중인 알림
        self.bt_connected = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        bus.subscribe(self.on_event)

    # ------------------------------------------------------------------ 이벤트
    def on_event(self, ev: Event):
        if ev.kind not in ALERT_KINDS:
            return
        with self._lock:
            self.active = ev
        self._play_for(ev)

    def ack(self):
        with self._lock:
            was = self.active
            self.active = None
        if was:
            log.info("알림 확인됨: %s", was.title)
        return bool(was)

    # ------------------------------------------------------------------ 재생
    def _sound_path(self, kind: str) -> str:
        d = str(self.cfg.get("notify.sound_dir"))
        name = {
            NEW_ORDER: self.cfg.get("notify.sound_new_order"),
            NEW_CS: self.cfg.get("notify.sound_new_cs"),
            ERROR: self.cfg.get("notify.sound_error"),
        }.get(kind, self.cfg.get("notify.sound_new_order"))
        return os.path.join(d, str(name))

    def _play_file(self, path: str, timeout: int = 30):
        cmd = str(self.cfg.get("notify.play_cmd", "paplay {file}")).format(file=shlex.quote(path))
        try:
            subprocess.run(shlex.split(cmd), timeout=timeout,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        except Exception as e:
            log.warning("소리 재생 실패(%s): %s", path, e)

    def _play_for(self, ev: Event):
        if _in_quiet_hours(self.cfg.get("notify.quiet_hours")):
            log.info("조용한 시간대 — 소리 생략 (화면 알림만)")
            return
        path = self._sound_path(ev.kind)
        if os.path.exists(path):
            self._play_file(path)
        else:
            log.warning("효과음 파일 없음: %s", path)
        extra = str(self.cfg.get("notify.extra_cmd", "") or "")
        if extra:
            with contextlib.suppress(Exception):
                subprocess.Popen(shlex.split(extra.format(title=ev.title, body=ev.body)))

    # ------------------------------------------------------------------ 백그라운드
    def start(self):
        threading.Thread(target=self._repeat_loop, name="notify-repeat", daemon=True).start()
        threading.Thread(target=self._bt_loop, name="notify-bt", daemon=True).start()

    def stop(self):
        self._stop.set()

    def _repeat_loop(self):
        interval = max(5, int(self.cfg.get("notify.repeat_interval_sec", 30)))
        while not self._stop.wait(interval):
            if not self.cfg.get("notify.repeat_until_ack", True):
                continue
            with self._lock:
                ev = self.active
            if ev is not None:
                self._play_for(ev)

    def _bt_loop(self):
        mac = str(self.cfg.get("notify.bt_mac", "") or "")
        keepalive = int(self.cfg.get("notify.bt_keepalive_sec", 120) or 0)
        _make_silence()
        last_keepalive = 0.0
        while not self._stop.wait(20):
            if mac:
                self.bt_connected = self._bt_check_connect(mac)
                self.state.set("bt_connected", bool(self.bt_connected))
            if keepalive and time.time() - last_keepalive >= keepalive:
                last_keepalive = time.time()
                with self._lock:
                    busy = self.active is not None
                if not busy:
                    self._play_file(SILENCE_WAV, timeout=10)   # 스피커 절전 방지

    def _bt_check_connect(self, mac: str) -> bool:
        try:
            out = subprocess.run(["bluetoothctl", "info", mac], capture_output=True,
                                 text=True, timeout=15).stdout
        except Exception:
            return False
        if "Connected: yes" in out:
            return True
        log.warning("블루투스 스피커 연결 끊김 — 재연결 시도: %s", mac)
        with contextlib.suppress(Exception):
            subprocess.run(["bluetoothctl", "connect", mac], capture_output=True,
                           text=True, timeout=25)
        return False
