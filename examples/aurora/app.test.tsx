// Harness test for the aurora example: frozen clock, no exec, no hardware.
// The visuals are generative, so assertions are structural — hashes move when
// they should, stay put when they should, and two identical sessions agree
// byte-for-byte (the determinism invariant, SPEC §6).

import { describe, expect, test } from 'bun:test'
import { renderDeck } from '@jackadamson/inkdeck/testing'
import App from './app.tsx'

const TICK_MS = 120

describe('aurora (agent harness)', () => {
  test('fills the deck, animates on the clock, ripples on press', async () => {
    const deck = await renderDeck(<App />, { model: 'xl', freezeTime: true })

    // Every key is painted, interactive, and text-free.
    for (let p = 0; p < 32; p++) {
      const key = deck.key(p)
      expect(key.error).toBeNull()
      expect(key.hash).not.toBeNull()
      expect(key.hasPress).toBe(true)
      expect(key.hasLongPress).toBe(true)
      expect(key.text).toEqual([])
    }

    // Frozen clock ⇒ no time passes ⇒ nothing repaints on its own.
    const before = deck.key(0).hash
    await deck.settled()
    expect(deck.key(0).hash).toBe(before)

    // One tick moves the whole field.
    deck.advanceTime(TICK_MS)
    await deck.settled()
    expect(deck.key(0).hash).not.toBe(before)

    // A press spawns a ripple on the pressed key (and releases cleanly).
    const preTap = deck.key(13).hash
    await deck.tap(13)
    await deck.settled()
    expect(deck.key(13).hash).not.toBe(preTap)
    expect(deck.key(13).pressed).toBe(false)

    // Purely generative: the app never shells out.
    expect(deck.unmatchedExecs).toEqual([])

    await deck.shutdown()
  })

  test('long-press swaps the palette everywhere', async () => {
    const deck = await renderDeck(<App />, { model: 'xl', freezeTime: true })

    // Key 31 is the far corner — the ripple from key 0 cannot have reached it
    // by one tick, so a change there is the palette, not the ring.
    const far = deck.key(31).hash
    await deck.tap(0, 600) // ≥ 500 ms default threshold ⇒ long-press fires
    deck.advanceTime(TICK_MS)
    await deck.settled()
    expect(deck.key(31).hash).not.toBe(far)

    await deck.shutdown()
  })

  test('two identical sessions render byte-identical frames', async () => {
    const run = async (): Promise<(string | null)[]> => {
      const deck = await renderDeck(<App />, { model: 'xl', freezeTime: true })
      deck.advanceTime(TICK_MS * 2)
      await deck.settled()
      await deck.tap(5)
      deck.advanceTime(TICK_MS * 3)
      await deck.settled()
      const hashes = Array.from({ length: 32 }, (_, p) => deck.key(p).hash)
      await deck.shutdown()
      return hashes
    }

    const [a, b] = await Promise.all([run(), run()])
    expect(a).toEqual(b)
  })
})
