#!/usr/bin/env python3
"""ProxVPN tunnel watchdog.

Runs as a systemd timer (every 60 s). If the WireGuard interface exists but
has not handshaked for more than MAX_AGE seconds, the tunnel is restarted
once - that heals dead NAT mappings / stale paths without touching a tunnel
the user intentionally disconnected (interface down = deliberate choice).
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

WG_IF = "proton"
MAX_AGE = 180  # seconds without handshake before we restart the tunnel
SETTINGS_FILE = Path(os.environ.get("PROXVPN_SETTINGS_FILE", "/etc/proxvpn/settings.json"))


def run(cmd: list[str], timeout: int = 30) -> tuple[int, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return 127, ""


def main() -> None:
    try:
        settings = json.loads(SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        settings = {}
    if not settings.get("watchdog", True):
        return

    rc, out = run(["wg", "show", WG_IF, "latest-handshakes"])
    if rc != 0 or not out:
        return  # interface down: the user disconnected it on purpose
    try:
        handshake_ts = int(out.splitlines()[0].split()[-1])
    except (IndexError, ValueError):
        return
    if handshake_ts <= 0:
        age = 10**9  # never handshaked at all
    else:
        age = time.time() - handshake_ts
    if age > MAX_AGE:
        run(["systemctl", "restart", f"wg-quick@{WG_IF}"])


if __name__ == "__main__":
    main()