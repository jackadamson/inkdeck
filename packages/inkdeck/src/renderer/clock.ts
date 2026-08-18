// Injectable clock (SPEC §11.3). Backs usePoller, framework setInterval usage
// and long-press timers, so `--freeze-time` + advanceTime can drive them
// deterministically. Designed so animation hooks can land at [P1] without rework.

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
  setInterval(fn: () => void, ms: number): number
  clearInterval(id: number): void
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
  setTimeout(fn: () => void, ms: number): number {
    return globalThis.setTimeout(fn, ms) as unknown as number
  }
  clearTimeout(id: number): void {
    globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
  }
  setInterval(fn: () => void, ms: number): number {
    return globalThis.setInterval(fn, ms) as unknown as number
  }
  clearInterval(id: number): void {
    globalThis.clearInterval(id as unknown as ReturnType<typeof setInterval>)
  }
}

interface FrozenTimer {
  id: number
  at: number
  interval?: number
  fn: () => void
}

/** Starts frozen; only advance() moves time and fires due timers in order. */
export class FrozenClock implements Clock {
  #now = 0
  #nextId = 1
  #timers: FrozenTimer[] = []

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.#nextId++
    this.#timers.push({ id, at: this.#now + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(id: number): void {
    this.#timers = this.#timers.filter((t) => t.id !== id)
  }

  setInterval(fn: () => void, ms: number): number {
    const interval = Math.max(1, ms)
    const id = this.#nextId++
    this.#timers.push({ id, at: this.#now + interval, interval, fn })
    return id
  }

  clearInterval(id: number): void {
    this.clearTimeout(id)
  }

  advance(ms: number): void {
    const target = this.#now + Math.max(0, ms)
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.#now = due.at
      if (due.interval) {
        due.at += due.interval
      } else {
        this.#timers = this.#timers.filter((t) => t.id !== due.id)
      }
      due.fn()
    }
    this.#now = target
  }
}

/**
 * A Clock whose callbacks run inside `enter` — used by the controller so
 * usePoller / framework timers execute in the session's exec scope.
 */
export class ScopedClock implements Clock {
  readonly inner: Clock
  readonly #enter: <T>(fn: () => T) => T
  constructor(inner: Clock, enter: <T>(fn: () => T) => T) {
    this.inner = inner
    this.#enter = enter
  }
  now(): number {
    return this.inner.now()
  }
  setTimeout(fn: () => void, ms: number): number {
    return this.inner.setTimeout(() => this.#enter(fn), ms)
  }
  clearTimeout(id: number): void {
    this.inner.clearTimeout(id)
  }
  setInterval(fn: () => void, ms: number): number {
    return this.inner.setInterval(() => this.#enter(fn), ms)
  }
  clearInterval(id: number): void {
    this.inner.clearInterval(id)
  }
}
