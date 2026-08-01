// Browser simulator (SPEC §9 --simulate, §16 security posture).
//
// A client of the harness pipeline: the deck runs against a VirtualTransport
// in-process and this server pushes the *server-rendered* PNGs to a local
// page — the browser never re-renders text, so hardware and simulator are
// pixel-identical (§6.2).
//
// Non-negotiable rules (§16) — a synthetic key press is RCE-equivalent
// (onPress → exec), so the socket is locked down:
//   - bind 127.0.0.1 only, random ephemeral port
//   - per-session random token in the URL fragment, required on the WS
//     handshake (a malicious page cannot read it from the user's terminal)
//   - Origin validated on every WS upgrade (WebSockets are not CORS-gated)
//   - Host validated on every request (DNS rebinding)
//   - UI served from the same origin; no external fetches, no discovery

import { randomBytes } from 'node:crypto'
import type { Server, ServerWebSocket } from 'bun'
import type { Model } from '../device/models.js'
import type { DeckController } from '../renderer/controller.js'
import type { VirtualHandle } from '../transport/virtual.js'
import { HarnessSession } from '../harness/session.js'
import { loadApp, resolveHeadlessModel } from './headless.js'
import { createElement } from 'react'

interface WsData {
  authed: true
}

export interface SimulatorServer {
  url: string
  port: number
  token: string
  stop(): Promise<void>
}

export function startSimulatorServer(
  controller: DeckController,
  handle: VirtualHandle,
  model: Model,
): SimulatorServer {
  const token = randomBytes(16).toString('hex')
  const sockets = new Set<ServerWebSocket<WsData>>()

  const keyPng = async (position: number): Promise<string | null> => {
    const snapshot = controller.keySnapshots().find((s) => s.position === position)
    if (!snapshot?.rgba) return null
    const png = await controller.raster.rgbaToPng(snapshot.rgba, model)
    return Buffer.from(png).toString('base64')
  }

  const sendKey = async (ws: ServerWebSocket<WsData>, position: number): Promise<void> => {
    const png = await keyPng(position)
    ws.send(JSON.stringify(png ? { type: 'key', position, png } : { type: 'clear', position }))
  }

  const server: Server = Bun.serve<WsData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      // Host check on every request defeats DNS rebinding (§16).
      if (req.headers.get('host') !== `127.0.0.1:${srv.port}`) {
        return new Response('forbidden', { status: 403 })
      }
      if (url.pathname === '/ws') {
        const origin = req.headers.get('origin')
        if (origin !== `http://127.0.0.1:${srv.port}`) {
          return new Response('forbidden: bad origin', { status: 403 })
        }
        if (url.searchParams.get('token') !== token) {
          return new Response('forbidden: bad token', { status: 403 })
        }
        if (srv.upgrade(req, { data: { authed: true as const } })) return undefined as unknown as Response
        return new Response('upgrade failed', { status: 400 })
      }
      if (url.pathname === '/') {
        return new Response(pageHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(
          JSON.stringify({
            type: 'hello',
            model: { id: model.id, columns: model.columns, rows: model.rows, keyW: model.keyW, keyH: model.keyH },
            serial: controller.deckInfo.serial,
            brightness: controller.brightness,
          }),
        )
        void (async () => {
          for (const snapshot of controller.keySnapshots()) {
            await sendKey(ws, snapshot.position)
          }
        })()
      },
      message(ws, raw) {
        let msg: { type?: string; position?: number }
        try {
          msg = JSON.parse(String(raw))
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'malformed message' }))
          return
        }
        const keyCount = model.columns * model.rows
        if (
          (msg.type === 'press' || msg.type === 'release') &&
          Number.isInteger(msg.position) &&
          (msg.position as number) >= 0 &&
          (msg.position as number) < keyCount
        ) {
          if (msg.type === 'press') handle.pressKey(msg.position as number)
          else handle.releaseKey(msg.position as number)
          return
        }
        ws.send(JSON.stringify({ type: 'error', message: `unrecognized message: ${String(raw).slice(0, 100)}` }))
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })

  const unrender = controller.onRendered((changed) => {
    void (async () => {
      for (const position of changed) {
        for (const ws of sockets) await sendKey(ws, position)
      }
    })()
  })
  const unbrightness = controller.subscribeBrightness(() => {
    const payload = JSON.stringify({ type: 'brightness', value: controller.brightness })
    for (const ws of sockets) ws.send(payload)
  })

  const port = server.port
  return {
    url: `http://127.0.0.1:${port}/#${token}`,
    port,
    token,
    async stop() {
      unrender()
      unbrightness()
      // Let stop(true) force-close the sockets: a graceful ws.close() first
      // deadlocks server.stop's promise on Bun 1.3.11 (close handshake never
      // reaped once the server is stopping).
      await server.stop(true)
    },
  }
}

