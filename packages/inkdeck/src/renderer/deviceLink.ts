// DeviceLink: the controller's grip on the transport handle — attach/detach/
// replace with stale-handle guards, the reset + brightness handshake, and
// the one-shot "device lost" signal. Rendering state lives elsewhere; this
// only knows whether there is a live handle to push to.

import { encodeBrightness, encodeReset } from '../device/protocol.js'
import { DeviceDisconnectedError, type TransportHandle } from '../transport/iface.js'
import { Emitter } from './emitter.js'
import { describeError, type Logger } from './logger.js'

export interface DeviceLinkOptions {
  handle: TransportHandle
  logger: Logger
  onInput: (report: Uint8Array) => void
}

export class DeviceLink {
  #handle: TransportHandle
  #detached = false
  #closed = false
  readonly #logger: Logger
  readonly #onInput: (report: Uint8Array) => void
  readonly #lost = new Emitter()

  constructor(options: DeviceLinkOptions) {
    this.#handle = options.handle
    this.#logger = options.logger
    this.#onInput = options.onInput
    this.#attach(options.handle)
  }

  get handle(): TransportHandle {
    return this.#handle
  }

  /** True between an unplug and a successful replace(). Pushes are silent meanwhile. */
  get detached(): boolean {
    return this.#detached
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Fires once per unplug. Pair with replace() after a replug. */
  onLost(listener: () => void): () => void {
    return this.#lost.on(listener)
  }

  #attach(handle: TransportHandle): void {
    handle.onInput((report) => {
      if (handle !== this.#handle) return // stale handle after a replug
      this.#onInput(report)
    })
    handle.onDisconnect(() => {
      if (handle !== this.#handle) return
      this.markLost()
    })
  }

  /** The device is gone (transport signal or a DeviceDisconnectedError seen by a writer). */
  markLost(): void {
    if (this.#closed || this.#detached) return
    this.#detached = true
    this.#lost.emit()
  }

  /** Reset (clears stale images from a previous process, §5.2) + brightness. */
  async handshake(brightness: number): Promise<void> {
    await this.#handle.sendFeature(encodeReset())
    await this.#handle.sendFeature(encodeBrightness(brightness))
  }

  /**
   * Reattach after a replug: close the old handle, wire the new one, redo the
   * handshake. If the handshake fails (the deck dropped again) the link stays
   * detached and the error propagates for the caller to retry.
   */
  async replace(handle: TransportHandle, brightness: number): Promise<void> {
    if (this.#closed) throw new Error('[inkdeck] controller is shut down')
    await this.#handle.close().catch(() => {})
    this.#handle = handle
    this.#attach(handle)
    this.#detached = false
    try {
      await this.handshake(brightness)
    } catch (error) {
      this.#detached = true
      throw error
    }
  }

  /** Fire-and-forget brightness update; silent while detached. */
  sendBrightness(percent: number): void {
    if (this.#detached || this.#closed) return
    void this.#handle.sendFeature(encodeBrightness(percent)).catch((error) => {
      if (error instanceof DeviceDisconnectedError) return
      this.#logger.error(`[inkdeck] failed to set brightness: ${describeError(error)}`)
    })
  }

  /** Best-effort reset, then close (§9). */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#handle.sendFeature(encodeReset())
    } catch {
      // Device may already be gone; reset is best-effort on the way out.
    }
    await this.#handle.close()
  }
}
