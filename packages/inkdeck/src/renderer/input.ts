// InputMachine: contact-bounce filtering plus the press / long-press gesture
// recogniser, driven entirely by the injectable Clock. Pure — no React, no
// transport — so it is unit-testable in isolation and the controller only
// maps gestures to <Key> handlers.
//
// Bounce model: a physical switch can chatter down→up→down (or up→down→up)
// within a few milliseconds. The filter is symmetric:
//   - a physical *release* is deferred by KEY_DEBOUNCE_MS; a re-press inside
//     that window cancels it, so the key is treated as continuously held
//     (long-press timers keep running, isPressed stays true);
//   - a physical *press* while a release is deferred is that cancellation —
//     no new key-down event.
// The cost is KEY_DEBOUNCE_MS of latency on every release (and therefore on
// onPress when a long-press is armed, which fires on release). Key-down and
// the on-key-down onPress path are never delayed.

import type { Clock } from './clock.js'

export const KEY_DEBOUNCE_MS = 30

export type Gesture = 'press' | 'longPress'

export interface InputMachineOptions {
  clock: Clock
  keyCount: number
  debounceMs?: number
  /** Long-press threshold for a key, or null when no long-press is armed. */
  longPressMs: (position: number) => number | null
  /** A recognised gesture. */
  onGesture: (position: number, gesture: Gesture) => void
  /** Logical pressed-state changed for these keys (after debouncing). */
  onChange: (positions: number[]) => void
}

interface KeyState {
  pressed: boolean
  releaseTimer: number | null
  longPressTimer: number | null
  longPressFired: boolean
  lastInputAt: number
}

export class InputMachine {
  readonly #clock: Clock
  readonly #debounceMs: number
  readonly #opts: InputMachineOptions
  readonly #keys: KeyState[]

  constructor(options: InputMachineOptions) {
    this.#opts = options
    this.#clock = options.clock
    this.#debounceMs = options.debounceMs ?? KEY_DEBOUNCE_MS
    this.#keys = Array.from({ length: options.keyCount }, () => ({
      pressed: false,
      releaseTimer: null,
      longPressTimer: null,
      longPressFired: false,
      lastInputAt: Number.NEGATIVE_INFINITY,
    }))
  }

  isPressed(position: number): boolean {
    return this.#keys[position]?.pressed ?? false
  }

  /** Clock time of the last logical state change for a key (-Infinity if none). */
  lastInputAt(position: number): number {
    return this.#keys[position]?.lastInputAt ?? Number.NEGATIVE_INFINITY
  }

  /** Feed one decoded input report: the physical state of every key. */
  apply(states: readonly boolean[]): void {
    const changed: number[] = []
    for (let position = 0; position < states.length && position < this.#keys.length; position++) {
      if (states[position]) {
        if (this.#down(position)) changed.push(position)
      } else {
        this.#up(position)
      }
    }
    if (changed.length > 0) this.#opts.onChange(changed)
  }

  /** Cancel every pending timer (shutdown). */
  dispose(): void {
    for (const key of this.#keys) {
      if (key.releaseTimer !== null) this.#clock.clearTimeout(key.releaseTimer)
      if (key.longPressTimer !== null) this.#clock.clearTimeout(key.longPressTimer)
      key.releaseTimer = null
      key.longPressTimer = null
    }
  }

  /** Returns true when the logical state changed. */
  #down(position: number): boolean {
    const key = this.#keys[position]!
    if (key.releaseTimer !== null) {
      // Bounce: released and re-pressed inside the window ⇒ still held.
      this.#clock.clearTimeout(key.releaseTimer)
      key.releaseTimer = null
      return false
    }
    if (key.pressed) return false
    key.pressed = true
    key.lastInputAt = this.#clock.now()
    key.longPressFired = false
    const longPressMs = this.#opts.longPressMs(position)
    if (longPressMs !== null) {
      key.longPressTimer = this.#clock.setTimeout(() => {
        key.longPressTimer = null
        key.longPressFired = true
        this.#opts.onGesture(position, 'longPress')
      }, longPressMs)
    } else {
      // No long-press competing ⇒ fire on key-down for instant feel.
      this.#opts.onGesture(position, 'press')
    }
    return true
  }

  #up(position: number): void {
    const key = this.#keys[position]!
    if (!key.pressed || key.releaseTimer !== null) return
    key.releaseTimer = this.#clock.setTimeout(() => {
      key.releaseTimer = null
      this.#commitRelease(position)
    }, this.#debounceMs)
  }

  #commitRelease(position: number): void {
    const key = this.#keys[position]!
    key.pressed = false
    key.lastInputAt = this.#clock.now()
    const armed = key.longPressTimer !== null
    if (armed) {
      this.#clock.clearTimeout(key.longPressTimer!)
      key.longPressTimer = null
      // Long-press armed but released early ⇒ this was a short press.
      this.#opts.onGesture(position, 'press')
    }
    key.longPressFired = false
    this.#opts.onChange([position])
  }
}
