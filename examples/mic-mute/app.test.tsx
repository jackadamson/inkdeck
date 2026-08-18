// Harness-based test for the reference app (SPEC §11.4, §14): frozen time,
// mocked osascript — no hardware, no real subprocesses, deterministic.

import { describe, expect, test } from 'bun:test'
import { renderDeck } from '@jackadamson/inkdeck/testing'
import App from './app.tsx'
import mocks from './mocks.json'

describe('mic-mute app (agent harness)', () => {
  test('polls, toggles optimistically, and reconciles', async () => {
    const deck = await renderDeck(<App />, { model: 'mk2', freezeTime: true, mockExec: mocks })

    // The poller fires on mount; the mock reports input volume 75 ⇒ LIVE.
    expect(deck.key(0).text).toEqual(['mic', 'LIVE'])
    expect(deck.key(0).hasPress).toBe(true)
    expect(deck.key(0).error).toBeNull()

    // Press ⇒ optimistic MUTED, the mocked `set volume` command runs, then the
    // app re-polls immediately (refresh). The mock still reads volume 75, so
    // it reconciles straight back to LIVE — the drift-correction behaviour
    // the optimistic update relies on, without waiting for the next tick.
    await deck.tap(0)
    await deck.settled()
    expect(deck.key(0).text).toEqual(['mic', 'LIVE'])

    // The regular poll keeps agreeing.
    deck.advanceTime(1000)
    await deck.settled()
    expect(deck.key(0).text).toEqual(['mic', 'LIVE'])

    // Every command the app ran was covered by a mock.
    expect(deck.unmatchedExecs).toEqual([])

    await deck.shutdown()
  })

  test('an unmocked command surfaces as a gap, not a hang', async () => {
    const deck = await renderDeck(<App />, {
      model: 'mk2',
      freezeTime: true,
      mockExec: { mocks: [] },
    })
    // The mount poll ran with no matching mock: recorded, exec got exit 127,
    // and the tile stays in its unknown state.
    expect(deck.unmatchedExecs.length).toBeGreaterThan(0)
    expect(deck.unmatchedExecs[0]).toContain('osascript')
    expect(deck.key(0).text).toEqual(['mic', '?'])
    await deck.shutdown()
  })
})
