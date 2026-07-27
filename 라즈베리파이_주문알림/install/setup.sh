#!/usr/bin/env bash
# 더망고 주문/CS 알림 시스템 설치 스크립트 (Raspberry Pi OS Lite 64-bit)
#
#   sudo bash install/setup.sh
#
# 하는 일: 패키지 설치 → /opt/tmg-alert 배치 → venv → 효과음 생성 → 설정 파일 →
#          SD 쓰기 최소화(스왑/저널/tmpfs) → 워치독 → systemd 유닛 → 서비스 활성화
# 여러 번 실행해도 안전(멱등)합니다.
set -euo pipefail

APP_DIR=/opt/tmg-alert
CFG_DIR=/etc/tmg-alert
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-pi}"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m[!] %s\033[0m\n" "$*"; }

[[ $EUID -eq 0 ]] || { echo "sudo 로 실행하세요"; exit 1; }
id "$RUN_USER" >/dev/null 2>&1 || { echo "사용자 $RUN_USER 가 없습니다"; exit 1; }
RUN_UID="$(id -u "$RUN_USER")"

# ---------------------------------------------------------------- 1. 패키지
say "1/9 패키지 설치"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  python3 python3-venv python3-pip \
  xvfb xserver-xorg xinit x11-xserver-utils openbox unclutter \
  bluez pipewire pipewire-pulse wireplumber pulseaudio-utils \
  ca-certificates curl dbus-x11

# 한글 폰트 — Lite 에는 CJK 폰트가 없어서 관리자 화면이 전부 □ 로 보인다.
# (DOM 파싱에는 지장이 없지만 스크린샷 기반 진단이 불가능해진다)
apt-get install -y --no-install-recommends fonts-nanum || \
  apt-get install -y --no-install-recommends fonts-noto-cjk || \
  warn "한글 폰트 설치 실패 — 스크린샷이 □ 로 보일 수 있습니다."

# 배포판마다 패키지 이름이 다르다 (Pi OS: chromium / chromium-browser)
apt-get install -y chromium || apt-get install -y chromium-browser
apt-get install -y chromium-driver || apt-get install -y chromium-chromedriver || \
  warn "chromedriver 패키지를 못 찾았습니다. 'apt search chromedriver' 로 확인하세요."

# ---------------------------------------------------------------- 2. 배치
say "2/9 애플리케이션 배치: $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/agent" "$APP_DIR/tools"
cp -r "$SRC_DIR/agent" "$SRC_DIR/tools" "$APP_DIR/"
cp "$SRC_DIR/requirements.txt" "$APP_DIR/"
mkdir -p "$APP_DIR/userscripts"          # 향후 .user.js 를 여기에 둔다
mkdir -p "$APP_DIR/extensions"           # 더망고 확장(압축 해제 폴더)을 여기에 둔다 — RAM 아닌 SD 에 영구 보관
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

say "3/9 파이썬 가상환경"
if [[ ! -x "$APP_DIR/venv/bin/python" ]]; then
  python3 -m venv "$APP_DIR/venv"
fi
"$APP_DIR/venv/bin/pip" install --upgrade pip wheel >/dev/null
"$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/venv"

say "4/9 효과음 생성"
"$APP_DIR/venv/bin/python" "$APP_DIR/tools/make_sounds.py" "$APP_DIR/sounds"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/sounds"

say "5/9 설정 파일"
mkdir -p "$CFG_DIR" /var/lib/tmg-alert
if [[ -f "$CFG_DIR/config.yaml" ]]; then
  echo "  기존 설정 유지: $CFG_DIR/config.yaml"
else
  cp "$SRC_DIR/config.example.yaml" "$CFG_DIR/config.yaml"
  chmod 600 "$CFG_DIR/config.yaml"      # 아이디/비밀번호가 들어가므로
  warn "설정을 채우세요: sudo nano $CFG_DIR/config.yaml"
fi
chown -R "$RUN_USER":"$RUN_USER" /var/lib/tmg-alert "$CFG_DIR"
cat > /etc/tmpfiles.d/tmg-alert.conf <<EOF
d /run/tmg-alert 0755 $RUN_USER $RUN_USER -
d /var/log/apt   0755 root root -
d /var/log/private 0700 root root -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/tmg-alert.conf || true

# ---------------------------------------------------------------- 6. SD 쓰기 최소화
say "6/9 SD카드 쓰기 최소화"

# (a) 스왑 완전 제거 — SD 쓰기의 최대 주범
if systemctl list-unit-files | grep -q dphys-swapfile; then
  dphys-swapfile swapoff || true
  dphys-swapfile uninstall || true
  systemctl disable --now dphys-swapfile || true
  echo "  스왑 비활성화"
fi

