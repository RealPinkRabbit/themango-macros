"""시간 구간 판정 — "22:00-08:00" 처럼 자정을 넘는 구간도 다룬다.

야간 정지(schedule.night_stop)와 조용한 시간대(notify.quiet_hours)가 같은 문법을 쓰므로
한 곳에 둔다. 문자열 하나든 리스트든 그대로 받는다.
"""
from __future__ import annotations

import datetime as dt


def as_windows(value) -> list:
    """설정값을 구간 문자열 리스트로 정규화. 빈 값이면 [] (= 기능 끔)."""
    if not value:
        return []
    if isinstance(value, str):
        value = [value]
    return [str(v).strip() for v in value if str(v).strip()]


def _parse(text: str):
    a, b = text.split("-")
    start = dt.time(*map(int, a.strip().split(":")))
    end = dt.time(*map(int, b.strip().split(":")))
    return start, end


def in_window(value, now: "dt.time | None" = None) -> bool:
    """지금이 구간 안인가. 잘못된 형식의 구간은 조용히 건너뛴다."""
    windows = as_windows(value)
    if not windows:
        return False
    now = now or dt.datetime.now().time()
    for w in windows:
        try:
            start, end = _parse(w)
        except Exception:
            continue
        if start <= end:
            if start <= now < end:
                return True
        else:                       # 자정을 넘는 구간 (예: 22:00-08:00)
            if now >= start or now < end:
                return True
    return False
