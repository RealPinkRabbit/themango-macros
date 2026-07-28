"""Selenium + Chromium 세션.

설계 메모
- 라즈베리파이(ARM64)에서는 Playwright가 공식 Chromium 빌드를 제공하지 않는다.
  apt 의 chromium + chromium-driver + Selenium 조합이 가장 안정적이다.
- 헤드리스가 아니라 Xvfb(:99) 안의 '진짜 창' 으로 띄운다.
  팝업/새 창/확장/스크린샷이 헤드리스에서 자주 깨지기 때문. 향후 수집 매크로까지 고려한 선택.
- 프로필/캐시/다운로드는 전부 /dev/shm (RAM) → SD 쓰기 0.
- 더망고 로그인은 reCAPTCHA v3 를 쓰므로 반드시 실제 브라우저에서 폼을 제출해야 한다.
  (페이지의 onSubmitLoginForm 이 grecaptcha.execute 로 토큰을 만들어 넣는다)
"""
from __future__ import annotations

import contextlib
import logging
import os
import shutil
import time

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By

log = logging.getLogger("browser")

BINARY_CANDIDATES = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/google-chrome",
]
DRIVER_CANDIDATES = [
    "/usr/bin/chromedriver",
    "/usr/lib/chromium/chromedriver",
    "/usr/lib/chromium-browser/chromedriver",
]

USERSCRIPT_DIR = os.path.join(os.path.dirname(__file__), "userscripts")


class LoginRequired(Exception):
    """로그인이 풀렸다."""


class CaptchaChallenge(Exception):
    """자동으로 넘길 수 없는 캡차 챌린지. 사람을 불러야 한다."""


def _first_existing(explicit: str, candidates) -> str:
    if explicit and os.path.exists(explicit):
        return explicit
    for c in candidates:
        if os.path.exists(c):
            return c
    found = shutil.which(os.path.basename(candidates[0]))
    if found:
        return found
    raise FileNotFoundError(f"실행 파일을 찾을 수 없습니다: {candidates}")


class _Window:
    """새 창/탭 핸들 래퍼."""

    def __init__(self, browser: "Browser", handle: str):
        self._b = browser
        self.handle = handle

    def get(self, url: str):
        self._b.driver.get(url)

    def js(self, script: str, *args):
        return self._b.driver.execute_script(script, *args)

    def inject_userscript(self, name_or_path: str, with_shim: bool = True):
        self._b.inject_userscript(name_or_path, with_shim=with_shim)

    def text(self) -> str:
        return self._b.driver.find_element(By.TAG_NAME, "body").text


