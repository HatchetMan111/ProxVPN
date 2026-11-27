# ProxVPN Gateway 🛡️

Ein schlanker LXC-Container für Proxmox VE, der als **VPN-Gateway** fungiert:
Native **WireGuard**-Verbindung zu **ProtonVPN**, **permanenter nftables-Kill-Switch**
(ohne Tunnel kein weitergeleiteter Traffic) und eine **React-Web-UI** zum
Verbinden, Trennen und Testen.

- Läuft komplett lokal, keine Cloud-Dienste
- Unprivileged LXC (~1 GB RAM, 4 GB Disk, `onboot: 1`, nesting)
- Web UI auf Port **8090** (bindet `0.0.0.0`)
- systemd-Service mit `Restart=always` nach `network-online.target`
- WireGuard-Interface: `proton` (aus `/etc/wireguard/proton.conf`)
- Tunnel verbindet nach Reboot automatisch neu (`wg-quick@proton`)

## Installation (Einzeiler auf dem Proxmox-Host)

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)"
```

Debug-Installation mit vollem Trace:

```bash
bash -x <(wget -qO- https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)
```

Optionale Variablen vor dem Einzeiler:

| Variable | Default | Bedeutung |
|---|---|---|
| `CT_ID` | nächste freie ID | feste Container-ID |
| `CORES` | 2 | vCPU |
| `RAM` | 1024 | MiB |
| `DISK` | 4 | GiB |
| `BRIDGE` | vmbr0 | Bridge |
| `VLAN` | – | VLAN-Tag (optional) |
| `ROOTFS_STORAGE` | auto | erster lvm-thin, sonst `local-lvm` |

```bash
CT_ID=125 bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)"
```

## Nach der Installation

1. Web UI öffnen: `http://<LXC-IP>:8090`
2. Im ProtonVPN-Dashboard eine **WireGuard-Config** herunterladen
3. In der Web UI unter **Setup** die `.conf` einfügen → speichern (wird validiert, Rechte 600)
4. **Verbinden** → **Test** zeigt die öffentliche IP durch den Tunnel

### Als Gateway nutzen

Clients tragen die LXC-IP als Default-Gateway ein, oder der Router bekommt eine
statische Route über den Container. Der Kill Switch erlaubt Forwarding **nur**
über das WireGuard-Interface, sonst `policy drop`:

```text
table inet proxvpn {
  forward: policy drop; accept nur eth0 <-> proton (plus established)
  postrouting: masquerade oifname "proton"
}
```

⚠️ Die Web UI hat keine Authentifizierung: nur im LAN verwenden bzw. per
Reverse-Proxy mit Basic Auth absichern.

## Architektur

```
ProxVPN/
├── install/proxvpn.sh            # Proxmox-Host-Installer (Community-Script-Stil)
└── app/
    ├── backend/                  # FastAPI (main.py, requirements.txt, systemd-Unit)
    │   └── static/               # gebautes Frontend (entsteht bei der Installation)
    └── frontend/                 # React + Vite (wird im CT gebaut)
```

API-Endpoints:

| Endpoint | Methode | Zweck |
|---|---|---|
| `/api/status` | GET | Tunnel-Status, Kill Switch, Handshake, Transfer |
| `/api/health` | GET | Liveness-Probe |
| `/api/connect` | POST | `wg-quick up proton` (idempotent) |
| `/api/disconnect` | POST | `wg-quick down proton` (idempotent) |
| `/api/test` | POST | Public-IP-Test, gebunden ans Tunnel-Interface |
| `/api/config` | POST | WireGuard-Config speichern (validiert, aktiviert Auto-Reconnect) |
| `/api/logs` | GET | letzte Service-Logzeilen |

Fehler werden immer als **komplette Meldungskette** zurückgegeben
(Command, Exit-Code, stdout, stderr) und im Installer auch im `bash -x`-Trace.

## Update

```bash
pct exec <CT-ID> -- bash -ec '
  wget -qO- https://github.com/HatchetMan111/ProxVPN/archive/refs/heads/main.tar.gz | tar -xz -C /opt/proxvpn --strip-components=1
  cd /opt/proxvpn/app/frontend && npm install --no-audit --no-fund && npm run build
  rm -rf /opt/proxvpn/app/backend/static/*
  cp -r dist/* /opt/proxvpn/app/backend/static/
  /opt/proxvpn/venv/bin/pip install -q -r /opt/proxvpn/app/backend/requirements.txt
  systemctl restart proxvpn'
```

## Deinstallation

```bash
pct stop <CT-ID> && pct destroy <CT-ID> --purge
```

## Getesteter Ablauf (Referenz)

1. Einzeiler auf dem PVE-Host → CT mit nächster freier ID wird erstellt
2. Installer verifiziert selbst: `systemctl is-active proxvpn` + HTTP-Check auf `localhost:8090`
3. `pct reboot <CT-ID>` → `onboot: 1` startet den CT, systemd startet die App nach `network-online.target`,
   `wg-quick@proton` bringt den Tunnel automatisch wieder hoch
4. Web UI wieder erreichbar unter `http://<LXC-IP>:8090`

## License

MIT – siehe [LICENSE](LICENSE).
