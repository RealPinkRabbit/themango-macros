# 라즈베리파이 24시간 주문/CS 알림 시스템 — 설계 및 로드맵

> 대상: 라즈베리파이 4 모델B 4GB + micro SD Pro Endurance 64GB + 블루투스 스피커 + LCD 패널
> 목적: `admin_getorder.php`의 **전체마켓 가져오기**를 n분마다 실행하고, 신규 주문/클레임/문의가 생기면
> **소리(BT 스피커) + 화면(LCD)** 으로 즉시 알린다. 24시간 무중단, SD카드 쓰기 최소화.

---

## 0. 사전 조사 결과 (실제 사이트 확인, 2026-07-27)

브라우저로 `https://tmg4682.mycafe24.com/mall/admin/admin_getorder.php` 를 직접 열어 확인한 사실입니다.
이 값들이 이후 설계의 근거입니다.

| 항목 | 확인 내용 |
|---|---|
| 버튼 | `a#getorder_allmarket_btn` · `onclick="openmarket_select_getorder('all')"` |
| 내부 흐름 | `openmarket_select_getorder('all')` → `openmarket_getorder('all','')` → 마켓별 `getorder_load(...)` 를 **setTimeout으로 시차 실행** |
| 시차 | 마켓마다 다름(11번가 3초, 옥션/G마켓2.0 7초, 쿠팡 3초 …). 등록 마켓 **10개**(옥션2.0·11번가·G마켓2.0·스마트스토어·쿠팡 × 계정 2개) |
| 결과 표시 | `#getorder_market` 에 `.load()` 로 누적 표시, `#getorder_market_loading` 로딩 표시 |
| 진행 중 표시 | 버튼 텍스트가 "주문/CS 내역을 가져오는 중입니다."로 바뀌고 onclick이 alert로 교체됨 |
| **신규 건수 신호** | 상단 메뉴가 **서버 렌더링 배지**를 가짐: `a.top_menu` 안의 `span.badge.btn-danger` (확인 시점: `CS관리 3`). 모든 관리자 페이지에 공통으로 실림 |
| 주문 목록 | 조회 시점에 주문 0건이라 행 구조는 미확인 (→ 6장 "남은 확인 항목") |
| **로그인** | `/mall/admin/admin_login.php` → POST `/mall/m_login_ok.php`, 필드 `login_id` / `login_pass` |
| **★ reCAPTCHA v3** | 로그인 폼에 `recaptcha_token` hidden + `grecaptcha.execute(..., {action:'login'})`. **순수 HTTP(requests) 로그인은 불가** |

**여기서 나오는 2개의 결정적 제약**

1. **로그인은 반드시 실제 브라우저에서** 해야 한다 (reCAPTCHA v3 토큰을 페이지 JS가 생성).
   → 파이에 Chromium을 상주시키는 구조가 필수. (v3는 사람이 푸는 문제가 아니라 점수 기반이라
   정상 로그인이면 그대로 통과한다. 다만 점수가 떨어져 **대화형 챌린지가 뜨면 자동 해결을 시도하지 않고
   사람을 호출**하도록 설계했다 — 7장.)
2. 반면 **신규 건수 확인은 배지 한 줄이면 끝**이라, 무거운 브라우저 조작 없이
   쿠키만 물려받은 가벼운 HTTP GET으로 자주 확인할 수 있다.

→ 그래서 **"무거운 작업(가져오기)은 드물게 브라우저로, 가벼운 감시(배지)는 자주 HTTP로"** 라는 2계층 구조로 간다.

---

## 1. 전체 아키텍처

```
┌──────────────────────────── Raspberry Pi 4 (Pi OS Lite 64-bit) ────────────────────────────┐
│                                                                                            │
│  systemd                                                                                   │
│  ├─ tmg-xvfb.service      Xvfb :99  (가상 화면 1920x1080 — 자동화 전용, LCD와 분리)        │
│  ├─ tmg-wm.service        openbox @ :99 (팝업 창 관리 — 스크래퍼 창이 뜨는 데 필요)        │
│  │                                                                                         │
│  ├─ tmg-agent.service     ★ 파이썬 데몬 (Type=notify + WatchdogSec)                        │
│  │   ├─ Browser        Selenium + Chromium @ :99   (프로필/캐시 = /dev/shm)                │
│  │   │                  · 로그인(reCAPTCHA v3 통과) · 전체마켓 가져오기 · 향후 수집매크로   │
│  │   ├─ HttpSession    requests + 브라우저에서 복사한 쿠키  (배지 폴링 / 목록 파싱)         │
│  │   ├─ Scheduler      태스크별 주기 실행, 실패 백오프, 브라우저 주기적 재시작              │
│  │   ├─ EventBus       new_order / new_cs / error / status 이벤트                           │
│  │   ├─ Notifier       ① 오디오(BT 스피커, 확인 전까지 반복) ② 대시보드 푸시(SSE)          │
│  │   └─ WebServer      127.0.0.1:8080 (표준 라이브러리, 의존성 0)                          │
│  │                                                                                         │
│  └─ tmg-kiosk.service     Xorg :0 + openbox + Chromium --kiosk http://127.0.0.1:8080       │
│                            → **LCD 패널에 전체화면 알림판**                                 │
│                                                                                            │
│  RAM(tmpfs)만 사용: /tmp /var/tmp /var/log /run  · journald=volatile · swap off             │
│  SD 쓰기: 설정파일 읽기 + 상태 스냅샷(최대 1시간에 1회) 뿐                                  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
        │ Wi-Fi/유선                                   │ BlueZ + PipeWire (A2DP)
        ▼                                              ▼
  더망고 관리자                                    블루투스 스피커
```

