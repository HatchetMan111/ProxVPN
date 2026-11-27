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
# Update an existing proxvpn container (keeps tunnel config; password is kept
# or bootstrapped if the container was installed before auth existed):
#   UPDATE=1 bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)"
#
# Debug install (full trace):
#   bash -x <(wget -qO- https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)
#
# Optional env overrides:
#   CT_ID=125 CORES=2 RAM=1024 DISK=4 BRIDGE=vmbr0 VLAN=10 bash -c "$(wget -qLO - ...)"
#   REINSTALL=1 bash -c "$(wget -qLO - ...)"   # remove existing proxvpn CT and rebuild
#   ALLOW_CIDR=192.168.1.0/24 bash -c ...      # only this subnet may use the gateway
#   WEB_PASSWORD=mypass bash -c ...             # set the Web UI password explicitly
#   NO_IPV6=1 bash -c ...                       # skip the IPv6 kill switch

set -euo pipefail

# ----------------------- VARIABLES -----------------------
APP="proxvpn"
REPO_URL="https://github.com/HatchetMan111/ProxVPN"
REPO_TARBALL="${REPO_URL}/archive/refs/heads/main.tar.gz"
WEB_PORT="${WEB_PORT:-8090}"
WG_IF="proton"                 # wireguard interface name (matches /etc/wireguard/proton.conf)
ALLOW_CIDR="${ALLOW_CIDR:-}"   # empty = any LAN client may use the gateway
DNS_SERVERS="${DNS_SERVERS:-}" # comma-separated LAN DNS IPs (AdGuard/Pi-hole) bypassing the tunnel
NO_IPV6="${NO_IPV6:-0}"        # 1 = do not install the IPv6 kill switch
WATCHDOG="${WATCHDOG:-1}"      # 0 = no tunnel auto-reconnect watchdog
UPDATE="${UPDATE:-0}"          # 1 = update an existing proxvpn container in place
REINSTALL="${REINSTALL:-0}"    # 1 = destroy existing proxvpn CT and rebuild

CT_ID="${CT_ID:-auto}"         # next free ID if "auto"
CT_NAME="${APP}"
CORES="${CORES:-2}"
RAM="${RAM:-1024}"             # MiB
DISK="${DISK:-4}"              # GiB
BRIDGE="${BRIDGE:-vmbr0}"
VLAN="${VLAN:-}"
TAGS="${TAGS:-proxvpn;vpn}"
ROOTFS_STORAGE="${ROOTFS_STORAGE:-auto}"   # "auto" = first lvm/lvmthin storage, fallback local-lvm

UI_PW=""

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

find_ct() { pct list 2>/dev/null | awk -v name="$CT_NAME" 'NR>1 && $NF==name {print $1; exit}'; }

# Password: explicit via WEB_PASSWORD, else random (host python3, PVE ships it)
gen_password() {
  if [[ -n "${WEB_PASSWORD:-}" ]]; then
    printf '%s' "$WEB_PASSWORD"
  else
    python3 -c 'import secrets; print(secrets.token_urlsafe(12))'
  fi
}

# Write /etc/proxvpn/auth.json inside the CT. The password travels as an argv
# element (never through stdin or a quoted heredoc), so special characters are
# safe. Runs via bash -ec with $1 = password.
write_auth_file() {
  pct exec "$CT_ID" -- bash -ec '
    set -e
    mkdir -p /etc/proxvpn
    python3 - "$1" <<PYEOF
import json, pathlib, sys
p = pathlib.Path("/etc/proxvpn/auth.json")
tmp = p.with_suffix(".tmp")
tmp.write_text(json.dumps({"password": sys.argv[1], "tokens": {}}))
tmp.chmod(0o600)
tmp.replace(p)
PYEOF
  ' _ "$1"
}

# systemd unit (idempotent; also rewritten on UPDATE)
write_unit() {
  pct exec "$CT_ID" -- bash -ec 'cat > /etc/systemd/system/proxvpn.service <<EOF
[Unit]
Description=ProxVPN Gateway Web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/proxvpn/app/backend
Environment=PROXVPN_WEB_PORT='"$WEB_PORT"'
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
}

