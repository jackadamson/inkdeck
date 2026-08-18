// The in-process testing helper (SPEC §11.4): tap semantics under both clocks.

import { describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { Deck, Key } from './index.js'
import { renderDeck } from './testing.js'

function Counter() {
  const [n, setN] = useState(0)
  return (
    <Deck>
      <Key position={0} onPress={() => setN((v) => v + 1)}>
        <span className="text-white">{String(n)}</span>
      </Key>
      <Key position={1} onPress={() => setN((v) => v + 1)} onLongPress={() => {}}>
        <span className="text-white">{String(n)}</span>
      </Key>
    </Deck>
  )
}

describe('renderDeck', () => {
  for (const freezeTime of [false, true]) {
    test(`back-to-back taps are distinct presses (freezeTime: ${freezeTime})`, async () => {
      const deck = await renderDeck(<Counter />, { freezeTime })
      await deck.tap(0)
      await deck.tap(0)
      await deck.tap(0)
      await deck.settled()
      expect(deck.key(0).text).toEqual(['3'])
      // With a long-press armed, onPress fires on release — still three.
      await deck.tap(1)
      await deck.tap(1)
      await deck.tap(1)
      await deck.settled()
      expect(deck.key(1).text).toEqual(['6'])
      await deck.shutdown()
    })
  }

  test('frozen press/release/press is two presses', async () => {
    const deck = await renderDeck(<Counter />, { freezeTime: true })
    deck.press(0)
    deck.release(0)
    deck.press(0)
    expect(deck.key(0).pressed).toBe(true)
    deck.release(0)
    await deck.settled()
    expect(deck.key(0).text).toEqual(['2'])
    expect(deck.key(0).pressed).toBe(false)
    await deck.shutdown()
  })
})
