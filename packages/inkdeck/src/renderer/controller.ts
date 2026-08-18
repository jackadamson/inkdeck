// DeckController: owns the React root and orchestrates the pieces —
// SceneBuilder (host tree → key scenes), FlushQueue (raster + push),
// InputMachine (debounce + gestures), DeviceLink (handle lifecycle) — and
// exposes the state hooks/manifest/harness read. Used identically by hardware
// and headless paths.

import { createElement, type ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import type { Model, ModelId } from '../device/models.js'
import { parseInputReport } from '../device/protocol.js'
import type { TransportHandle } from '../transport/iface.js'
import { RasterEngine } from '../raster/takumi.js'
import { collectText, sceneHash, type SceneNode } from '../raster/scene.js'
import type { Clock } from './clock.js'
import { ScopedClock, SystemClock } from './clock.js'
import { DeckContext } from './context.js'
import { DeviceLink } from './deviceLink.js'
import { Emitter } from './emitter.js'
import { registerExecScope, runInExecScope, type ExecInterceptor, type ExecScope } from './exec.js'
import { FlushQueue, type FlushMetrics } from './flushQueue.js'
import { flushReact, reconciler } from './hostConfig.js'
import { createHostRoot, type HostRoot } from './hostTree.js'
import { InputMachine, type Gesture } from './input.js'
import { describeError, stderrLogger, type Logger } from './logger.js'
import { buildCommitScenes, type KeyDefinition } from './sceneBuilder.js'

const METRICS_WINDOW_MS = 10_000

export interface DeckInfo {
  model: ModelId
  columns: number
  rows: number
  keyCount: number
  serial: string | null
  /** Row-major position → { row, col }. */
  coordsOf(position: number): { row: number; col: number }
  /** { row, col } → row-major position. */
  positionOf(row: number, col: number): number
}

export interface KeySnapshot {
  position: number
  scene: SceneNode | null
  text: string[]
  error: string | null
  hasPress: boolean
  hasLongPress: boolean
  /** Hash of the last pushed RGBA for this key (hex), if any. */
  imageHash: string | null
  rgba: Uint8Array | null
}

interface KeyEntry extends KeyDefinition {
  sceneHash: string
}

export interface ControllerOptions {
  model: Model
  handle: TransportHandle
  serial?: string
  clock?: Clock
  /** Base directory for resolving app-relative img/font paths (when no raster is injected). */
  assetDir?: string
  /** A pre-built raster engine (fonts loaded); default: new RasterEngine(assetDir). */
  raster?: RasterEngine
  logger?: Logger
  debug?: boolean
  /** Session-scoped exec() interception (mock table); null/undefined ⇒ real spawns. */
  execInterceptor?: ExecInterceptor | null
}

export class DeckController {
  readonly model: Model
  readonly clock: Clock
  readonly raster: RasterEngine
  readonly logger: Logger

  readonly #execScope: ExecScope
  readonly #releaseExecScope: () => void
  readonly #deckInfo: DeckInfo
  readonly #link: DeviceLink
  readonly #queue: FlushQueue
  readonly #input: InputMachine
  readonly #hostRoot: HostRoot
  readonly #fiberRoot: ReturnType<typeof reconciler.createContainer>

  #keys = new Map<number, KeyEntry>()
  #commitPending = false
  #commitCount = 0
  #commitError: Error | null = null
  #closed = false

  readonly #rendered = new Emitter<[changed: number[]]>()
  readonly #pressed = new Emitter()
  #pressedVersion = 0
  readonly #handlerErrors = new Emitter<[position: number, handler: string, error: unknown]>()
  #brightness = 100
  readonly #brightnessChanged = new Emitter()
  #warnedPositions = new Set<number>()

  // Debug render metrics (§6.2): per 10 s window, logged so performance
  // regressions are visible as text an agent loop can read.
  #metricsTimer: number | null = null
  #metrics: FlushMetrics & { sceneSkips: number } = { flushes: 0, sceneSkips: 0, dedupSkips: 0, renderMsTotal: 0, renderMsPeak: 0 }

  constructor(options: ControllerOptions) {
    this.model = options.model
    this.logger = options.logger ?? stderrLogger
    this.#execScope = { interceptor: options.execInterceptor ?? null }
    this.#releaseExecScope = registerExecScope(this.#execScope)
    // App code reached through timers (usePoller) runs inside this session's
    // exec scope, like render() and key handlers below.
    this.clock = new ScopedClock(options.clock ?? new SystemClock(), (fn) => this.runInScope(fn))
    this.raster = options.raster ?? new RasterEngine(options.assetDir)
    this.#deckInfo = this.#buildDeckInfo(options.serial ?? null)

    this.#link = new DeviceLink({
      handle: options.handle,
      logger: this.logger,
      onInput: (report) => {
        const states = parseInputReport(this.model, report)
        if (states) this.#input.apply(states)
      },
    })
    this.#link.onLost(() => this.#queue.clearPending()) // replaceHandle repaints everything anyway

    this.#input = new InputMachine({
      clock: this.clock,
      keyCount: this.keyCount,
      longPressMs: (position) => {
        const entry = this.#keys.get(position)
        return entry?.onLongPress ? entry.longPressMs : null
      },
      onGesture: (position, gesture) => this.#onGesture(position, gesture),
      onChange: () => {
        this.#pressedVersion++
        this.#pressed.emit()
      },
    })

    this.#queue = new FlushQueue({
      model: this.model,
      raster: this.raster,
      clock: this.clock,
      logger: this.logger,
      metrics: this.#metrics,
      handle: () => this.#link.handle,
      paused: () => this.#closed || this.#link.detached,
      lastInputAt: (position) => this.#input.lastInputAt(position),
      onRound: (changed) => this.#rendered.emit(changed),
      onDisconnected: () => this.#link.markLost(),
      onRasterFailure: (position, message) => {
        // Recorded on the entry so check/render/manifest see it structurally.
        const entry = this.#keys.get(position)
        if (entry) entry.error = `raster failed: ${message}`
      },
    })

    this.#hostRoot = createHostRoot()
    this.#hostRoot.onCommit = () => this.#onCommit()
    this.#fiberRoot = reconciler.createContainer(
      this.#hostRoot,
      ConcurrentRoot,
      null,
      false,
      null,
      'inkdeck',
      (error) => {
        // Errors outside any <Key> (root scope) are fatal (§10).
        this.#commitError = error instanceof Error ? error : new Error(String(error))
      },
      () => {
        // Caught by a KeyBoundary, which logs it with the key position.
      },
      () => {},
      () => {},
      null,
    )

    if (options.debug) {
      this.#metricsTimer = this.clock.setInterval(() => this.#logMetrics(), METRICS_WINDOW_MS)
    }
  }

  #logMetrics(): void {
    const m = this.#metrics
    const considered = m.flushes + m.sceneSkips + m.dedupSkips
    if (considered === 0) return // quiet window — nothing to report
    const pct = (n: number) => `${Math.round((n / considered) * 100)}%`
    const avg = m.flushes > 0 ? (m.renderMsTotal / m.flushes).toFixed(1) : '0'
    this.logger.error(
      `[inkdeck] metrics(10s): flushes=${m.flushes} scene-skip=${pct(m.sceneSkips)} dedup=${pct(m.dedupSkips)} round avg=${avg}ms/key peak=${m.renderMsPeak.toFixed(1)}ms`,
    )
    Object.assign(m, { flushes: 0, sceneSkips: 0, dedupSkips: 0, renderMsTotal: 0, renderMsPeak: 0 })
  }

  get keyCount(): number {
    return this.model.columns * this.model.rows
  }

  /** Stable for the life of the controller (safe as an effect dependency). */
  get deckInfo(): DeckInfo {
    return this.#deckInfo
  }

  #buildDeckInfo(serial: string | null): DeckInfo {
    const columns = this.model.columns
    return Object.freeze({
      model: this.model.id,
      columns,
      rows: this.model.rows,
      keyCount: this.keyCount,
      serial,
      coordsOf: (position: number) => ({ row: Math.floor(position / columns), col: position % columns }),
      positionOf: (row: number, col: number) => row * columns + col,
    })
  }

  /** Reset on startup (§5.2) so stale images from a previous process clear, then brightness. */
  async start(): Promise<void> {
    await this.#link.handshake(this.#brightness)
  }

  /** Run app-facing work inside this session's exec scope. */
  runInScope<T>(fn: () => T): T {
    return runInExecScope(this.#execScope, fn)
  }

  // ---- device lifecycle (unplug / replug) ----

  get detached(): boolean {
    return this.#link.detached
  }

  /** Fires once per unplug. Pair with replaceHandle() after a replug. */
  onDeviceLost(listener: () => void): () => void {
    return this.#link.onLost(listener)
  }

  /**
   * Reattach after a replug: reset + brightness on the new handle, then
   * repaint every mounted key from its cached scene. If the handshake fails
   * the controller stays detached and the error propagates.
   */
  async replaceHandle(handle: TransportHandle): Promise<void> {
    if (this.#closed) throw new Error('[inkdeck] controller is shut down')
    await this.#link.replace(handle, this.#brightness)
    for (const [position, entry] of this.#keys) {
      this.#queue.invalidate(position) // force the push past output dedup
      this.#queue.schedule(position, entry.scene)
    }
  }

  // ---- render / settle ----

  /** Render the app element. Errors surface through settled(). */
  render(element: ReactNode): void {
    this.#commitPending = true
    this.#commitError = null // a fresh render gets a fresh verdict
    const wrapped = createElement(DeckContext.Provider, { value: this }, element)
    this.runInScope(() => {
      reconciler.updateContainer(wrapped, this.#fiberRoot, null, () => {
        this.#commitPending = false
      })
    })
  }

  /**
   * Resolves once React has committed, all pending rasterization/pushes have
   * drained, and nothing new happened across two consecutive passes. Each
   * pass flushes pending passive effects and sync work (so effect-triggered
   * updates are forced now rather than found later), then yields one
   * macrotask for the scheduler's concurrent renders. Under frozen time +
   * mocked exec every remaining step is task-resolvable, so this converges
   * without timed sleeps; with real I/O it is the same quiescence heuristic.
   */
  async settled(): Promise<void> {
    const yieldMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0))
    let idlePasses = 0
    while (idlePasses < 2) {
      this.#throwCommitError()
      const commitsBefore = this.#commitCount
      flushReact()
      const busy = this.#commitPending || this.#queue.busy || this.#commitCount !== commitsBefore
      idlePasses = busy ? 0 : idlePasses + 1
      await yieldMacrotask()
    }
    this.#throwCommitError()
  }

  /** A commit error is reported once; the next settled() reflects the next commit. */
  #throwCommitError(): void {
    const error = this.#commitError
    if (!error) return
    this.#commitError = null
    throw error
  }

  onRendered(listener: (changed: number[]) => void): () => void {
    return this.#rendered.on(listener)
  }

  // ---- reads (manifest, simulator) ----

  /** Last pushed RGBA for one key (null if never pushed / unmounted). */
  keyRgba(position: number): Uint8Array | null {
    return this.#queue.frame(position)?.rgba ?? null
  }

  /** Structural + pixel snapshot of every mounted key (manifest source, §11.1). */
  keySnapshots(): KeySnapshot[] {
    const out: KeySnapshot[] = []
    for (const [position, entry] of [...this.#keys.entries()].sort((a, b) => a[0] - b[0])) {
      const frame = this.#queue.frame(position)
      out.push({
        position,
        scene: entry.scene,
        text: entry.error ? [] : collectText(entry.scene),
        error: entry.error,
        hasPress: entry.onPress !== undefined,
        hasLongPress: entry.onLongPress !== undefined,
        imageHash: frame?.hash ?? null,
        rgba: frame?.rgba ?? null,
      })
    }
    return out
  }

  // ---- brightness ----

  get brightness(): number {
    return this.#brightness
  }

  setBrightness(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    if (clamped === this.#brightness) return
    this.#brightness = clamped
    this.#link.sendBrightness(clamped) // silent while detached; replaceHandle resends
    this.#brightnessChanged.emit()
  }

  subscribeBrightness(listener: () => void): () => void {
    return this.#brightnessChanged.on(listener)
  }

  // ---- key press state (useKeyState) ----

  isPressed(position: number): boolean {
    return this.#input.isPressed(position)
  }

  get pressedVersion(): number {
    return this.#pressedVersion
  }

  subscribePressed(listener: () => void): () => void {
    return this.#pressed.on(listener)
  }

  // ---- commit walk ----

  #onCommit(): void {
    this.#commitCount++
    try {
      this.#syncKeys()
    } catch (error) {
      // Recorded rather than rethrown into React's commit phase; render/check
      // surface it via settled() and exit non-zero (§10).
      this.#commitError = error instanceof Error ? error : new Error(String(error))
    }
  }

  #syncKeys(): void {
    const commit = buildCommitScenes(this.#hostRoot, this.keyCount, {
      registerInlineImage: (bytes) => this.raster.registerInlineImage(bytes),
    })
    if (commit.brightness !== null) this.setBrightness(commit.brightness)
    for (const position of commit.outOfRange) {
      if (this.#warnedPositions.has(position)) continue
      this.#warnedPositions.add(position)
      this.logger.error(
        `[inkdeck] <Key position={${position}}> is beyond this ${this.model.id}'s ${this.keyCount} keys (0-${this.keyCount - 1}) — not rendered. Lower the position or run on a larger model.`,
      )
    }

    // Unmounted keys are cleared to black (§7.1).
    for (const position of [...this.#keys.keys()]) {
      if (!commit.keys.has(position)) {
        this.#keys.delete(position)
        this.#queue.forget(position)
        this.#queue.schedule(position, null)
      }
    }

    for (const [position, definition] of commit.keys) {
      const hash = sceneHash(definition.scene)
      const prev = this.#keys.get(position)
      this.#keys.set(position, { ...definition, sceneHash: hash })
      // Scene hash unchanged ⇒ no raster work for that key (§6.2 step 1).
      if (!prev || prev.sceneHash !== hash) {
        this.#queue.schedule(position, definition.scene)
      } else {
        this.#metrics.sceneSkips++
        if (prev.error?.startsWith('raster failed')) {
          this.#keys.get(position)!.error = prev.error // same scene, still unrasterizable
        }
      }
    }
  }

  // ---- input gestures → handlers ----

  #onGesture(position: number, gesture: Gesture): void {
    const entry = this.#keys.get(position)
    if (!entry) return
    if (gesture === 'longPress') {
      if (entry.onLongPress) this.#invokeHandler(position, 'onLongPress', entry.onLongPress)
    } else if (entry.onPress) {
      this.#invokeHandler(position, 'onPress', entry.onPress)
    }
  }

  /**
   * Handler failures (thrown or rejected onPress/onLongPress) go to listeners
   * when any are registered — the agent harness turns them into structured
   * error events — and to the logger otherwise (§10).
   */
  onHandlerError(listener: (position: number, handler: string, error: unknown) => void): () => void {
    return this.#handlerErrors.on(listener)
  }

  #reportHandlerError(position: number, name: string, error: unknown): void {
    if (this.#handlerErrors.size > 0) {
      this.#handlerErrors.emit(position, name, error)
      return
    }
    this.logger.error(`[inkdeck] [key ${position}] ${name} failed: ${describeError(error)}`)
  }

  #invokeHandler(position: number, name: string, handler: () => unknown): void {
    try {
      const result = this.runInScope(handler)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).catch((error) => {
          this.#reportHandlerError(position, name, error)
        })
      }
    } catch (error) {
      this.#reportHandlerError(position, name, error)
    }
  }

  // ---- shutdown ----

  /** Clear deck, reset, close transport (§9). */
  async shutdown(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#metricsTimer !== null) this.clock.clearInterval(this.#metricsTimer)
    this.#input.dispose()
    this.#releaseExecScope()
    reconciler.updateContainer(null, this.#fiberRoot, null, null)
    await this.#link.close()
  }
}
