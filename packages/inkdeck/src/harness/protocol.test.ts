// M3 acceptance (SPEC §13): scripted `inkdeck agent` session over real stdio —
// press → rendered → snapshot asserts, plus the §11.2 guarantees: every
// command acknowledged, rendered only on actual change, malformed input is an
// error event not a crash, EOF exits cleanly.

import type { Subprocess } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'cli', 'index.ts')
const EXAMPLE = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'mic-mute', 'app.tsx')
const MOCKS = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'mic-mute', 'mocks.json')

interface AgentEvent {
  event: string
  [key: string]: unknown
}

/** Drives one agent subprocess; reads events as newline-delimited JSON. */
class AgentClient {
  proc: Subprocess<'pipe', 'pipe', 'pipe'>
  #events: AgentEvent[] = []
  #buffer = ''
  #waiters: Array<() => void> = []
  #reader: Promise<void>

  constructor(args: string[]) {
    this.proc = Bun.spawn([process.execPath, CLI, 'agent', ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.#reader = this.#readLoop()
  }

  async #readLoop(): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      this.#buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, idx)
        this.#buffer = this.#buffer.slice(idx + 1)
        if (line.trim().length === 0) continue
        this.#events.push(JSON.parse(line))
        for (const w of this.#waiters.splice(0)) w()
      }
    }
  }

  send(command: Record<string, unknown> | string): void {
    const line = typeof command === 'string' ? command : JSON.stringify(command)
    this.proc.stdin.write(`${line}\n`)
    this.proc.stdin.flush()
  }

  /** Next unconsumed event, waiting for it to arrive (5 s cap). */
  async next(): Promise<AgentEvent> {
    const deadline = Date.now() + 5000
    for (;;) {
      const event = this.#events.shift()
      if (event) return event
      if (Date.now() > deadline) throw new Error('timed out waiting for an agent event')
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }

  /** Consume events until one matches; unrelated log events are skipped. */
  async nextNonLog(): Promise<AgentEvent> {
    for (;;) {
      const event = await this.next()
      if (event.event !== 'log') return event
    }
  }

  async close(): Promise<number> {
    await this.proc.stdin.end()
    const code = await this.proc.exited
    await this.#reader.catch(() => {})
    return code
  }
}

function keyText(event: AgentEvent, position: number): string[] {
  const manifest = event.manifest as { keys: Array<{ position: number; text: string[] }> }
  return manifest.keys.find((k) => k.position === position)?.text ?? []
}

describe('inkdeck agent protocol (§11.2)', () => {
  const client = new AgentClient([EXAMPLE, '--freeze-time', '--mock-exec', MOCKS])
  afterAll(async () => {
    await client.close()
  })

  test('scripted session: ready → press → rendered → snapshot → reconcile', async () => {
    // ready carries the initial manifest; the mount poll already ran (mock: 75).
    const ready = await client.nextNonLog()
    expect(ready.event).toBe('ready')
    expect(keyText(ready, 0)).toEqual(['mic', 'LIVE'])

    // press ⇒ optimistic MUTED, then the app re-polls at once (refresh) and
    // the mock still reads 75 ⇒ LIVE. Depending on raster coalescing that is
    // zero or more rendered notifications (changed=[0]) — when the MUTED frame
    // is coalesced away the pixels end up unchanged — followed by exactly one
    // state ack echoing the command id and showing LIVE.
    client.send({ cmd: 'press', position: 0, id: 'p1' })
    let ack = await client.nextNonLog()
    while (ack.event === 'rendered') {
      expect(ack.changed).toEqual([0])
      expect(ack.id).toBe('p1')
      ack = await client.nextNonLog()
    }
    expect(ack.event).toBe('state')
    expect(ack.id).toBe('p1')
    expect(keyText(ack, 0)).toEqual(['mic', 'LIVE'])

    // snapshot reflects the same manifest (no id ⇒ no id on the ack).
    client.send({ cmd: 'snapshot' })
    const state = await client.nextNonLog()
    expect(state.event).toBe('state')
    expect(state.id).toBeUndefined()
    expect(keyText(state, 0)).toEqual(['mic', 'LIVE'])

    // release changes no pixels ⇒ a state ack, no rendered.
    client.send({ cmd: 'release', position: 0, id: 2 })
    const releaseAck = await client.nextNonLog()
    expect(releaseAck.event).toBe('state')
    expect(releaseAck.id).toBe(2)

    // advanceTime fires the next poll; the mock still reads 75 ⇒ no change ⇒ state.
    client.send({ cmd: 'advanceTime', ms: 1000 })
    const reconciled = await client.nextNonLog()
    expect(reconciled.event).toBe('state')
    expect(keyText(reconciled, 0)).toEqual(['mic', 'LIVE'])
  })

  test('malformed input and bad positions are error events, not crashes', async () => {
    client.send('this is not json')
    const malformed = await client.nextNonLog()
    expect(malformed.event).toBe('error')
    expect(malformed.scope).toBe('protocol')

    client.send({ cmd: 'press', position: 999 })
    const outOfRange = await client.nextNonLog()
    expect(outOfRange.event).toBe('error')
    expect(String(outOfRange.message)).toContain('out of range')

    client.send({ cmd: 'advanceTime', ms: 'soon' })
    const badMs = await client.nextNonLog()
    expect(badMs.event).toBe('error')

    // The session survived: snapshot still answers.
    client.send({ cmd: 'snapshot' })
    const state = await client.nextNonLog()
    expect(state.event).toBe('state')
  })

  test('writeFrames dumps PNGs + manifest on demand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkdeck-agent-frames-'))
    client.send({ cmd: 'writeFrames', dir })
    const frames = await client.nextNonLog()
    expect(frames.event).toBe('frames')
    expect(frames.keys).toBe(1)
    expect(await Bun.file(join(dir, 'key-0.png')).exists()).toBe(true)
    const manifest = await Bun.file(join(dir, 'manifest.json')).json()
    expect(manifest.keys[0].text).toEqual(['mic', 'LIVE'])
  })

  test('EOF on stdin exits cleanly', async () => {
    const eofClient = new AgentClient([EXAMPLE, '--freeze-time', '--mock-exec', MOCKS])
    const ready = await eofClient.nextNonLog()
    expect(ready.event).toBe('ready')
    const code = await eofClient.close()
    expect(code).toBe(0)
  })
})
