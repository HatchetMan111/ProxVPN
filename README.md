# ProxVPN Gateway 🛡️

Ein schlanker LXC-Container für Proxmox VE, der als **VPN-Gateway** fungiert:
Native **WireGuard**-Verbindung zu **ProtonVPN**, **permanenter nftables-Kill-Switch**
(ohne Tunnel kein weitergeleiteter Traffic, IPv4 **und** IPv6) und eine
**React-Web-UI** zum Verbinden, Trennen und Testen – mit Login.

- Läuft komplett lokal, keine Cloud-Dienste
- Unprivileged LXC (~1 GB RAM, 4 GB Disk, `onboot: 1`, nesting)
- Web UI auf Port **8090** (bindet `0.0.0.0`, **Passwort-Login**, Session-Tokens)
- systemd-Service mit `Restart=always` nach `network-online.target`
- WireGuard-Interface: `proton` (aus `/etc/wireguard/proton.conf`)
- Tunnel verbindet nach Reboot automatisch neu (`wg-quick@proton`)
- **Kein Node.js im Container** – das Frontend wird vorab gebaut und mitgeliefert

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
| `ALLOW_CIDR` | – (alle) | nur dieses Subnetz darf das Gateway nutzen (Forwarding) |
| `WEB_PASSWORD` | Zufall | Web-UI-Passwort explizit setzen |
| `NO_IPV6` | 0 | `1` = IPv6-Kill-Switch überspringen |
| `UPDATE` | 0 | `1` = bestehenden Container aktualisieren (Config + Passwort bleiben) |
| `REINSTALL` | 0 | `1` = bestehenden Container löschen und neu bauen |

```bash
CT_ID=125 ALLOW_CIDR=192.168.1.0/24 bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)"
```

Das **Web-UI-Passwort** wird am Ende der Installation ausgegeben (und steht in
`/etc/proxvpn/auth.json` im Container, Rechte 600).

## Nach der Installation

1. Web UI öffnen: `http://<LXC-IP>:8090` → mit dem Installations-Passwort anmelden
2. Im ProtonVPN-Dashboard eine **WireGuard-Config** herunterladen
   (ProtonVPN → Downloads → WireGuard; dort „Create WireGuard configuration“
   mit **UDP 1194/51820** – Port 443/UDP wird von manchen Proton-Servern nicht
   per Standard-WireGuard unterstützt)
3. In der Web UI unter **Setup** die `.conf` einfügen → speichern (wird validiert, Rechte 600)
4. **Verbinden** → **Test** zeigt die öffentliche IP **durch den Tunnel**

### Als Gateway nutzen

Clients tragen die LXC-IP als Default-Gateway ein, oder der Router bekommt eine
statische Route über den Container. Der Kill Switch erlaubt Forwarding **nur**
über das WireGuard-Interface, sonst `policy drop` – für IPv4 und IPv6:

```text
table inet proxvpn {
  forward: policy drop; accept nur eth0 <-> proton (optional: ip saddr <ALLOW_CIDR>)
  postrouting: masquerade oifname "proton"
}
table inet proxvpn6 { forward: policy drop; postrouting: masquerade oifname "proton" }
```

⚠️ Ohne `ALLOW_CIDR` darf **jedes** Gerät im LAN das Gateway als Default-Gateway
setzen. Wenn das nicht gewünscht ist, `ALLOW_CIDR` beim Installieren angeben.

## Was der „Test“ wirklich prüft

`POST /api/test` fragt mehrere IP-Dienste (ipify, ifconfig.me, icanhazip)
**gebunden an das WireGuard-Interface** ab (`curl --interface proton`).
Eine Antwort kann also nur durch den Tunnel kommen – anders als vorher, wo
`api.ipify.org` einfach per Default-Route abgefragt wurde (Timeout 15 s,
identisches Ergebnis bei up und down). Bei getrenntem Tunnel wird zusätzlich
die **direkte** IP angezeigt, damit klar ist, dass der Kill Switch nur
weitergeleiteten Traffic schützt, nicht den Host selbst.

## Update

```bash
UPDATE=1 bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ProxVPN/main/install/proxvpn.sh)"
```

Das aktualisiert App + Backend + Frontend im bestehenden Container, lässt
WireGuard-Config, Passwort und Kill Switch aber unberührt. Alternativ von Hand:

```bash
pct exec <CT-ID> -- bash -ec '
  wget -qO- https://github.com/HatchetMan111/ProxVPN/archive/refs/heads/main.tar.gz | tar -xz -C /opt/proxvpn --strip-components=1
  /opt/proxvpn/venv/bin/pip install -q -r /opt/proxvpn/app/backend/requirements.txt
  systemctl restart proxvpn'
```

## Deinstallation

```bash
pct stop <CT-ID> && pct destroy <CT-ID> --purge
```

## Architektur

```
ProxVPN/
├── install/proxvpn.sh            # Proxmox-Host-Installer (Community-Script-Stil)
├── test/harness.sh               # Offline-Harness (gemockte System-Commands, kein Root)
└── app/
    ├── backend/                  # FastAPI (main.py, requirements.txt, systemd-Unit)
    │   └── static/               # gebautes Frontend (committed, wird nicht im CT gebaut)
    └── frontend/                 # React + Vite (Quelle; Build lokal, siehe .gitignore)
```

API-Endpoints:

| Endpoint | Methode | Zweck |
|---|---|---|
| `/api/status` | GET | Tunnel-Status, Kill Switch, Handshake, Transfer |
| `/api/health` | GET | Liveness-Probe (ohne Login erreichbar) |
| `/api/auth` | GET | ob ein Login nötig ist |
| `/api/login` | POST | Passwort → Session-Token (12 h) |
| `/api/logout` | POST | Session-Token verwerfen |
| `/api/connect` | POST | `wg-quick up proton` (idempotent) |
| `/api/disconnect` | POST | `wg-quick down proton` (idempotent) |
| `/api/test` | POST | Public-IP-Test **durch** das Tunnel-Interface |
| `/api/config` | POST | WireGuard-Config speichern (validiert, Auto-Reconnect) |
| `/api/logs` | GET | letzte Service-Logzeilen |

Fehler werden immer als **komplette Meldungskette** zurückgegeben
(Command, Exit-Code, stdout, stderr) und im Installer auch im `bash -x`-Trace.

## Tests

```bash
bash test/harness.sh     # offline, kein Proxmox, kein Root
```

## Getesteter Ablauf (Referenz)

1. Einzeiler auf dem PVE-Host → CT mit nächster freier ID wird erstellt
2. Installer verifiziert selbst: `systemctl is-active proxvpn` + HTTP-Check auf `/api/health`
3. `pct reboot <CT-ID>` → `onboot: 1` startet den CT, systemd startet die App nach
   `network-online.target`, `wg-quick@proton` bringt den Tunnel automatisch wieder hoch
4. Web UI wieder erreichbar unter `http://<LXC-IP>:8090`, Login mit dem Installations-Passwort

## License

MIT – siehe [LICENSE](LICENSE).