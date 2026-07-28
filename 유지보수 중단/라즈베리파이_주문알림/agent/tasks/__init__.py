"""태스크 등록. interval 이 0이면 비활성."""
from __future__ import annotations

import logging

from .badge_watch import BadgeWatch
from .example_collect import ExampleCollect
from .market_fetch import MarketFetch
from .order_list_watch import OrderListWatch

log = logging.getLogger("tasks")


def build(cfg):
    specs = [
        (BadgeWatch, int(cfg.get("schedule.badge_watch_sec", 60))),
        (MarketFetch, int(cfg.get("schedule.market_fetch_min", 5)) * 60),
        (OrderListWatch, int(cfg.get("schedule.order_list_sec", 0))),
        (ExampleCollect, int(cfg.get("schedule.example_collect_sec", 0))),
    ]
    tasks = []
    for cls, interval in specs:
        if interval and interval > 0:
            tasks.append(cls(interval))
            log.info("태스크 등록: %s (%d초 주기)", cls.name, interval)
        else:
            log.info("태스크 비활성: %s", cls.name)
    return tasks
