// Simulator security posture (SPEC §16): loopback + token + Origin + Host are
// the whole defense — a synthetic press is RCE-equivalent, so every rejection
// path is load-bearing and gets its own test.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { modelById } from '../device/models.js'
import { Deck, Key } from '../renderer/components.js'
import { HarnessSession } from '../harness/session.js'
import { MIC_MUTE_APP } from '../test/helpers.js'
import { simulateCommand, startSimulatorServer, type SimulatorServer } from './simulate.js'

let session: HarnessSession
let sim: SimulatorServer
let pressed = 0

beforeAll(async () => {
  session = await HarnessSession.start({
    model: modelById('mk2')!,
    element: createElement(
      Deck,
      null,
      createElement(Key, { position: 0, onPress: () => pressed++ }, createElement('span', { className: 'text-white' }, 'sim')),
    ),
  })
  sim = startSimulatorServer(session.controller, session.handle, session.controller.model)
})

afterAll(async () => {
  await sim.stop()
  await session.shutdown()
})

const origin = () => `http://127.0.0.1:${sim.port}`

function wsAttempt(url: string, headers: Record<string, string>): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    const timer = setTimeout(() => {
      ws.close()
      resolve('rejected')
    }, 2000)
    ws.onopen = () => {
      clearTimeout(timer)
      ws.close()
      resolve('open')
    }
    ws.onerror = () => {
      clearTimeout(timer)
      resolve('rejected')
    }
  })
}

describe('browser simulator (§16)', () => {
  test('binds loopback on an ephemeral port and prints a token URL', () => {
    expect(sim.url).toBe(`http://127.0.0.1:${sim.port}/#${sim.token}`)
    expect(sim.token).toMatch(/^[0-9a-f]{32}$/)
  })

  test('serves the page from its own origin', async () => {
    const res = await fetch(`${origin()}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('inkdeck simulator')
    // No external resources: the page must be self-contained (§16).
    expect(html).not.toMatch(/src\s*=\s*"http/)
    expect(html).not.toMatch(/href\s*=\s*"http/)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`connect-src ws://127.0.0.1:${sim.port}`)
    expect(csp).toContain("frame-ancestors 'none'")
  })

  test('rejects requests with a forged Host header (DNS rebinding)', async () => {
    const res = await fetch(`${origin()}/`, { headers: { host: 'evil.example:80' } })
    expect(res.status).toBe(403)
  })

  test('rejects a WS handshake without the session token', async () => {
    expect(await wsAttempt(`ws://127.0.0.1:${sim.port}/ws`, { origin: origin() })).toBe('rejected')
    expect(await wsAttempt(`ws://127.0.0.1:${sim.port}/ws?token=wrong`, { origin: origin() })).toBe('rejected')
  })

  test('rejects a WS handshake from a foreign Origin (drive-by web page)', async () => {
    expect(
      await wsAttempt(`ws://127.0.0.1:${sim.port}/ws?token=${sim.token}`, { origin: 'https://evil.example' }),
    ).toBe('rejected')
  })

  test('accepts the genuine handshake, sends hello + server-rendered PNGs, and delivers presses', async () => {
    const messages: Array<Record<string, unknown>> = []
    const ws = new WebSocket(`ws://127.0.0.1:${sim.port}/ws?token=${sim.token}`, {
      headers: { origin: origin() },
    })
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      ws.onerror = () => resolve(false)
    })
    expect(opened).toBe(true)
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)))

    const until = async (pred: () => boolean) => {
      const deadline = Date.now() + 3000
      while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(pred()).toBe(true)
    }

    await until(() => messages.some((m) => m.type === 'hello'))
    const hello = messages.find((m) => m.type === 'hello')! as { model: { columns: number; rows: number }; brightness: number }
    expect(hello.model.columns).toBe(5)
    expect(hello.model.rows).toBe(3)
    expect(hello.brightness).toBe(100)
    // The page applies hello.brightness on connect (not only on later changes).
    const html = await (await fetch(`${origin()}/`)).text()
    expect(html).toContain('applyBrightness(msg.brightness)')

    // Initial state push: key 0's server-rendered PNG.
    await until(() => messages.some((m) => m.type === 'key' && m.position === 0))
    const key = messages.find((m) => m.type === 'key' && m.position === 0)! as { png: string }
    expect(Buffer.from(key.png, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    )

    // A click reaches the app's onPress through the same pipeline as hardware.
    ws.send(JSON.stringify({ type: 'press', position: 0 }))
    await until(() => pressed > 0)
    ws.send(JSON.stringify({ type: 'release', position: 0 }))

    // Out-of-range positions are refused.
    ws.send(JSON.stringify({ type: 'press', position: 999 }))
    await until(() => messages.some((m) => m.type === 'error'))

    ws.close()
  })

  test('simulateCommand runs in-process and shuts down idempotently on request', async () => {
    const running = await simulateCommand(MIC_MUTE_APP, { model: 'mk2' })
    await Promise.all([running.shutdown(), running.shutdown()])
    expect(await running.done).toBe(0)
  })
})