**왜 자동화용 화면(:99)과 표시용 화면(:0)을 나누는가**
자동화 Chromium이 LCD에 떠 있으면 (1) 알림판을 가리고 (2) 로그인·팝업 창이 사용자 눈에 튀고
(3) 사람이 실수로 클릭하면 자동화가 깨진다. Xvfb로 분리하면 자동화는 눈에 안 보이는 곳에서 돌고,
LCD에는 알림판만 남는다. 그러면서도 **완전 헤드리스가 아니라 "진짜 창이 있는" 브라우저**라
확장 프로그램·팝업창·스크린샷이 전부 정상 동작한다(헤드리스 모드에서 자주 깨지는 부분).

---

## 2. LCD 알림 방식 — 두 안의 차이와 장단점

질문하신 "1번 키오스크 웹 대시보드 / 2번 데스크톱 팝업"의 실제 차이입니다.

### 방식 A — 키오스크 웹 대시보드 (채택)

파이 안에서 로컬 웹서버(에이전트에 내장)를 띄우고, LCD에는 Chromium을 `--kiosk` 전체화면으로
`http://127.0.0.1:8080` 에 고정해 둔다. 알림은 **SSE(Server-Sent Events)** 로 브라우저에 밀어 넣어
페이지 새로고침 없이 즉시 화면이 바뀐다.

- 평상시: 어두운 대기 화면 (현재 시각 / 마지막 가져오기 시각 / 다음 실행까지 남은 시간 / 로그인·스피커 상태 점)
- 이벤트: 화면 전체가 빨강·주황으로 번쩍이며 `신규 주문 2건` 같은 큰 글씨 + 최근 이벤트 목록
- 화면(또는 아무 키)을 누르면 **확인(ACK)** → 소리 정지, 대기 화면 복귀

장점
- 표현이 자유롭다. 3m 밖에서도 읽히는 크기, 색, 깜빡임, 건수, 최근 목록, 상태 표시를 마음대로 만든다.
- **상태 모니터를 겸한다.** 24시간 돌리는 물건에서 이게 크다. "지금 살아 있나? 마지막 성공이 언제지?"가
  화면에 늘 떠 있어야 조용히 죽는 사고를 막는다. 팝업 방식은 이걸 못 한다.
- 같은 URL을 폰·PC에서도 열 수 있다(같은 공유기 안에서 `http://파이IP:8080`). 자리에 없을 때 유용.
- 알림 표시 = 이미 떠 있는 페이지의 DOM만 바꾸는 것 → **프로세스 생성도, 디스크 쓰기도 0**.
- 어차피 자동화용으로 Chromium을 설치하므로 추가 설치 부담이 없다.

단점
- Chromium 상주로 RAM 250~400MB를 먹는다 (4GB 중 — 여유 충분).
- HTML/서버 코드가 필요하다 (이번 산출물에 포함되어 있으므로 실질 부담은 없음).
- 브라우저가 죽을 수 있다 → systemd `Restart=always`로 자동 복구.

### 방식 B — 데스크톱 팝업 (`zenity` / `yad` / `notify-send`)

데스크톱 환경을 띄워두고, 이벤트마다 팝업 창 프로세스를 하나씩 실행한다.

장점
- 구현이 한 줄 수준(`zenity --warning --text="신규 주문"`). RAM 사용도 적다.

단점
- **알림이 올 때만 뭔가 보이고, 평소엔 화면이 아무것도 말해주지 않는다.** 죽어 있어도 알 수 없다.
- 팝업이 쌓인다. 5분마다 이벤트가 나면 창이 계속 겹치고, 누가 안 닫으면 수십 개가 된다.
- 창 관리자·알림 데몬(notification daemon)이 필요해서 결국 데스크톱 환경을 깔아야 한다 →
  "Lite + 필요한 것만"이라는 SD 절약 전제와 어긋나고, 오히려 상주 프로세스가 늘어난다.
