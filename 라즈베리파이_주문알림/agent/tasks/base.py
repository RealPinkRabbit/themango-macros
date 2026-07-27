"""태스크 인터페이스.

새 자동화를 추가하려면 이 폴더에 파일 하나를 만들고 Task 를 상속한 뒤,
tasks/__init__.py 의 build() 에 한 줄 등록하면 된다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from ..events import Event


@dataclass
class Ctx:
    """태스크가 쓸 수 있는 모든 것."""
    cfg: object
    browser: object       # agent.browser.Browser  (Selenium 세션, 로그인/새 창/유저스크립트)
    http: object          # agent.session.HttpSession (쿠키 물린 requests)
    state: object         # agent.state.State (RAM 우선 상태)
    bus: object           # agent.events.EventBus
    log: logging.Logger

    def emit(self, kind: str, title: str, body: str = "", count: int = 0):
        self.bus.publish(Event(kind, title, body, count))


class Task:
    name = "task"
    #: 이 태스크가 브라우저를 쓰는가 (쓰면 실행 후 브라우저 tick)
    uses_browser = False

    def __init__(self, interval_sec: int):
        self.interval_sec = int(interval_sec)
        self.next_run = 0.0
        self.fail_count = 0

    def run(self, ctx: Ctx):
        raise NotImplementedError
