// Unplug/replug behavior: one device-lost event, no per-key error flood,
// state survives, replaceHandle repaints everything on the new handle.

import { describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { modelById } from '../device/models.js'
import { VirtualTransport } from '../transport/virtual.js'
import { DeviceDisconnectedError } from '../transport/iface.js'
import type { Logger } from './logger.js'
import { Deck, Key } from './components.js'
import { DeckController } from './controller.js'

const mk2 = modelById('mk2')!

function TwoKeys() {
  const [count, setCount] = useState(0)
  return (
    <Deck>
      <Key position={0} onPress={() => setCount((c) => c + 1)}>
        <span className="text-white">count {count}</span>
      </Key>
      <Key position={1}>
        <span className="text-white">static</span>
      </Key>
    </Deck>
  )
}

async function mountTwoKeys(logger?: Logger) {
  const transport = new VirtualTransport(mk2)
  const handle = await transport.open('virtual:0')
  const controller = new DeckController({ model: mk2, handle, serial: transport.serial, logger })
  await controller.start()
  controller.render(<TwoKeys />)
  await controller.settled()
  return { controller, handle: transport.handle }
}

describe('device unplug/replug', () => {
  test('disconnect fires onDeviceLost once and silences pushes — no error flood', async () => {
    const errors: string[] = []
    const { controller, handle } = await mountTwoKeys({ error: (line) => errors.push(line) })
    let lost = 0
    controller.onDeviceLost(() => lost++)

    handle.simulateDisconnect()
    expect(lost).toBe(1)
    expect(controller.detached).toBe(true)

    // App keeps rendering while detached (press via state change): no
    // writes, no "push failed" spam.
    controller.render(<TwoKeys key="force-remount" />)
    await controller.settled()
    expect(errors.filter((e) => e.includes('failed'))).toEqual([])
    await controller.shutdown()
  })

  test('replaceHandle reattaches: reset + brightness resent, all keys repaint, input works', async () => {
    const { controller, handle } = await mountTwoKeys()
    handle.simulateDisconnect()
    expect(controller.detached).toBe(true)

    const replug = new VirtualTransport(mk2)
    await replug.open('virtual:0')
    const newHandle = replug.handle
    await controller.replaceHandle(newHandle)
    await controller.settled()

    expect(controller.detached).toBe(false)
    // Reset-on-attach clears, then every mounted key is repainted.
    expect(newHandle.resetCount).toBe(1)
    expect(newHandle.brightnessCalls.length).toBeGreaterThan(0)
    expect(newHandle.keyImages.has(0)).toBe(true)
    expect(newHandle.keyImages.has(1)).toBe(true)

    // React state survived the unplug, and input flows through the new handle.
    const before = controller.keySnapshots().find((s) => s.position === 0)!.text
    expect(before).toEqual(['count ', '0'])
    newHandle.pressKey(0)
    newHandle.releaseKey(0)
    await controller.settled()
    expect(controller.keySnapshots().find((s) => s.position === 0)!.text).toEqual(['count ', '1'])
    await controller.shutdown()
  })

  test('a handshake failure during replaceHandle leaves the controller detached and silent', async () => {
    const { controller, handle } = await mountTwoKeys()
    handle.simulateDisconnect()

    const replug = new VirtualTransport(mk2)
    await replug.open('virtual:0')
    const flaky = replug.handle
    flaky.simulateDisconnect() // gone again before reset/brightness land
    await expect(controller.replaceHandle(flaky)).rejects.toBeInstanceOf(DeviceDisconnectedError)
    expect(controller.detached).toBe(true)

    // A second, healthy replug still works.
    const again = new VirtualTransport(mk2)
    await again.open('virtual:0')
    await controller.replaceHandle(again.handle)
    await controller.settled()
    expect(controller.detached).toBe(false)
    expect(again.handle.keyImages.has(0)).toBe(true)
    await controller.shutdown()
  })

  test('input from the stale handle is ignored after replaceHandle', async () => {
    const { controller, handle } = await mountTwoKeys()
    handle.simulateDisconnect()
    const replug = new VirtualTransport(mk2)
    await replug.open('virtual:0')
    await controller.replaceHandle(replug.handle)
    await controller.settled()

    // The old handle can no longer inject presses (a ghost press would be
    // command execution — same threat model as §16).
    handle.pressKey(0)
    handle.releaseKey(0)
    await controller.settled()
    expect(controller.keySnapshots().find((s) => s.position === 0)!.text).toEqual(['count ', '0'])
    await controller.shutdown()
  })
})
