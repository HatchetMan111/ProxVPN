"""ProxVPN Gateway Web UI backend (FastAPI).

Endpoints:
  GET  /api/status      tunnel up/down, kill switch, handshake, transfer
  POST /api/connect     wg-quick up proton (idempotent)
  POST /api/disconnect  wg-quick down proton (idempotent)
  POST /api/test        connectivity test through the tunnel
  POST /api/config      save pasted ProtonVPN WireGuard config
  GET  /api/logs        last service log lines
  GET  /api/health      lightweight liveness probe

Everything runs locally; no cloud services required.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="ProxVPN Gateway", docs_url=None, redoc_url=None)

WG_IF = "proton"  # matches /etc/wireguard/proton.conf
WG_CONF = Path("/etc/wireguard/proton.conf")
WG_QUICK = shutil.which("wg-quick") or "wg-quick"
STATIC_DIR = Path(__file__).parent / "static"


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


def _killswitch_active() -> bool:
    rc, out, _ = _run(["nft", "list", "chain", "inet", "proxvpn", "forward"])
    return rc == 0 and "policy drop" in out and WG_IF in out


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
    for line in show_out.splitlines():
        if line.startswith("endpoint:"):
            endpoint = line.split(":", 1)[1].strip()
        elif line.startswith("latest handshake:"):
            handshake = line.split(":", 1)[1].strip()
        elif line.startswith("transfer:"):
            transfer = line.split(":", 1)[1].strip()
    return {
        "configured": WG_CONF.exists(),
        "up": up,
        "endpoint": endpoint,
        "latest_handshake": handshake,
        "transfer": transfer,
        "killswitch_active": _killswitch_active(),
        "gateway_ip": _lan_ip(),
        "killswitch_iface": WG_IF,
        "detail": show_err if show_rc != 0 and "No such device" not in show_err else "",
    }


def _public_ip(bind_iface: str | None = None) -> dict:
    cmd = ["curl", "-fsS", "-m", "15", "https://api.ipify.org"]
    if bind_iface:
        cmd += ["--interface", bind_iface]
    rc, out, err = _run(cmd, timeout=25)
    return {"reachable": rc == 0, "ip": out if rc == 0 else None, "error": err or None}


@app.get("/api/status")
def status():
    st = _wg_status()
    st["web_port"] = 8090
    return st


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/connect")
def connect():
    if not WG_CONF.exists():
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
    """Test that traffic actually leaves through the tunnel.

    When the tunnel is up, curl binds to the WireGuard interface, so a
    positive result proves the path through the VPN. When it is down, the
    kill switch already blocks forwarded traffic; we report that state.
    """
    st = _wg_status()
    pub = _public_ip(bind_iface=WG_IF if st["up"] else None)
    return {
        "tunnel_up": st["up"],
        "killswitch_active": st["killswitch_active"],
        "public": pub,
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
