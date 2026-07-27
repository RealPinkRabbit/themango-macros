"""스케줄러 + systemd 워치독.

- 태스크는 한 번에 하나만 실행한다(Selenium 세션을 공유하므로 동시 실행 금지).
- 실패하면 지수 백오프(최대 10분). 연속 3회 실패하면 화면·소리로 알린다.
- systemd Type=notify + WatchdogSec 과 연동:
  별도 스레드가 주기적으로 WATCHDOG=1 을 보내되, 태스크가 max_task_sec 를 넘겨
  '진짜로 멈춘' 상태면 핑을 멈춰 systemd 가 프로세스를 재시작하게 한다.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
import time

from .events import ERROR

log = logging.getLogger("sched")

MAX_TASK_SEC = 900          # 이 시간을 넘기면 '멈춘 것'으로 보고 워치독 핑 중단
BACKOFF_MAX = 600


def sd_notify(msg: str):
    """systemd 에 상태 통지 (의존성 없이 직접 소켓으로)."""
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return
    if addr.startswith("@"):
        addr = "\0" + addr[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
            s.connect(addr)
            s.sendall(msg.encode("utf-8"))
    except OSError:
        pass


class Scheduler:
    def __init__(self, cfg, ctx, tasks, notifier=None):
        self.cfg = cfg
        self.ctx = ctx
        self.tasks = tasks
        self.notifier = notifier
        self.stop_event = threading.Event()
        self.current_task = None
        self.current_started = 0.0
        self.started_at = time.time()

    # ------------------------------------------------------------------ 워치독
    def start_watchdog(self):
        usec = int(os.environ.get("WATCHDOG_USEC", "0") or 0)
        if not usec:
            log.info("워치독 비활성(WATCHDOG_USEC 없음)")
            return
        interval = max(5.0, usec / 1_000_000.0 / 3.0)

        def loop():
            while not self.stop_event.wait(interval):
                started = self.current_started
                if started and (time.time() - started) > MAX_TASK_SEC:
                    log.error("태스크 %s 가 %d초 넘게 멈춰 있음 — 워치독 핑 중단(재시작 유도)",
                              self.current_task, MAX_TASK_SEC)
                    continue
                sd_notify("WATCHDOG=1")

        threading.Thread(target=loop, name="watchdog", daemon=True).start()
        log.info("워치독 핑 %.0f초 간격", interval)

    # ------------------------------------------------------------------ 상태
    def status(self) -> dict:
        return {
            "uptime_sec": int(time.time() - self.started_at),
            "current_task": self.current_task,
            "tasks": [
                {"name": t.name,
                 "interval_sec": t.interval_sec,
                 "next_in_sec": max(0, int(t.next_run - time.time())),
                 "fail_count": t.fail_count}
                for t in self.tasks
            ],
        }

    # ------------------------------------------------------------------ 루프
    def run(self):
        now = time.time()
        for i, t in enumerate(self.tasks):
            t.next_run = now + i * 2          # 기동 직후 몰리지 않게 살짝 분산
        sd_notify("READY=1")
        self.start_watchdog()

        while not self.stop_event.is_set():
            now = time.time()
            due = [t for t in self.tasks if t.next_run <= now]
            for t in due:
                if self.stop_event.is_set():
                    break
                self._run_one(t)
            self.ctx.state.maybe_flush()
            self.stop_event.wait(1.0)

    def _run_one(self, task):
        self.current_task = task.name
        self.current_started = time.time()
        try:
            task.run(self.ctx)
            task.fail_count = 0
            task.next_run = time.time() + task.interval_sec
        except Exception as e:
            task.fail_count += 1
            delay = min(BACKOFF_MAX, task.interval_sec * (2 ** min(task.fail_count, 5)))
            task.next_run = time.time() + delay
            log.error("태스크 %s 실패(%d회): %s — %d초 후 재시도",
                      task.name, task.fail_count, e, delay, exc_info=task.fail_count == 1)
            if task.fail_count == 3:      # 한 번 삐끗한 정도로는 울리지 않는다
                self.ctx.emit(ERROR, f"{task.name} 3회 연속 실패", str(e)[:300])
        finally:
            self.current_task = None
            self.current_started = 0.0
            if getattr(task, "uses_browser", False):
                try:
                    self.ctx.browser.tick()
                except Exception:
                    log.warning("브라우저 tick 실패", exc_info=True)

    def stop(self):
        self.stop_event.set()
