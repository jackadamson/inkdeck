// Gen-2 Stream Deck HID report framing.
//
// Transcribed from github.com/Julusian/node-elgato-stream-deck (MIT, fetched 2026-07-31):
//   - image packet header: packages/core/src/services/imageWriter/headerGenerator.ts
//     (StreamdeckGen2ImageHeaderGenerator: 8-byte header
//      [0x02, 0x07, keyIndex, isLast, bodyLenLE(2), partIndexLE(2)])
//   - brightness/reset:    packages/core/src/services/properties/gen2.ts
//     (feature reports [0x03, 0x08, percent, 0…] and [0x03, 0x02, 0…], 32 bytes)
//   - input report layout: packages/core/src/services/input/{gen1,gen2}.ts +
//     packages/node/src/hid-device.ts — the raw report is
//     [reportId=0x01, inputType, …, keyStates] and node-hid strips the report ID
//     before Gen2InputService sees data with KEY_DATA_OFFSET = 3
//     (generic-gen2.ts), so in the *raw* report keys start at byte 1 + 3 = 4.
//
// Verified on an XL (M2): image packets, brightness, reset and input reports.

import type { Model } from './models.js'

export const IMAGE_HEADER_LENGTH = 8
export const FEATURE_REPORT_LENGTH = 32
export const INPUT_REPORT_ID = 0x01
export const INPUT_TYPE_BUTTON = 0x00
export const KEY_DATA_OFFSET_RAW = 4 // 1 (report ID) + KEY_DATA_OFFSET 3

/**
 * Split encoded key image bytes (JPEG for gen-2) into fixed-size output
 * reports. Every packet is exactly `model.packetSize` bytes, zero padded,
 * report ID 0x02 in the first byte.
 */
export function encodeKeyImagePackets(model: Model, keyIndex: number, image: Uint8Array): Uint8Array[] {
  const maxPayload = model.packetSize - IMAGE_HEADER_LENGTH
  const packets: Uint8Array[] = []
  let offset = 0
  let part = 0
  do {
    const body = image.subarray(offset, offset + maxPayload)
    offset += body.length
    const isLast = offset >= image.length
    const packet = new Uint8Array(model.packetSize)
    const view = new DataView(packet.buffer)
    view.setUint8(0, 0x02)
    view.setUint8(1, 0x07)
    view.setUint8(2, keyIndex)
    view.setUint8(3, isLast ? 1 : 0)
    view.setUint16(4, body.length, true)
    view.setUint16(6, part, true)
    packet.set(body, IMAGE_HEADER_LENGTH)
    packets.push(packet)
    part++
  } while (offset < image.length)
  return packets
}

/** Feature report setting panel brightness (0–100%). */
export function encodeBrightness(percent: number): Uint8Array {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const report = new Uint8Array(FEATURE_REPORT_LENGTH)
  report[0] = 0x03
  report[1] = 0x08
  report[2] = clamped
  return report
}

/** Feature report resetting the deck to the Elgato logo. Sent on startup and clean shutdown. */
export function encodeReset(): Uint8Array {
  const report = new Uint8Array(FEATURE_REPORT_LENGTH)
  report[0] = 0x03
  report[1] = 0x02
  return report
}

/**
 * Parse a raw input report (report ID included as byte 0). Returns one boolean
 * per key position, or null when the report is not a button state report.
 */
export function parseInputReport(model: Model, report: Uint8Array): boolean[] | null {
  if (report[0] !== INPUT_REPORT_ID) return null
  if (report[1] !== INPUT_TYPE_BUTTON) return null // 0x02 LCD / 0x03 encoder / 0x04 NFC are [P1]
  const keyCount = model.columns * model.rows
  const states: boolean[] = new Array(keyCount)
  for (let i = 0; i < keyCount; i++) {
    states[i] = Boolean(report[KEY_DATA_OFFSET_RAW + i])
  }
  return states
}

/** Build a raw button input report — used by VirtualTransport to synthesize presses. */
export function buildInputReport(model: Model, states: boolean[]): Uint8Array {
  const keyCount = model.columns * model.rows
  const report = new Uint8Array(KEY_DATA_OFFSET_RAW + keyCount)
  report[0] = INPUT_REPORT_ID
  report[1] = INPUT_TYPE_BUTTON
  report[2] = keyCount & 0xff
  for (let i = 0; i < keyCount; i++) {
    report[KEY_DATA_OFFSET_RAW + i] = states[i] ? 1 : 0
  }
  return report
}
