import { describe, expect, test } from 'bun:test'
import { modelById } from '../device/models.js'
import { encodeBrightness, encodeKeyImagePackets, encodeReset, parseInputReport } from '../device/protocol.js'
import { VirtualTransport, type VirtualHandle } from './virtual.js'

const mk2 = modelById('mk2')!

async function open(): Promise<VirtualHandle> {
  const transport = new VirtualTransport(mk2)
  await transport.open('virtual:0')
  return transport.handle
}

describe('VirtualTransport', () => {
  test('lists one virtual device with the model resolved', async () => {
    const transport = new VirtualTransport(mk2)
    const devices = await transport.list()
    expect(devices.length).toBe(1)
    expect(devices[0].model).toBe('mk2')
    expect(devices[0].vendorId).toBe(0x0fd9)
  })

  test('un-frames multi-packet key images back to the original bytes', async () => {
    const handle = await open()
    const jpeg = new Uint8Array(3000).map((_, i) => i % 251)
    for (const packet of encodeKeyImagePackets(mk2, 4, jpeg)) {
      await handle.writeOutput(packet)
    }
    const stored = handle.keyImages.get(4)
    expect(stored).toBeDefined()
    expect(Buffer.compare(Buffer.from(stored!), Buffer.from(jpeg))).toBe(0)
  })

  test('rejects reports that are not exactly packetSize', async () => {
    const handle = await open()
    expect(handle.writeOutput(new Uint8Array(10))).rejects.toThrow('packetSize')
  })

  test('records brightness and reset feature calls; reset clears images', async () => {
    const handle = await open()
    await handle.sendFeature(encodeBrightness(55))
    expect(handle.brightness).toBe(55)
    const jpeg = new Uint8Array(100).fill(1)
    for (const packet of encodeKeyImagePackets(mk2, 0, jpeg)) await handle.writeOutput(packet)
    expect(handle.keyImages.size).toBe(1)
    await handle.sendFeature(encodeReset())
    expect(handle.resetCount).toBe(1)
    expect(handle.keyImages.size).toBe(0)
  })

  test('pressKey/releaseKey synthesize parseable input reports', async () => {
    const handle = await open()
    const seen: Array<boolean[] | null> = []
    handle.onInput((report) => seen.push(parseInputReport(mk2, report)))
    handle.pressKey(2)
    handle.releaseKey(2)
    expect(seen.length).toBe(2)
    expect(seen[0]?.[2]).toBe(true)
    expect(seen[1]?.[2]).toBe(false)
  })

  test('out-of-range press throws', async () => {
    const handle = await open()
    expect(() => handle.pressKey(99)).toThrow('out of range')
  })
})
