// M1 acceptance behaviors (SPEC §13 M1): scene extraction, dirty diffing,
// output dedup, duplicate-position throw with both stacks, per-key error tile,
// out-of-range warning, press handling through the virtual transport.

import { describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { modelById } from '../device/models.js'
import { VirtualTransport } from '../transport/virtual.js'
import { Deck, Key } from './components.js'
import { DeckController } from './controller.js'
import { buildManifest } from '../harness/manifest.js'
import type { Clock } from './clock.js'
import { FrozenClock } from './clock.js'
import type { Logger } from './logger.js'

const mk2 = modelById('mk2')!

async function mount(element: React.ReactNode, clock?: Clock, logger?: Logger) {
  const transport = new VirtualTransport(mk2)
  const handle = await transport.open('virtual:0')
  const controller = new DeckController({ model: mk2, handle, serial: transport.serial, clock, logger })
  await controller.start()
  controller.render(element)
  await controller.settled()
  return { controller, handle: transport.handle }
}

describe('headless renderer', () => {
  test('renders keys, pushes JPEGs, and builds a §11.1 manifest', async () => {
    const { controller, handle } = await mount(
      <Deck>
        <Key position={0} onPress={() => {}}>
          <div className="flex h-full w-full flex-col items-center justify-center bg-[#0a7d33]">
            <span className="text-[12px] text-white/70">mic</span>
            <span className="text-[20px] font-bold text-white">LIVE</span>
          </div>
        </Key>
        <Key position={3}>
          <div className="h-full w-full bg-[#1d4ed8]" />
        </Key>
      </Deck>,
    )

    expect(handle.keyImages.has(0)).toBe(true)
    expect(handle.keyImages.has(3)).toBe(true)
    // JPEG magic
    expect(handle.keyImages.get(0)![0]).toBe(0xff)
    expect(handle.keyImages.get(0)![1]).toBe(0xd8)

    const manifest = buildManifest(controller)
    expect(manifest.model).toBe('mk2')
    expect(manifest.columns).toBe(5)
    expect(manifest.rows).toBe(3)
    const key0 = manifest.keys.find((k) => k.position === 0)!
    expect(key0.text).toEqual(['mic', 'LIVE'])
    expect(key0.error).toBeNull()
    expect(key0.hasPress).toBe(true)
    expect(key0.hasLongPress).toBe(false)
    expect(key0.hash).toBeTruthy()
    expect(key0.image).toBe('key-0.png')
    await controller.shutdown()
  })

  test('reset is sent on startup and shutdown', async () => {
    const { controller, handle } = await mount(
      <Deck>
        <Key position={0} />
      </Deck>,
    )
    expect(handle.resetCount).toBe(1)
    await controller.shutdown()
    expect(handle.resetCount).toBe(2)
    expect(handle.closed).toBe(true)
  })

  test('duplicate position throws at commit with both component stacks', async () => {
    const transport = new VirtualTransport(mk2)
    const handle = await transport.open('virtual:0')
    const controller = new DeckController({ model: mk2, handle })
    await controller.start()
    controller.render(
      <Deck>
        <Key position={2} />
        <Key position={2} />
      </Deck>,
    )
    let error: Error | null = null
    try {
      await controller.settled()
    } catch (e) {
      error = e as Error
    }
    expect(error).not.toBeNull()
    expect(error!.message).toContain('position={2}')
    expect(error!.message).toContain('First:')
    expect(error!.message).toContain('Second:')
    expect(error!.message.match(/<Key> mounted here/g)?.length).toBe(2)
    await controller.shutdown()
  })

  test('a throwing component paints the error tile on its key only', async () => {
    function Boom(): never {
      throw new Error('kaboom')
    }
    const { controller, handle } = await mount(
      <Deck>
        <Key position={0}>
          <Boom />
        </Key>
        <Key position={1}>
          <span className="text-white">fine</span>
        </Key>
      </Deck>,
    )
    const manifest = buildManifest(controller)
    const key0 = manifest.keys.find((k) => k.position === 0)!
    const key1 = manifest.keys.find((k) => k.position === 1)!
    expect(key0.error).toContain('kaboom')
    expect(key1.error).toBeNull()
    expect(key1.text).toEqual(['fine'])
    // Both keys still rendered pixels (key 0 shows the fallback tile).
    expect(handle.keyImages.has(0)).toBe(true)
    expect(handle.keyImages.has(1)).toBe(true)
    await controller.shutdown()
  })

  test('out-of-range position warns once and is not rendered', async () => {
    const errors: string[] = []
    const { controller, handle } = await mount(
      <Deck>
        <Key position={99}>
          <span>ghost</span>
        </Key>
        <Key position={0}>
          <span>ok</span>
        </Key>
      </Deck>,
      undefined,
      { error: (line) => errors.push(line) },
    )
    expect(handle.keyImages.has(0)).toBe(true)
    const warnings = errors.filter((e) => e.includes('position={99}'))
    expect(warnings.length).toBe(1)
    const manifest = buildManifest(controller)
    expect(manifest.keys.some((k) => k.position === 99)).toBe(false)
    await controller.shutdown()
  })

  test('press toggles state through the virtual transport; pixels update', async () => {
    function Toggle() {
      const [on, setOn] = useState(false)
      return (
        <Deck>
          <Key position={0} onPress={() => setOn((v) => !v)}>
            <div className={`h-full w-full ${on ? 'bg-[#ff0000]' : 'bg-[#00ff00]'}`}>
              <span className="text-white">{on ? 'ON' : 'OFF'}</span>
            </div>
          </Key>
        </Deck>
      )
    }
    const { controller, handle } = await mount(<Toggle />)
    const before = handle.keyImages.get(0)!
    expect(buildManifest(controller).keys[0].text).toEqual(['OFF'])

    handle.pressKey(0)
    handle.releaseKey(0)
    await controller.settled()

    expect(buildManifest(controller).keys[0].text).toEqual(['ON'])
    const after = handle.keyImages.get(0)!
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).not.toBe(0)
    await controller.shutdown()
  })

  test('output dedup: a re-render with identical pixels skips the push', async () => {
    let renders = 0
    function Same() {
      const [, setTick] = useState(0)
      renders++
      return (
        <Deck>
          <Key position={0} onPress={() => setTick((t) => t + 1)}>
            {/* tick is intentionally not shown: pixels never change */}
            <span className="text-white">static</span>
          </Key>
        </Deck>
      )
    }
    const { controller, handle } = await mount(<Same />)
    const changed: number[][] = []
    controller.onRendered((positions) => changed.push(positions))
    handle.pressKey(0)
    handle.releaseKey(0)
    await controller.settled()
    expect(renders).toBeGreaterThan(1)
    // Scene unchanged ⇒ no raster scheduled ⇒ no rendered event, no extra push.
    expect(changed.length).toBe(0)
    await controller.shutdown()
  })

  test('unmounted keys are cleared to black', async () => {
    function Hide() {
      const [show, setShow] = useState(true)
      return (
        <Deck>
          <Key position={1} onPress={() => setShow(false)} />
          {show && (
            <Key position={0}>
              <span className="text-white">here</span>
            </Key>
          )}
        </Deck>
      )
    }
    const { controller, handle } = await mount(<Hide />)
    expect(buildManifest(controller).keys.some((k) => k.position === 0)).toBe(true)
    handle.pressKey(1)
    handle.releaseKey(1)
    await controller.settled()
    expect(buildManifest(controller).keys.some((k) => k.position === 0)).toBe(false)
    await controller.shutdown()
  })

  test('long press fires onLongPress; short press fires onPress', async () => {
    const events: string[] = []
    const { controller, handle } = await mount(
      <Deck>
        <Key
          position={0}
          onPress={() => {
            events.push('press')
          }}
          onLongPress={() => {
            events.push('long')
          }}
          longPressMs={50}
        />
      </Deck>,
    )
    // Short press: released before the threshold. With a long-press armed,
    // onPress fires on the (debounced) release.
    handle.pressKey(0)
    handle.releaseKey(0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(events).toEqual(['press'])

    // Long press: held past the threshold.
    handle.pressKey(0)
    await new Promise((resolve) => setTimeout(resolve, 80))
    handle.releaseKey(0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(events).toEqual(['press', 'long'])
    await controller.shutdown()
  })

  test('re-render repaints only the keys whose pixels changed (M4 hot-reload contract)', async () => {
    const app = (label: string) => (
      <Deck>
        <Key position={0}>
          <span className="text-white">stable</span>
        </Key>
        <Key position={1}>
          <span className="text-white">{label}</span>
        </Key>
      </Deck>
    )
    const { controller } = await mount(app('one'))
    const repainted: number[] = []
    controller.onRendered((changed) => repainted.push(...changed))

    // Same content ⇒ scene hashes match ⇒ nothing repaints.
    controller.render(app('one'))
    await controller.settled()
    expect(repainted).toEqual([])

    // One key's content changes ⇒ only that key repaints.
    controller.render(app('two'))
    await controller.settled()
    expect(repainted).toEqual([1])
    await controller.shutdown()
  })

  test('contact bounce is debounced: a release is deferred by the window and a re-press cancels it', async () => {
    const clock = new FrozenClock()
    let presses = 0
    const { controller, handle } = await mount(
      <Deck>
        <Key position={0} onPress={() => presses++} />
      </Deck>,
      clock,
    )
    // Clean press.
    handle.pressKey(0)
    expect(presses).toBe(1)
    clock.advance(100)
    // Release followed by a bounce re-press 5 ms later: still held.
    handle.releaseKey(0)
    clock.advance(5)
    handle.pressKey(0)
    expect(presses).toBe(1)
    expect(controller.isPressed(0)).toBe(true)
    // A real release commits after the window; then a real press fires again.
    handle.releaseKey(0)
    clock.advance(30)
    expect(controller.isPressed(0)).toBe(false)
    handle.pressKey(0)
    expect(presses).toBe(2)
    handle.releaseKey(0)
    clock.advance(30)
    expect(controller.isPressed(0)).toBe(false)
    await controller.shutdown()
  })

  test('a bounce mid-hold does not break long-press or useKeyState', async () => {
    const clock = new FrozenClock()
    const events: string[] = []
    const { controller, handle } = await mount(
      <Deck>
        <Key position={0} onPress={() => events.push('press')} onLongPress={() => events.push('long')} />
      </Deck>,
      clock,
    )
    handle.pressKey(0)
    clock.advance(100)
    handle.releaseKey(0) // bounce
    clock.advance(3)
    handle.pressKey(0)
    expect(controller.isPressed(0)).toBe(true)
    clock.advance(2000)
    expect(events).toEqual(['long'])
    handle.releaseKey(0)
    clock.advance(30)
    expect(controller.isPressed(0)).toBe(false)
    expect(events).toEqual(['long'])
    await controller.shutdown()
  })

  test('a commit error is reported once; the next good render settles cleanly', async () => {
    const bad = (
      <Deck>
        <Key position={0} />
        <Key position={0} />
      </Deck>
    )
    const good = (
      <Deck>
        <Key position={0}>
          <span className="text-white">ok</span>
        </Key>
      </Deck>
    )
    const transport = new VirtualTransport(mk2)
    const handle = await transport.open('virtual:0')
    const controller = new DeckController({ model: mk2, handle })
    await controller.start()
    controller.render(bad)
    await expect(controller.settled()).rejects.toThrow('two <Key> elements')
    controller.render(good)
    await controller.settled()
    expect(buildManifest(controller).keys[0]!.text).toEqual(['ok'])
    await controller.shutdown()
  })

  test('rendered fires per flush round under continuous animation', async () => {
    function Ticker() {
      const [n, setN] = useState(0)
      // Commit faster than the flush loop can rasterize.
      if (n < 40) setTimeout(() => setN(n + 1), 1)
      return (
        <Deck>
          <Key position={0}>
            <span className="text-white">{String(n)}</span>
          </Key>
        </Deck>
      )
    }
    const transport = new VirtualTransport(mk2)
    const handle = await transport.open('virtual:0')
    const controller = new DeckController({ model: mk2, handle })
    await controller.start()
    let rounds = 0
    controller.onRendered(() => rounds++)
    controller.render(<Ticker />)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(rounds).toBeGreaterThan(1)
    await controller.settled()
    await controller.shutdown()
  })

  test('a raster failure is recorded on the key and paints the error tile', async () => {
    const { controller, handle } = await mount(
      <Deck>
        <Key position={0}>
          <img src="does-not-exist.png" />
        </Key>
      </Deck>,
    )
    const key = buildManifest(controller).keys[0]!
    expect(key.error).toContain('raster failed')
    expect(handle.keyImages.has(0)).toBe(true)
    await controller.shutdown()
  })
})
