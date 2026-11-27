#!/usr/bin/env bash

# Copyright (c) 2026 Tobi As / Bildung4.0
# Author: Tobi As
# License: MIT
# Source: https://github.com/HatchetMan111/ProxVPN
#
# proxvpn - Simple VPN Gateway LXC (WireGuard + ProtonVPN) with Web UI
# Community-Script style for Proxmox VE
#
# Install (on the Proxmox host):
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)"
#
# Debug install (full trace):
#   bash -x <(wget -qO- https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)
#
# Optional env overrides:
#   CT_ID=125 CORES=2 RAM=1024 DISK=4 BRIDGE=vmbr0 VLAN=10 bash -c "$(wget -qLO - ...)"

set -euo pipefail

# ----------------------- VARIABLES -----------------------
APP="proxvpn"
APP_TITLE="ProxVPN Gateway"
REPO_URL="https://github.com/HatchetMan111/ProxVPN"
REPO_TARBALL="${REPO_URL}/archive/refs/heads/main.tar.gz"
WEB_PORT="8090"
WG_IF="proton"                 # wireguard interface name (matches /etc/wireguard/proton.conf)

CT_ID="${CT_ID:-auto}"         # next free ID if "auto"
CT_NAME="${APP}"
CORES="${CORES:-2}"
RAM="${RAM:-1024}"             # MiB
DISK="${DISK:-4}"              # GiB
BRIDGE="${BRIDGE:-vmbr0}"
VLAN="${VLAN:-}"
TAGS="${TAGS:-proxvpn;vpn}"
ROOTFS_STORAGE="${ROOTFS_STORAGE:-auto}"   # "auto" = first lvm-thin storage, fallback local-lvm

# ----------------------- HELPERS -----------------------
YW=$(echo "\033[33m"); RD=$(echo "\033[01;31m"); GN=$(echo "\033[1;92m"); CL=$(echo "\033[m")
header_info() {
  clear
  echo -e "${RD}  ____            ____  __  __ ${CL}
 ${RD}|  _ \ _ __ ___ | __ )|  \/  |${CL}
 ${RD}| |_) | '_ \` _ \|  _ \| |\/| |${CL}
 ${RD}|  __/| | | | | | |_) | |  | |${CL}
 ${RD}|_|   |_| |_| |_|____/|_|  |_|${CL}
        ${GN}VPN Gateway LXC with Web UI${CL}"
}
msg_info()    { echo -e "  ${YW}[INFO]${CL} $1"; }
msg_ok()      { echo -e "  ${GN}[OK]${CL} $1"; }
msg_error()   { echo -e "  ${RD}[ERROR]${CL} $1"; }

# Full error chain on any failure: line, command, exit code, logs
trap 'catch $? $LINENO "$BASH_COMMAND"' ERR
catch() {
  msg_error "Install failed at line $2 while executing: $3"
  msg_error "Exit code: $1"
  if pct status "$CT_ID" >/dev/null 2>&1; then
    echo -e "  ${RD}--- last container log ---${CL}"
    pct logs "$CT_ID" 2>&1 | tail -n 40 || true
    echo -e "  ${RD}--- proxvpn service log (if any) ---${CL}"
    pct exec "$CT_ID" -- journalctl -u proxvpn --no-pager -n 40 2>&1 | tail -n 40 || true
  fi
  echo -e "  ${RD}--- rerun with full trace ---${CL}"
  echo "  bash -x <(wget -qO- ${REPO_URL}/install/${APP}.sh)"
  exit "$1"
}

# ----------------------- PRECHECKS -----------------------
if [[ $EUID -ne 0 ]]; then
  msg_error "This script must run as root on the Proxmox host."
  exit 1
fi
for cmd in pct pvesh pveam wget; do
  command -v "$cmd" >/dev/null 2>&1 || { msg_error "Command '$cmd' not found - is this a Proxmox host?"; exit 1; }
done
header_info

# ----------------------- CT-ID -----------------------
if [[ "$CT_ID" == "auto" ]]; then
  CT_ID=$(pvesh get /cluster/nextid)
  msg_info "Next free CT-ID: ${CT_ID}"
