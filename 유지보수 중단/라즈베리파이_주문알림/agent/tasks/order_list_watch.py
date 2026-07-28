"""주문 목록 diff — 배지로 주문 감지가 안 될 때만 쓰는 예비 수단 (기본 비활성).

사용법
 1) 실제 주문이 1건 있는 상태에서 `python -m tools.probe --dump-order-list` 로 목록 HTML을 받는다.
 2) config.yaml 의 order_list.url / order_list.row_regex(주문번호 캡처 그룹 1개)를 채운다.
 3) schedule.order_list_sec 을 60 등으로 올린다.
"""
from __future__ import annotations

import re

from ..browser import LoginRequired
from ..events import NEW_ORDER
from .base import Task

MAX_KEYS = 500


class OrderListWatch(Task):
    name = "order_list_watch"

    def run(self, ctx):
        url = str(ctx.cfg.get("order_list.url", "") or "")
        pattern = str(ctx.cfg.get("order_list.row_regex", "") or "")
        if not url or not pattern:
            ctx.log.debug("order_list 설정이 비어 있어 건너뜀")
            return

        try:
            html = ctx.http.get(url)
        except LoginRequired:
            ctx.browser.ensure_login(force=True)
            ctx.http.sync_from_browser(ctx.browser)
            html = ctx.http.get(url)

        keys = []
        for m in re.finditer(pattern, html):
            keys.append(m.group(1) if m.groups() else m.group(0))
        keys = list(dict.fromkeys(keys))[:MAX_KEYS]     # 순서 유지 중복 제거

        prev = ctx.state.get("order_keys")
        ctx.state.set("order_keys", keys)
        if prev is None:
            ctx.log.info("주문 목록 기준선 설정: %d건", len(keys))
            return

        new = [k for k in keys if k not in set(prev)]
        if new:
            ctx.emit(NEW_ORDER, f"신규 주문 {len(new)}건", ", ".join(new[:10]), len(new))
