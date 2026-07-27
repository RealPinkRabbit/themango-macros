"""가벼운 HTTP 세션 — 브라우저 쿠키를 물려받아 관리자 페이지를 싸게 읽는다.

로그인은 reCAPTCHA v3 때문에 브라우저에서만 가능하지만, 로그인 이후의 '읽기'는
쿠키만 있으면 되므로 requests 로 처리한다. (브라우저 조작보다 수십 배 싸다)
"""
from __future__ import annotations

import logging
import re

import requests

from .browser import LoginRequired

log = logging.getLogger("http")

UA = ("Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

_TOP_MENU_RE = re.compile(r'<a\b[^>]*class="[^"]*top_menu[^"]*"[^>]*>(.*?)</a>', re.I | re.S)
_BADGE_RE = re.compile(r'<span[^>]*class="[^"]*badge[^"]*"[^>]*>\s*([0-9]+)\s*</span>', re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def parse_badges(html: str) -> dict:
    """상단 메뉴의 라벨별 배지 숫자.

    배지가 없는 메뉴는 0으로 넣는다 → 나중에 '주문관리'에 배지가 처음 생겨도
    0 → N 증가로 자동 감지된다(라벨 하드코딩 없음).
    반환 예: {'주문관리': 0, 'CS관리': 3, ...}
    """
    out = {}
    for inner in _TOP_MENU_RE.findall(html or ""):
        m = _BADGE_RE.search(inner)
        count = int(m.group(1)) if m else 0
        label = _BADGE_RE.sub(" ", inner)
        label = _WS_RE.sub(" ", _TAG_RE.sub("", label)).strip()
        if label:
            out[label] = count
    return out


class HttpSession:
    def __init__(self, cfg):
        self.cfg = cfg
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"})
        self.has_cookies = False

    def sync_from_browser(self, browser):
        """Selenium 이 가진 로그인 쿠키를 requests 로 복사."""
        self.s.cookies.clear()
        for c in browser.cookies():
            try:
                self.s.cookies.set(c["name"], c["value"],
                                   domain=c.get("domain", "").lstrip("."),
                                   path=c.get("path", "/"))
            except Exception:
                continue
        self.has_cookies = True
        log.info("쿠키 %d개 동기화", len(self.s.cookies))

    def get(self, path: str, timeout: int = 30) -> str:
        url = path if path.startswith("http") else self.cfg.url(path)
        r = self.s.get(url, timeout=timeout, allow_redirects=True)
        r.raise_for_status()
        text = r.text
        marker = str(self.cfg.get("site.login_marker", "login_pass"))
        if marker in text or "admin_login.php" in r.url:
            raise LoginRequired("세션 만료 — 재로그인 필요")
        return text

    def badges(self) -> dict:
        return parse_badges(self.get(self.cfg.get("site.poll_path")))
