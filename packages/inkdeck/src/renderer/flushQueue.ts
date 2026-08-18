// FlushQueue: the raster + push pipeline (SPEC §6.2). Owns per-key pending
// scenes (coalescing), the last pushed frame per key (output dedup), the
// input-priority order, per-round `rendered` emission and failure handling.
//
// A round drains every scene pending at its start: keys rasterize
// concurrently (Takumi renders on native threads), then encode + HID writes
// go out sequentially in priority order. Commits landing mid-round replace
// the pending scene for the next round, so three commits while a JPEG is in
// flight still cost one raster (§6.2 step 3).

import type { Model } from '../device/models.js'
import { encodeKeyImagePackets } from '../device/protocol.js'
import type { RasterEngine } from '../raster/takumi.js'
import { errorTileScene, type SceneNode } from '../raster/scene.js'
import { DeviceDisconnectedError, type TransportHandle } from '../transport/iface.js'
import type { Clock } from './clock.js'
import { describeError, type Logger } from './logger.js'

const INPUT_PRIORITY_WINDOW_MS = 500

export interface Frame {
  rgba: Uint8Array
  hash: string
}

export interface FlushMetrics {
  flushes: number
  dedupSkips: number
  renderMsTotal: number
  renderMsPeak: number
}

export interface FlushQueueOptions {
  model: Model
  raster: RasterEngine
  clock: Clock
  logger: Logger
  metrics: FlushMetrics
  /** The current handle (changes after a replug). */
  handle: () => TransportHandle
  /** True while pushes must not happen (detached / shut down). */
  paused: () => boolean
  /** Clock time of the last input on a key (-Infinity if none): those flush first. */
  lastInputAt: (position: number) => number
  /** A round finished with these keys' pixels changed on the device. */
  onRound: (changed: number[]) => void
  /** A writer saw DeviceDisconnectedError. */
  onDisconnected: () => void
  /** A scene could not be rasterized; the error tile is being painted instead. */
  onRasterFailure: (position: number, message: string) => void
}

export class FlushQueue {
  readonly #o: FlushQueueOptions
  #pending = new Map<number, SceneNode | null>()
  #frames = new Map<number, Frame>()
  #flushing = false

  constructor(options: FlushQueueOptions) {
    this.#o = options
  }

  /** Newest scene wins; kicks the loop. */
  schedule(position: number, scene: SceneNode | null): void {
    if (this.#o.paused()) return
    this.#pending.set(position, scene)
    void this.#loop()
  }

  /** Something is pending or in flight. */
  get busy(): boolean {
    return this.#flushing || this.#pending.size > 0
  }

  /** Last frame pushed for a key. */
  frame(position: number): Frame | null {
    return this.#frames.get(position) ?? null
  }

  /** Forget a key's frame so the next identical raster is pushed anyway (replug repaint). */
  invalidate(position: number): void {
    this.#frames.delete(position)
  }

  /** Drop a key entirely (unmounted). The caller schedules the black frame. */
  forget(position: number): void {
    this.#frames.delete(position)
  }

  /** Drop everything pending (unplug: replace() repaints anyway). */
  clearPending(): void {
    this.#pending.clear()
  }

  async #loop(): Promise<void> {
    if (this.#flushing) return
    this.#flushing = true
    try {
      while (this.#pending.size > 0 && !this.#o.paused()) {
        const round = [...this.#pending.entries()]
        this.#pending.clear()
        const changed = await this.#runRound(round)
        if (changed.length > 0) this.#o.onRound(changed)
      }
    } finally {
      this.#flushing = false
    }
  }

  async #runRound(round: Array<[number, SceneNode | null]>): Promise<number[]> {
    const started = performance.now()
    // 1. Rasterize concurrently.
    const rendered = await Promise.all(
      round.map(async ([position, scene]) => {
        try {
          const rgba = await this.#o.raster.renderScene(scene, this.#o.model)
          return { position, rgba, failure: null as string | null }
        } catch (error) {
          return { position, rgba: null, failure: describeError(error) }
        }
      }),
    )
    // Scenes that failed to rasterize get the error tile instead (recorded upstream).
    for (const item of rendered) {
      if (item.failure === null) continue
      this.#o.logger.error(`[inkdeck] [key ${item.position}] raster failed: ${item.failure}`)
      this.#o.onRasterFailure(item.position, item.failure)
      try {
        item.rgba = await this.#o.raster.renderScene(errorTileScene(), this.#o.model)
      } catch {
        // Even the error tile failed — leave the key as it is.
      }
    }
    // 2. Push sequentially, input-prioritised.
    const changed: number[] = []
    for (const item of this.#prioritise(rendered)) {
      if (!item.rgba || this.#o.paused()) continue
      try {
        if (await this.#push(item.position, item.rgba)) changed.push(item.position)
      } catch (error) {
        if (error instanceof DeviceDisconnectedError) {
          this.#pending.clear() // unplugged mid-flush: one event, no per-key flood
          this.#o.onDisconnected()
          break
        }
        this.#o.logger.error(`[inkdeck] [key ${item.position}] push failed: ${describeError(error)}`)
      }
    }
    const elapsed = performance.now() - started
    const m = this.#o.metrics
    m.renderMsTotal += elapsed
    m.renderMsPeak = Math.max(m.renderMsPeak, elapsed)
    return changed.sort((a, b) => a - b)
  }

  /** Slots whose change was caused by user input in the last 500 ms flush first (§6.2). */
  #prioritise<T extends { position: number }>(items: T[]): T[] {
    const now = this.#o.clock.now()
    const urgent = (p: number) => now - this.#o.lastInputAt(p) <= INPUT_PRIORITY_WINDOW_MS
    return [...items].sort((a, b) => Number(urgent(b.position)) - Number(urgent(a.position)))
  }

  /** Dedup + encode + write; the frame is recorded only once every packet landed. */
  async #push(position: number, rgba: Uint8Array): Promise<boolean> {
    const hash = Bun.hash(rgba).toString(16)
    if (this.#frames.get(position)?.hash === hash) {
      this.#o.metrics.dedupSkips++
      return false
    }
    const jpeg = await this.#o.raster.rgbaToJpeg(rgba, this.#o.model)
    const handle = this.#o.handle()
    for (const packet of encodeKeyImagePackets(this.#o.model, position, jpeg)) {
      await handle.writeOutput(packet)
    }
    this.#frames.set(position, { rgba, hash })
    this.#o.metrics.flushes++
    return true
  }
}
