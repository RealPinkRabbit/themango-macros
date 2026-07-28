"""가벼운 HTTP 세션 — 브라우저 쿠키를 물려받아 관리자 페이지를 싸게 읽는다.

로그인은 reCAPTCHA v3 때문에 브라우저에서만 가능하지만, 로그인 이후의 '읽기'는
쿠키만 있으면 되므로 requests 로 처리한다. (브라우저 조작보다 수십 배 싸다)

★ 재시도가 필요한 이유 (2026-07-28, 실제로 겪음)
Wi-Fi 가 불안정한 환경에서 badge_watch 가 1시간 가까이 멈춰 있었다. 로그를 보면
같은 시각에 브라우저(market_fetch)는 멀쩡히 성공하는데 여기만 계속 실패했다.

    13:41 badge_watch 실패: Failed to resolve 'tmg4682...' ([Errno -3] Temporary failure...)
    13:44 http 쿠키 3개 동기화        ← 같은 시각 브라우저는 성공

이유는 둘의 접속 방식이 다르기 때문이다. Chromium 은 자체 DNS 캐시와 keep-alive
연결을 물고 있어 재조회를 거의 안 하지만, 여기는 60초마다 새 연결 = 매번 새 DNS 조회다.
즉 '깨어나서 패킷 하나 던지고 다시 자는' 가장 불리한 패턴이라, 링크가 잠깐 흔들리면
그대로 실패한다. → 짧은 재시도를 붙여 일시적 흔들림을 흡수한다(근본 원인은 Wi-Fi 신호).
"""
from __future__ import annotations

import logging
import re

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

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
        # DNS/연결/읽기 실패를 짧게 재시도한다(2회, 2초→4초 간격).
        # 폴링 간격(60초) 안에 끝나야 하므로 재시도 횟수와 타임아웃을 함께 낮게 잡는다.
        retry = Retry(total=2, connect=2, read=2, backoff_factor=1.0)
        adapter = HTTPAdapter(max_retries=retry)
        self.s.mount("https://", adapter)
        self.s.mount("http://", adapter)
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
        n = len(self.s.cookies)
        # ★ 0개를 받아 놓고 has_cookies=True 로 두면 화면의 '로그인' 점이 거짓말을 한다.
        #   (실제로 `쿠키 0개 동기화` 뒤 12분간 초록불이 켜져 있었다)
        self.has_cookies = n > 0
        if n:
            log.info("쿠키 %d개 동기화", n)
        else:
            log.warning("브라우저에서 쿠키를 가져오지 못했습니다 — 세션 없음")

    def get(self, path: str, timeout: int = 30) -> str:
        url = path if path.startswith("http") else self.cfg.url(path)
        r = self.s.get(url, timeout=timeout, allow_redirects=True)
        r.raise_for_status()
        text = r.text
        marker = str(self.cfg.get("site.login_marker", "login_pass"))
        if marker in text or "admin_login.php" in r.url:
            self.has_cookies = False
            raise LoginRequired("세션 만료 — 재로그인 필요")
        return text

    def badges(self) -> dict:
        return parse_badges(self.get(self.cfg.get("site.poll_path"),
                                     timeout=int(self.cfg.get("site.poll_timeout_sec", 15))))