- 전체화면 강제·포커스 뺏기·글자 크기 조절이 까다롭다. 창이 LCD 구석에 작게 뜨면 알림 역할을 못 한다.
- 이벤트마다 프로세스를 새로 띄운다(fork/exec) → 자잘하지만 24시간 누적되면 불필요한 부하.

### 결론

**A 채택.** B는 "알림"만 하고, A는 "알림 + 상태 감시"를 한다. 24시간 무인 운영에서는 후자가 사실상 필수다.
구현 난이도 차이는 이번 산출물에 코드가 포함되어 사라졌다.
(A를 쓰면서 굳이 원하면 `notify.extra_cmd` 설정으로 팝업 명령을 덧붙일 수도 있게 해 두었다.)

---

## 3. 동작 시나리오 (타임라인)

```
00:00  부팅
       ├ Xvfb :99 기동 → 에이전트 기동 → 웹서버 :8080 → 키오스크 Chromium이 LCD에 대기화면
       ├ 에이전트: 브라우저로 로그인(reCAPTCHA v3 자동 통과) → 쿠키를 HttpSession에 복사
       └ 첫 배지 스냅샷을 "기준선"으로 저장 (기존 미처리 건으로 오알림 내지 않음)

+60초마다  [badge_watch]  가벼운 GET → 상단 메뉴 배지 파싱
           · CS관리 3 → 4  ⇒ new_cs 이벤트 1건
           · 주문관리 배지 등장/증가 ⇒ new_order 이벤트
           · 로그인 풀림 감지 ⇒ 브라우저 재로그인 후 쿠키 재복사

+5분마다   [market_fetch] 브라우저에서 admin_getorder.php 열고
           openmarket_select_getorder('all') 실행
           → #getorder_market 이 조용해질 때까지(기본 25초 무변화) 대기, 최대 10분 타임아웃
           → 완료 시각·결과 요약을 대시보드에 표시
           ※ 가져오기가 끝나면 서버 배지가 갱신되므로, 실제 알림은 다음 badge_watch가 즉시 잡는다

이벤트 발생  → EventBus
              ├ 오디오: BT 스피커로 효과음 (확인 전까지 30초마다 반복)
              └ 대시보드: SSE 푸시 → LCD 화면 전체가 알림 모드로 전환
사용자 확인  → 화면 터치/클릭/아무 키 → ACK → 소리 정지, 대기화면 복귀

04:30 (일)  주간 예방 재부팅 (선택, 기본 켜짐)
```

**왜 알림 판정을 "가져오기 결과 텍스트"가 아니라 "배지"로 하나**
가져오기 결과 영역(`#getorder_market`)은 마켓별 응답을 누적하는 자유 텍스트라 문구가 바뀌면 바로 깨진다.
반면 배지는 서버가 "미처리 건수"를 직접 렌더링한 숫자다. 숫자 증가 비교는 문구 변화에 영향받지 않고,
가져오기 실패·중복 실행에도 오탐이 없다. 그래서 **가져오기 = 트리거, 배지 = 판정**으로 역할을 나눴다.

---

## 4. SD카드 쓰기 최소화 설계

Pro Endurance는 연속 쓰기에 강한 카드지만, 24시간 운영에서 카드를 죽이는 건 용량이 아니라
**작은 쓰기의 반복(write amplification)** 이다. 아래를 전부 적용하면 정상 운영 중 SD 쓰기는
**사실상 0**(설정 읽기 + 최대 1시간에 1회 상태 스냅샷)이 된다.

| # | 대상 | 조치 | 적용 위치 |
|---|---|---|---|
| 1 | 스왑 | `dphys-swapfile` 완전 비활성 (RAM 4GB면 불필요). 스왑은 SD 쓰기의 최대 주범 | `setup.sh` |
| 2 | systemd 저널 | `Storage=volatile`, `RuntimeMaxUse=32M` → 로그를 RAM에만 | `/etc/systemd/journald.conf.d/` |
| 3 | `/var/log` `/tmp` `/var/tmp` | tmpfs 마운트 (noatime, nosuid, 크기 제한) | `/etc/fstab` |
| 4 | 애플리케이션 로그 | 파일 로그 없음. stdout → journald(=RAM). 최근 500건은 대시보드 메모리 링버퍼 | `agent/` |
| 5 | Chromium 프로필·캐시 | 자동화·키오스크 모두 `--user-data-dir=/dev/shm/...`, `--disk-cache-dir=/dev/shm/...`, 캐시 32MB 상한 | `agent/browser.py`, 키오스크 유닛 |
| 6 | 상태 파일 | 상시 저장은 `/run/tmg-alert/state.json`(tmpfs). SD(`/var/lib/...`)에는 **값이 바뀌었고 + 마지막 저장 후 1시간 경과**일 때만, 종료 시 1회. `os.replace`로 원자적 교체 | `agent/state.py` |
| 7 | 수집 산출물 | 향후 이미지/텍스트 수집물은 `/dev/shm` 또는 USB/NAS로. SD에 쓰지 않음 | `agent/browser.py` 다운로드 경로 |
| 8 | 마운트 옵션 | 루트 `noatime,commit=600` (기본 5초 → 600초로 늘려 메타데이터 쓰기 병합) | `/boot/firmware/cmdline.txt` 또는 fstab |
| 9 | 자동 업데이트 | `unattended-upgrades` 비활성 (한밤중 대량 쓰기 + 예고 없는 Chromium 버전 변경 방지). 업데이트는 사람이 계획적으로 | `setup.sh` |
| 10 | 파일시스템 검사 | `fake-hwclock` 기본 유지(쓰기 미미), `man-db` 자동 인덱싱 비활성 | `setup.sh` |
| 11 | **(선택) 읽기전용 루트** | 모든 게 안정된 뒤 `raspi-config` → Performance → Overlay File System 활성화 → 루트를 완전 읽기 전용으로. 쓰기가 물리적으로 불가능해짐 | 8장 Phase 6 |

