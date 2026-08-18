// In-process fake transport (SPEC §4.3) used by `render`, `agent`, `check` and
// the browser simulator. Sits *below* the protocol layer: it consumes the same
// framed bytes as hardware and un-frames them, so the full pipeline is
// exercised headlessly.

import type { Model } from '../device/models.js'
import { VENDOR_ID } from '../device/models.js'
import { buildInputReport, FEATURE_REPORT_LENGTH, IMAGE_HEADER_LENGTH } from '../device/protocol.js'
import { DeviceDisconnectedError, type DeviceInfo, type Transport, type TransportHandle } from './iface.js'

export class VirtualTransport implements Transport {
  readonly model: Model
  readonly serial: string
  #handle: VirtualHandle | null = null

  constructor(model: Model, serial = `VIRTUAL-${model.id.toUpperCase()}`) {
    this.model = model
    this.serial = serial
  }

  async list(): Promise<DeviceInfo[]> {
    return [
      {
        path: 'virtual:0',
        vendorId: VENDOR_ID,
        productId: this.model.productIds[0],
        serial: this.serial,
        model: this.model.id,
      },
    ]
  }

  async open(path: string): Promise<TransportHandle> {
    if (path !== 'virtual:0') throw new Error(`[inkdeck] VirtualTransport: unknown path "${path}"`)
    this.#handle = new VirtualHandle(this.model)
    return this.#handle
  }

  /** The currently open handle; throws if open() has not been called. */
  get handle(): VirtualHandle {
    if (!this.#handle) throw new Error('[inkdeck] VirtualTransport: no open handle')
    return this.#handle
  }
}

interface PendingImage {
  parts: Uint8Array[]
  nextPart: number
}

/** Open a virtual deck in one call: the handle plus the serial it reports. */
export async function openVirtualDeck(model: Model): Promise<{ handle: VirtualHandle; serial: string }> {
  const transport = new VirtualTransport(model)
  await transport.open('virtual:0')
  return { handle: transport.handle, serial: transport.serial }
}

export class VirtualHandle implements TransportHandle {
  readonly model: Model
  /** Last complete image (JPEG bytes) written per key index. */
  readonly keyImages = new Map<number, Uint8Array>()
  /** Recorded brightness percentages, in order. */
  readonly brightnessCalls: number[] = []
  /** Number of reset feature reports received. */
  resetCount = 0
  closed = false

  #pending = new Map<number, PendingImage>()
  #inputCbs: Array<(report: Uint8Array) => void> = []
  #disconnectCbs: Array<() => void> = []
  #disconnected = false
  #keyStates: boolean[]

  constructor(model: Model) {
    this.model = model
    this.#keyStates = new Array(model.columns * model.rows).fill(false)
  }

  async writeOutput(report: Uint8Array): Promise<void> {
    this.#assertOpen()
    if (report.length !== this.model.packetSize) {
      throw new Error(
        `[inkdeck] VirtualTransport: output report is ${report.length} bytes, expected packetSize ${this.model.packetSize}`,
      )
    }
    if (report[0] !== 0x02 || report[1] !== 0x07) {
      throw new Error(`[inkdeck] VirtualTransport: unrecognized output report [${report[0]}, ${report[1]}]`)
    }
    const view = new DataView(report.buffer, report.byteOffset)
    const keyIndex = view.getUint8(2)
    const isLast = view.getUint8(3) === 1
    const bodyLength = view.getUint16(4, true)
    const partIndex = view.getUint16(6, true)

    let pending = this.#pending.get(keyIndex)
    if (!pending) {
      pending = { parts: [], nextPart: 0 }
      this.#pending.set(keyIndex, pending)
    }
    if (partIndex !== pending.nextPart) {
      this.#pending.delete(keyIndex)
      throw new Error(`[inkdeck] VirtualTransport: key ${keyIndex} got part ${partIndex}, expected ${pending.nextPart}`)
    }
    pending.parts.push(report.slice(IMAGE_HEADER_LENGTH, IMAGE_HEADER_LENGTH + bodyLength))
    pending.nextPart++

    if (isLast) {
      this.#pending.delete(keyIndex)
      const total = pending.parts.reduce((n, p) => n + p.length, 0)
      const image = new Uint8Array(total)
      let offset = 0
      for (const part of pending.parts) {
        image.set(part, offset)
        offset += part.length
      }
      this.keyImages.set(keyIndex, image)
    }
  }

  async sendFeature(report: Uint8Array): Promise<void> {
    this.#assertOpen()
    if (report[0] === 0x03 && report[1] === 0x08) {
      this.brightnessCalls.push(report[2])
      return
    }
    if (report[0] === 0x03 && report[1] === 0x02) {
      this.resetCount++
      this.keyImages.clear()
      return
    }
    throw new Error(`[inkdeck] VirtualTransport: unrecognized feature report [${report[0]}, ${report[1]}]`)
  }

  async getFeature(_reportId: number, length: number): Promise<Uint8Array> {
    this.#assertOpen()
    return new Uint8Array(Math.max(length, FEATURE_REPORT_LENGTH))
  }

  onInput(cb: (report: Uint8Array) => void): void {
    this.#inputCbs.push(cb)
  }

  onDisconnect(cb: () => void): void {
    this.#disconnectCbs.push(cb)
  }

  /** Simulate the physical device going away (tests, harness). */
  simulateDisconnect(): void {
    if (this.#disconnected || this.closed) return
    this.#disconnected = true
    for (const cb of [...this.#disconnectCbs]) cb()
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Synthesize a key-down input report, as the hardware would. */
  pressKey(position: number): void {
    this.#setKey(position, true)
  }

  /** Synthesize a key-up input report. */
  releaseKey(position: number): void {
    this.#setKey(position, false)
  }

  get brightness(): number | undefined {
    return this.brightnessCalls[this.brightnessCalls.length - 1]
  }

  #setKey(position: number, pressed: boolean): void {
    const keyCount = this.model.columns * this.model.rows
    if (position < 0 || position >= keyCount) {
      throw new Error(`[inkdeck] VirtualTransport: position ${position} out of range (0-${keyCount - 1})`)
    }
    this.#keyStates[position] = pressed
    const report = buildInputReport(this.model, this.#keyStates)
    for (const cb of this.#inputCbs) cb(report)
  }

  #assertOpen(): void {
    if (this.#disconnected) throw new DeviceDisconnectedError()
    if (this.closed) throw new Error('[inkdeck] VirtualTransport: handle is closed')
  }
}
