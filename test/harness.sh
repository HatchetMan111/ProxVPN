#!/usr/bin/env bash
# Offline harness for ProxVPN: no Proxmox host, no network, no root.
# Runs the FastAPI backend with mocked system commands and checks the
# installer's static invariants.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  [ok] $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  [FAIL] $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "== 1. Python syntax =="
python3 -c "import fastapi" 2>/dev/null || { echo "  [skip] fastapi missing - pip install -r app/backend/requirements.txt httpx"; exit 0; }
python3 -m py_compile "$REPO/app/backend/main.py" 2>/dev/null && ok "main.py compiles" || bad "main.py compiles"

echo "== 2. Installer static invariants =="
bash -n "$REPO/install/proxvpn.sh" && ok "installer parses" || bad "installer parses"
grep -q 'UPDATE=1' "$REPO/install/proxvpn.sh" && ok "UPDATE mode documented" || bad "UPDATE mode documented"
grep -q 'app/backend/static/index.html' "$REPO/install/proxvpn.sh" && ok "installer verifies prebuilt frontend" || bad "installer verifies prebuilt frontend"
grep -q 'nodejs npm' "$REPO/install/proxvpn.sh" && bad "installer still installs nodejs/npm" || ok "no Node in CT"
grep -q 'Web UI password' "$REPO/install/proxvpn.sh" && ok "installer prints UI password" || bad "installer prints UI password"
grep -q 'proxvpn6' "$REPO/install/proxvpn.sh" && ok "IPv6 kill switch present" || bad "IPv6 kill switch present"
grep -q 'ALLOW_CIDR' "$REPO/install/proxvpn.sh" && ok "ALLOW_CIDR forwarding limit present" || bad "ALLOW_CIDR forwarding limit present"
grep -q 'write_auth_file' "$REPO/install/proxvpn.sh" && ok "auth file written via argv (stdin-safe)" || bad "auth file written via argv"
grep -q 'write_killswitch' "$REPO/install/proxvpn.sh" && ok "kill switch shared by install+update" || bad "kill switch shared by install+update"
grep -q 'PROXVPN_WEB_PORT' "$REPO/install/proxvpn.sh" && ok "unit exports PROXVPN_WEB_PORT" || bad "unit exports PROXVPN_WEB_PORT"
test -f "$REPO/app/backend/static/index.html" && ok "dist committed" || bad "dist committed"
grep -q 'proxvpn_token' "$REPO/app/frontend/src/App.jsx" && ok "frontend login gate present" || bad "frontend login gate present"

echo "== 3. Backend behaviour (mocked) =="
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/etc"
cat > "$TMP/bin/wg" <<'EOF'
#!/bin/bash
if [[ "$1" == "show" ]]; then
  [[ -f "$MOCK_WG_UP" ]] || { echo "Unable to access interface: No such device" >&2; exit 1; }
  cat <<'OUT'
interface: proton
  public key: abc
  private key: (hidden)
  listening port: 51820
peer: xyz
  endpoint: 1.2.3.4:51820
  allowed ips: 0.0.0.0/0
  latest handshake: 30 seconds ago
  transfer: 1.2 GiB received, 300 MiB sent
OUT
fi
EOF
cat > "$TMP/bin/nft" <<'EOF'
#!/bin/bash
[[ "$1" == "list" ]] && { echo "chain forward { type filter hook forward priority 0; policy drop; iifname \"eth0\" oifname \"proton\" accept }"; exit 0; }
exit 0
EOF
cat > "$TMP/bin/ip" <<'EOF'
#!/bin/bash
echo '2: eth0    inet 10.120.1.135/24 brd 10.120.1.255 scope global eth0'
EOF
cat > "$TMP/bin/wg-quick" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/bash
# bind to tunnel interface? then simulate a tunnel answer
for a in "$@"; do [[ "$a" == "--interface" ]] && { echo "203.0.113.7"; exit 0; }; done
echo "198.51.100.9"
EOF
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
export MOCK_WG_UP="$TMP/wg.up"; touch "$MOCK_WG_UP"
export PROXVPN_AUTH_FILE="$TMP/etc/auth.json"
export PROXVPN_WG_CONF="$TMP/wg/proton.conf"; mkdir -p "$TMP/wg"
export PROXVPN_WEB_PORT=8090

