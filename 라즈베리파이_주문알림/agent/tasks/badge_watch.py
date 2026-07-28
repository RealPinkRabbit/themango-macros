"""신규 건수 감시 — 상단 메뉴 배지를 가볍게 폴링한다. ★실제 알림 판정은 여기서 한다.

왜 배지인가
- 서버가 직접 렌더링하는 '미처리 건수' 숫자라, 가져오기 결과 문구가 바뀌어도 안 깨진다.
- 모든 관리자 페이지에 공통으로 실려 있어 아무 페이지나 한 번 GET 하면 된다.
- 라벨을 하드코딩하지 않으므로(모든 top_menu 라벨을 0 기본으로 추적),
  지금은 배지가 없는 '주문관리'에 배지가 처음 생기는 순간 0 → N 증가로 자동 감지된다.

★★ 오탐 방지 (2026-07-28, 실제로 겪고 로그로 원인 확정)
배지는 '신규 도착 수' 가 아니라 '미처리 잔량' 이다. 그래서 **기준선이 잘못 낮아지면
원래 있던 미처리 건이 통째로 신규로 둔갑한다.** 실제 로그:

    04:27:52 WARNING 배지를 하나도 못 읽었습니다   ← 네트워크가 불안정해 이상한 응답을 받음
    05:04:57 INFO    배지 변화: {} → {... 'CS관리': 3 ...}   ← 0 → 3 으로 보여 "신규 CS 3건" 오탐

원인은 두 가지였고 둘 다 여기서 막는다.
  1) 배지를 하나도 못 읽었는데 예전 코드는 그 빈 값을 **먼저 저장하고 나서** 빠져나갔다.
     → 빈 값이 기준선이 됐다. **저장하기 전에 나간다.**
  2) 페이지는 왔는데 배지만 낮게/빠지게 읽히는 경우도 같은 결과를 낳는다.
     → **감소는 즉시 믿지 않고, 같은 낮은 값이 badge_drop_confirm 회 연속 관측될 때만 반영한다.**

그래서 '표시용 최신값(badges)' 과 '알림 판정 기준선(badge_base)' 을 분리한다.
증가는 즉시 반영하고(알림이 늦으면 안 되므로) 감소만 확인 후 반영한다.
"""
from __future__ import annotations

import time

from ..auditlog import KEEP
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

        # ★ 못 읽었으면 기준선을 건드리지 않고 그대로 나간다 (위 오탐 경로 1).
        if not badges:
            ctx.log.warning("배지를 하나도 못 읽었습니다(응답 이상 또는 구조 변경) — 기준선 유지")
            return

        ctx.state.set("badges", badges)                 # 표시용 최신값
        ctx.state.set("last_badge_check", time.time())

        base = ctx.state.get("badge_base")
        if base is None:
            # 첫 실행 = 기준선. 기존 미처리 건으로 시끄럽게 울리지 않게 한다.
            ctx.state.set("badge_base", badges)
            ctx.state.set("badge_drop", {})
            ctx.state.maybe_flush(force=True, min_gap=60)
            ctx.log.info("배지 기준선 설정: %s", badges, extra=KEEP)
            return

        if badges != base:
            ctx.log.info("배지 변화: %s → %s", base, badges, extra=KEEP)

        # 야간 정지 뒤 첫 판정이면 밤사이 쌓인 분량이므로 문구를 달리한다.
        overnight = bool(ctx.state.get("night_resume_pending"))
        confirm_n = max(1, int(ctx.cfg.get("schedule.badge_drop_confirm", 2)))
        drop = dict(ctx.state.get("badge_drop") or {})
        new_base = dict(base)
        alerts = []

        for label, count in badges.items():
            before = int(base.get(label, 0))
            if count > before:
                new_base[label] = count
                drop.pop(label, None)
                alerts.append((label, before, count))
            elif count < before:
                seen = drop.get(label)
                if isinstance(seen, list) and len(seen) == 2 and seen[0] == count:
                    seen = [count, int(seen[1]) + 1]
                else:
                    seen = [count, 1]
                if seen[1] >= confirm_n:
                    new_base[label] = count
                    drop.pop(label, None)
                    ctx.log.info("배지 감소 확정: %s %d → %d", label, before, count, extra=KEEP)
                else:
                    drop[label] = seen
                    ctx.log.info("배지 감소 관측(%d/%d회) — 기준선 보류: %s %d → %d",
                                 seen[1], confirm_n, label, before, count)
            else:
                drop.pop(label, None)

        ctx.state.set("badge_drop", drop)
        if new_base != base:
            ctx.state.set("badge_base", new_base)
            # 기준선은 잃으면 곧 오탐이 되므로 SD에도 남긴다(단 5분에 한 번까지만).
            ctx.state.maybe_flush(force=True, min_gap=300)

        if overnight:
            ctx.state.set("night_resume_pending", False)

        for label, before, count in alerts:
            delta = count - before
            kind = kind_for(label)
            word = "주문" if kind == NEW_ORDER else "CS"
            title = f"야간 신규 {word} {delta}건" if overnight else f"신규 {word} {delta}건"
            ctx.emit(kind, title, f"{label}: {before} → {count}", delta)