> 11번을 켜면 SD 쓰기는 **0**이 되지만, 설정 변경·업데이트마다 오버레이를 껐다 켜고 재부팅해야 한다.
> 그래서 **운영이 안정된 뒤 마지막 단계에서** 켜는 것을 권한다. 켜기 전에 상태 스냅샷 경로(`/var/lib`)를
> USB 메모리로 옮기거나, 스냅샷을 포기(부팅 시 서버에서 기준선을 다시 잡음)하면 된다.

**보너스: 쓰기량 확인 방법**
```bash
# 누적 쓰기(섹터×512B). 몇 시간 간격으로 두 번 재서 증가분을 본다
awk '{print $3, $10*512/1024/1024" MB written"}' /proc/diskstats | grep -E 'mmcblk0 '
```

---

## 5. 24시간 무중단 설계

| 위험 | 대책 |
|---|---|
| 파이썬 데몬이 죽음 | `Restart=always`, `RestartSec=10` |
| 데몬이 **살아는 있는데 멈춤**(Selenium 무한 대기 등) | `Type=notify` + `WatchdogSec=180`. 스케줄러 루프가 30초마다 `WATCHDOG=1`을 보내고, 끊기면 systemd가 강제 재시작 |
| 커널/시스템 전체 프리즈 | 하드웨어 워치독(`bcm2835_wdt`) + `RuntimeWatchdogSec=15` → 자동 리셋 |
| Chromium 메모리 누수 | 태스크 N회(기본 40회)마다 브라우저 프로세스 재시작 + `MemoryMax=2500M` (초과 시 재시작). 상품업데이트 배치는 1.2G 를 쉽게 넘겨 한도를 올렸다 |
| 세션 만료 / 로그아웃 | 배지 파싱이 로그인 폼을 감지하면 즉시 브라우저 재로그인 → 쿠키 재복사 |
| **reCAPTCHA 챌린지 등장** | 자동 해결 시도 안 함. `error` 이벤트로 소리+화면 알림("사람이 로그인해야 함") 후 백오프 재시도 |
| 네트워크 끊김 | 태스크 실패 → 지수 백오프(최대 10분), 복구되면 자동 정상화. 화면 상태 점이 빨강으로 |
| **블루투스 스피커가 절전으로 끊김** | ① 기기 `trust` 등록 ② 재연결 루프 ③ **2분마다 무음 킵얼라이브 재생**(스피커 절전 진입 자체를 방지) |
| BT ↔ Wi-Fi 2.4GHz 간섭 (파이4의 고질) | Wi-Fi를 **5GHz 대역**으로 고정하거나 **유선 랜** 사용 권장. 2.4GHz + BT 오디오는 끊김이 잦음 |
| 정전 후 파일시스템 손상 | 위 4장 조치로 쓰기 자체가 거의 없어 손상 확률이 크게 낮아짐. + 11번(읽기전용) 적용 시 사실상 면역 |
| 원인 모를 누적 열화 | 주 1회 새벽 예방 재부팅 타이머(기본 일요일 04:30, 끌 수 있음) |
| 화면 꺼짐/번인 | `xset s off -dpms`로 절전 해제, 대기 화면은 어둡게 + 요소 위치를 분 단위로 미세 이동 |

---

## 6. 확장 설계 — 향후 크롬 확장(유저스크립트) 매크로 수용

요청하신 "나중에 크롬 창에서 새 창을 띄워 이미지·텍스트를 수집하는 매크로"를 나중에 얹을 수 있도록,
처음부터 **태스크 플러그인 + 유저스크립트 주입** 두 축으로 만들었습니다.

### 6-1. 태스크 플러그인

`agent/tasks/` 에 파일 하나를 떨어뜨리면 끝입니다. 스케줄러가 자동으로 등록합니다.

