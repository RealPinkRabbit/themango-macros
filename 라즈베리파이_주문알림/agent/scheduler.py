"""스케줄러 + systemd 워치독 + 야간 정지.

- 태스크는 한 번에 하나만 실행한다(Selenium 세션을 공유하므로 동시 실행 금지).
- 실패하면 지수 백오프(최대 10분). 연속 3회 실패하면 화면·소리로 알린다.
- systemd Type=notify + WatchdogSec 과 연동:
  별도 스레드가 주기적으로 WATCHDOG=1 을 보내되, 태스크가 max_task_sec 를 넘겨
  '진짜로 멈춘' 상태면 핑을 멈춰 systemd 가 프로세스를 재시작하게 한다.
- 야간 정지(schedule.night_stop): 그 시간대에는 태스크를 하나도 돌리지 않고 브라우저도 닫는다.
  소리도 화면도 없으니 LCD가 번쩍이지 않고, 그 시간에 다른 매크로(상품정보 갱신 등)가
  파이의 CPU/디스플레이를 온전히 쓸 수 있다. 프로세스 자체는 살아 있어(워치독·대시보드 유지)
  아침이 되면 알아서 다시 로그인하고 재개한다.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
import time

from .auditlog import KEEP
from .events import ERROR
from .timewin import in_window

log = logging.getLogger("sched")

MAX_TASK_SEC = 900          # 이 시간을 넘기면 '멈춘 것'으로 보고 워치독 핑 중단
BACKOFF_MAX = 600
NIGHT_POLL_SEC = 20         # 야간에는 '아침이 됐나'만 이 간격으로 확인한다


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
        self.night = False

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

    # ------------------------------------------------------------------ 야간 정지
    def _is_night(self) -> bool:
        return in_window(self.cfg.get("schedule.night_stop", ""))

    def _enter_night(self):
        self.night = True
        log.info("야간 정지 시작 — 태스크를 멈추고 브라우저를 닫습니다", extra=KEEP)
        st = self.ctx.state
        st.set("night", True)
        st.set("night_since", time.time())
        # 아침에 '야간 신규 N건' 을 한 번만 알리기 위해, 지금의 판정 기준선을 그대로 얼려 둔다.
        # (야간 동안 badge_watch 가 돌지 않으므로 badge_base 는 저절로 유지된다)
        st.set("night_resume_pending", True)
        if self.notifier:
            self.notifier.ack()          # 화면에 떠 있던 경고를 내려 LCD를 재운다
        try:
            self.ctx.browser.quit()
        except Exception:
            log.warning("야간 브라우저 종료 실패", exc_info=True)
        # 재부팅으로 /run 이 날아가도 기준선이 살아남게 이때 한 번 SD에 기록한다(하루 1회).
        st.maybe_flush(force=True)

    def _exit_night(self):
        self.night = False
        log.info("야간 정지 해제 — 재개합니다", extra=KEEP)
        self.ctx.state.set("night", False)
        try:
            # 밤새 세션이 만료됐을 것이므로 먼저 로그인해 둔다. 실패해도 태스크가 알아서 재시도한다.
            self.ctx.browser.ensure_login(force=True)
            self.ctx.http.sync_from_browser(self.ctx.browser)
        except Exception as e:
            log.warning("재개 로그인 실패(태스크 재시도에 맡김): %s", e)
        now = time.time()
        for i, t in enumerate(self.tasks):
            t.next_run = now + i * 2
            t.fail_count = 0

    # ------------------------------------------------------------------ 상태
    def status(self) -> dict:
        return {
            "uptime_sec": int(time.time() - self.started_at),
            "current_task": self.current_task,
            "night": self.night,
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
            night = self._is_night()
            if night != self.night:
                self._enter_night() if night else self._exit_night()
            if self.night:
                self.ctx.state.maybe_flush()
                self.stop_event.wait(NIGHT_POLL_SEC)
                continue

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
