import { useEffect, useState, useCallback } from 'react'

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
      if (!path.startsWith('login')) window.location.reload()
    }
    if (!r.ok) throw { status: r.status, detail: body.detail, ...body }
    return body
  })
}

function Card({ title, children }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
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
    <div className="wrap">
      <header>
        <h1>🛡️ ProxVPN Gateway</h1>
        <p className="sub">Login erforderlich</p>
      </header>
      <div className="card">
        <h2>Anmelden</h2>
        <p className="sub">
          Das Passwort wurde bei der Installation im Proxmox-Log ausgegeben
          („Web UI password“). Es steht in <code>/etc/proxvpn/auth.json</code> im Container.
        </p>
        <form onSubmit={submit} className="btns">
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Passwort"
            autoFocus
          />
          <button disabled={busy || !pw} type="submit">Anmelden</button>
        </form>
        {err && (
          <div className="card error">
            <pre>{typeof err.detail === 'string' ? err.detail : JSON.stringify(err, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [auth, setAuth] = useState(null) // null = checking, false = open, true = login
  const [status, setStatus] = useState(null)
  const [test, setTest] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [conf, setConf] = useState('')
  const [logs, setLogs] = useState(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('status'))
      setError(null)
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
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [auth, refresh])

  const action = async (name) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api(name, { method: 'POST' }))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const runTest = async () => {
    setBusy(true)
    setTest(null)
    setError(null)
    try {
      setTest(await api('test', { method: 'POST' }))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const saveConf = async () => {
    setBusy(true)
    setError(null)
    try {
      await api('config', { method: 'POST', body: JSON.stringify({ config: conf }) })
      setShowSetup(false)
      setConf('')
      await refresh()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const loadLogs = async () => {
    try {
      setLogs((await api('logs')).logs)
    } catch (e) {
      setError(e)
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
  const pub = test?.public

  return (
    <div className="wrap">
      <header>
        <h1>🛡️ ProxVPN Gateway</h1>
        <p className="sub">
          WireGuard-VPN-Gateway · Kill Switch{' '}
          {kill === undefined ? '…' : kill ? <span className="ok">aktiv</span> : <span className="bad">inaktiv</span>}
          {auth && <> · <button className="link" onClick={logout}>Abmelden</button></>}
        </p>
      </header>

      {error && (
        <div className="card error">
          <h2>Fehler (komplette Meldungskette)</h2>
          <pre>{typeof error.detail === 'string' ? error.detail : JSON.stringify(error, null, 2)}</pre>
        </div>
      )}

      <div className="grid">
        <Card title="Tunnel">
          <div className="stat">
            <span className={'pill ' + (up ? 'ok' : 'bad')}>
              {up ? 'Verbunden' : 'Getrennt'}
            </span>
            {status?.configured === false && <p className="warn">Noch keine ProtonVPN-Config hinterlegt.</p>}
            {status?.endpoint && <p>Endpoint: {status.endpoint}</p>}
            {status?.latest_handshake && <p>Letzter Handshake: {status.latest_handshake}</p>}
            {status?.transfer && <p>Transfer: {status.transfer}</p>}
            {status?.gateway_ip && <p>Gateway-IP im LAN: {status.gateway_ip}</p>}
          </div>
          <div className="btns">
            <button disabled={busy || !status?.configured} onClick={() => action('connect')}>Verbinden</button>
            <button disabled={busy || !up} onClick={() => action('disconnect')}>Trennen</button>
            <button disabled={busy} onClick={runTest}>Test</button>
          </div>
        </Card>

        <Card title="Verbindungstest">
          {test ? (
            <div className="stat">
              <p>
                Urteil: <strong className={pub?.reachable ? 'ok' : 'bad'}>{test.verdict}</strong>
              </p>
              {pub?.ip && (
                <p>
                  Öffentliche IP (über Tunnel): <strong>{pub.ip}</strong>
                </p>
              )}
              {!pub?.reachable && (
                <>
                  {pub?.direct_ip && (
                    <p>
                      Direkte IP (ohne Tunnel): <strong className="warn">{pub.direct_ip}</strong>
                      {' '}– der Kill Switch schützt nur weitergeleiteten Traffic, nicht den Host selbst.
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
                Kill Switch: {test.killswitch_active ? 'aktiv' : 'inaktiv'} · Tunnel: {test.tunnel_up ? 'up' : 'down'}
              </p>
            </div>
          ) : (
            <p className="sub">
              „Test“ fragt mehrere IP-Dienste <em>über das Tunnel-Interface</em> ab – eine Antwort
              kann nur durch den Tunnel kommen.
            </p>
          )}
        </Card>

        <Card title="Setup">
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
              />
              <div className="btns">
                <button disabled={busy} onClick={saveConf}>Speichern</button>
                <button disabled={busy} onClick={() => setShowSetup(false)}>Abbrechen</button>
              </div>
            </>
          ) : (
            <button onClick={() => setShowSetup(true)}>WireGuard-Config einfügen</button>
          )}
        </Card>

        <Card title="Logs & System">
          <div className="btns">
            <button onClick={loadLogs}>Service-Log laden</button>
            <button onClick={refresh}>Status aktualisieren</button>
          </div>
          {logs && <pre className="logs">{logs}</pre>}
        </Card>
      </div>
    </div>
  )
}