elif pct status "$CT_ID" >/dev/null 2>&1; then
  msg_error "CT ${CT_ID} already exists. Remove it or set CT_ID=<free-id>."
  exit 1
fi

# Idempotency: refuse to run twice for an existing container of the same name
if pct list 2>/dev/null | awk 'NR>1 {print $NF}' | grep -qx "$CT_NAME"; then
  msg_error "A container named '$CT_NAME' already exists. Uninstall it first (see README)."
  exit 1
fi

# ----------------------- STORAGE -----------------------
msg_info "Detecting storage"
# template storage: first storage with template content type
TEMPLATE_STORAGE=$(pvesh get /storage --output-format json 2>/dev/null \
  | python3 -c 'import json,sys
for s in json.load(sys.stdin):
    if "template" in s.get("content", []): print(s["storage"]); break' 2>/dev/null || true)
[[ -n "$TEMPLATE_STORAGE" ]] || TEMPLATE_STORAGE="local"

# rootfs storage: first lvm-thin, else local-lvm
if [[ "$ROOTFS_STORAGE" == "auto" ]]; then
  ROOTFS_STORAGE=$(pvesh get /storage --output-format json 2>/dev/null \
    | python3 -c 'import json,sys
for s in json.load(sys.stdin):
    if s.get("type") == "lvmthin": print(s["storage"]); break' 2>/dev/null || true)
  [[ -n "$ROOTFS_STORAGE" ]] || ROOTFS_STORAGE="local-lvm"
fi
msg_ok "Storages: templates=${TEMPLATE_STORAGE}, rootfs=${ROOTFS_STORAGE}"

# ----------------------- TEMPLATE (pick latest debian-12 automatically) -----------------------
msg_info "Selecting a Debian 12 template"
pveam update >/dev/null 2>&1 || true
TEMPLATE=$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $2}' | grep '^debian-12-standard' | sort -V | tail -n1)
if [[ -z "$TEMPLATE" ]]; then
  # 'pveam available' output is single-column (" debian-12-standard_..."), so $1, not $2
  TEMPLATE=$(pveam available 2>/dev/null | grep -o 'debian-12-standard[^ ]*' | sort -V | tail -n1)
  if [[ -n "$TEMPLATE" ]]; then
    msg_info "Downloading template ${TEMPLATE}..."
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
  fi
fi
[[ -n "$TEMPLATE" ]] || { msg_error "No debian-12-standard template found."; exit 1; }
msg_ok "Template ready (${TEMPLATE_STORAGE}/${TEMPLATE})"

# ----------------------- CREATE CT -----------------------
msg_info "Creating LXC ${CT_ID} (${CORES} vCPU, ${RAM} MiB RAM, ${DISK} GiB disk)"
NET_STRING="name=eth0,bridge=${BRIDGE},ip=dhcp"
[[ -n "$VLAN" ]] && NET_STRING="${NET_STRING},tag=${VLAN}"
pct create "$CT_ID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$CT_NAME" \
  --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "${ROOTFS_STORAGE}:rootfs,size=${DISK}" \
  --net0 "$NET_STRING" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 --start 1 \
  --tags "$TAGS" >/dev/null
msg_ok "Container ${CT_ID} (${CT_NAME}) created and started"

# Wait for container init (avoid pct exec race right after --start 1)
msg_info "Waiting for container to finish booting"
for i in $(seq 1 30); do
  if pct exec "$CT_ID" -- true >/dev/null 2>&1; then break; fi
  sleep 1
  [[ $i -eq 30 ]] && { msg_error "Container did not become reachable within 30s."; exit 1; }
done
sleep 2
msg_ok "Container is up"

# ----------------------- INSIDE CT: BASE PACKAGES -----------------------
msg_info "Installing base packages inside CT (this can take a few minutes)"
pct exec "$CT_ID" -- bash -ec '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq wireguard nftables python3 python3-venv python3-pip \
    curl wget ca-certificates nodejs npm >/dev/null
'
msg_ok "Base packages installed"

# ----------------------- INSIDE CT: APP -----------------------
msg_info "Fetching ${APP} from GitHub"
pct exec "$CT_ID" -- bash -ec '
  mkdir -p /opt/proxvpn
  wget -qO- "'"$REPO_TARBALL"'" | tar -xz -C /opt/proxvpn --strip-components=1
  test -f /opt/proxvpn/app/backend/main.py || {
    echo "ERROR: app sources incomplete, tarball download failed" >&2
    exit 1
  }
'
msg_ok "App sources in place (/opt/proxvpn)"

msg_info "Building React/Vite frontend inside CT"
pct exec "$CT_ID" -- bash -ec '
  cd /opt/proxvpn/app/frontend
  npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
  npm run build >/dev/null 2>&1 || npm run build
  test -d dist || { echo "ERROR: vite build produced no dist/ directory" >&2; exit 1; }
  mkdir -p /opt/proxvpn/app/backend/static
  rm -rf /opt/proxvpn/app/backend/static/*
  cp -r dist/* /opt/proxvpn/app/backend/static/
'
msg_ok "Frontend built into backend/static"

msg_info "Setting up Python backend (venv + FastAPI)"
pct exec "$CT_ID" -- bash -ec '
  python3 -m venv /opt/proxvpn/venv
  /opt/proxvpn/venv/bin/pip install --quiet -r /opt/proxvpn/app/backend/requirements.txt
'
msg_ok "Backend venv ready"

# ----------------------- INSIDE CT: KILL SWITCH -----------------------
msg_info "Installing nftables kill switch (forward policy: drop unless via ${WG_IF})"
pct exec "$CT_ID" -- bash -ec 'cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
flush ruleset

table inet proxvpn {
  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport '"$WEB_PORT"' accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    iifname "eth0" oifname "'"$WG_IF"'" accept
    iifname "'"$WG_IF"'" oifname "eth0" accept
  }
  chain postrouting {
    type nat hook postrouting priority 100;
    oifname "'"$WG_IF"'" masquerade
  }
}
EOF
  nft -f /etc/nftables.conf
  systemctl enable nftables >/dev/null 2>&1
  cat > /etc/sysctl.d/99-proxvpn.conf <<EOF
net.ipv4.ip_forward=1
EOF
  sysctl -p /etc/sysctl.d/99-proxvpn.conf >/dev/null
'
msg_ok "Kill switch active: traffic only flows through ${WG_IF}"

# ----------------------- INSIDE CT: SYSTEMD -----------------------
msg_info "Installing systemd service (Restart=always, after network-online)"
pct exec "$CT_ID" -- bash -ec 'cat > /etc/systemd/system/proxvpn.service <<EOF
[Unit]
Description=${APP_TITLE} Web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/proxvpn/app/backend
ExecStart=/opt/proxvpn/venv/bin/uvicorn main:app --host 0.0.0.0 --port '"$WEB_PORT"'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable proxvpn >/dev/null 2>&1
  systemctl restart proxvpn
'
msg_ok "Service proxvpn enabled and started"

# ----------------------- VERIFICATION -----------------------
msg_info "Verifying installation"
sleep 3
if ! pct exec "$CT_ID" -- bash -ec '
  set -x
  systemctl is-active proxvpn
  curl -fsS -m 10 "http://localhost:'"$WEB_PORT"'" -o /dev/null
' >/dev/null 2>&1; then
  msg_error "Verification failed - full service log follows:"
  pct exec "$CT_ID" -- journalctl -u proxvpn --no-pager -n 60 || true
  exit 1
fi
msg_ok "Service active, Web UI responds on port ${WEB_PORT}"

CT_IP=$(pct exec "$CT_ID" -- hostname -I | awk '{print $1}')
echo
msg_ok "Install complete: http://${CT_IP}:${WEB_PORT}"
msg_info "Next: paste your ProtonVPN WireGuard config in the Web UI (card 'Setup')."
msg_info "The tunnel auto-reconnects after reboot (wg-quick@${WG_IF} is enabled on config save)."
msg_info "Gateway use: point clients to ${CT_IP} as their default gateway (or add a static route on your router)."
echo
