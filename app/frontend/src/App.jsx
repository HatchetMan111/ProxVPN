import { useEffect, useState, useCallback, useRef } from 'react'

const TOKEN_KEY = 'proxvpn_token'

const getToken = () => localStorage.getItem(TOKEN_KEY) || ''

const api = (path, opts = {}) => {
  const token = getToken()
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`/api/${path}`, { ...opts, headers }).then(async (r) => {
    const body = await r.json().catch(() => ({}))
    if (r.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      // 'auth' is the pre-login probe - reloading on its 401 would loop forever
      if (!path.startsWith('login') && !path.startsWith('auth')) window.location.reload()
    }
    if (!r.ok) throw { status: r.status, detail: body.detail, ...body }
    return body
  })
}

let toastSeq = 0

/* ---------- small building blocks ---------- */

function Card({ title, icon, children, accent, wide, right }) {
  return (
    <div className={'card' + (accent ? ' accent' : '') + (wide ? ' wide' : '')}>
      {title && (
        <h2>
          {icon && <span className="ico">{icon}</span>}
          {title}
          {right && <span className="card-right">{right}</span>}
        </h2>
      )}
      {children}
    </div>
  )
}

function Led({ tone, pulse }) {
  return <span className={'led ' + tone + (pulse ? ' pulse' : '')} />
}

function Tile({ label, tone, pulse, value, sub, mono = true }) {
  return (
    <div className={'tile ' + (tone || '')}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {tone && <Led tone={tone} pulse={pulse} />}
        <span className={mono ? 'mono' : ''}>{value ?? '—'}</span>
      </span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  )
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="toggle-row">
      <span className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="knob" />
      </span>
      <span className="toggle-text">
        <strong>{label}</strong>
        {hint && <em>{hint}</em>}
      </span>
    </label>
  )
}

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/* Live diagram: LAN -> ProxVPN -> Internet(Proton).
   green = traffic flows through the tunnel, red = kill switch blocks,
   amber = kill switch off, traffic leaves unfiltered. */
function NetworkMap({ up, kill, unconfigured }) {
  const flow = !!up
  const blocked = !up && !!kill
  const direct = !up && !kill
  const hubNote = unconfigured
    ? 'keine Config'
    : flow
      ? 'Tunnel aktiv'
      : blocked
        ? 'blockiert'
        : 'direkt'
  return (
    <svg viewBox="0 0 680 118" className="netmap" role="img" aria-label="Netzwerk-Diagramm">
      {/* LAN node */}
      <g>
        <rect x="16" y="26" width="168" height="66" rx="14" className={'node' + (flow ? ' live' : '')} />
        <text x="100" y="52" textAnchor="middle" className="node-emoji">🏠</text>
        <text x="100" y="74" textAnchor="middle" className="node-label">LAN-Clients</text>
      </g>
      {/* ProxVPN hub */}
      <g>
        <rect x="256" y="16" width="168" height="86" rx="14" className={'node hub ' + (flow ? ' ok' : blocked ? ' bad' : ' warn')} />
        <text x="340" y="46" textAnchor="middle" className="node-emoji">🛡️</text>
        <text x="340" y="68" textAnchor="middle" className="node-label">ProxVPN Gateway</text>
        <text x="340" y="88" textAnchor="middle" className={'node-note ' + (flow ? 'ok' : blocked ? 'bad' : 'warn')}>{hubNote}</text>
      </g>
      {/* Internet node */}
      <g>
        <rect x="496" y="26" width="168" height="66" rx="14" className={'node' + (flow ? ' live' : '')} />
        <text x="580" y="52" textAnchor="middle" className="node-emoji">🌐</text>
        <text x="580" y="74" textAnchor="middle" className="node-label">Internet · ProtonVPN</text>
      </g>
      {/* LAN -> CT */}
      <line x1="184" y1="59" x2="256" y2="59" className={'link ' + (flow ? ' ok' : ' dim')} />
      <circle cx="220" cy="59" r="3" className={'pkg ' + (flow ? 'ok' : 'dim')} />
      {/* CT -> Internet */}
      <line x1="424" y1="59" x2="496" y2="59"
        className={'link ' + (flow ? ' ok flow' : blocked ? ' bad block' : direct ? ' warn flow' : ' dim')} />
      {blocked && (
        <g>
          <line x1="446" y1="49" x2="474" y2="69" className="xmark" />
          <line x1="446" y1="69" x2="474" y2="49" className="xmark" />
        </g>
      )}
    </svg>
  )
}

