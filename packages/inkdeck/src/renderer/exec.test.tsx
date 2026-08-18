// exec() interception is scoped per session (SPEC §11.3): two live sessions
// with different mock tables never answer each other, shutting one down does
// not strip the other's mocks, and a mocked session never reaches Bun.spawn.

import { describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { Deck, Key, exec, usePoller } from '../index.js'
import { renderDeck } from '../testing.js'

function Reader({ pollMs }: { pollMs: number }) {
  const [value, setValue] = useState('?')
  usePoller(async () => {
    const { stdout } = await exec(['probe'])
    setValue(stdout.trim())
  }, pollMs)
  return (
    <Deck>
      <Key
        position={0}
        onPress={async () => {
          const { stdout } = await exec(['probe'])
          setValue(`pressed:${stdout.trim()}`)
        }}
      >
        <span className="text-white">{value}</span>
      </Key>
    </Deck>
  )
}

describe('session-scoped exec', () => {
  test('two concurrent sessions each see only their own mocks; survivor keeps its mocks after the other shuts down', async () => {
    const a = await renderDeck(<Reader pollMs={200} />, {
      freezeTime: true,
      mockExec: [{ match: 'probe', stdout: 'A' }],
    })
    const b = await renderDeck(<Reader pollMs={200} />, {
      freezeTime: true,
      mockExec: [{ match: 'probe', stdout: 'B' }],
    })
    await a.settled()
    await b.settled()
    expect(a.key(0).text).toEqual(['A'])
    expect(b.key(0).text).toEqual(['B'])

    // Handlers run in scope too.
    await a.tap(0)
    await a.settled()
    expect(a.key(0).text).toEqual(['pressed:A'])

    // Pollers on the frozen clock run in scope.
    a.advanceTime(200)
    b.advanceTime(200)
    await a.settled()
    await b.settled()
    expect(a.key(0).text).toEqual(['A'])
    expect(b.key(0).text).toEqual(['B'])

    await b.shutdown()
    // A must not fall through to a real spawn now that B is gone.
    a.advanceTime(200)
    await a.settled()
    expect(a.key(0).text).toEqual(['A'])
    expect(a.unmatchedExecs).toEqual([])
    await a.shutdown()
  })

  test('unmatched commands in a mocked session resolve 127 and are reported, never spawned', async () => {
    const deck = await renderDeck(<Reader pollMs={1000} />, {
      freezeTime: true,
      mockExec: [{ match: 'something-else', stdout: 'x' }],
    })
    await deck.settled()
    expect(deck.key(0).text).toEqual([])
    expect(deck.unmatchedExecs).toEqual(['probe'])
    await deck.shutdown()
  })
})
