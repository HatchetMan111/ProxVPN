"""ProxVPN Gateway Web UI backend (FastAPI).

Endpoints:
  GET  /api/status      tunnel up/down, kill switch, handshake, transfer
  POST /api/connect     wg-quick up proton (idempotent)
  POST /api/disconnect  wg-quick down proton (idempotent)
  POST /api/test        connectivity test through the tunnel (proxy proof)
  POST /api/config      save pasted ProtonVPN WireGuard config
  GET  /api/logs        last service log lines
  GET  /api/health      lightweight liveness probe
  POST /api/login       exchange password for a session token
  POST /api/logout      drop the current session token

Everything runs locally; no cloud services required.

Auth: when PROXVPN_AUTH_FILE (default /etc/proxvpn/auth.json) exists, every
/api/* route except /api/health and /api/login requires a session token
(Authorization: Bearer <token> or X-ProxVPN-Token). Without the file the UI
stays open (the installer always writes the file and prints the password once).
"""
from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="ProxVPN Gateway", docs_url=None, redoc_url=None)

WG_IF = "proton"  # matches /etc/wireguard/proton.conf
WG_CONF = Path(os.environ.get("PROXVPN_WG_CONF", "/etc/wireguard/proton.conf"))
WG_QUICK = shutil.which("wg-quick") or "wg-quick"
STATIC_DIR = Path(__file__).parent / "static"
AUTH_FILE = Path(os.environ.get("PROXVPN_AUTH_FILE", "/etc/proxvpn/auth.json"))

WEB_PORT = int(os.environ.get("PROXVPN_WEB_PORT", "8090"))
TOKEN_TTL = 12 * 3600  # seconds a session token stays valid

# Paths that stay reachable without a token (login must work to get one)
_OPEN_PATHS = {"/api/health", "/api/login"}


