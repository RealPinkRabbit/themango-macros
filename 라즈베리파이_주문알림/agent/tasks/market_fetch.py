"""전체마켓 가져오기 — 브라우저로 n분마다 실행한다(알림 판정은 badge_watch 담당).

사이트 확인 결과(2026-07-27)
  a#getorder_allmarket_btn  onclick="openmarket_select_getorder('all')"
    → openmarket_getorder('all','')
    → 등록 마켓(10개)마다 setTimeout 시차를 두고 getorder_load(...) 호출
    → 결과가 #getorder_market 에 누적, #getorder_market_loading 이 로딩 표시

완료 판정
  마켓마다 응답 시간이 제각각이라 고정 대기는 위험하다.
  "결과 영역이 quiet_sec 동안 더 이상 변하지 않으면 완료"로 본다.
  명확한 완료 문구를 알아내면 config 의 fetch.done_text 에 넣어 더 빨리 끝낼 수 있다.
"""
from __future__ import annotations

import hashlib
import time

from ..events import ERROR, STATUS
from ..browser import CaptchaChallenge
from .base import Task

RESULT_JS = """
var el = document.getElementById('getorder_market');
return el ? el.innerText : '';
"""
LOADING_JS = """
var el = document.getElementById('getorder_market_loading');
if (!el) return false;
return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
"""


class MarketFetch(Task):
    name = "market_fetch"
    uses_browser = True

    def run(self, ctx):
        b = ctx.browser
        try:
            b.ensure_login()
        except CaptchaChallenge as e:
            ctx.emit(ERROR, "로그인 캡차 — 사람이 필요합니다", str(e))
            raise

        # 로그인 직후 쿠키를 HTTP 세션에 넘겨 둔다(배지 폴링용)
        ctx.http.sync_from_browser(b)

        b.get(ctx.cfg.get("site.poll_path"))
        if not b.js("return typeof openmarket_select_getorder === 'function';"):
            raise RuntimeError("페이지에 openmarket_select_getorder 가 없습니다(구조 변경?)")

        ctx.log.info("전체마켓 가져오기 시작")
        started = time.time()
        b.js("openmarket_select_getorder('all');")

        min_sec = int(ctx.cfg.get("fetch.min_sec", 20))
        quiet_sec = int(ctx.cfg.get("fetch.quiet_sec", 25))
        max_sec = int(ctx.cfg.get("fetch.max_sec", 600))
        done_text = str(ctx.cfg.get("fetch.done_text", "") or "")

        last_hash, last_change = None, time.time()
        result = ""
        while True:
            time.sleep(3)
            elapsed = time.time() - started
            try:
                result = b.js(RESULT_JS) or ""
            except Exception:
                ctx.log.warning("결과 영역 읽기 실패", exc_info=True)
                result = ""
            h = hashlib.md5(result.encode("utf-8", "ignore")).hexdigest()
            if h != last_hash:
                last_hash, last_change = h, time.time()

            if done_text and done_text in result:
                ctx.log.info("완료 문구 감지 (%.0f초)", elapsed)
                break
            if elapsed >= min_sec and (time.time() - last_change) >= quiet_sec:
                ctx.log.info("결과 영역 안정 → 완료 판정 (%.0f초)", elapsed)
                break
            if elapsed >= max_sec:
                ctx.log.warning("가져오기 타임아웃 (%.0f초) — 다음 주기로 넘어감", elapsed)
                break

        elapsed = time.time() - started
        summary = " / ".join(x.strip() for x in result.splitlines() if x.strip())[:300]
        ctx.state.set("last_fetch_ts", time.time())
        ctx.state.set("last_fetch_summary", summary)
        ctx.emit(STATUS, "가져오기 완료", f"{elapsed:.0f}초 · {summary}" if summary else f"{elapsed:.0f}초")
