import { describe, expect, test } from 'bun:test'
import { FrozenClock } from '../renderer/clock.js'
import { createMockExecInterceptor, normalizeMockExecConfig } from './mockExec.js'

describe('mockExec', () => {
  test('exact match, regex match, first hit wins, unmatched ⇒ 127 + report', async () => {
    const unmatched: string[] = []
    const intercept = createMockExecInterceptor(
      normalizeMockExecConfig(
        [
          { match: 'git status', stdout: 'clean' },
          { match: '^git .*', regex: true, stdout: 'any-git', exitCode: 3 },
        ],
        'test',
      ),
      { clock: new FrozenClock(), onUnmatched: (c) => unmatched.push(c) },
    )
    expect(await intercept(['git', 'status'])).toEqual({ stdout: 'clean', stderr: '', exitCode: 0 })
    expect(await intercept(['git', 'log'])).toEqual({ stdout: 'any-git', stderr: '', exitCode: 3 })
    const miss = await intercept(['ls'])
    expect(miss?.exitCode).toBe(127)
    expect(unmatched).toEqual(['ls'])
  })

  test('delayMs resolves on the harness clock', async () => {
    const clock = new FrozenClock()
    const intercept = createMockExecInterceptor(
      normalizeMockExecConfig({ mocks: [{ match: 'slow', stdout: 'done', delayMs: 100 }] }, 'test'),
      { clock },
    )
    let settled = false
    const pending = Promise.resolve(intercept(['slow'])).then((r) => {
      settled = true
      return r
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    clock.advance(100)
    expect((await pending)?.stdout).toBe('done')
  })

  test('normalizeMockExecConfig rejects malformed tables', () => {
    expect(() => normalizeMockExecConfig({ nope: [] }, 'x')).toThrow('expected')
    expect(() => normalizeMockExecConfig([{ stdout: 'no match' }], 'x')).toThrow('missing a string "match"')
  })
})
