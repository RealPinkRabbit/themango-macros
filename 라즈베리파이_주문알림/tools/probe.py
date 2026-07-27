"""사이트 구조 조사 / 수동 1회 실행 도구.

    sudo systemctl stop tmg-agent
    sudo -u pi DISPLAY=:99 /opt/tmg-alert/venv/bin/python -m tools.probe --config /etc/tmg-alert/config.yaml
    ...                                                   -m tools.probe --fetch          # 가져오기 1회 실행
    ...                                                   -m tools.probe --dump-order-list # 목록 HTML 저장

산출물은 /dev/shm/tmg-probe/ 에 남는다(RAM이라 SD 쓰기 없음). 필요하면 scp 로 가져갈 것.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent import config as config_mod          # noqa: E402
from agent.browser import Browser                # noqa: E402
from agent.session import HttpSession, parse_badges  # noqa: E402

OUT = "/dev/shm/tmg-probe"


def save(name: str, text: str):
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"  저장: {p} ({len(text)}자)")
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="/etc/tmg-alert/config.yaml")
    ap.add_argument("--fetch", action="store_true", help="전체마켓 가져오기 1회 실행")
    ap.add_argument("--dump-order-list", action="store_true", help="주문 목록 HTML 저장")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(name)-8s %(message)s")
    cfg = config_mod.load(args.config)
    b = Browser(cfg)
    http = HttpSession(cfg)

    print("\n[1] 로그인")
    b.ensure_login()
    http.sync_from_browser(b)
    print("  OK")

    print("\n[2] 상단 메뉴 배지")
    html = http.get(cfg.get("site.poll_path"))
    badges = parse_badges(html)
    for k, v in badges.items():
        print(f"  {k:<20} {v}")
    if not badges:
        print("  !! 하나도 못 읽음 — 페이지 구조가 바뀌었을 수 있음")
    save("poll_page.html", html)
    b.screenshot(os.path.join(OUT, "logged_in.png"))
    print(f"  스크린샷: {OUT}/logged_in.png")

    print("\n[3] 가져오기 버튼 존재 확인")
    b.get(cfg.get("site.poll_path"))
    has_fn = b.js("return typeof openmarket_select_getorder === 'function';")
    has_btn = b.js("return !!document.getElementById('getorder_allmarket_btn');")
    markets = b.js("return document.querySelectorAll('#getorder_select option').length;")
    print(f"  함수={has_fn}  버튼={has_btn}  등록마켓={markets}개")

    if args.fetch:
        print("\n[4] 전체마켓 가져오기 실행 (최대 10분)")
        b.js("openmarket_select_getorder('all');")
        started = time.time()
        last = ""
        while time.time() - started < int(cfg.get("fetch.max_sec", 600)):
            time.sleep(5)
            cur = b.js("var e=document.getElementById('getorder_market'); return e? e.innerText : '';") or ""
            if cur != last:
                last = cur
                print(f"  [{time.time()-started:5.0f}s] {cur.strip()[-160:]!r}")
        save("getorder_result.txt", last)
        b.screenshot(os.path.join(OUT, "after_fetch.png"))
        print("  ★ 위 출력에서 '완료' 류의 고정 문구가 보이면 config 의 fetch.done_text 에 넣으세요")

    if args.dump_order_list:
        print("\n[5] 주문 목록 HTML 저장")
        url = str(cfg.get("order_list.url", "") or cfg.get("site.poll_path"))
        save("order_list.html", http.get(url))
        print("  ★ 이 파일에서 주문번호를 잡는 정규식을 만들어 order_list.row_regex 에 넣으세요")

    b.quit()
    print("\n완료.")


if __name__ == "__main__":
    main()
