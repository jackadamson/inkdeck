import { describe, expect, test } from 'bun:test'
import { FrozenClock } from './clock.js'

describe('FrozenClock', () => {
  test('fires due timers in time order and moves now() to each due time', () => {
    const clock = new FrozenClock()
    const log: string[] = []
    clock.setTimeout(() => log.push(`b@${clock.now()}`), 20)
    clock.setTimeout(() => log.push(`a@${clock.now()}`), 10)
    const interval = clock.setInterval(() => log.push(`i@${clock.now()}`), 15)
    clock.advance(30)
    expect(log).toEqual(['a@10', 'i@15', 'b@20', 'i@30'])
    expect(clock.now()).toBe(30)
    clock.clearInterval(interval)
    clock.advance(100)
    expect(log.length).toBe(4)
  })

  test('a timer scheduled from a callback fires within the same advance if due', () => {
    const clock = new FrozenClock()
    const log: number[] = []
    clock.setTimeout(() => {
      log.push(clock.now())
      clock.setTimeout(() => log.push(clock.now()), 5)
    }, 10)
    clock.advance(20)
    expect(log).toEqual([10, 15])
  })

  test('cleared timeouts never fire; advance(0) fires nothing new', () => {
    const clock = new FrozenClock()
    let fired = 0
    const id = clock.setTimeout(() => fired++, 5)
    clock.clearTimeout(id)
    clock.advance(0)
    clock.advance(10)
    expect(fired).toBe(0)
  })
})
