"""향후 '크롬 확장 매크로' 확장 예시 (기본 비활성).

기존 매크로/ 폴더의 .user.js 를 파이에서 그대로 굴리는 방법을 보여준다.
Tampermonkey 를 설치하는 대신 CDP 로 document-start 시점에 직접 주입한다
(GM_* 함수는 agent/userscripts/gm_shim.js 가 제공).

실제 수집 매크로를 만들 때는 이 파일을 복사해서 이름만 바꾸고,
tasks/__init__.py 의 build() 에 한 줄 추가하면 된다.
"""
from __future__ import annotations

import json
import os
import time

from ..events import STATUS
from .base import Task

OUT_DIR = "/dev/shm/tmg-collect"     # ★ SD가 아니라 RAM. 결과는 USB/NAS로 옮길 것


class ExampleCollect(Task):
    name = "example_collect"
    uses_browser = True

    def run(self, ctx):
        ctx.browser.ensure_login()
        os.makedirs(OUT_DIR, exist_ok=True)

        # 새 창을 열고, 필요하면 유저스크립트를 주입한 뒤 결과를 회수한다
        with ctx.browser.new_window(ctx.cfg.get("site.poll_path")) as w:
            # w.inject_userscript("/opt/tmg-alert/userscripts/내매크로.user.js")
            title = w.js("return document.title;")
            count = w.js("return document.querySelectorAll('a.top_menu').length;")
            shot = os.path.join(OUT_DIR, f"shot_{int(time.time())}.png")
            ctx.browser.screenshot(shot)

        payload = {"title": title, "menu_count": count, "screenshot": shot}
        with open(os.path.join(OUT_DIR, "last.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)

        ctx.emit(STATUS, "수집 예시 완료", json.dumps(payload, ensure_ascii=False)[:200])