```python
# agent/tasks/my_collect.py
from .base import Task

class MyCollect(Task):
    name = "my_collect"
    default_interval_sec = 3600      # config에서 덮어쓸 수 있음
    enabled_by_default = False

    def run(self, ctx):
        ctx.browser.ensure_login()
        with ctx.browser.new_window("https://.../page") as w:   # 새 창(팝업) 그대로 사용
            w.inject_userscript("collect.user.js")              # 기존 .user.js 재사용
            data = w.js("return window.__RESULT__")
        ctx.emit("status", "수집 완료", f"{len(data)}건")
```

`ctx` 가 제공하는 것: `browser`(Selenium 세션), `http`(쿠키 물린 requests), `state`(RAM 우선 상태),
`emit()`(이벤트 발행 → 소리·화면), `log`, `cfg`.

### 6-2. 기존 `.user.js` 를 그대로 굴리는 방법

Tampermonkey를 파이에 설치해 사용자 스크립트를 심는 건 자동화 환경에서 재현성이 나쁩니다
(확장 설치 UI·스토어 로그인·확장 내부 저장소 시드가 전부 수작업). 대신 **CDP로 직접 주입**합니다.

- `Page.addScriptToEvaluateOnNewDocument` 로 **모든 새 문서(팝업 포함)에 document-start 시점 주입**
  → `@run-at document-start` 와 동일한 타이밍
- `agent/userscripts/gm_shim.js` 가 `GM_setValue/GM_getValue/GM_xmlhttpRequest/GM_addStyle/
  GM_download/unsafeWindow/GM_info` 를 구현 → 기존 매크로의 GM_* 호출이 그대로 동작
- 진짜 확장 프로그램(CRX)이 꼭 필요하면 `browser.extensions: ["/opt/.../unpacked"]` 설정으로
  `--load-extension` 도 지원 (압축 해제된 폴더 형태)

즉 `매크로/` 폴더의 기존 `.user.js` 들을 **거의 수정 없이** 파이에서 스케줄 실행할 수 있습니다.
(엑셀 입력이 필요한 매크로는 파일 경로만 파이 쪽으로 바꿔주면 됩니다.)

### 6-3. 새 창·이미지 수집 대비

- `browser.new_window(url)` : 새 탭/창을 열고 컨텍스트 매니저 종료 시 자동 정리
- 다운로드 경로는 `/dev/shm/tmg-downloads` 기본값 (SD 쓰기 없음) → 필요 시 USB/NAS로 이동
- 스크린샷·이미지도 동일 경로. 용량이 커지면 `tmpfs` 크기 상한에 걸리므로 USB 사용을 권장

### 6-4. 상품업데이트(가격·재고) 매크로 대비 — 실측 2026-07-27

대상 페이지 `admin_goods_update.php`(관리자 로그인 상태에서 브라우저로 직접 확인).

| 확인한 것 | 내용 | 파이에 주는 영향 |
|---|---|---|
| 시작 버튼 | `#update_start` → `start_ini_all()`, 행 단위는 `start_ini('상품uid','사이트코드')` | 클릭 1회로 배치 시작 — 태스크로 감싸기 쉬움 |
| 실행 흐름 | `update_page_load()` → `admin_goods_update_shell.php` 를 `.load()` → `scrapDetailParallel()` → `scrapDetailOne(uid, site_id, mode)` | 페이지 이동 없이 한 탭 안에서 진행 |
| 창 | 숨은 iframe `target_frame`/`target_frame1` + `window.open`(800x700) 스크래퍼/확장 창 | **팝업 차단 해제·창 관리자 필요** |
| 확장 | `detectExtension(id)` 가 `chrome-extension://<ID>/themango.ico` 로드로 설치 여부 판정 | **더망고 크롬 확장이 없으면 동작 안 함** |
| 이탈 방지 | 실행 중 `set_beforeunload(...)` 로 beforeunload 등록 | 다른 태스크가 이 탭을 가져가면 확인창이 뜬다 |
| 자동 반복 | `auto_repeat = "Y"` — 배치 완료 후 0~60분 랜덤 대기 뒤 `auto_restart_ini()` 로 스스로 재시작 | 24시간 켜두는 파이와 궁합이 좋다 |
| 규모 | 조회 시점 대상 **6,467개**(검색결과 전체), 10페이지 목록 | 수 시간짜리 장시간 작업 |

설계상 결론:

1. **상품업데이트는 "주기 실행 태스크"가 아니라 "전용 탭 상주 태스크"로 만든다.**
   페이지 스스로 완료 후 재시작하므로, 에이전트는 `browser.new_window()` 로 전용 창을 하나 띄워
   시작만 시키고 그 창을 **건드리지 않은 채** 로그(`layer_page`)만 읽는 편이 안전하다.
   주문 알림용 탭과 반드시 분리 — 같은 탭을 쓰면 beforeunload 확인창과 배치 중단이 발생한다.
