// Shared harness core (SPEC §11): a headless deck with press/tap/advanceTime
// semantics and mock-exec wiring. `inkdeck agent` speaks JSON-lines around it,
// the `testing` helper wraps it in-process, and the browser simulator is a
// client of the same pipeline.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement, type ComponentType, type ReactNode } from 'react'
import type { Model } from '../device/models.js'
import { VirtualTransport, type VirtualHandle } from '../transport/virtual.js'
import { DeckController } from '../renderer/controller.js'
import { FrozenClock, SystemClock, type Clock } from '../renderer/clock.js'
import { KEY_DEBOUNCE_MS } from '../renderer/input.js'
import type { Logger } from '../renderer/logger.js'
import { buildManifest, type Manifest } from './manifest.js'
import { createMockExecInterceptor, type MockExecConfig } from './mockExec.js'

const DEFAULT_TAP_HOLD_MS = 50
// A release is committed by the controller only KEY_DEBOUNCE_MS after the
// physical up (a re-press inside that window is contact bounce = still held),
// so every release here waits that window out — otherwise back-to-back taps
// merge into one hold.
const RELEASE_SETTLE_MS = KEY_DEBOUNCE_MS + 5

export interface HarnessOptions {
  model: Model
  element: ReactNode
  freezeTime?: boolean
  mockExec?: MockExecConfig
  /** Receives commands that no mock matched (harness emits an error event). */
  onUnmatchedExec?: (command: string) => void
  /** Base directory for app-relative img/font paths. */
  assetDir?: string
  fonts?: string[]
  /** Framework diagnostics sink (default: stderr). */
  logger?: Logger
}

export class HarnessSession {
  readonly controller: DeckController
  readonly handle: VirtualHandle
  readonly transport: VirtualTransport
  readonly clock: Clock
  readonly frozen: boolean

  private constructor(controller: DeckController, transport: VirtualTransport, clock: Clock, frozen: boolean) {
    this.controller = controller
    this.transport = transport
    this.handle = transport.handle
    this.clock = clock
    this.frozen = frozen
  }

  static async start(options: HarnessOptions): Promise<HarnessSession> {
    const clock = options.freezeTime ? new FrozenClock() : new SystemClock()
    const execInterceptor = options.mockExec
      ? createMockExecInterceptor(options.mockExec, { clock, onUnmatched: options.onUnmatchedExec })
      : null
    const transport = new VirtualTransport(options.model)
    const handle = await transport.open('virtual:0')
    const controller = new DeckController({
      model: options.model,
      handle,
      serial: transport.serial,
      clock,
      assetDir: options.assetDir,
      execInterceptor,
      logger: options.logger,
    })
    try {
      if (options.fonts?.length && options.assetDir) {
        await controller.raster.loadAppFonts(options.fonts, options.assetDir)
      }
      await controller.start()
      controller.render(options.element)
      await controller.settled()
    } catch (error) {
      await controller.shutdown().catch(() => {})
      throw error
    }
    return new HarnessSession(controller, transport, clock, Boolean(options.freezeTime))
  }

  manifest(): Manifest {
    return buildManifest(this.controller)
  }

  press(position: number): void {
    this.#assertPosition(position)
    this.handle.pressKey(position)
  }

  /**
   * Physical release. Under frozen time the clock also advances past the
   * contact-bounce window so the release commits immediately (a following
   * press() is then a new press, not bounce); under real time it commits
   * KEY_DEBOUNCE_MS later on its own — use tap() or settled() to wait.
   */
  release(position: number): void {
    this.#assertPosition(position)
    this.handle.releaseKey(position)
    if (this.frozen) (this.clock as FrozenClock).advance(RELEASE_SETTLE_MS)
  }

  /**
   * Press + release. Under frozen time the clock advances by holdMs during the
   * hold (driving long-press timers) and past the contact-bounce window after
   * release; under real time both are actual sleeps, so back-to-back taps are
   * distinct presses.
   */
  async tap(position: number, holdMs = DEFAULT_TAP_HOLD_MS): Promise<void> {
    this.#assertPosition(position)
    this.handle.pressKey(position)
    if (this.frozen) {
      ;(this.clock as FrozenClock).advance(holdMs)
    } else {
      await new Promise((resolve) => setTimeout(resolve, holdMs))
    }
    this.release(position)
    if (!this.frozen) {
      await new Promise((resolve) => setTimeout(resolve, RELEASE_SETTLE_MS))
    }
  }

  advanceTime(ms: number): void {
    if (!this.frozen) {
      throw new Error('[inkdeck] advanceTime requires --freeze-time (the clock is running on its own)')
    }
    ;(this.clock as FrozenClock).advance(ms)
  }

  async settled(): Promise<void> {
    await this.controller.settled()
  }

  /** Write key-N.png + manifest.json for the current state (agent writeFrames, §11.2). */
  async writeFrames(dir: string): Promise<Manifest> {
    await mkdir(dir, { recursive: true })
    const manifest = this.manifest()
    for (const snapshot of this.controller.keySnapshots()) {
      if (!snapshot.rgba) continue
      const png = await this.controller.raster.rgbaToPng(snapshot.rgba, this.controller.model)
      await Bun.write(join(dir, `key-${snapshot.position}.png`), png)
    }
    await Bun.write(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  }

  async shutdown(): Promise<void> {
    await this.controller.shutdown()
  }

  #assertPosition(position: number): void {
    const keyCount = this.controller.keyCount
    if (!Number.isInteger(position) || position < 0 || position >= keyCount) {
      throw new Error(`[inkdeck] position ${position} is out of range for ${this.controller.model.id} (0-${keyCount - 1})`)
    }
  }
}

/** Coerce a default export or element to an element (testing helper takes either). */
export function toElement(appOrElement: ReactNode | ComponentType): ReactNode {
  return typeof appOrElement === 'function' ? createElement(appOrElement) : appOrElement
}