# Firewall: regenerated by the BACKEND from /etc/proxvpn/settings.json
# (same template the Web UI uses - installer and UI can never drift apart).
# settings.json is written first, then "python3 main.py regen" renders and
# applies /etc/nftables.conf (IPv4 + IPv6, kill switch policy, DNS exceptions).
write_settings_file() {
  pct exec "$CT_ID" -- bash -ec '
    set -e
    mkdir -p /etc/proxvpn
    python3 - "$1" "$2" "$3" "$4" <<PYEOF
import json, pathlib, sys
p = pathlib.Path("/etc/proxvpn/settings.json")
st = {"killswitch": sys.argv[1] == "1", "dns_servers": [x.strip() for x in sys.argv[2].split(",") if x.strip()],
      "allow_cidr": sys.argv[3], "watchdog": sys.argv[4] == "1"}
tmp = p.with_suffix(".tmp")
tmp.write_text(json.dumps(st, indent=2))
tmp.chmod(0o600)
tmp.replace(p)
PYEOF
  ' _ "$([[ "${KILL_SWITCH:-1}" == "0" ]] && echo 0 || echo 1)" "$DNS_SERVERS" "$ALLOW_CIDR" "$([[ "$WATCHDOG" == "0" ]] && echo 0 || echo 1)"
}

# settings.json bootstrap: create when missing (v1/v2 upgrades) or when the
# user passes DNS_SERVERS/ALLOW_CIDR explicitly; otherwise keep UI-tuned values.
ensure_settings() {
  local EXISTS=1
  pct exec "$CT_ID" -- test -f /etc/proxvpn/settings.json >/dev/null 2>&1 || EXISTS=0
  if [[ $EXISTS == 0 || -n "$DNS_SERVERS" || -n "$ALLOW_CIDR" ]]; then
    write_settings_file
    NEW_SETTINGS=1
  fi
}

write_killswitch() {
  msg_info "Generating nftables kill switch from settings (backend template)"
  local RC=0
  pct exec "$CT_ID" -- /opt/proxvpn/venv/bin/python /opt/proxvpn/app/backend/main.py regen || RC=$?
  if [[ $RC -ne 0 ]]; then
    msg_error "nftables regen failed inside the CT (see output above)"
    exit 1
  fi
  pct exec "$CT_ID" -- bash -ec '
    systemctl enable nftables >/dev/null 2>&1 || true
    printf "net.ipv4.ip_forward=1\n" > /etc/sysctl.d/99-proxvpn.conf
    sysctl -p /etc/sysctl.d/99-proxvpn.conf >/dev/null
  '
  msg_ok "Kill switch applied: forwarding policy + DNS exceptions from settings"
}

write_watchdog() {
  pct exec "$CT_ID" -- bash -ec 'cat > /etc/systemd/system/proxvpn-watchdog.service <<EOF
[Unit]
Description=ProxVPN tunnel watchdog (restarts stale WireGuard handshake)
After=network-online.target wg-quick@proton.service

[Service]
Type=oneshot
ExecStart=/opt/proxvpn/venv/bin/python /opt/proxvpn/app/backend/watchdog.py
EOF
cat > /etc/systemd/system/proxvpn-watchdog.timer <<EOF
[Unit]
Description=Run the ProxVPN tunnel watchdog every minute

[Timer]
OnBootSec=90
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable proxvpn-watchdog.timer >/dev/null 2>&1
  systemctl start proxvpn-watchdog.timer
'
  msg_ok "Tunnel watchdog armed (restarts tunnel when handshake is stale >180 s)"
}

verify_service() {
  sleep 3
  pct exec "$CT_ID" -- bash -ec "systemctl is-active proxvpn >/dev/null && curl -fsS -m 10 http://localhost:${WEB_PORT}/api/health >/dev/null"
}

# ----------------------- PRECHECKS -----------------------
if [[ $EUID -ne 0 ]]; then
  msg_error "This script must run as root on the Proxmox host."
  exit 1
fi
for cmd in pct pvesh pveam wget; do
  command -v "$cmd" >/dev/null 2>&1 || { msg_error "Command '$cmd' not found - is this a Proxmox host?"; exit 1; }
done
command -v python3 >/dev/null 2>&1 || { msg_error "python3 not found on the host (needed for password generation)."; exit 1; }
header_info

