"""재부팅해도 남는 '사건 기록' — SD에 아주 조금만 쓴다.

왜 필요한가
- 이 시스템은 SD 수명을 위해 저널을 RAM에만 둔다(`Storage=volatile`, `/var/log` 도 tmpfs).
  그래서 **재부팅하면 이전 부팅의 로그가 통째로 사라진다.**
- 야간 정지(22:00~08:00)를 켜면 밤은 소리도 화면도 없는 '감시 사각지대' 가 된다.
  그 시간의 유일한 목격자가 로그인데, 그게 휘발성이면 아침에 아무것도 알 수 없다.
  (실제로 2026-07-28 오탐은 재부팅 전이라 로그가 남아 있어서 원인을 확정할 수 있었다)

그래서 **모든 로그가 아니라 '사건'만** SD에 남긴다.
- 자동 포함: WARNING 이상 (네트워크 실패·로그인 실패·구조 변경 등)
- 명시 포함: `log.info("...", extra=KEEP)` 로 표시한 줄 (알림 발생/확인, 배지 기준선 변화, 야간 전환 …)

하루 수십 줄, 수 KB 수준이라 SD 부담은 사실상 없다. 크기 상한(회전)이 걸려 있어 폭주하지도 않는다.
"""
from __future__ import annotations

import logging
import logging.handlers
import os

#: 이 줄은 SD에도 남긴다는 표시.  예) log.info("배지 변화: ...", extra=KEEP)
KEEP = {"keep": True}


class _OnlyNotable(logging.Filter):
    def filter(self, record) -> bool:
        return record.levelno >= logging.WARNING or bool(getattr(record, "keep", False))


def install(path: str, max_kb: int = 256, backups: int = 3):
    """루트 로거에 회전 파일 핸들러를 붙인다. path 가 비면 아무것도 하지 않는다."""
    if not path:
        return None
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(
        path, maxBytes=max(16, int(max_kb)) * 1024, backupCount=max(0, int(backups)),
        encoding="utf-8", delay=True,
    )
    h.setLevel(logging.INFO)
    h.addFilter(_OnlyNotable())
    # 콘솔과 달리 날짜까지 남긴다 — 며칠치가 한 파일에 쌓이기 때문.
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)-8s %(message)s",
                                     datefmt="%m-%d %H:%M:%S"))
    logging.getLogger().addHandler(h)
    return h
