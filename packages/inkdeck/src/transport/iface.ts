// Transport seam (SPEC §4.1). The renderer must only ever touch the device
// through this interface — the simulator and agent harness depend on it.
//
// §4.1 defines five handle operations and says not to let the surface grow;
// onDisconnect is the one deliberate addition (recorded in DECISIONS.md):
// device removal is a transport-level event that cannot be synthesized
// correctly above this seam, and without it an unplug is only discoverable
// as a flood of failed writes.

import type { ModelId } from '../device/models.js'

export interface DeviceInfo {
  /** Opaque, transport-specific locator. */
  path: string
  vendorId: number // 0x0fd9
  productId: number
  /** Stable identity; used by --device. */
  serial: string
  /** Resolved from productId. */
  model: ModelId
}

export interface Transport {
  list(): Promise<DeviceInfo[]>
  open(path: string): Promise<TransportHandle>
}

export interface TransportHandle {
  /** Output report; report ID is the first byte. */
  writeOutput(report: Uint8Array): Promise<void>
  sendFeature(report: Uint8Array): Promise<void>
  getFeature(reportId: number, length: number): Promise<Uint8Array>
  /** Input reports are delivered with the report ID as the first byte. */
  onInput(cb: (report: Uint8Array) => void): void
  /** Fires once when the physical device goes away. Reports after this throw
   *  DeviceDisconnectedError. Never fires for a clean close(). */
  onDisconnect(cb: () => void): void
  close(): Promise<void>
}

/** Thrown by handle operations once the device is gone — callers classify it
 *  as "reconnect or wait", never as a per-report failure worth logging. */
export class DeviceDisconnectedError extends Error {
  constructor(message = '[inkdeck] device disconnected') {
    super(message)
    this.name = 'DeviceDisconnectedError'
  }
}

/** A device I/O failure that is *not* a disconnect (the device is still there
 *  but rejected the report). Transports throw this from write/feature calls
 *  so callers can tell it from a plain bug without matching on messages. */
export class TransportIOError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportIOError'
  }
}
