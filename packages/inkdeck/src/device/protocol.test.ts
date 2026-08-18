import { describe, expect, test } from 'bun:test'
import { modelById } from './models.js'
import { buildInputReport, encodeBrightness, encodeKeyImagePackets, encodeReset, parseInputReport } from './protocol.js'

const mk2 = modelById('mk2')!

describe('gen2 framing', () => {
  test('image packets carry the 8-byte header and are padded to packetSize', () => {
    const image = new Uint8Array(2500).fill(0xab)
    const packets = encodeKeyImagePackets(mk2, 7, image)
    // 2500 bytes / (1024 - 8) payload ⇒ 3 packets
    expect(packets.length).toBe(3)
    for (const [i, packet] of packets.entries()) {
      expect(packet.length).toBe(mk2.packetSize)
      expect(packet[0]).toBe(0x02)
      expect(packet[1]).toBe(0x07)
      expect(packet[2]).toBe(7)
      const view = new DataView(packet.buffer)
      expect(view.getUint16(6, true)).toBe(i)
    }
    expect(packets[0][3]).toBe(0)
    expect(packets[2][3]).toBe(1) // isLast
    const lastLen = new DataView(packets[2].buffer).getUint16(4, true)
    expect(lastLen).toBe(2500 - 2 * (1024 - 8))
  })

  test('an empty image still produces one (last) packet', () => {
    const packets = encodeKeyImagePackets(mk2, 0, new Uint8Array(0))
    expect(packets.length).toBe(1)
    expect(packets[0][3]).toBe(1)
  })

  test('brightness feature report', () => {
    const report = encodeBrightness(80)
    expect(report.length).toBe(32)
    expect([...report.slice(0, 3)]).toEqual([0x03, 0x08, 80])
    expect(encodeBrightness(150)[2]).toBe(100)
    expect(encodeBrightness(-5)[2]).toBe(0)
  })

  test('reset feature report', () => {
    const report = encodeReset()
    expect(report.length).toBe(32)
    expect([...report.slice(0, 3)]).toEqual([0x03, 0x02, 0x00])
  })

  test('input report round-trip', () => {
    const states = new Array(15).fill(false)
    states[3] = true
    states[14] = true
    const report = buildInputReport(mk2, states)
    expect(report[0]).toBe(0x01)
    const parsed = parseInputReport(mk2, report)
    expect(parsed).toEqual(states)
  })

  test('non-button reports are ignored', () => {
    const report = buildInputReport(mk2, new Array(15).fill(false))
    report[1] = 0x03 // encoder
    expect(parseInputReport(mk2, report)).toBeNull()
    report[0] = 0x05 // not an input report
    expect(parseInputReport(mk2, report)).toBeNull()
  })
})