# ----------------------- UPDATE MODE -----------------------
if [[ "$UPDATE" == "1" ]]; then
  CT_ID=$(find_ct)
  [[ -n "$CT_ID" ]] || { msg_error "UPDATE=1 but no container named '${CT_NAME}' exists."; exit 1; }
  msg_info "UPDATE: refreshing ${APP} inside existing CT ${CT_ID}"

  pct exec "$CT_ID" -- bash -ec '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates python3 python3-venv >/dev/null
    mkdir -p /opt/proxvpn
    wget -qO- "'"$REPO_TARBALL"'" | tar -xz -C /opt/proxvpn --strip-components=1
    test -f /opt/proxvpn/app/backend/main.py
    test -f /opt/proxvpn/app/backend/static/index.html || {
      echo "ERROR: bundled frontend (app/backend/static) missing in tarball" >&2; exit 1; }
    python3 -m venv /opt/proxvpn/venv
    /opt/proxvpn/venv/bin/pip install --quiet -r /opt/proxvpn/app/backend/requirements.txt
  '

  # Kill switch + unit are ours to manage: refresh both so an older install
  # (v1 = no IPv6 rules, no auth) ends up on the same state as a fresh install.
  ensure_settings
  write_killswitch
  write_unit
  write_watchdog

  # Auth bootstrap: keep an existing password, create one if the container
  # predates auth (otherwise the new backend would run with the UI wide open).
  if [[ -n "${WEB_PASSWORD:-}" ]] || ! pct exec "$CT_ID" -- test -f /etc/proxvpn/auth.json 2>/dev/null; then
    UI_PW=$(gen_password)
    write_auth_file "$UI_PW"
    NEW_PW=1
  fi

  if verify_service; then
    CT_IP=$(pct exec "$CT_ID" -- hostname -I | awk '{print $1}')
    msg_ok "Update complete: http://${CT_IP}:${WEB_PORT}"
    if [[ "${NEW_PW:-0}" == "1" ]]; then
      echo -e "  ${GN}Web UI password (new):${CL} ${UI_PW}"
    else
      msg_ok "Web UI password unchanged (/etc/proxvpn/auth.json)"
    fi
    if [[ "${NEW_SETTINGS:-0}" == "1" ]]; then
      msg_ok "Settings created (/etc/proxvpn/settings.json) - kill switch, DNS, CIDR now editable in the Web UI"
    else
      msg_ok "Settings unchanged (/etc/proxvpn/settings.json)"
    fi
    exit 0
  fi
  msg_error "Update verification failed - service log:"
  pct exec "$CT_ID" -- journalctl -u proxvpn --no-pager -n 60 || true
  exit 1
fi

# ----------------------- CT-ID -----------------------
if [[ "$CT_ID" == "auto" ]]; then
  CT_ID=$(pvesh get /cluster/nextid)
  msg_info "Next free CT-ID: ${CT_ID}"
elif pct status "$CT_ID" >/dev/null 2>&1; then
  msg_error "CT ${CT_ID} already exists. Remove it or set CT_ID=<free-id>."
  exit 1
fi

# ----------------------- EXISTING CONTAINER -----------------------
# Idempotency: a container with this name may already exist from a previous run.
EXISTING_CT_ID=$(find_ct)
if [[ -n "$EXISTING_CT_ID" ]]; then
  if [[ "$REINSTALL" == "1" ]]; then
    msg_info "REINSTALL=1: removing existing CT ${EXISTING_CT_ID} (${CT_NAME})"
    pct stop "$EXISTING_CT_ID" >/dev/null 2>&1 || true
    pct destroy "$EXISTING_CT_ID" --purge >/dev/null
    msg_ok "Old container removed"
  else
    msg_error "A container named '${CT_NAME}' already exists (CT ${EXISTING_CT_ID})."
    msg_info "Update it in place (keeps tunnel config + password):"
    msg_info "  UPDATE=1 bash -c \"\$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/${APP}.sh)\""
    msg_info "Or remove and rebuild: REINSTALL=1 ..."
    exit 1
  fi
fi

