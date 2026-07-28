"""알림 — 유선(USB / 3.5mm) 스피커 소리 + (대시보드는 web.py 가 담당).

- 알림은 '확인(ACK)' 전까지 일정 간격으로 반복 재생한다. 자리를 비웠다 돌아와도 놓치지 않게.
- 조용한 시간대(quiet_hours)에는 소리만 끄고 화면 알림은 유지한다.
- 블루투스는 쓰지 않는다. 파이4는 2.4GHz Wi-Fi 와 BT 가 같은 칩이라 간섭하고,
  연결이 끊겨도 '소리만 안 나는' 조용한 실패가 되기 때문. 유선은 꽂혀 있으면 울린다.
- 액티브 스피커도 무신호가 이어지면 절전에 드는 제품이 있어 무음 킵얼라이브는 유지한다.
"""
from __future__ import annotations

import contextlib
import logging
import os
import shlex
import struct
import subprocess
import threading
import time
import wave

from .auditlog import KEEP
from .events import ALERT_KINDS, ERROR, NEW_CS, NEW_ORDER, Event
from .timewin import in_window

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


class Notifier:
    def __init__(self, cfg, bus, state):
        self.cfg = cfg
        self.bus = bus
        self.state = state
        self.active = None            # 확인 대기 중인 알림
        self.speaker_ok = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        bus.subscribe(self.on_event)

    # ------------------------------------------------------------------ 이벤트
    def on_event(self, ev: Event):
        if ev.kind not in ALERT_KINDS:
            return
        log.info("알림 발생: [%s] %s — %s", ev.kind, ev.title, ev.body, extra=KEEP)
        with self._lock:
            self.active = ev
        self._play_for(ev)

    def ack(self):
        with self._lock:
            was = self.active
            self.active = None
        if was:
            log.info("알림 확인됨: %s", was.title, extra=KEEP)
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
        if in_window(self.cfg.get("notify.quiet_hours")):
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
        threading.Thread(target=self._audio_loop, name="notify-audio", daemon=True).start()

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

    def _audio_loop(self):
        keepalive = int(self.cfg.get("notify.keepalive_sec", 120) or 0)
        _make_silence()
        last_keepalive = 0.0
        prev = None
        while not self._stop.wait(20):
            self.speaker_ok = self._check_speaker()
            self.state.set("speaker_ok", bool(self.speaker_ok))
            if prev is not None and prev != self.speaker_ok:
                log.warning("오디오 출력 장치 상태 변화: %s", "정상" if self.speaker_ok else "없음")
            prev = self.speaker_ok
            if keepalive and time.time() - last_keepalive >= keepalive:
                last_keepalive = time.time()
                with self._lock:
                    busy = self.active is not None
                if not busy:
                    self._play_file(SILENCE_WAV, timeout=10)   # 스피커 절전 방지

    def _check_speaker(self) -> bool:
        """오디오 출력 장치(싱크)가 살아 있는지 확인.

        USB 스피커를 뽑거나 인식이 풀리면 싱크가 사라진다. sink_match 를 설정하면
        그 문자열이 들어간 싱크가 있을 때만 정상으로 본다(HDMI 로 새는 것 방지).
        """
        try:
            out = subprocess.run(["pactl", "list", "short", "sinks"],
                                 capture_output=True, text=True, timeout=10).stdout
        except Exception as e:
            log.warning("오디오 장치 확인 실패: %s", e)
            return False
        lines = [ln for ln in out.splitlines() if ln.strip()]
        if not lines:
            return False
        want = str(self.cfg.get("notify.sink_match", "") or "").lower()
        if want:
            return any(want in ln.lower() for ln in lines)
        return True
