"""설정 로딩. YAML 한 장을 점 표기로 읽는다."""
from __future__ import annotations

import os

import yaml

DEFAULTS = {
    "site.base_url": "https://tmg4682.mycafe24.com/mall",
    "site.admin_path": "/admin",
    "site.login_path": "/admin/admin_login.php",
    "site.login_marker": "login_pass",
    "site.poll_path": "/admin/admin_getorder.php",
    # 배지 폴링 타임아웃. 재시도 2회를 더해도 폴링 간격(60초) 안에 끝나야 한다.
    "site.poll_timeout_sec": 15,
    "site.login_id": "",
    "site.login_pw": "",
    "schedule.market_fetch_min": 5,
    "schedule.badge_watch_sec": 60,
    "schedule.order_list_sec": 0,
    "schedule.example_collect_sec": 0,
    "schedule.night_stop": "22:00-08:00",
    "schedule.badge_drop_confirm": 2,
    "browser.binary": "",
    "browser.driver": "",
    "browser.display": ":99",
    "browser.profile_dir": "/dev/shm/tmg-profile",
    "browser.cache_dir": "/dev/shm/tmg-cache",
    "browser.download_dir": "/dev/shm/tmg-downloads",
    "browser.window_size": "1280,900",
    "browser.page_load_timeout": 120,
    "browser.restart_every": 40,
    "browser.extensions": [],
    "fetch.min_sec": 20,
    "fetch.quiet_sec": 25,
    "fetch.max_sec": 600,
    "fetch.done_text": "",
    "notify.sound_dir": "/opt/tmg-alert/sounds",
    "notify.sound_new_order": "order.wav",
    "notify.sound_new_cs": "cs.wav",
    "notify.sound_error": "error.wav",
    "notify.play_cmd": "paplay {file}",
    "notify.repeat_until_ack": True,
    "notify.repeat_interval_sec": 30,
    "notify.quiet_hours": [],
    "notify.error_after_min": 60,
    "notify.sink_match": "",
    "notify.keepalive_sec": 120,
    "notify.extra_cmd": "",
    "web.host": "0.0.0.0",
    "web.port": 8080,
    "state.ram_path": "/run/tmg-alert/state.json",
    "state.disk_path": "/var/lib/tmg-alert/state.json",
    "state.flush_min_interval_sec": 3600,
    "order_list.url": "",
    "order_list.row_regex": "",
    "log.level": "INFO",
    # 재부팅해도 남는 사건 기록 (WARNING 이상 + 표시된 주요 INFO). 비우면 끔.
    "log.keep_path": "/var/lib/tmg-alert/events.log",
    "log.keep_max_kb": 256,
    "log.keep_backups": 3,
}

_MISSING = object()


class Config:
    """점 표기 조회. 키가 없으면 DEFAULTS, 그것도 없으면 default."""

    def __init__(self, data: dict):
        self._d = data or {}

    def get(self, path: str, default=None):
        cur = self._d
        for part in path.split("."):
            if not isinstance(cur, dict) or part not in cur:
                cur = _MISSING
                break
            cur = cur[part]
        if cur is _MISSING or cur is None:
            return DEFAULTS.get(path, default)
        return cur

    def url(self, path: str) -> str:
        base = str(self.get("site.base_url")).rstrip("/")
        return base + "/" + str(path).lstrip("/")

    @property
    def raw(self) -> dict:
        return self._d


def load(path: str) -> Config:
    if not os.path.exists(path):
        raise SystemExit(f"설정 파일이 없습니다: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return Config(yaml.safe_load(f) or {})