# (b) 저널을 RAM 으로
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/00-volatile.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=32M
RuntimeMaxFileSize=8M
ForwardToSyslog=no
EOF
echo "  저널 → RAM(volatile)"

# (c) tmpfs 마운트
cp /etc/fstab "/etc/fstab.bak-$STAMP"
add_fstab() {
  grep -qE "^[^#]*[[:space:]]$1[[:space:]]" /etc/fstab || echo "$2" >> /etc/fstab
}
add_fstab /tmp     "tmpfs /tmp     tmpfs defaults,noatime,nosuid,nodev,size=256M 0 0"
add_fstab /var/tmp "tmpfs /var/tmp tmpfs defaults,noatime,nosuid,nodev,size=64M  0 0"
add_fstab /var/log "tmpfs /var/log tmpfs defaults,noatime,nosuid,nodev,mode=0755,size=64M 0 0"
echo "  /tmp, /var/tmp, /var/log → tmpfs (백업: /etc/fstab.bak-$STAMP)"

# (d) 루트 파일시스템 쓰기 병합 (noatime + commit=600)
if ! awk '$2=="/" && $4 ~ /commit=/ {found=1} END{exit !found}' /etc/fstab; then
  awk 'BEGIN{OFS="\t"}
       $1 !~ /^#/ && $2=="/" && $4 !~ /commit=/ {
         $4 = $4 ($4 ~ /noatime/ ? "" : ",noatime") ",commit=600"
       } {print}' /etc/fstab > /tmp/fstab.new && mv /tmp/fstab.new /etc/fstab
  echo "  루트 마운트 옵션에 noatime,commit=600 추가"
fi

# (e) 예고 없는 대량 쓰기 / 버전 변경 방지
systemctl disable --now unattended-upgrades 2>/dev/null || true
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl disable --now man-db.timer 2>/dev/null || true
echo "  자동 업데이트/인덱싱 타이머 비활성 (업데이트는 사람이 계획적으로)"