2. **확장 없이는 성립하지 않는다.** 아래 절차로 파이에 심는다.
3. 스크랩 대상은 소싱 사이트(Zara/ABC마트)라 **트래픽·시간이 크다.** 주문 알림 주기(5분)와
   겹치면 파이의 네트워크·CPU를 뺏기므로, 업데이트는 심야에 시작하도록 스케줄을 나누는 것을 권장.

#### 더망고 크롬 확장을 파이에 설치하기

Debian/Pi OS 의 Chromium 은 웹스토어에서 직접 설치가 막히는 경우가 있으므로,
**윈도우 크롬에 이미 설치된 확장 폴더를 통째로 복사해 `--load-extension` 으로 로드**한다.

```powershell
# 윈도우: 확장 폴더 위치 (ID 는 크롬 주소창 chrome://extensions 에서 '개발자 모드' 켜면 보임)
%LocalAppData%\Google\Chrome\User Data\Default\Extensions\<확장ID>\<버전>
```

```bash
# 파이로 복사한 뒤
sudo mv ~/themango /opt/tmg-alert/extensions/themango
sudo chown -R pi:pi /opt/tmg-alert/extensions
# config.yaml
#   browser:
#     extensions: ["/opt/tmg-alert/extensions/themango"]
sudo systemctl restart tmg-agent
```

- ★ **`--load-extension` 은 Chrome 137 부터 "브랜드 크롬"에서 제거됐지만, Chromium·Chrome for Testing
  에서는 계속 동작한다.** 파이에서 apt `chromium` 을 쓰기로 한 결정이 여기서도 맞아떨어진다.
- ★ **확장 ID 가 유지되는지 반드시 확인할 것.** 더망고는 ID를 하드코딩해 확장 설치를 판정한다.
  웹스토어로 설치된 폴더의 `manifest.json` 에는 `"key"` 필드가 들어 있어 압축 해제 로드에서도
  같은 ID 가 유지되지만, 이 필드가 없으면 ID 가 경로 기반으로 바뀌어 **사이트가 "확장 없음"으로 본다.**
  확인: `chrome://extensions` 대신 페이지에서 `detectExtension('<ID>', console.log)` 가 `true` 인지.

---

## 7. 로드맵 (Phase 0 → 6)

각 단계마다 **"여기까지 되면 통과"** 기준을 뒀습니다. 순서대로 하나씩 확인하며 진행하세요.

### Phase 0 — 준비물 확인 (30분)
- 파이4 4GB, **정품 USB-C 어댑터(5.1V / 3A = 15.3W)** — 전원 부실이 24시간 운영 사고 1위, Pro Endurance 64GB
- LCD 패널 + micro-HDMI 케이블, 블루투스 스피커, 유선랜 또는 **5GHz Wi-Fi**
- 다른 PC에 **Raspberry Pi Imager** 설치
- ✅ 통과: 위 항목이 모두 손에 있음

### Phase 1 — OS 설치와 기본 설정 (1시간)
1. Imager 실행 → 기기: Raspberry Pi 4 → OS: **Raspberry Pi OS Lite (64-bit)** (Trixie/Debian 13 계열)
2. ⚙️ 설정 편집(중요): 호스트명 `tmg-alert`, 사용자 `pi` + 비밀번호, **Wi-Fi(5GHz) SSID/비번**,
   지역/시간대 `Asia/Seoul`, 키보드 `us`, **SSH 활성화**
3. SD에 굽고 파이에 꽂아 부팅 → 다른 PC에서 `ssh pi@tmg-alert.local`
4. `sudo apt update && sudo apt full-upgrade -y && sudo reboot`
- ✅ 통과: SSH 접속되고 `cat /etc/os-release` 확인, `ping -c3 8.8.8.8` 성공

> Lite(데스크톱 없음)를 쓰는 이유: 데스크톱판은 상주 프로세스·자동 업데이트·인덱싱으로
> SD 쓰기와 RAM을 모두 낭비한다. 우리에게 필요한 GUI는 "전체화면 브라우저 하나"뿐이고,
> 그건 X + openbox만으로 충분하다.

### Phase 2 — SD 쓰기 최소화 + 프로젝트 설치 (30분)
```bash
# 이 폴더를 파이로 복사 (예: PC에서)
scp -r "라즈베리파이_주문알림" pi@tmg-alert.local:~/

# 파이에서
cd ~/라즈베리파이_주문알림
sudo bash install/setup.sh          # 패키지·tmpfs·journald·swap off·systemd 유닛까지 한 번에
sudo nano /etc/tmg-alert/config.yaml # 아이디/비번/스피커 MAC/주기 입력
sudo reboot
```
- ✅ 통과: 재부팅 후 `free -h`에 Swap 0, `mount | grep tmpfs` 에 `/var/log` `/tmp` 보임,
  `systemctl status tmg-agent` 가 `active (running)`