class Browser:
    def __init__(self, cfg):
        self.cfg = cfg
        self._driver = None
        self.run_count = 0
        self.restart_every = int(cfg.get("browser.restart_every", 40) or 0)
        self._pending_scripts = []   # 재시작해도 유지되는 주입 스크립트

    # ------------------------------------------------------------------ 수명주기
    @property
    def driver(self):
        if self._driver is None:
            self._start()
        return self._driver

    def _start(self):
        cfg = self.cfg
        binary = _first_existing(cfg.get("browser.binary", ""), BINARY_CANDIDATES)
        driver_path = _first_existing(cfg.get("browser.driver", ""), DRIVER_CANDIDATES)
        profile = cfg.get("browser.profile_dir")
        cache = cfg.get("browser.cache_dir")
        downloads = cfg.get("browser.download_dir")
        for d in (profile, cache, downloads):
            os.makedirs(d, exist_ok=True)

        os.environ.setdefault("DISPLAY", str(cfg.get("browser.display", ":99")))

        opt = Options()
        opt.binary_location = binary
        # --- SD 쓰기 방지: 프로필/캐시를 전부 RAM 으로 ---
        opt.add_argument(f"--user-data-dir={profile}")
        opt.add_argument(f"--disk-cache-dir={cache}")
        opt.add_argument("--disk-cache-size=33554432")       # 32MB
        opt.add_argument("--media-cache-size=8388608")
        # --- 파이에서의 안정성 ---
        opt.add_argument("--no-first-run")
        opt.add_argument("--no-default-browser-check")
        opt.add_argument("--disable-background-timer-throttling")
        opt.add_argument("--disable-backgrounding-occluded-windows")
        opt.add_argument("--disable-renderer-backgrounding")
        opt.add_argument("--disable-sync")
        opt.add_argument("--password-store=basic")
        opt.add_argument("--disable-features=Translate,MediaRouter")
        # 더망고는 스크래퍼/확장 창을 window.open 으로 띄운다. 타이머(setTimeout) 안에서
        # 열리면 user activation 이 없어 기본 설정으로는 차단된다.
        opt.add_argument("--disable-popup-blocking")
        # Xvfb 에는 GL 이 없다. 명시적으로 꺼서 GPU 프로세스 크래시/로그를 막는다.
        opt.add_argument("--disable-gpu")
        opt.add_argument(f"--window-size={cfg.get('browser.window_size', '1280,900')}")
        opt.add_argument("--window-position=0,0")
        for ext in cfg.get("browser.extensions", []) or []:
            opt.add_argument(f"--load-extension={ext}")
        opt.add_experimental_option("excludeSwitches", ["enable-automation"])
        # 무인 운영: alert() / beforeunload 확인창이 뜨면 WebDriver 명령이 멈춘다.
        # (더망고는 alert 을 자주 쓰고, 업데이트 실행 중에는 beforeunload 를 건다)
        opt.set_capability("unhandledPromptBehavior", "accept")
        opt.add_experimental_option("prefs", {
            "download.default_directory": downloads,
            "download.prompt_for_download": False,
            "profile.default_content_setting_values.notifications": 2,
        })

        log.info("Chromium 기동: %s (driver=%s, DISPLAY=%s)", binary, driver_path, os.environ.get("DISPLAY"))
        self._driver = webdriver.Chrome(service=Service(executable_path=driver_path), options=opt)
        self._driver.set_page_load_timeout(int(cfg.get("browser.page_load_timeout", 120)))
        self._driver.set_script_timeout(60)
        for src in self._pending_scripts:
            self._add_document_start_script(src)

    def quit(self):
        if self._driver is not None:
            with contextlib.suppress(Exception):
                self._driver.quit()
            self._driver = None
            log.info("Chromium 종료")

    def restart(self):
        log.info("Chromium 재시작(누수 방지)")
        self.quit()
        self._start()

    def tick(self):
        """태스크 1회 실행마다 호출 — 일정 횟수마다 예방적 재시작."""
        self.run_count += 1
        if self.restart_every and self.run_count % self.restart_every == 0:
            self.restart()

    # ------------------------------------------------------------------ 기본 조작
    def get(self, path_or_url: str):
        url = path_or_url if path_or_url.startswith("http") else self.cfg.url(path_or_url)
        self.driver.get(url)

    def js(self, script: str, *args):
        return self.driver.execute_script(script, *args)

    def current_url(self) -> str:
        return self.driver.current_url

    def screenshot(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with contextlib.suppress(Exception):
            self.driver.save_screenshot(path)
        return path

    def cookies(self) -> list:
        return self.driver.get_cookies()

    # ------------------------------------------------------------------ 로그인
    def is_logged_in(self) -> bool:
        marker = str(self.cfg.get("site.login_marker", "login_pass"))
        try:
            html = self.driver.page_source
        except WebDriverException:
            return False
        return marker not in html and "admin_login.php" not in self.driver.current_url

    def ensure_login(self, force: bool = False) -> bool:
        """로그인 상태 보장. 이미 로그인되어 있으면 아무것도 하지 않는다."""
        if not force:
            try:
                self.get(self.cfg.get("site.poll_path"))
                if self.is_logged_in():
                    return True
            except WebDriverException as e:
                log.warning("페이지 열기 실패, 브라우저 재시작 후 재시도: %s", e)
                self.restart()

        uid = str(self.cfg.get("site.login_id", ""))
        pw = str(self.cfg.get("site.login_pw", ""))
        if not uid or not pw:
            raise LoginRequired("config 에 site.login_id / site.login_pw 가 없습니다")

        log.info("로그인 시도")
        self.get(self.cfg.get("site.login_path"))
        time.sleep(1.5)                                   # grecaptcha 로딩 여유
        # ★ 로그인 입력칸에는 id 속성이 없다(name 만 있음). getElementById 는 null 을 돌려준다.
        #   또 HTML 이 깨져 있어 input 들이 DOM 상 <form> 바깥(td)에 놓이지만,
        #   form.elements 에는 정상적으로 포함되므로 requestSubmit() 으로 함께 전송된다.
        self.js(
            "var id = document.querySelector('input[name=login_id]');"
            "var pw = document.querySelector('input[name=login_pass]');"
            "if (!id || !pw) { throw new Error('로그인 입력칸을 찾지 못했습니다'); }"
            "id.value = arguments[0]; pw.value = arguments[1];",
            uid, pw,
        )
        # 페이지의 onsubmit 핸들러(onSubmitLoginForm)가 reCAPTCHA v3 토큰을 만들어 넣고 제출한다.
        # 그래서 form.submit() 이 아니라 requestSubmit() 으로 submit 이벤트를 발생시켜야 한다.
        self.js(
            "var f = document.getElementById('loginForm') || document.forms['morning_main_login'];"
            "if (f.requestSubmit) { f.requestSubmit(); }"
            "else { f.dispatchEvent(new Event('submit', {cancelable:true, bubbles:true})); }"
        )

        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(1.0)
            with contextlib.suppress(WebDriverException):
                if "admin_login.php" not in self.driver.current_url:
                    log.info("로그인 성공")
                    return True

        shot = self.screenshot("/dev/shm/tmg-probe/login_fail.png")
        html = ""
        with contextlib.suppress(Exception):
            html = self.driver.page_source
        if "g-recaptcha" in html or "다시 시도" in html or "recaptcha/api2" in html:
            raise CaptchaChallenge(f"캡차 챌린지로 보입니다. 사람이 직접 로그인해야 합니다. 화면: {shot}")
        raise LoginRequired(f"로그인 실패(아이디/비밀번호 확인). 화면: {shot}")

    # ------------------------------------------------------------------ 유저스크립트 주입
    def _add_document_start_script(self, source: str):
        self.driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": source})

    def inject_userscript(self, name_or_path: str, with_shim: bool = True):
        """기존 Tampermonkey 스타일 .user.js 를 그대로 주입한다.

        Tampermonkey 를 파이에 설치하는 대신 CDP 로 document-start 시점에 직접 넣는다.
        (@run-at document-start 와 동일 타이밍, 팝업/새 창에도 자동 적용)
        """
        path = name_or_path
        if not os.path.isabs(path):
            path = os.path.join(USERSCRIPT_DIR, name_or_path)
        with open(path, "r", encoding="utf-8") as f:
            body = f.read()
        if with_shim:
            shim_path = os.path.join(USERSCRIPT_DIR, "gm_shim.js")
            with open(shim_path, "r", encoding="utf-8") as f:
                body = f.read() + "\n;\n" + body
        self._pending_scripts.append(body)
        self._add_document_start_script(body)
        log.info("유저스크립트 주입 등록: %s", os.path.basename(path))

    # ------------------------------------------------------------------ 새 창
    @contextlib.contextmanager
    def new_window(self, url: str = "about:blank"):
        """새 창을 열고 블록이 끝나면 닫는다. (향후 이미지/텍스트 수집 매크로용)"""
        main = self.driver.current_window_handle
        self.driver.switch_to.new_window("window")
        handle = self.driver.current_window_handle
        try:
            if url and url != "about:blank":
                self.driver.get(url if url.startswith("http") else self.cfg.url(url))
            yield _Window(self, handle)
        finally:
            with contextlib.suppress(Exception):
                self.driver.switch_to.window(handle)
                self.driver.close()
            with contextlib.suppress(Exception):
                self.driver.switch_to.window(main)
