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

    def emit_once(self, key: str, kind: str, title: str, body: str = "", count: int = 0):
        """같은 상황이 이어지는 동안 딱 한 번만 알린다.

        캡차처럼 '재시도해도 계속 같은 결과' 인 상황을 태스크가 돌 때마다 알리면
        몇 분 간격으로 계속 울리게 된다. clear_once(key) 로 상황이 풀렸음을 알린다.
        """
        k = f"once_{key}"
        if self.state.get(k):
            return False
        self.state.set(k, True)
        self.emit(kind, title, body, count)
        return True

    def clear_once(self, key: str):
        if self.state.get(f"once_{key}"):
            self.state.set(f"once_{key}", False)


class Task:
    name = "task"
    #: 이 태스크가 브라우저를 쓰는가 (쓰면 실행 후 브라우저 tick)
    uses_browser = False
    #: 실패 시 물러날 수 있는 최대 간격. 무거운 태스크는 길게, 가벼운 폴링은 짧게 잡는다.
    max_backoff_sec = 600

    def __init__(self, interval_sec: int):
        self.interval_sec = int(interval_sec)
        self.next_run = 0.0
        self.fail_count = 0
        #: 연속 실패가 시작된 시각(0 = 정상). 알림은 횟수가 아니라 '얼마나 오래' 로 판단한다.
        self.first_fail_ts = 0.0
        #: 이번 장애에 대해 이미 알렸는가 (한 번만 울리게)
        self.alerted = False
        #: 마지막 실패 사유(화면에 짧게 보여주기 위함). 성공하면 지운다.
        self.last_error = ""

    def run(self, ctx: Ctx):
        raise NotImplementedError
