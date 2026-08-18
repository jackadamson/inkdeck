// Public hooks (SPEC §7.2): latest-callback semantics for usePoller,
// refresh(), stable useDeckInfo/useBrightness identities, useKeyState.

import { describe, expect, test } from 'bun:test'
import { useEffect, useRef, useState } from 'react'
import { Deck, Key, useBrightness, useDeckInfo, useKeyState, usePoller } from '../index.js'
import { renderDeck } from '../testing.js'

describe('usePoller', () => {
  test('calls the latest callback (props/state are current) and refresh() runs it now', async () => {
    let refreshNow: () => void = () => {}
    let runs = 0
    function App() {
      const [paused, setPaused] = useState(false)
      const [seen, setSeen] = useState(0)
      const { refresh } = usePoller(() => {
        runs++
        if (paused) return
        setSeen((v) => v + 1)
      }, 100)
      refreshNow = refresh
      return (
        <Deck>
          <Key position={0} onPress={() => setPaused(true)}>
            <span className="text-white">{String(seen)}</span>
          </Key>
        </Deck>
      )
    }
    const deck = await renderDeck(<App />, { freezeTime: true })
    expect(deck.key(0).text).toEqual(['1']) // immediate first run
    deck.advanceTime(100)
    await deck.settled()
    expect(deck.key(0).text).toEqual(['2'])
    // Pause via state: the poller must see the new value, not the mount-time one.
    await deck.tap(0)
    await deck.settled()
    deck.advanceTime(300)
    await deck.settled()
    expect(deck.key(0).text).toEqual(['2'])
    // refresh() runs the callback immediately (still paused ⇒ counter unchanged, runs++).
    const before = runs
    refreshNow()
    expect(runs).toBe(before + 1)
    await deck.shutdown()
  })
})

describe('useDeckInfo / useBrightness / useKeyState', () => {
  test('useDeckInfo is referentially stable and exposes grid helpers', async () => {
    const infos: unknown[] = []
    let coords = ''
    function App() {
      const info = useDeckInfo()
      infos.push(info)
      const [, force] = useState(0)
      useEffect(() => {
        force(1)
      }, [])
      coords = `${JSON.stringify(info.coordsOf(7))}/${info.positionOf(1, 2)}`
      return (
        <Deck>
          <Key position={0} />
        </Deck>
      )
    }
    const deck = await renderDeck(<App />, { model: 'mk2' })
    expect(infos.length).toBeGreaterThan(1)
    expect(new Set(infos).size).toBe(1)
    expect(coords).toBe('{"row":1,"col":2}/7')
    await deck.shutdown()
  })

  test('useBrightness setter is stable and effective; useKeyState tracks the press', async () => {
    const setters: unknown[] = []
    function App() {
      const [brightness, setBrightness] = useBrightness()
      setters.push(setBrightness)
      const { pressed } = useKeyState(0)
      const [, force] = useState(0)
      useEffect(() => {
        force(1)
      }, [])
      return (
        <Deck>
          <Key position={0} onPress={() => setBrightness(40)}>
            <span className="text-white">{`${brightness}:${pressed ? 'down' : 'up'}`}</span>
          </Key>
        </Deck>
      )
    }
    const deck = await renderDeck(<App />, { freezeTime: true })
    expect(new Set(setters).size).toBe(1)
    expect(deck.key(0).text).toEqual(['100:up'])
    deck.press(0)
    await deck.settled()
    expect(deck.key(0).text).toEqual(['40:down'])
    deck.release(0)
    await deck.settled()
    expect(deck.key(0).text).toEqual(['40:up'])
    await deck.shutdown()
  })
})
