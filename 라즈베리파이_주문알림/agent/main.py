"""진입점.

    python -m agent.main --config /etc/tmg-alert/config.yaml

systemd 유닛에서 Type=notify 로 띄운다(scheduler 가 READY=1 / WATCHDOG=1 을 보낸다).
로그는 파일로 쓰지 않고 stdout → journald(RAM) 로만 남긴다. SD 쓰기 0.
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
import time

from . import config as config_mod
from . import tasks as task_mod
from .browser import Browser, CaptchaChallenge
from .events import ERROR, EventBus
from .notify import Notifier
from .scheduler import Scheduler, sd_notify
from .session import HttpSession
from .state import State
from .tasks.base import Ctx
from .timewin import in_window
from .web import WebServer

log = logging.getLogger("main")


def setup_logging(level: str):
    logging.basicConfig(
        stream=sys.stdout,
        level=getattr(logging, str(level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)-8s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("selenium").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def main(argv=None):
    ap = argparse.ArgumentParser(description="더망고 주문/CS 알림 에이전트")
    ap.add_argument("--config", default="/etc/tmg-alert/config.yaml")
    args = ap.parse_args(argv)

    cfg = config_mod.load(args.config)
    setup_logging(cfg.get("log.level", "INFO"))
    log.info("=== tmg-alert 시작 ===")

    state = State(cfg.get("state.ram_path"), cfg.get("state.disk_path"),
                  cfg.get("state.flush_min_interval_sec"))
    bus = EventBus()
    browser = Browser(cfg)
    http = HttpSession(cfg)
    notifier = Notifier(cfg, bus, state)
    ctx = Ctx(cfg=cfg, browser=browser, http=http, state=state, bus=bus,
              log=logging.getLogger("task"))
    sched = Scheduler(cfg, ctx, task_mod.build(cfg), notifier)

    def status():
        s = state.snapshot()
        st = sched.status()
        active = notifier.active
        return {
            "now": time.time(),
            "badges": s.get("badges", {}),
            "last_badge_check": s.get("last_badge_check"),
            "last_fetch_ts": s.get("last_fetch_ts"),
            "last_fetch_summary": s.get("last_fetch_summary", ""),
            "speaker_ok": s.get("speaker_ok"),
            "night": bool(st.get("night")),
            "logged_in": bool(http.has_cookies),
            "alert": active.to_dict() if active else None,
            "scheduler": st,
        }

    web = WebServer(cfg, bus, notifier, status)
    web.start()
    notifier.start()
    # 대시보드가 뜬 시점에 systemd 에 준비 완료를 알린다.
    # (첫 로그인이 오래 걸려도 TimeoutStartSec 에 걸리지 않게)
    sd_notify("READY=1")

    # 최초 로그인 — 실패해도 죽지 않고 태스크 백오프에 맡긴다.
    # 단, 야간 정지 시간대에 켜졌다면 브라우저를 아예 띄우지 않는다(아침에 스케줄러가 로그인한다).
    if in_window(cfg.get("schedule.night_stop", "")):
        log.info("야간 정지 시간대 — 초기 로그인을 생략합니다")
    else:
        try:
            browser.ensure_login()
            http.sync_from_browser(browser)
        except CaptchaChallenge as e:
            log.error("캡차 챌린지: %s", e)
            ctx.emit(ERROR, "로그인 캡차 — 사람이 필요합니다", str(e))
        except Exception as e:
            log.error("초기 로그인 실패: %s", e)
            ctx.emit(ERROR, "초기 로그인 실패", str(e)[:300])

    def shutdown(signum, _frame):
        log.info("종료 신호(%s) 수신", signum)
        sched.stop()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        sched.run()
    finally:
        log.info("정리 중…")
        notifier.stop()
        web.stop()
        browser.quit()
        state.maybe_flush(force=True)       # 종료 시 1회만 SD 기록
        log.info("=== tmg-alert 종료 ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
