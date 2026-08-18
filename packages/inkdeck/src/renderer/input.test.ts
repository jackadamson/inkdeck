import { describe, expect, test } from 'bun:test'
import { FrozenClock } from './clock.js'
import { InputMachine, KEY_DEBOUNCE_MS } from './input.js'

function machine(longPress: number | null) {
  const clock = new FrozenClock()
  const gestures: string[] = []
  const changes: number[][] = []
  const m = new InputMachine({
    clock,
    keyCount: 2,
    longPressMs: () => longPress,
    onGesture: (p, g) => gestures.push(`${p}:${g}`),
    onChange: (ps) => changes.push(ps),
  })
  const states = (down: boolean, position = 0) => {
    const s = [false, false]
    s[position] = down
    return s
  }
  return { clock, gestures, changes, m, states }
}

describe('InputMachine', () => {
  test('press fires on key-down when no long-press is armed; release is debounced', () => {
    const { clock, gestures, m, states } = machine(null)
    m.apply(states(true))
    expect(gestures).toEqual(['0:press'])
    expect(m.isPressed(0)).toBe(true)
    m.apply(states(false))
    // Still logically held until the bounce window elapses.
    expect(m.isPressed(0)).toBe(true)
    clock.advance(KEY_DEBOUNCE_MS)
    expect(m.isPressed(0)).toBe(false)
    expect(gestures).toEqual(['0:press'])
  })

  test('a bounce (up→down inside the window) during a hold keeps the long-press alive', () => {
    const { clock, gestures, m, states } = machine(500)
    m.apply(states(true))
    clock.advance(100)
    m.apply(states(false)) // bounce up
    clock.advance(5)
    m.apply(states(true)) // bounce down: cancels the deferred release
    expect(m.isPressed(0)).toBe(true)
    clock.advance(400) // 505 ms after the original press
    expect(gestures).toEqual(['0:longPress'])
    m.apply(states(false))
    clock.advance(KEY_DEBOUNCE_MS)
    expect(m.isPressed(0)).toBe(false)
    expect(gestures).toEqual(['0:longPress'])
  })

  test('short press with long-press armed fires press on (debounced) release', () => {
    const { clock, gestures, m, states } = machine(500)
    m.apply(states(true))
    clock.advance(50)
    m.apply(states(false))
    expect(gestures).toEqual([])
    clock.advance(KEY_DEBOUNCE_MS)
    expect(gestures).toEqual(['0:press'])
    // A subsequent real press is a new gesture.
    clock.advance(1)
    m.apply(states(true))
    clock.advance(600)
    expect(gestures).toEqual(['0:press', '0:longPress'])
  })

  test('a re-press within the window after a release is not a second press', () => {
    const { clock, gestures, m, states } = machine(null)
    m.apply(states(true))
    clock.advance(100)
    m.apply(states(false))
    clock.advance(5)
    m.apply(states(true))
    expect(gestures).toEqual(['0:press'])
    // Past the window a real release + press fires again.
    m.apply(states(false))
    clock.advance(KEY_DEBOUNCE_MS)
    m.apply(states(true))
    expect(gestures).toEqual(['0:press', '0:press'])
  })

  test('onChange reports logical transitions only, once per key', () => {
    const { clock, changes, m, states } = machine(null)
    m.apply(states(true))
    m.apply(states(true)) // repeated report, no change
    m.apply(states(false))
    m.apply(states(true)) // bounce
    m.apply(states(false))
    expect(changes).toEqual([[0]])
    clock.advance(KEY_DEBOUNCE_MS)
    expect(changes).toEqual([[0], [0]])
    expect(m.lastInputAt(0)).toBe(KEY_DEBOUNCE_MS)
  })

  test('dispose cancels pending timers', () => {
    const { clock, gestures, m, states } = machine(500)
    m.apply(states(true))
    m.dispose()
    clock.advance(1000)
    expect(gestures).toEqual([])
  })
})