python3 - "$REPO/app/backend" <<'PY' || bad "backend test run"
import importlib.util, json, sys, pathlib
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("proxvpn_main", sys.argv[1] + "/main.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
fails = []
def ck(name, cond):
    print(("  [ok] " if cond else "  [FAIL] ") + name)
    if not cond: fails.append(name)

from fastapi.testclient import TestClient
c = TestClient(m.app)

# --- open mode (no auth file yet) ---
r = c.get("/api/status"); ck("status 200 without auth", r.status_code == 200)
st = r.json()
ck("status shows tunnel up", st["up"] is True)
ck("status shows killswitch active", st["killswitch_active"] is True)
ck("status shows gateway ip", st["gateway_ip"] == "10.120.1.135")
ck("status shows endpoint", st["endpoint"] == "1.2.3.4:51820")
ck("health open", c.get("/api/health").json() == {"ok": True})

r = c.post("/api/test"); ck("test 200", r.status_code == 200)
t = r.json()
ck("test verdict tunnel", "tunnel" in t["verdict"])
ck("test public ip from tunnel", t["public"]["ip"] == "203.0.113.7")
ck("test marks via=tunnel", t["public"]["via"] == "tunnel")

r = c.post("/api/config", json={"config": "nope"}); ck("bad config rejected 400", r.status_code == 400)
r = c.post("/api/config", json={"config": "[Interface]\nPrivateKey = x\n[Peer]\nPublicKey = y"}); ck("good config accepted", r.status_code == 200)

r = c.post("/api/connect"); ck("connect ok", r.status_code == 200 and r.json()["ok"])
r = c.post("/api/disconnect"); ck("disconnect ok", r.status_code == 200)

# --- auth mode ---
m.AUTH_FILE.write_text(json.dumps({"password": "secret123", "tokens": {}}))
c2 = TestClient(m.app)
ck("api blocked without token", c2.get("/api/status").status_code == 401)
ck("health still open", c2.get("/api/health").status_code == 200)
ck("login wrong pw 401", c2.post("/api/login", json={"password": "x"}).status_code == 401)
r = c2.post("/api/login", json={"password": "secret123"})
ck("login ok", r.status_code == 200 and r.json().get("token"))
if r.status_code != 200:
    print("   login response:", r.status_code, r.text[:300]); sys.exit(1)
tok = r.json()["token"]
ck("api with token 200", c2.get("/api/status", headers={"Authorization": f"Bearer {tok}"}).status_code == 200)
ck("api with wrong token 401", c2.get("/api/status", headers={"Authorization": "Bearer nope"}).status_code == 401)
r = c2.post("/api/logout", headers={"Authorization": f"Bearer {tok}"})
ck("logout ok", r.status_code == 200)
ck("token dead after logout", c2.get("/api/status", headers={"Authorization": f"Bearer {tok}"}).status_code == 401)
ck("auth file mode 600", oct(m.AUTH_FILE.stat().st_mode)[-3:] == "600")

# --- tunnel down path ---
import os; os.environ["MOCK_WG_UP"] = "/nonexistent"
st = m._wg_status(); ck("wg down reported", st["up"] is False)
m.WG_CONF.unlink(missing_ok=True)   # token was consumed by the logout test above
tok2 = c2.post("/api/login", json={"password": "secret123"}).json()["token"]
r = c2.post("/api/test", headers={"Authorization": f"Bearer {tok2}"})
if r.status_code != 200:
    print("   test response:", r.status_code, r.text[:300]); sys.exit(1)
t = r.json()
ck("test down verdict honest", "no answer" in t["verdict"] or not t["public"]["reachable"])

if fails:
    print(f"  {len(fails)} backend checks failed"); sys.exit(1)
print("  all backend checks passed")
PY
[[ $? -eq 0 ]] && ok "backend suite passed" || true

echo
echo "RESULT: $PASS ok, $FAIL failed"
[[ $FAIL -eq 0 ]]