function Toasts({ items }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={'toast ' + t.type}>{t.msg}</div>
      ))}
    </div>
  )
}

/* ---------- login ---------- */

function Login({ onDone }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await api('login', { method: 'POST', body: JSON.stringify({ password: pw }) })
      if (r.token) localStorage.setItem(TOKEN_KEY, r.token)
      setPw('')
      onDone()
    } catch (e2) {
      setErr(e2)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wrap narrow">
      <header className="brand-head">
        <span className="logo">🛡️</span>
        <h1>ProxVPN Gateway</h1>
        <p className="sub">Anmeldung erforderlich</p>
      </header>
      <div className="card login-card">
        <p className="sub">
          Das Passwort wurde bei der Installation im Proxmox-Log ausgegeben
          („Web UI password“). Es steht in <code>/etc/proxvpn/auth.json</code> im Container.
        </p>
        <form onSubmit={submit} className="login-form">
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Passwort"
            autoFocus
          />
          <button className="btn primary" disabled={busy || !pw} type="submit">
            {busy ? <span className="spin" /> : 'Anmelden'}
          </button>
        </form>
        {err && (
          <div className="card error inline">
            <pre>{typeof err.detail === 'string' ? err.detail : JSON.stringify(err, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- dashboard ---------- */

export default function App() {
  const [auth, setAuth] = useState(null)
  const [status, setStatus] = useState(null)
  const [test, setTest] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [showSetup, setShowSetup] = useState(false)
  const [conf, setConf] = useState('')
  const [logs, setLogs] = useState(null)
  const [showLogs, setShowLogs] = useState(false)
  const [toasts, setToasts] = useState([])
  const toastId = useRef(0)

  const [settings, setSettings] = useState(null)
  const [savedSettings, setSavedSettings] = useState(null)
  const [settingsError, setSettingsError] = useState(false)
  const [stats, setStats] = useState(null)
  const [dnsTest, setDnsTest] = useState(null)

  const toast = useCallback((msg, type = 'ok') => {
    const id = ++toastSeq.current
    setToasts((t) => [...t, { id, msg, type }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('status'))
      setError(null)
    } catch (e) {
      setError(e)
    }
    try {
      setStats(await api('stats'))
    } catch {
      /* stats are optional */
    }
  }, [])

  const loadSettings = useCallback(async () => {
    setSettingsError(false)
    try {
      const s = await api('settings')
      setSavedSettings(s)
      setSettings({ ...s, _dns: (s.dns_servers || []).join(', ') })
    } catch {
      setSettingsError(true)
    }
  }, [])

  useEffect(() => {
    api('auth')
      .then((r) => setAuth(!!r.auth_enabled))
      .catch(() => setAuth(false))
  }, [])

  useEffect(() => {
    if (auth !== false) return
    refresh()
    loadSettings()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [auth, refresh, loadSettings])

  const action = async (name, label) => {
    setBusy(name)
    setError(null)
    try {
      setStatus(await api(name, { method: 'POST' }))
      toast(label + ' erfolgreich')
    } catch (e) {
      setError(e)
      toast(label + ' fehlgeschlagen', 'bad')
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const runTest = async () => {
    setBusy('test')
    setTest(null)
    setError(null)
    try {
      const r = await api('test', { method: 'POST' })
      setTest(r)
      toast(r.public?.reachable ? 'Tunnel-Test bestanden' : 'Kein Traffic durch den Tunnel', r.public?.reachable ? 'ok' : 'warn')
    } catch (e) {
      setError(e)
      toast('Test fehlgeschlagen', 'bad')
    } finally {
      setBusy(null)
    }
  }

  const saveConf = async () => {
    setBusy('config')
    setError(null)
    try {
      await api('config', { method: 'POST', body: JSON.stringify({ config: conf }) })
      setShowSetup(false)
      setConf('')
      toast('WireGuard-Config gespeichert – Auto-Reconnect aktiv')
      await refresh()
    } catch (e) {
      setError(e)
      toast('Config wurde abgelehnt', 'bad')
    } finally {
      setBusy(null)
    }
  }

  const saveSettings = async () => {
    setBusy('settings')
    setError(null)
    try {
      const dns = (settings._dns || '').split(',').map((x) => x.trim()).filter(Boolean)
      const r = await api('settings', {
        method: 'POST',
        body: JSON.stringify({
          killswitch: !!settings.killswitch,
          watchdog: !!settings.watchdog,
          dns_servers: dns,
          allow_cidr: settings.allow_cidr || '',
        }),
      })
      setSavedSettings(r.settings)
      setSettings({ ...r.settings, _dns: (r.settings.dns_servers || []).join(', ') })
      toast('Einstellungen übernommen – Firewall neu aufgebaut')
      await refresh()
    } catch (e) {
      setError(e)
      toast('Einstellungen abgelehnt: ' + (typeof e.detail === 'string' ? e.detail : 'API-Fehler'), 'bad')
    } finally {
      setBusy(null)
    }
  }

  const runDnsTest = async () => {
    setBusy('dnstest')
    setDnsTest(null)
    try {
      const r = await api('dnstest', { method: 'POST' })
      setDnsTest(r.results)
      const allOk = r.results.length > 0 && r.results.every((x) => x.ok)
      toast(allOk ? 'Alle DNS-Server erreichbar' : 'Nicht alle DNS-Server erreichbar', allOk ? 'ok' : 'warn')
    } catch {
      toast('DNS-Test fehlgeschlagen', 'bad')
    } finally {
      setBusy(null)
    }
  }

  const loadLogs = async () => {
    setBusy('logs')
    try {
      setLogs((await api('logs')).logs)
      setShowLogs(true)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const logout = async () => {
    try {
      await api('logout', { method: 'POST' })
    } catch {
      /* ignore */
    }
    localStorage.removeItem(TOKEN_KEY)
    window.location.reload()
  }

  if (auth === null) return <div className="wrap"><p className="sub">Lade…</p></div>
  if (auth === true && !getToken()) return <Login onDone={() => setAuth(false)} />

  const up = status?.up
  const kill = status?.killswitch_active
  const authOn = status?.auth_enabled || auth === true
  const pub = test?.public
  const unconfigured = status?.configured === false
  const counters = stats?.counters || {}
  const dirty = settings && savedSettings && (
    settings.killswitch !== savedSettings.killswitch ||
    settings.watchdog !== savedSettings.watchdog ||
    (settings._dns || '') !== (savedSettings.dns_servers || []).join(', ') ||
    (settings.allow_cidr || '') !== (savedSettings.allow_cidr || '')
  )

  return (
    <div className="wrap">
      <header className="bar">
        <div className="brand">
          <span className="logo">🛡️</span>
          <div>
            <h1>ProxVPN Gateway</h1>
            <p className="sub">WireGuard · ProtonVPN · Kill Switch</p>
          </div>
        </div>
        <div className="bar-right">
          <span className={'badge ' + (kill ? 'ok' : 'bad')}>
            {kill ? 'Kill Switch aktiv' : 'Kill Switch AUS'}
          </span>
          {authOn && (
            <button className="btn ghost" onClick={logout}>Abmelden</button>
          )}
        </div>
      </header>

      {error && (
        <div className="card error slim">
          <pre>{typeof error.detail === 'string' ? error.detail : JSON.stringify(error, null, 2)}</pre>
        </div>
      )}

      {/* ===== status panel: diagram + tiles ===== */}
      <div className="panel">
        <div className={'panel-top ' + (up ? 'ok' : kill ? 'bad' : 'warn')}>
          <div className="panel-headline">
            <span className={'dot ' + (up ? 'ok pulse' : 'bad')} />
            <div>
              <div className={'hero-title ' + (up ? 'ok' : 'bad')}>
                {up ? 'Tunnel aktiv' : 'Tunnel getrennt'}
              </div>
              <div className="sub">
                {unconfigured
                  ? 'Noch keine ProtonVPN-Config hinterlegt – unten einfügen.'
                  : up
                    ? 'Gesamter Client-Traffic läuft verschlüsselt über ProtonVPN.'
                    : kill
                      ? 'Kill Switch blockiert weitergeleiteten Traffic.'
                      : 'Kill Switch aus – Traffic geht ungeschützt direkt ins Internet.'}
              </div>
            </div>
            <div className="btns">
              <button className="btn primary" disabled={busy !== null || !status?.configured || up} onClick={() => action('connect', 'Verbinden')}>
                {busy === 'connect' ? <span className="spin" /> : '▶ Verbinden'}
              </button>
              <button className="btn danger" disabled={busy !== null || !up} onClick={() => action('disconnect', 'Trennen')}>
                {busy === 'disconnect' ? <span className="spin" /> : '■ Trennen'}
              </button>
              <button className="btn" disabled={busy !== null} onClick={runTest}>
                {busy === 'test' ? <span className="spin" /> : '🧪 Test'}
              </button>
            </div>
          </div>
          <NetworkMap up={up} kill={kill} unconfigured={unconfigured} />
        </div>
        <div className="tiles">
          <Tile
            label="Tunnel"
            tone={up ? 'ok' : 'bad'}
            pulse={up}
            value={up ? 'Verbunden' : 'Getrennt'}
            sub={status?.endpoint || 'kein Endpoint'}
          />
          <Tile
            label="Kill Switch"
            tone={kill ? 'ok' : 'bad'}
            value={kill ? 'aktiv' : 'aus'}
            sub={kill ? 'Drop ohne Tunnel' : 'LAN-Traffic ungeschützt'}
          />
          <Tile
            label="Öffentliche IP"
            tone={pub?.reachable ? 'ok' : undefined}
            value={pub?.ip ?? '—'}
            sub={pub?.ip ? 'via Tunnel' : 'erst nach Test'}
          />
          <Tile
            label="Letzter Handshake"
            value={status?.latest_handshake ?? '—'}
            sub="WireGuard-Peer"
          />
          <Tile label="Gateway-IP im LAN" value={status?.gateway_ip ?? '—'} sub="für Clients" />
          <Tile
            label="DNS-Bypass"
            value={(savedSettings?.dns_servers || []).length
              ? savedSettings.dns_servers.join(', ')
              : 'keiner'}
            sub="AdGuard/Pi-hole direkt"
            mono={false}
          />
          <Tile
            label="Tunnel-Forward"
            value={counters.tunnel_fwd ? `${fmtBytes(counters.tunnel_fwd.bytes)}` : '—'}
            sub={counters.tunnel_fwd ? `${counters.tunnel_fwd.packets} Pakete` : 'keine Daten'}
          />
          <Tile
            label="DNS-Forward"
            value={counters.dns ? `${fmtBytes(counters.dns.bytes)}` : '—'}
            sub={counters.dns ? `${counters.dns.packets} Pakete` : 'keine Daten'}
          />
        </div>
      </div>

      <div className="grid">
        {/* ===== firewall ===== */}
        <Card
          title="Firewall & Einstellungen"
          icon="🧯"
          accent={dirty}
          right={dirty ? <span className="warn tiny">ungenom.</span> : null}
        >
          {settingsError ? (
            <div className="stat">
              <p className="bad">Einstellungen konnten nicht geladen werden.</p>
              <button className="btn" onClick={loadSettings}>Erneut versuchen</button>
            </div>
          ) : settings ? (
            <>
              <h3 className="sec">Schutz</h3>
              <Toggle
                checked={!!settings.killswitch}
                onChange={(v) => setSettings({ ...settings, killswitch: v })}
                label="Kill Switch"
                hint="Aus = bei getrenntem Tunnel geht LAN-Traffic direkt ins Internet (ungeschützt)."
              />
              <Toggle
                checked={!!settings.watchdog}
                onChange={(v) => setSettings({ ...settings, watchdog: v })}
                label="Tunnel-Watchdog"
                hint="Startet den Tunnel neu, wenn der Handshake über 3 Min. stillsteht."
              />
              <h3 className="sec">DNS · AdGuard / Pi-hole</h3>
              <label className="field">
                <span>DNS-IPs, kommagetrennt – Port 53 dorthin umgeht den Kill Switch immer (Schritt-für-Schritt in der Anleitung unten)</span>
                <input
                  type="text"
                  value={settings._dns || ''}
                  onChange={(e) => setSettings({ ...settings, _dns: e.target.value })}
                  placeholder="z. B. 192.168.1.111"
                />
              </label>
              {dnsTest && (
                <div className="dnstest">
                  {dnsTest.map((r) => (
                    <div key={r.server} className={'dnstest-row ' + (r.ok ? 'ok' : 'bad')}>
                      <Led tone={r.ok ? 'ok' : 'bad'} />
                      <span className="mono">{r.server}</span>
                      <span className="dim">{r.ok ? `erreichbar · ${r.ms} ms` : r.error}</span>
                    </div>
                  ))}
                </div>
              )}
              <h3 className="sec">Zugriff</h3>
              <label className="field">
                <span>Nur dieses Subnetz darf das Gateway nutzen (CIDR, leer = alle Geräte)</span>
                <input
                  type="text"
                  value={settings.allow_cidr || ''}
                  onChange={(e) => setSettings({ ...settings, allow_cidr: e.target.value })}
                  placeholder="z. B. 192.168.1.0/24"
                />
              </label>
              <div className="btns">
                <button className="btn primary" disabled={busy !== null} onClick={saveSettings}>
                  {busy === 'settings' ? <span className="spin" /> : '💾 Anwenden'}
                </button>
                <button className="btn" disabled={busy !== null || !(settings.dns_servers || []).length} onClick={runDnsTest}>
                  {busy === 'dnstest' ? <span className="spin" /> : '🔍 DNS-Test'}
                </button>
              </div>
            </>
          ) : (
            <p className="sub">Lade Einstellungen…</p>
          )}
        </Card>

        {/* ===== tunnel test ===== */}
        <Card title="Verbindungstest" icon="🧪">
          {test ? (
            <div className="stat">
              <p>
                <strong className={pub?.reachable ? 'ok' : 'bad'}>{test.verdict}</strong>
              </p>
              {pub?.ip && (
                <p>
                  Öffentliche IP (über Tunnel): <strong className="mono">{pub.ip}</strong>
                </p>
              )}
              {!pub?.reachable && (
                <>
                  {pub?.direct_ip && (
                    <p className="warn">
                      Direkte IP (ohne Tunnel): <strong className="mono">{pub.direct_ip}</strong> – der
                      Kill Switch schützt nur weitergeleiteten Traffic, nicht den Host selbst.
                    </p>
                  )}
                  {(pub?.probes || []).map((p, i) => (
                    <pre key={i} className="warn">{p.url}: {p.error}</pre>
                  ))}
                  {!pub?.direct_ip && pub?.direct_error && (
                    <p className="bad">Auch direkt kein Internet: {pub.direct_error}</p>
                  )}
                </>
              )}
              <p className="sub">
                Tunnel: {test.tunnel_up ? 'up' : 'down'} · Kill Switch: {test.killswitch_active ? 'aktiv' : 'aus'}
              </p>
            </div>
          ) : (
            <p className="sub">
              „Test“ fragt mehrere IP-Dienste <em>über das Tunnel-Interface</em> ab – eine Antwort
              kann nur durch den Tunnel kommen. Ergebnis landet oben bei „Öffentliche IP“.
            </p>
          )}
        </Card>

        {/* ===== setup ===== */}
        <Card title="WireGuard-Setup" icon="⚙️" accent={unconfigured}>
          <p className="sub">
            ProtonVPN → Downloads → WireGuard-Config (.conf) kopieren und hier einfügen. Landet als
            <code>/etc/wireguard/proton.conf</code> (Rechte 600, validiert, Auto-Reconnect nach Reboot).
          </p>
          {showSetup ? (
            <>
              <textarea
                rows="8"
                value={conf}
                onChange={(e) => setConf(e.target.value)}
                placeholder={'[Interface]\nPrivateKey = ...'}
                autoFocus
              />
              <div className="btns">
                <button className="btn primary" disabled={busy !== null || !conf.trim()} onClick={saveConf}>
                  {busy === 'config' ? <span className="spin" /> : '💾 Speichern'}
                </button>
                <button className="btn ghost" disabled={busy !== null} onClick={() => setShowSetup(false)}>Abbrechen</button>
              </div>
            </>
          ) : (
            <button className="btn primary" onClick={() => setShowSetup(true)}>
              {unconfigured ? '① Config einfügen' : 'Config ändern'}
            </button>
          )}
        </Card>

        {/* ===== logs ===== */}
        <Card title="Logs & System" icon="🧾">
          <div className="btns">
            <button className="btn" disabled={busy !== null} onClick={loadLogs}>
              {busy === 'logs' ? <span className="spin" /> : 'Service-Log laden'}
            </button>
            <button className="btn ghost" onClick={refresh}>Status aktualisieren</button>
          </div>
          {showLogs && logs && <pre className="logs term">{logs}</pre>}
        </Card>
      </div>

      {/* ===== embedded guide ===== */}
      <Card title="Anleitung · Gateway, Clients & AdGuard/Pi-hole" icon="📖">
        <details open>
          <summary>🧭 Schnellstart (4 Schritte)</summary>
          <ol className="steps">
            <li>
              <strong>WireGuard-Config von ProtonVPN holen:</strong> Auf
              <code>account.protonvpn.com</code> → <em>Downloads</em> → <em>WireGuard configuration</em>.
              Plattform „GNU/Linux“, Protokoll <strong>UDP 1194 oder 51820</strong> (nicht 443) –
              dann den Inhalt der <code>.conf</code>-Datei kopieren.
            </li>
            <li>
              <strong>Hier einfügen:</strong> Karte „WireGuard-Setup“ unten → Config einfügen →
              „💾 Speichern“. Die Config landet als <code>/etc/wireguard/proton.conf</code> im
              Container (Rechte 600, wird validiert).
            </li>
            <li>
              <strong>Verbinden und prüfen:</strong> „▶ Verbinden“ oben → LED „Tunnel“ grün →
              „🧪 Test“ drücken. Bei „Öffentliche IP“ muss jetzt eine <em>ProtonVPN</em>-IP stehen,
              nicht deine Heim-IP.
            </li>
            <li>
              <strong>Clients umstellen:</strong> Bei den Geräten, die über das VPN sollen, die
              Gateway-IP aus der Kachel oben als <em>Standard-Gateway</em> eintragen (siehe
              „Clients anbinden“).
            </li>
          </ol>
        </details>

        <details>
          <summary>🏠 Clients anbinden (3 Varianten)</summary>
          <ol className="steps">
            <li>
              <strong>Variante A – Router/DHCP (empfohlen):</strong> In den DHCP-Einstellungen
              deines Routers <em>Standard-Gateway</em> auf die Gateway-IP des CT setzen. Alle
              Geräte erben die Einstellung automatisch. Achtung: Damit geht dann das <strong>ganze
              Netz</strong> über den Tunnel – der Kill Switch muss dafür aus sein, wenn der Tunnel
              mal getrennt ist (oder du lässt ihn an und das Netz ist offline, bis der Tunnel
              zurück ist).
            </li>
            <li>
              <strong>Variante B – einzelnes Gerät:</strong> Nur ausgewählte Geräte umbiegen:<br />
              • <em>Windows:</em> Netzwerkadapter → IPv4-Eigenschaften → Standardgateway eintragen<br />
              • <em>Android/iOS:</em> WLAN → Netzwerk bearbeiten → IP-Einstellungen „statisch/manuell“ → Gateway eintragen
            </li>
            <li>
              <strong>Variante C – zweites Subnetz (VLAN/LAN1):</strong> Auf dem Router eine
              statische Route anlegen: Ziel-Subnetz → über die CT-IP. Am CT selbst ist nichts
              einzustellen (er hat nur ein Interface und routed intern).
            </li>
          </ol>
        </details>

        <details>
          <summary>🛡️ AdGuard / Pi-hole einbinden (5 Schritte)</summary>
          <ol className="steps">
            <li>
              <strong>DNS-IP eintragen:</strong> Karte „Firewall & Einstellungen“ → Feld
              „DNS-Server im LAN“ → IP deines AdGuard/Pi-hole (z. B. <code>192.168.1.111</code>).
              Mehrere mit Komma trennen.
            </li>
            <li>
              <strong>„💾 Anwenden“:</strong> Die Firewall wird neu gebaut und lässt Port 53 zu
              diesen IPs <strong>immer</strong> durch den Kill Switch – auch bei getrenntem Tunnel.
            </li>
            <li>
              <strong>„🔍 DNS-Test“:</strong> Jede Zeile muss ✅ „erreichbar“ zeigen. Bei ❌: läuft
              der AdGuard/Pi-hole? Stimmt die IP? (Test prüft TCP 53 vom CT aus.)
            </li>
            <li>
              <strong>Router-DHCP umstellen:</strong> Im Router als <em>DNS-Server</em> die
              AdGuard/Pi-hole-IP eintragen (im selben DHCP-Dialog wie der Gateway-Eintrag aus
              Schritt „Clients anbinden“). Die Clients fragen dann AdGuard <em>direkt</em> im LAN –
              nicht durch den Tunnel, sonst würde der Filter umgangen/doppelt belastet.
            </li>
            <li>
              <strong>Verifizieren:</strong> AdGuard-„Abfrageprotokoll“ zeigt jetzt die
              DNS-Anfragen deiner Clients. Parallel zeigt „🧪 Test“ hier weiterhin die
              Proton-IP: <strong>DNS = gefiltert im LAN, Traffic = verschlüsselt durch Proton.</strong>
            </li>
          </ol>
        </details>

        <details>
          <summary>🔧 Fehlersuche</summary>
          <ol className="steps">
            <li>
              <strong>Clients haben kein Internet, Tunnel getrennt:</strong> Das ist der Kill
              Switch (by design). Entweder „▶ Verbinden“ oder in der Firewall-Karte den Kill
              Switch ausschalten – dann geht Traffic ungeschützt direkt raus.
            </li>
            <li>
              <strong>Handshake-Kachel sehr alt / Tunnel hängt:</strong> Der Watchdog startet den
              Tunnel automatisch neu (wenn aktiv). Manuell: „■ Trennen“ → „▶ Verbinden“.
            </li>
            <li>
              <strong>„Test“ zeigt die Heim-IP statt einer Proton-IP:</strong> Tunnel down oder
              Proton-Config-Fehler → „Service-Log laden“ zeigt die komplette Fehlerkette.
            </li>
            <li>
              <strong>Nichts geht mehr:</strong> Auf dem PVE-Host <code>UPDATE=1</code>-Einzeiler
              (aus dem README) hält Config und Passwort. <code>REINSTALL=1</code> baut neu –
              <strong>WireGuard-Config muss danach neu eingefügt werden!</strong>
            </li>
          </ol>
        </details>
      </Card>

      <footer className="foot">
        ProxVPN · Status aktualisiert alle 5 s · Web UI Port {status?.web_port ?? 8090}
      </footer>

      <Toasts items={toasts} />
    </div>
  )
}