### Phase 3 — 브라우저 로그인·가져오기 검증 (30분)
```bash
# 실시간 로그 (RAM 저널)
journalctl -u tmg-agent -f

# 수동 1회 실행 테스트 (서비스 정지 후)
sudo systemctl stop tmg-agent
sudo -u pi DISPLAY=:99 /opt/tmg-alert/venv/bin/python -m tools.probe --config /etc/tmg-alert/config.yaml
```
`tools/probe.py` 가 하는 일: 로그인 → 배지 파싱 결과 출력 → (옵션 `--fetch`) 전체마켓 가져오기 1회 실행 →
결과 HTML/스크린샷을 `/dev/shm/tmg-probe/` 에 저장.
- ✅ 통과: 로그인 성공 로그, 배지 파싱에 `CS관리: 3` 류가 찍힘, 스크린샷에 관리자 화면이 보임

### Phase 4 — 소리(블루투스 스피커) (30분)
```bash
bluetoothctl
> power on
> scan on          # 스피커를 페어링 모드로
> pair  XX:XX:XX:XX:XX:XX
> trust XX:XX:XX:XX:XX:XX      # ★ trust 필수 — 자동 재연결의 핵심
> connect XX:XX:XX:XX:XX:XX
> quit
paplay /opt/tmg-alert/sounds/order.wav      # 소리 확인
```
config의 `notify.bt_mac` 에 MAC을 넣으면 에이전트가 끊길 때마다 재연결하고, 2분마다 무음을 흘려
스피커 절전을 막습니다.
- ✅ 통과: 스피커에서 효과음이 나고, 스피커를 껐다 켜도 1분 내 자동 재연결

### Phase 5 — LCD 알림판 (30분)
```bash
sudo systemctl enable --now tmg-kiosk
```
- ✅ 통과: LCD에 대기 화면(시계 + 상태)이 전체화면으로 뜸.
  `curl -X POST 127.0.0.1:8080/api/test` 로 테스트 알림 → 화면이 빨갛게 번쩍이고 소리가 남,
  화면/키 입력으로 확인(ACK) 시 원상복구

### Phase 6 — 실전 검증과 굳히기 (1~2주)
1. 며칠간 `journalctl -u tmg-agent --since -24h | grep -i error` 로 오류 관찰
2. **실제 주문이 1건 들어왔을 때** 알림이 뜨는지 확인 (→ 6장 남은 확인 항목)
3. 쓰기량 확인: `/proc/diskstats` 를 24시간 간격으로 두 번 측정 → 하루 수 MB 이하면 정상
4. 안정되면 **읽기전용 루트(overlayfs)** 활성화: `sudo raspi-config` → Performance → Overlay File System
5. UPS(보조배터리형 파워팩)나 최소한 안정적인 전원 확보
- ✅ 통과: 일주일간 무재시작(또는 계획된 주간 재부팅만) 유지

---

## 8. 남은 확인 항목 (실제 데이터가 있어야 확정 가능)

조사 시점에 주문 0건이라 **주문 목록의 행 구조를 확정하지 못했습니다.** 다음 순서로 해결됩니다.

1. **1순위 — 주문관리 배지**: CS관리처럼 `주문관리` 에도 신규 건수 배지가 붙는다면 추가 작업이 전혀 없습니다.
   `badge_watch` 는 특정 라벨을 하드코딩하지 않고 **`a.top_menu` 의 모든 배지를 라벨별로 추적**하므로,
   주문 배지가 나타나는 순간 자동으로 감시 대상이 됩니다.
   → 실제 주문 1건 발생 시 로그에서 `badges: {'주문관리': 1, 'CS관리': 3}` 처럼 찍히는지만 확인하세요.
2. **2순위 — 목록 diff**: 배지가 안 붙는다면, 주문 1건이 있는 상태에서
   `python -m tools.probe --dump-order-list` 를 돌려 목록 페이지 HTML을 받아
   `config.yaml` 의 `order_list.url` / `order_list.row_regex`(주문번호 추출) 를 채우면
   `order_list_watch` 태스크가 활성화됩니다. (코드는 이미 들어 있고 기본 비활성 상태입니다.)

그 외:
- 가져오기 완료 판정을 지금은 **"결과 영역이 25초간 변하지 않으면 완료"** 로 잡았습니다.
  사이트가 명확한 완료 문구(예: "… 완료되었습니다")를 낸다면 `browser.fetch_done_text` 에 넣어
  더 빠르고 정확하게 끝낼 수 있습니다. Phase 3의 probe 결과 텍스트를 보고 채우세요.
- 마켓 10개 × 시차(최대 7초 간격)라 1회 가져오기는 **대략 30초~2분** 예상.
  `schedule.market_fetch_min` 은 그보다 넉넉한 5분을 기본값으로 뒀습니다(마켓 API 호출 제한도 고려).