def _run(cmd: list[str], timeout: int = 20) -> tuple[int, str, str]:
    """Run command, return (returncode, stdout, stderr). Never raises."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else ""
        return 124, out, f"timeout after {timeout}s: {' '.join(cmd)}"
    except FileNotFoundError:
        return 127, "", f"command not found: {cmd[0]}"


def _full_chain(rc: int, out: str, err: str, cmd: list[str]) -> dict:
    """Return the complete error chain, never just the last line."""
    return {
        "command": " ".join(cmd),
        "exit_code": rc,
        "stdout": out,
        "stderr": err,
    }


# --------------------------- auth ---------------------------
def _load_auth() -> dict:
    try:
        return json.loads(AUTH_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _tokens() -> dict:
    """Valid, unexpired session tokens: {token: expiry}."""
    now = time.time()
    raw = _load_auth().get("tokens", {})
    return {t: e for t, e in raw.items() if isinstance(e, (int, float)) and e > now}


def _auth_enabled() -> bool:
    return AUTH_FILE.exists()


def _check_auth(request: Request) -> None:
    if not _auth_enabled():
        return
    if request.url.path in _OPEN_PATHS:
        return
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    token = token or request.headers.get("x-proxvpn-token", "").strip()
    if not token or token not in _tokens():
        raise HTTPException(401, "Unauthorized. Login with the gateway password first.")


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    try:
        _check_auth(request)
    except HTTPException as e:
        # FastAPI's HTTPException is not an ExceptionGroup, but the
        # BaseHTTPMiddleware stack of some Starlette versions wraps it.
        return JSONResponse(status_code=e.status_code, content={"detail": e.detail})
    return await call_next(request)


@app.post("/api/login")
def login(body: dict):
    if not _auth_enabled():
        return {"ok": True, "token": None, "auth_enabled": False}
    pw = str(body.get("password", ""))
    expected = str(_load_auth().get("password", ""))
    if not expected or not hmac.compare_digest(pw, expected):
        raise HTTPException(401, "Wrong password.")
    token = secrets.token_urlsafe(32)
    auth = _load_auth()
    auth.setdefault("tokens", {})[token] = time.time() + TOKEN_TTL
    _save_auth(auth)
    return {"ok": True, "token": token, "expires_in": TOKEN_TTL, "auth_enabled": True}


def _save_auth(auth: dict) -> None:
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = AUTH_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(auth))
    tmp.chmod(0o600)
    tmp.replace(AUTH_FILE)


@app.post("/api/logout")
def logout(request: Request):
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    token = token or request.headers.get("x-proxvpn-token", "").strip()
    if token:
        auth = _load_auth()
        auth.get("tokens", {}).pop(token, None)
        _save_auth(auth)
    return {"ok": True}


@app.get("/api/auth")
def auth_state():
    """Whether a login is required (the UI calls this before anything else)."""
    return {"auth_enabled": _auth_enabled()}


# --------------------------- status helpers ---------------------------
def _killswitch_active() -> bool:
    rc, out, _ = _run(["nft", "list", "chain", "inet", "proxvpn", "forward"])
    if rc != 0 or "policy drop" not in out:
        return False
    return WG_IF in out


def _lan_ip() -> str | None:
    rc, out, _ = _run(["ip", "-4", "-o", "addr", "show", "dev", "eth0"])
    if rc != 0:
        return None
    match = re.search(r"inet ([0-9.]+)", out)
    return match.group(1) if match else None


def _wg_status() -> dict:
    show_rc, show_out, show_err = _run(["wg", "show", WG_IF])
    up = show_rc == 0 and bool(show_out)
    endpoint = None
    handshake = None
    transfer = None
    in_peer = False
    for line in show_out.splitlines():
        stripped = line.strip()
        if stripped.startswith("peer:"):
            in_peer = True
        # only trust the first peer block (wg show <if> may list several)
        if in_peer and endpoint is None and stripped.startswith("endpoint:"):
            endpoint = stripped.split(":", 1)[1].strip()
        elif in_peer and handshake is None and stripped.startswith("latest handshake:"):
            handshake = stripped.split(":", 1)[1].strip()
        elif in_peer and transfer is None and stripped.startswith("transfer:"):
            transfer = stripped.split(":", 1)[1].strip()
    try:
        configured = WG_CONF.exists()
    except OSError:  # e.g. unreadable /etc/wireguard
        configured = False
    return {
        "configured": configured,
        "up": up,
        "endpoint": endpoint,
        "latest_handshake": handshake,
        "transfer": transfer,
        "killswitch_active": _killswitch_active(),
        "gateway_ip": _lan_ip(),
        "killswitch_iface": WG_IF,
        "auth_enabled": _auth_enabled(),
        "detail": show_err if show_rc != 0 and "No such device" not in show_err else "",
    }


# --------------------------- routes ---------------------------
@app.get("/api/status")
def status():
    st = _wg_status()
    st["web_port"] = WEB_PORT
    return st


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/connect")
def connect():
    try:
        has_conf = WG_CONF.exists()
    except OSError:
        has_conf = False
    if not has_conf:
        raise HTTPException(400, "No WireGuard config found. Use 'Setup' in the Web UI first.")
    if _wg_status()["up"]:
        return {"ok": True, "already_up": True, **_wg_status()}
    rc, out, err = _run([WG_QUICK, "up", WG_IF], timeout=45)
    if rc != 0:
        return JSONResponse(
            status_code=500,
            content={
                "error": "wg-quick up failed",
                **_full_chain(rc, out, err, [WG_QUICK, "up", WG_IF]),
                "wg_show": _wg_status(),
            },
        )
    return {"ok": True, **_wg_status()}


@app.post("/api/disconnect")
def disconnect():
    if not _wg_status()["up"]:
        return {"ok": True, "already_down": True, **_wg_status()}
    rc, out, err = _run([WG_QUICK, "down", WG_IF], timeout=45)
    if rc != 0:
        return JSONResponse(
            status_code=500,
            content={
                "error": "wg-quick down failed",
                **_full_chain(rc, out, err, [WG_QUICK, "down", WG_IF]),
            },
        )
    return {"ok": True, **_wg_status()}


@app.post("/api/test")
def test():
    """Prove that traffic really leaves through the tunnel.

    Strategy (no external dependency on a single service):
      1. Ask ipify through the tunnel interface (bound via --interface).
      2. If that fails, ask ifconfig.me / icanhazip.com through the tunnel.
      3. If the tunnel is down, report that honestly and show the direct IP
         (which the kill switch does not block for the host itself).
    The answer is trustworthy because curl is bound to the WireGuard
    interface, so a success can only come through the tunnel.
    """
    st = _wg_status()
    probes = []
    if st["up"]:
        for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"):
            rc, out, err = _run(
                ["curl", "-fsS", "-m", "8", "--interface", WG_IF, url], timeout=12
            )
            probes.append({"url": url, "ok": rc == 0, "ip": out if rc == 0 else None,
                           "error": None if rc == 0 else (err or f"exit {rc}")})
            if rc == 0:
                break
        via_tunnel = next((p["ip"] for p in probes if p["ok"]), None)
    else:
        via_tunnel = None
    rc, direct, err = _run(["curl", "-fsS", "-m", "8", "https://api.ipify.org"], timeout=12)
    return {
        "tunnel_up": st["up"],
        "killswitch_active": st["killswitch_active"],
        "public": {
            "reachable": bool(via_tunnel),
            "ip": via_tunnel,
            "via": "tunnel" if via_tunnel else None,
            "probes": probes,
            "direct_ip": direct if rc == 0 else None,
            "direct_error": None if rc == 0 else (err or f"exit {rc}"),
        },
        "verdict": (
            "traffic leaves through the tunnel"
            if via_tunnel
            else "no answer through the tunnel - tunnel down or peer unreachable"
        ),
    }


@app.post("/api/config")
def save_config(body: dict):
    conf = body.get("config", "").strip()
    if not conf or "[Interface]" not in conf or "[Peer]" not in conf:
        raise HTTPException(400, "Config does not look like a WireGuard config ([Interface]/[Peer] missing).")
    if "PrivateKey" not in conf:
        raise HTTPException(400, "Config has no PrivateKey.")
    try:
        WG_CONF.parent.mkdir(parents=True, exist_ok=True)
        WG_CONF.write_text(conf + "\n")
        WG_CONF.chmod(0o600)
        rc, out, err = _run([WG_QUICK, "strip", str(WG_CONF)])
        if rc != 0:
            WG_CONF.unlink(missing_ok=True)
            raise HTTPException(400, f"wg-quick rejected the config: {err}")
        # Auto-reconnect after reboot (idempotent; harmless without tunnel up)
        _run(["systemctl", "enable", f"wg-quick@{WG_IF}"])
    except PermissionError as e:
        raise HTTPException(500, f"Cannot write {WG_CONF}: {e}")
    return {"ok": True, "saved": str(WG_CONF), "auto_reconnect": True}


@app.get("/api/logs")
def logs():
    rc, out, err = _run(["journalctl", "-u", "proxvpn", "-n", "100", "--no-pager"])
    return {"logs": out or err}


@app.get("/")
def index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({"error": "frontend not built"}, status_code=500)


_assets = STATIC_DIR / "assets"
_assets.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")