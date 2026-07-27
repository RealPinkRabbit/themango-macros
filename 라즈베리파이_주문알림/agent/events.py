"""이벤트와 이벤트 버스. 파일 쓰기 없이 메모리에서만 돈다."""
from __future__ import annotations

import itertools
import threading
import time
from collections import deque
from dataclasses import dataclass, field, asdict

# kind 값
NEW_ORDER = "new_order"   # 신규 주문
NEW_CS = "new_cs"         # 클레임/문의
ERROR = "error"           # 사람이 봐야 하는 문제 (로그인 실패 등)
STATUS = "status"         # 정보성 (가져오기 완료 등) — 소리 없음

ALERT_KINDS = (NEW_ORDER, NEW_CS, ERROR)

_ids = itertools.count(1)


@dataclass
class Event:
    kind: str
    title: str
    body: str = ""
    count: int = 0
    ts: float = field(default_factory=time.time)
    id: int = field(default_factory=lambda: next(_ids))

    @property
    def is_alert(self) -> bool:
        return self.kind in ALERT_KINDS

    def to_dict(self) -> dict:
        d = asdict(self)
        d["is_alert"] = self.is_alert
        d["time_str"] = time.strftime("%H:%M:%S", time.localtime(self.ts))
        return d


class EventBus:
    def __init__(self, history: int = 200):
        self._subs = []
        self._lock = threading.Lock()
        self.history = deque(maxlen=history)

    def subscribe(self, fn):
        with self._lock:
            self._subs.append(fn)

    def publish(self, ev: Event):
        with self._lock:
            subs = list(self._subs)
            self.history.append(ev)
        for fn in subs:
            try:
                fn(ev)
            except Exception:  # 구독자 하나가 죽어도 전체는 계속
                import logging

                logging.getLogger("bus").exception("구독자 처리 실패")

    def recent(self, n: int = 30):
        return [e.to_dict() for e in list(self.history)[-n:]][::-1]