export interface SimulateOptions {
  model?: string
  watch?: boolean
}

export async function simulateCommand(appPath: string, options: SimulateOptions = {}): Promise<number> {
  const app = await loadApp(appPath)
  const model = resolveHeadlessModel(app, options.model)
  const session = await HarnessSession.start({
    model,
    element: createElement(app.App),
    assetDir: app.appDir,
    fonts: app.config.fonts,
  })
  const sim = startSimulatorServer(session.controller, session.handle, model)
  console.error(`[inkdeck] simulating ${model.id} (${model.columns}×${model.rows})`)
  console.error(`[inkdeck] open ${sim.url}`)

  const shutdown = async () => {
    await sim.stop()
    await session.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  if (options.watch) {
    const { watchApp } = await import('./start.js')
    watchApp(app.appPath, appPath, session.controller)
  }

  return new Promise<number>(() => {})
}

// Vanilla JS, served from the simulator's own origin; the page reads the
// session token from location.hash and displays server-rendered PNGs only.
function pageHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>inkdeck simulator</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #18181b; font-family: ui-monospace, monospace; color: #a1a1aa; }
  main { text-align: center; }
  #deck { display: grid; gap: 10px; padding: 24px; background: #27272a;
          border-radius: 18px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  .key { border-radius: 8px; background: #000; cursor: pointer; display: block;
         width: var(--kw); height: var(--kh); border: 1px solid #3f3f46;
         -webkit-user-select: none; user-select: none; }
  .key:active { transform: scale(.96); }
  #status { margin-top: 12px; font-size: 12px; }
</style>
</head>
<body>
<main>
  <div id="deck"></div>
  <div id="status">connecting…</div>
</main>
<script>
  const token = location.hash.slice(1)
  const status = document.getElementById('status')
  const deck = document.getElementById('deck')
  const keys = []
  const ws = new WebSocket('ws://' + location.host + '/ws?token=' + encodeURIComponent(token))
  ws.onopen = () => { status.textContent = 'connected' }
  ws.onclose = () => { status.textContent = 'disconnected — restart the simulator and reload' }
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'hello') {
      const scale = msg.model.keyW >= 96 ? 1 : 1.25
      deck.style.setProperty('--kw', (msg.model.keyW * scale) + 'px')
      deck.style.setProperty('--kh', (msg.model.keyH * scale) + 'px')
      deck.style.gridTemplateColumns = 'repeat(' + msg.model.columns + ', auto)'
      deck.textContent = ''
      keys.length = 0
      for (let i = 0; i < msg.model.columns * msg.model.rows; i++) {
        const img = document.createElement('img')
        img.className = 'key'
        img.draggable = false
        img.addEventListener('pointerdown', () => ws.send(JSON.stringify({ type: 'press', position: i })))
        img.addEventListener('pointerup', () => ws.send(JSON.stringify({ type: 'release', position: i })))
        img.addEventListener('pointerleave', () => ws.send(JSON.stringify({ type: 'release', position: i })))
        deck.appendChild(img)
        keys.push(img)
      }
      status.textContent = msg.model.id + (msg.serial ? ' · ' + msg.serial : '') + ' · simulated'
    } else if (msg.type === 'key' && keys[msg.position]) {
      keys[msg.position].src = 'data:image/png;base64,' + msg.png
    } else if (msg.type === 'clear' && keys[msg.position]) {
      keys[msg.position].removeAttribute('src')
    } else if (msg.type === 'brightness') {
      deck.style.opacity = String(Math.max(msg.value, 4) / 100)
    }
  }
</script>
</body>
</html>`
}
