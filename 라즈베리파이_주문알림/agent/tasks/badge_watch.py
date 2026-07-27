"""신규 건수 감시 — 상단 메뉴 배지를 가볍게 폴링한다. ★실제 알림 판정은 여기서 한다.

왜 배지인가
- 서버가 직접 렌더링하는 '미처리 건수' 숫자라, 가져오기 결과 문구가 바뀌어도 안 깨진다.
- 모든 관리자 페이지에 공통으로 실려 있어 아무 페이지나 한 번 GET 하면 된다.
- 라벨을 하드코딩하지 않으므로(모든 top_menu 라벨을 0 기본으로 추적),
  지금은 배지가 없는 '주문관리'에 배지가 처음 생기는 순간 0 → N 증가로 자동 감지된다.
"""
from __future__ import annotations

import time

from ..browser import CaptchaChallenge, LoginRequired
from ..events import ERROR, NEW_CS, NEW_ORDER
from .base import Task

ORDER_HINTS = ("주문",)
CS_HINTS = ("CS", "클레임", "문의")


def kind_for(label: str) -> str:
    if any(h in label for h in ORDER_HINTS):
        return NEW_ORDER
    if any(h.lower() in label.lower() for h in CS_HINTS):
        return NEW_CS
    return NEW_CS


class BadgeWatch(Task):
    name = "badge_watch"

    def run(self, ctx):
        try:
            badges = ctx.http.badges()
        except LoginRequired:
            ctx.log.info("세션 만료 감지 → 브라우저 재로그인")
            try:
                ctx.browser.ensure_login(force=True)
            except CaptchaChallenge as e:
                ctx.emit(ERROR, "로그인 캡차 — 사람이 필요합니다", str(e))
                raise
            ctx.http.sync_from_browser(ctx.browser)
            badges = ctx.http.badges()

        prev = ctx.state.get("badges")
        ctx.state.set("badges", badges)
        ctx.state.set("last_badge_check", time.time())

        if not badges:
            ctx.log.warning("배지를 하나도 못 읽었습니다(페이지 구조 변경?)")
            return

        if prev is None:
            # 첫 실행 = 기준선. 기존 미처리 건으로 시끄럽게 울리지 않게 한다.
            ctx.log.info("배지 기준선 설정: %s", badges)
            return

        if badges != prev:
            ctx.log.info("배지 변화: %s → %s", prev, badges)

        for label, count in badges.items():
            before = int(prev.get(label, 0))
            if count > before:
                delta = count - before
                kind = kind_for(label)
                title = f"신규 {'주문' if kind == NEW_ORDER else 'CS'} {delta}건"
                ctx.emit(kind, title, f"{label}: {before} → {count}", delta)
