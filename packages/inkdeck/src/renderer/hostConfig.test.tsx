// Host-tree mutation semantics: React moves keyed children by re-inserting
// them without a removeChild, so inserts must be idempotent moves.

import { describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { modelById } from '../device/models.js'
import { VirtualTransport } from '../transport/virtual.js'
import { buildManifest } from '../harness/manifest.js'
import { Deck, Key } from './components.js'
import { DeckController } from './controller.js'

const mk2 = modelById('mk2')!

async function mount(element: React.ReactNode) {
  const transport = new VirtualTransport(mk2)
  const handle = await transport.open('virtual:0')
  const controller = new DeckController({ model: mk2, handle, serial: transport.serial })
  await controller.start()
  controller.render(element)
  await controller.settled()
  return controller
}

let setOrder: (o: string[]) => void = () => {}

function KeyedText() {
  const [order, set] = useState(['A', 'B', 'C'])
  setOrder = set
  return (
    <Deck>
      <Key position={0}>
        <div className="flex">
          {order.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </Key>
    </Deck>
  )
}

function KeyedKeys() {
  const [order, set] = useState(['A', 'B', 'C'])
  setOrder = set
  return (
    <Deck>
      {order.map((t, i) => (
        <Key key={t} position={i}>
          <span>{t}</span>
        </Key>
      ))}
    </Deck>
  )
}

describe('hostConfig keyed reorder', () => {
  test('reordering keyed content inside a <Key> keeps one node per child, in the new order', async () => {
    const controller = await mount(<KeyedText />)
    expect(buildManifest(controller).keys[0]!.text).toEqual(['A', 'B', 'C'])
    setOrder(['C', 'A', 'B'])
    await controller.settled()
    expect(buildManifest(controller).keys[0]!.text).toEqual(['C', 'A', 'B'])
    setOrder(['B', 'C', 'A'])
    await controller.settled()
    expect(buildManifest(controller).keys[0]!.text).toEqual(['B', 'C', 'A'])
    await controller.shutdown()
  })

  test('reordering keyed <Key>s under <Deck> does not duplicate host elements', async () => {
    const controller = await mount(<KeyedKeys />)
    setOrder(['C', 'A', 'B'])
    await controller.settled()
    // Before the fix the same HostElement sat in `children` twice and the
    // commit walk threw "two <Key> elements are mounted with position=…".
    const manifest = buildManifest(controller)
    expect(manifest.keys.length).toBe(3)
    expect(manifest.keys.map((k) => k.text[0])).toEqual(['C', 'A', 'B'])
    await controller.shutdown()
  })
})
