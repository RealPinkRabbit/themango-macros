"""상태 저장 — RAM 우선, SD 쓰기 최소화.

- 값이 바뀌면 항상 tmpfs(/run)에 기록  → SD 쓰기 0
- SD(/var/lib)에는 '변경이 있고 + 마지막 저장 후 flush_min_interval_sec 경과' 일 때만 기록
- 종료 시 1회 강제 기록
- 기록은 tmp 파일 + os.replace 로 원자적 교체 (정전 시 반쪽 파일 방지)
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time

log = logging.getLogger("state")


def _atomic_write(path: str, data: str):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-state-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class State:
    def __init__(self, ram_path: str, disk_path: str, flush_min_interval_sec: int = 3600):
        self.ram_path = ram_path
        self.disk_path = disk_path
        self.flush_min_interval = int(flush_min_interval_sec or 0)
        self._lock = threading.RLock()
        self._data = {}
        self._dirty_disk = False
        self._last_disk_flush = 0.0
        self._load()

    def _load(self):
        for p in (self.ram_path, self.disk_path):   # RAM 사본이 더 최신
            try:
                if p and os.path.exists(p):
                    with open(p, "r", encoding="utf-8") as f:
                        self._data = json.load(f)
                    log.info("상태 복원: %s (%d키)", p, len(self._data))
                    return
            except Exception:
                log.warning("상태 파일 손상, 무시: %s", p)
        log.info("상태 파일 없음 — 새로 시작")

    # ------------------------------------------------------------------ 접근
    def get(self, key, default=None):
        with self._lock:
            return self._data.get(key, default)

    def set(self, key, value):
        with self._lock:
            if self._data.get(key) == value:
                return
            self._data[key] = value
            self._dirty_disk = True
            self._write_ram()

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self._data)

    # ------------------------------------------------------------------ 기록
    def _write_ram(self):
        if not self.ram_path:
            return
        try:
            _atomic_write(self.ram_path, json.dumps(self._data, ensure_ascii=False))
        except Exception:
            log.warning("RAM 상태 기록 실패", exc_info=True)

    def maybe_flush(self, force: bool = False, min_gap: float = 0):
        """스케줄러 루프에서 주기적으로 호출. 조건을 만족할 때만 SD에 쓴다.

        force=True 는 간격을 무시하고 즉시 기록한다(종료·야간 진입처럼 드문 시점용).
        min_gap 을 함께 주면 그 간격 안에서는 강제 기록을 건너뛴다 — '배지 기준선처럼
        잃으면 안 되지만 하루에도 여러 번 바뀌는 값' 을 SD를 아끼며 남길 때 쓴다.
        """
        with self._lock:
            if not self.disk_path or not self._dirty_disk:
                return
            if force and min_gap and time.time() - self._last_disk_flush < min_gap:
                force = False
            if not force:
                if self.flush_min_interval <= 0:
                    return  # 0 이면 종료 시에만 저장
                if time.time() - self._last_disk_flush < self.flush_min_interval:
                    return
            try:
                _atomic_write(self.disk_path, json.dumps(self._data, ensure_ascii=False, indent=1))
                self._dirty_disk = False
                self._last_disk_flush = time.time()
                log.info("상태 스냅샷 저장(SD): %s", self.disk_path)
            except Exception:
                log.warning("SD 상태 기록 실패", exc_info=True)
