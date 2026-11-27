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

function Card({ title, icon, children, accent, wide }) {
  return (
    <div className={'card' + (accent ? ' accent' : '') + (wide ? ' wide' : '')}>
      <h2>{icon && <span className="ico">{icon}</span>}{title}</h2>
      {children}
    </div>
  )
}

function Chip({ label, value, tone }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className={'chip' + (tone ? ' ' + tone : '')}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
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

function Toasts({ items }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={'toast ' + t.type}>{t.msg}</div>
      ))}
    </div>
  )
}

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
      <header>
        <h1><span className="logo">🛡️</span> ProxVPN Gateway</h1>
        <p className="sub">Anmeldung erforderlich</p>
      </header>
      <div className="card login-card">
        <h2><span className="ico">🔑</span>Login</h2>
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

export default function App() {
  const [auth, setAuth] = useState(null) // null = checking, false = open, true = login needed
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

  const [settings, setSettings] = useState(null) // editable draft
  const [savedSettings, setSavedSettings] = useState(null) // server state
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
    try {
      const s = await api('settings')
      setSavedSettings(s)
      setSettings({ ...s, _dns: (s.dns_servers || []).join(', ') })
    } catch (e) {
      setError(e)
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
      setStatus((s) => ({ ...s, ...r, settings: undefined }))
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
  const dirty = settings && savedSettings && (
    settings.killswitch !== savedSettings.killswitch ||
    settings.watchdog !== savedSettings.watchdog ||
    (settings._dns || '') !== (savedSettings.dns_servers || []).join(', ') ||
    (settings.allow_cidr || '') !== (savedSettings.allow_cidr || '')
  )
  const counters = stats?.counters || {}

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
            Kill Switch {kill === undefined ? '…' : kill ? 'aktiv' : 'AUS'}
          </span>
          {authOn && (
            <button className="btn ghost" onClick={logout}>Abmelden</button>
          )}
        </div>
      </header>

      {error && (
        <div className="card error">
          <h2>Fehler (komplette Meldungskette)</h2>
          <pre>{typeof error.detail === 'string' ? error.detail : JSON.stringify(error, null, 2)}</pre>
        </div>
      )}

      <Card wide>
        <div className="hero">
          <div className="hero-state">
            <span className={'dot ' + (up ? 'ok pulse' : 'bad')} />
            <div>
              <div className={'hero-title ' + (up ? 'ok' : 'bad')}>
                {up ? 'Verbunden' : 'Getrennt'}
              </div>
              <div className="sub">
                {unconfigured
                  ? 'Noch keine ProtonVPN-Config hinterlegt – unten einfügen.'
                  : up
                    ? 'Traffic läuft durch den Tunnel.'
                    : kill
                      ? 'Kill Switch blockiert weitergeleiteten Traffic (in den Einstellungen abschaltbar).'
                      : 'Kill Switch aus – LAN-Traffic geht direkt ins Internet.'}
              </div>
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
        <div className="chips">
          <Chip label="Endpoint" value={status?.endpoint} />
          <Chip label="Letzter Handshake" value={status?.latest_handshake} />
          <Chip label="Transfer" value={status?.transfer} />
          <Chip label="Gateway-IP im LAN" value={status?.gateway_ip} />
          <Chip label="Tunnel-Forward" value={counters.tunnel_fwd ? `${fmtBytes(counters.tunnel_fwd.bytes)} · ${counters.tunnel_fwd.packets} Pkt.` : null} />
          <Chip label="DNS-Forward" value={counters.dns ? `${fmtBytes(counters.dns.bytes)} · ${counters.dns.packets} Pkt.` : null} />
        </div>
      </Card>

      <div className="grid">
        <Card title="Verbindungstest" icon="🧪">
          {test ? (
            <div className="stat">
              <p>
                <strong className={pub?.reachable ? 'ok' : 'bad'}>{test.verdict}</strong>
              </p>
              {pub?.ip && (
                <p>
                  Öffentliche IP (über Tunnel): <strong>{pub.ip}</strong>
                </p>
              )}
              {!pub?.reachable && (
                <>
                  {pub?.direct_ip && (
                    <p className="warn">
                      Direkte IP (ohne Tunnel): <strong>{pub.direct_ip}</strong> – der Kill Switch
                      schützt nur weitergeleiteten Traffic, nicht den Host selbst.
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
              kann nur durch den Tunnel kommen.
            </p>
          )}
        </Card>

        <Card title="Firewall & Einstellungen" icon="🧯">
          <p className="sub">Gilt für alle LAN-Clients, die den CT als Gateway nutzen.</p>
          {settings ? (
            <>
              <Toggle
                checked={!!settings.killswitch}
                onChange={(v) => setSettings({ ...settings, killswitch: v })}
                label="Kill Switch"
                hint="Aus = bei getrenntem Tunnel geht LAN-Traffic direkt ins Internet (ohne VPN-Schutz)."
              />
              <Toggle
                checked={!!settings.watchdog}
                onChange={(v) => setSettings({ ...settings, watchdog: v })}
                label="Tunnel-Watchdog"
                hint="Startet den Tunnel automatisch neu, wenn der Handshake über 3 Min. stillsteht."
              />
              <label className="field">
                <span>DNS-Server im LAN (AdGuard / Pi-hole), kommagetrennt</span>
                <input
                  type="text"
                  value={settings._dns || ''}
                  onChange={(e) => setSettings({ ...settings, _dns: e.target.value })}
                  placeholder="z. B. 192.168.1.111"
                />
              </label>
              <p className="sub tiny">
                DNS zu diesen IPs umgeht den Kill Switch immer – Clients behalten deinen Werbe- und
                Tracker-Filter, auch wenn der Tunnel gerade getrennt ist.
              </p>
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
                  {busy === 'settings' ? <span className="spin" /> : dirty ? '💾 Anwenden *' : '💾 Anwenden'}
                </button>
                <button className="btn" disabled={busy !== null || !(settings.dns_servers || []).length} onClick={runDnsTest}>
                  {busy === 'dnstest' ? <span className="spin" /> : '🔍 DNS-Test'}
                </button>
              </div>
              {dirty && <p className="sub tiny warn">* ungespeicherte Änderungen</p>}
              {dnsTest && (
                <div className="stat">
                  {dnsTest.map((r) => (
                    <p key={r.server}>
                      {r.ok ? '✅' : '❌'} {r.server} {r.ok ? `– erreichbar (${r.ms} ms)` : `– ${r.error}`}
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="sub">Lade Einstellungen…</p>
          )}
        </Card>

        <Card title="Setup" icon="⚙️" accent={unconfigured}>
          <p className="sub">
            ProtonVPN → Downloads → WireGuard-Config (.conf) kopieren und hier einfügen. Landet als
            /etc/wireguard/proton.conf im Container (Rechte 600, wird validiert, Auto-Reconnect nach Reboot).
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
              {unconfigured ? '① WireGuard-Config einfügen' : 'Config ändern'}
            </button>
          )}
        </Card>

        <Card title="Logs & System" icon="🧾">
          <div className="btns">
            <button className="btn" disabled={busy !== null} onClick={loadLogs}>
              {busy === 'logs' ? <span className="spin" /> : 'Service-Log laden'}
            </button>
            <button className="btn ghost" onClick={refresh}>Status aktualisieren</button>
          </div>
          {showLogs && logs && <pre className="logs">{logs}</pre>}
        </Card>
      </div>

      <footer className="foot">
        ProxVPN · Status aktualisiert alle 5 s · Web UI Port {status?.web_port ?? 8090}
      </footer>

      <Toasts items={toasts} />
    </div>
  )
}