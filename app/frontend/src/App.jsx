import { useEffect, useState, useCallback } from 'react'

const api = (path, opts) =>
  fetch(`/api/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw { status: r.status, detail: body.detail, ...body }
    return body
  })

function Card({ title, children }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

export default function App() {
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
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

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

  const up = status?.up
  const kill = status?.killswitch_active

  return (
    <div className="wrap">
      <header>
        <h1>🛡️ ProxVPN Gateway</h1>
        <p className="sub">
          WireGuard-VPN-Gateway · Kill Switch{' '}
          {kill === undefined ? '…' : kill ? <span className="ok">aktiv</span> : <span className="bad">inaktiv</span>}
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
              <p>Tunnel: {test.tunnel_up ? 'up' : 'down'}</p>
              <p>
                Öffentliche IP: <strong>{test.public?.ip ?? '—'}</strong>
              </p>
              {test.public?.error && <pre className="warn">{test.public.error}</pre>}
              {!test.public?.reachable && (
                <p className="bad">
                  Kein Internetzugang über den Tunnel (Kill Switch blockt Traffic, solange der Tunnel down ist).
                </p>
              )}
            </div>
          ) : (
            <p className="sub">„Test“ prüft, ob Traffic durch den Tunnel rausgeht.</p>
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