# ----------------------- STORAGE -----------------------
msg_info "Detecting storage"
# template storage: first storage with template content type
TEMPLATE_STORAGE=$(pvesh get /storage --output-format json 2>/dev/null \
  | python3 -c 'import json,sys
for s in json.load(sys.stdin):
    if "template" in s.get("content", []): print(s["storage"]); break' 2>/dev/null || true)
[[ -n "$TEMPLATE_STORAGE" ]] || TEMPLATE_STORAGE="local"

# rootfs storage: first lvmthin or lvm storage, else local-lvm
if [[ "$ROOTFS_STORAGE" == "auto" ]]; then
  ROOTFS_STORAGE=$(pvesh get /storage --output-format json 2>/dev/null \
    | python3 -c 'import json,sys
for s in json.load(sys.stdin):
    if s.get("type") in ("lvmthin", "lvm") and "rootdir" in s.get("content", []): print(s["storage"]); break' 2>/dev/null || true)
  [[ -n "$ROOTFS_STORAGE" ]] || ROOTFS_STORAGE="local-lvm"
fi
msg_ok "Storages: templates=${TEMPLATE_STORAGE}, rootfs=${ROOTFS_STORAGE}"

# ----------------------- TEMPLATE (pick latest debian-12 automatically) -----------------------
msg_info "Selecting a Debian 12 template"
pveam update >/dev/null 2>&1 || true
# NOTE: 'grep' returns exit code 1 when nothing matches, which is expected when
# the template is not downloaded yet. '|| true' keeps pipefail from aborting.
TEMPLATE=$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $2}' | grep '^debian-12-standard' | sort -V | tail -n1 || true)
if [[ -z "$TEMPLATE" ]]; then
  # 'pveam available' output is single-column (" debian-12-standard_..."), so $1, not $2
  TEMPLATE=$(pveam available 2>/dev/null | grep -o 'debian-12-standard[^ ]*' | sort -V | tail -n1 || true)
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
# NOTE: 'STORAGE:SIZE' lets pct create a fresh volume (e.g. vm-<id>-disk-0).
# 'STORAGE:rootfs,size=...' would reference a non-existent existing volume
# on lvm/lvmthin storages ("no such logical volume pve/rootfs").
pct create "$CT_ID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$CT_NAME" \
  --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "${ROOTFS_STORAGE}:${DISK}" \
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
# NOTE: no nodejs/npm - the frontend is prebuilt and shipped in the repo.
# Node in the CT caused CPU spikes on small hosts and is a needless attack surface.
msg_info "Installing base packages inside CT (this can take a few minutes)"
pct exec "$CT_ID" -- bash -ec '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq wireguard nftables python3 python3-venv python3-pip \
    curl wget ca-certificates >/dev/null
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
  test -f /opt/proxvpn/app/backend/static/index.html || {
    echo "ERROR: bundled frontend (app/backend/static/index.html) missing" >&2
    exit 1
  }
'
msg_ok "App sources in place (/opt/proxvpn, frontend prebuilt)"

msg_info "Setting up Python backend (venv + FastAPI)"
pct exec "$CT_ID" -- bash -ec '
  python3 -m venv /opt/proxvpn/venv
  /opt/proxvpn/venv/bin/pip install --quiet -r /opt/proxvpn/app/backend/requirements.txt
'
msg_ok "Backend venv ready"

# ----------------------- WEB UI PASSWORD -----------------------
UI_PW=$(gen_password)
write_auth_file "$UI_PW"
msg_ok "Web UI password set (printed at the end of this install)"

# ----------------------- KILL SWITCH / UNIT / VERIFY -----------------------
ensure_settings
write_killswitch
msg_info "Installing systemd service (Restart=always, after network-online)"
write_unit
write_watchdog
msg_ok "Service proxvpn enabled and started"

msg_info "Verifying installation"
if ! verify_service; then
  msg_error "Verification failed - full service log follows:"
  pct exec "$CT_ID" -- journalctl -u proxvpn --no-pager -n 60 || true
  exit 1
fi
msg_ok "Service active, Web UI responds on port ${WEB_PORT}"

CT_IP=$(pct exec "$CT_ID" -- hostname -I | awk '{print $1}')
echo
msg_ok "Install complete: http://${CT_IP}:${WEB_PORT}"
echo -e "  ${GN}Web UI password:${CL} ${UI_PW}"
echo -e "  ${YW}Login:${CL} http://${CT_IP}:${WEB_PORT}  (Passwort oben, oder in /etc/proxvpn/auth.json im CT)"
msg_info "Next: paste your ProtonVPN WireGuard config in the Web UI (card 'Setup')."
msg_info "The tunnel auto-reconnects after reboot (wg-quick@${WG_IF} is enabled on config save)."
msg_info "Gateway use: point clients to ${CT_IP} as their default gateway (or add a static route on your router)."
[[ -n "$ALLOW_CIDR" ]] && msg_info "Forwarding is restricted to ${ALLOW_CIDR} (ALLOW_CIDR)."
echo