---

## 9. 폴더 구조

```
라즈베리파이_주문알림/
├─ README.md                  ← 이 문서 (설계·로드맵)
├─ requirements.txt
├─ config.example.yaml        ← /etc/tmg-alert/config.yaml 로 복사해 사용
├─ install/
│   └─ setup.sh               ← 패키지·tmpfs·journald·swap·systemd 유닛 일괄 설치
├─ agent/
│   ├─ main.py                ← 진입점(스케줄러 + 워치독 + 종료 처리)
│   ├─ config.py  events.py  state.py  scheduler.py
│   ├─ browser.py             ← Selenium/Chromium 세션, 로그인, 유저스크립트 주입, 새 창
│   ├─ session.py             ← 쿠키 공유 HTTP 세션, 배지 파싱
│   ├─ notify.py              ← 오디오(BT) + 대시보드 알림, 반복/ACK, 무음 킵얼라이브
│   ├─ web.py                 ← 표준 라이브러리 HTTP + SSE 서버
│   ├─ web_static/index.html  ← LCD 알림판 화면
│   ├─ userscripts/gm_shim.js ← GM_* 호환 계층 (기존 .user.js 재사용용)
│   └─ tasks/
│       ├─ base.py            ← 태스크 인터페이스
│       ├─ market_fetch.py    ← 전체마켓 가져오기 (브라우저)
│       ├─ badge_watch.py     ← 배지 폴링 (경량 HTTP) ★ 알림 판정
│       ├─ order_list_watch.py← 목록 diff (기본 비활성, 8장 2순위용)
│       └─ example_collect.py ← 향후 수집 매크로 예시 (기본 비활성)
└─ tools/
    ├─ probe.py               ← 사이트 구조 조사 / 수동 1회 실행
    └─ make_sounds.py         ← 효과음 wav 3개 생성 (외부 음원 불필요)
```

> 검증 상태: 파이썬 문법 전체 컴파일, `gm_shim.js` 문법, `setup.sh` 문법 통과.
> 배지 파싱(실제 HTML 구조 기준), 상태 저장 코얼레싱(SD 쓰기 억제), 이벤트→소리→대시보드→ACK 흐름,
> SSE 스트리밍, 가져오기 완료 판정 루프를 모의 환경에서 동작 확인했습니다.
> 실제 하드웨어 위에서의 검증은 로드맵 Phase 3~5에서 이뤄집니다.

## 10. 운영 치트시트

```bash
systemctl status tmg-agent tmg-xvfb tmg-wm tmg-kiosk   # 상태
journalctl -u tmg-agent -f                  # 실시간 로그(RAM)
journalctl -u tmg-agent --since -1h | grep -i error
sudo systemctl restart tmg-agent            # 에이전트만 재시작
curl -X POST 127.0.0.1:8080/api/test        # 테스트 알림
curl -s 127.0.0.1:8080/api/state | python3 -m json.tool   # 현재 상태 JSON
sudo nano /etc/tmg-alert/config.yaml && sudo systemctl restart tmg-agent
```

문제 유형별 첫 확인
- 소리만 안 남 → `bluetoothctl info <MAC>` 의 `Connected: yes`, `pactl list sinks short`
- 화면만 안 나옴 → `systemctl status tmg-kiosk`, HDMI 케이블(파이4는 **전원 옆 포트가 HDMI0**)
- 알림이 아예 없음 → `journalctl`에서 `badges:` 로그가 주기적으로 찍히는지, 값이 갱신되는지
- 로그인 반복 실패 → reCAPTCHA 챌린지 가능성. 파이에서 `--headed` 스크린샷(`/dev/shm/tmg-probe/`) 확인 후
  필요하면 사람이 한 번 직접 로그인

---

## 11. 이 설계에서 일부러 하지 않은 것

- **순수 HTTP(requests)만으로 로그인**: reCAPTCHA v3 때문에 불가. 시도했다면 조용히 계속 실패했을 것.
- **Playwright**: ARM64 리눅스용 Chromium 빌드를 공식 배포하지 않아 파이에서 설치가 깨진다.
  → apt의 `chromium` + `chromium-driver` + Selenium 조합이 파이에서 가장 안정적.
- **헤드리스 모드**: 팝업·확장·일부 JS 타이밍이 달라진다. Xvfb 안에서 "진짜 창"으로 띄우는 편이
  향후 수집 매크로까지 고려하면 훨씬 덜 깨진다.
- **캡차 자동 해결**: 하지 않는다. 챌린지가 뜨면 사람을 부른다.
- **DB/파일 로그 적재**: SD 쓰기를 늘리므로 안 한다. 필요해지면 NAS나 USB로 뺀다.

---

*문서 작성: 2026-07-27 · 사이트 구조는 같은 날 브라우저로 직접 확인한 값 기준*