# (f) 하드웨어 워치독
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/10-watchdog.conf <<'EOF'
[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min
EOF
BOOTCFG=/boot/firmware/config.txt
[[ -f $BOOTCFG ]] || BOOTCFG=/boot/config.txt
if [[ -f $BOOTCFG ]] && ! grep -q "^dtparam=watchdog=on" "$BOOTCFG"; then
  echo "dtparam=watchdog=on" >> "$BOOTCFG"
fi
echo "  하드웨어 워치독 활성 (시스템 전체 프리즈 시 자동 리셋)"

# ---------------------------------------------------------------- 7. 오디오/블루투스
say "7/9 오디오·블루투스 권한"
usermod -aG bluetooth,audio,video,tty "$RUN_USER" || true
loginctl enable-linger "$RUN_USER"        # 로그인 없이도 PipeWire 사용자 세션이 돌게
sudo -u "$RUN_USER" XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user enable pipewire pipewire-pulse wireplumber 2>/dev/null || \
  warn "PipeWire 사용자 서비스 활성화는 재부팅 후 자동으로 됩니다"

# ---------------------------------------------------------------- 8. 키오스크
say "8/9 키오스크 화면 설정"
CHROME_BIN="$(command -v chromium || command -v chromium-browser)"

# ★ Xorg 래퍼 권한 — 이게 없으면 비root 사용자의 X 실행이 거부된다.
#   증상: tmg-kiosk 가 오류 메시지 없이 즉시 종료 → RestartSec 주기로 화면이 깜빡이며
#   로그인 프롬프트가 반복 표시된다. (오류는 journal 이 아니라 tty1 로 나가서 안 보인다)
cat > /etc/X11/Xwrapper.config <<'EOF'
allowed_users=anybody
needs_root_rights=yes
EOF
usermod -aG video,input,tty,render "$RUN_USER" 2>/dev/null || \
  usermod -aG video,input,tty "$RUN_USER"

mkdir -p "$APP_DIR/kiosk"
cat > "$APP_DIR/kiosk/xinitrc" <<EOF
#!/bin/sh
# LCD 전체화면 알림판. 프로필/캐시는 RAM(/dev/shm) → SD 쓰기 0
xset s off
xset -dpms
xset s noblank
unclutter -idle 0.1 -root &
openbox &
exec $CHROME_BIN \\
  --kiosk --incognito --noerrdialogs --disable-infobars \\
  --disable-session-crashed-bubble --disable-features=Translate \\
  --check-for-update-interval=31536000 \\
  --user-data-dir=/dev/shm/tmg-kiosk --disk-cache-dir=/dev/shm/tmg-kiosk-cache \\
  --disk-cache-size=16777216 \\
  --autoplay-policy=no-user-gesture-required \\
  http://127.0.0.1:8080/
EOF
chmod +x "$APP_DIR/kiosk/xinitrc"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/kiosk"
# 콘솔 사용자가 X를 띄울 수 있게
if [[ -f /etc/X11/Xwrapper.config ]]; then
  sed -i 's/^allowed_users=.*/allowed_users=anybody/' /etc/X11/Xwrapper.config
else
  printf 'allowed_users=anybody\nneeds_root_rights=yes\n' > /etc/X11/Xwrapper.config
fi

# ---------------------------------------------------------------- 9. systemd 유닛
say "9/9 systemd 유닛"

cat > /etc/systemd/system/tmg-xvfb.service <<EOF
[Unit]
Description=TMG 자동화용 가상 디스플레이 (:99)
Before=tmg-agent.service

[Service]
# 해상도는 브라우저 창(1280x900)보다 넉넉하게 — 더망고 스크래퍼 팝업이 800x700 으로 따로 뜬다
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp
Restart=always
RestartSec=5
User=$RUN_USER

[Install]
WantedBy=multi-user.target
EOF

# :99 에도 창 관리자가 필요하다. WM 이 없으면 window.open 으로 뜬 팝업이
# 위치/크기/포커스를 못 받아 스크래퍼 창이 제대로 동작하지 않을 수 있다. (RAM 약 10MB)
cat > /etc/systemd/system/tmg-wm.service <<EOF
[Unit]
Description=TMG 자동화 디스플레이용 창 관리자 (:99)
After=tmg-xvfb.service
Requires=tmg-xvfb.service
Before=tmg-agent.service

[Service]
User=$RUN_USER
Environment=DISPLAY=:99
ExecStart=/usr/bin/openbox --sm-disable
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/tmg-agent.service <<EOF
[Unit]
Description=TMG 주문/CS 알림 에이전트
After=network-online.target tmg-xvfb.service tmg-wm.service
Wants=network-online.target tmg-wm.service
Requires=tmg-xvfb.service

[Service]
Type=notify
NotifyAccess=all
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=DISPLAY=:99
Environment=XDG_RUNTIME_DIR=/run/user/$RUN_UID
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP_DIR/venv/bin/python -m agent.main --config $CFG_DIR/config.yaml
Restart=always
RestartSec=10
TimeoutStartSec=300
WatchdogSec=180
# 상품업데이트(수천 건 병렬 스크랩)까지 돌리면 Chromium 이 1.2G 를 쉽게 넘긴다.
# /dev/shm 의 프로필·캐시도 이 cgroup 에 계상되므로 여유를 둔다. (4GB 모델 기준)
MemoryMax=2500M
# 로그는 파일이 아니라 저널(RAM)로만
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/tmg-kiosk.service <<EOF
[Unit]
Description=TMG LCD 알림판 (Chromium 키오스크)
After=tmg-agent.service systemd-user-sessions.service getty@tty1.service
Wants=tmg-agent.service
# tty1 을 getty 와 동시에 잡으면 서로 화면을 뺏는다
Conflicts=getty@tty1.service
# 실패해도 무한 재시작하지 않게 (깜빡임 무한반복 방지)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=$RUN_USER
PAMName=login
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
StandardInput=tty
Environment=XDG_RUNTIME_DIR=/run/user/$RUN_UID
ExecStart=/usr/bin/startx $APP_DIR/kiosk/xinitrc -- :0 vt1 -keeptty -nocursor
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/tmg-reboot.service <<'EOF'
[Unit]
Description=TMG 주간 예방 재부팅

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl reboot
EOF

cat > /etc/systemd/system/tmg-reboot.timer <<'EOF'
[Unit]
Description=TMG 주간 예방 재부팅 (일요일 04:30)

[Timer]
OnCalendar=Sun *-*-* 04:30:00
Persistent=false

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable tmg-xvfb.service tmg-wm.service tmg-agent.service tmg-kiosk.service tmg-reboot.timer

cat <<EOF

────────────────────────────────────────────────────────────
 설치 완료

 1) 설정을 채우세요 (아이디/비밀번호/스피커 MAC/주기)
      sudo nano $CFG_DIR/config.yaml

 2) 블루투스 스피커 페어링 (trust 를 꼭 하세요)
      bluetoothctl
        power on / scan on / pair MAC / trust MAC / connect MAC / quit

 3) 재부팅
      sudo reboot

 4) 확인
      systemctl status tmg-agent tmg-kiosk
      journalctl -u tmg-agent -f
      curl -X POST 127.0.0.1:8080/api/test      # 테스트 알림

 ※ 모든 게 안정된 뒤 마지막으로 읽기전용 루트를 켜면 SD 쓰기가 0이 됩니다:
      sudo raspi-config → Performance Options → Overlay File System
────────────────────────────────────────────────────────────
EOF
