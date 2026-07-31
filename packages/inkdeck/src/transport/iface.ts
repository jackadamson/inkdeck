// Transport seam (SPEC §4.1). The renderer must only ever touch the device
// through this interface — the simulator and agent harness depend on it.
// Five operations on the handle; do not let the surface grow.

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
  close(): Promise<void>
}
