// DeckController: owns the React root, walks the host tree on every commit,
// diffs per-key scenes, rasterizes changed keys and pushes framed reports
// through the Transport seam. Used identically by hardware and headless paths.

import { createElement, type ReactNode } from 'react'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import type { Model } from '../device/models.js'
import {
  encodeBrightness,
  encodeKeyImagePackets,
  encodeReset,
  parseInputReport,
} from '../device/protocol.js'
import { DeviceDisconnectedError, type TransportHandle } from '../transport/iface.js'
import { RasterEngine } from '../raster/takumi.js'
import { collectText, sceneHash, type SceneElement, type SceneNode } from '../raster/scene.js'
import type { Clock } from './clock.js'
import { ScopedClock, SystemClock } from './clock.js'
import { registerExecScope, runInExecScope, type ExecInterceptor, type ExecScope } from './exec.js'
import { DeckContext } from './context.js'
import { InputMachine, type Gesture } from './input.js'
import { reconciler } from './hostConfig.js'
import {
  createHostRoot,
  findElements,
  KEY_ERROR_TYPE,
  KEY_TYPE,
  DECK_TYPE,
  type HostElement,
  type HostNode,
  type HostRoot,
} from './hostTree.js'

const DEFAULT_LONG_PRESS_MS = 500
const INPUT_PRIORITY_WINDOW_MS = 500
const METRICS_WINDOW_MS = 10_000
// Long enough for the transport's removal polling (1 s) to flag an unplug.
const DISCONNECT_GRACE_MS = 1200

export interface DeckInfo {
  model: string
  columns: number
  rows: number
  keyCount: number
  serial: string | null
}

export interface KeySnapshot {
  position: number
  scene: SceneNode | null
  text: string[]
  error: string | null
  hasPress: boolean
  hasLongPress: boolean
  /** Hash of the last rasterized RGBA for this key (hex), if rasterized. */
  imageHash: string | null
  rgba: Uint8Array | null
}

interface KeyEntry {
  scene: SceneNode | null
  sceneHash: string
  error: string | null
  hasPress: boolean
  hasLongPress: boolean
  onPress?: () => unknown
  onLongPress?: () => unknown
  longPressMs: number
  rgba: Uint8Array | null
  rgbaHash: string | null
}

export interface ControllerOptions {
  model: Model
  handle: TransportHandle
  serial?: string
  clock?: Clock
  /** Base directory for resolving app-relative img/font paths. */
  assetDir?: string
  debug?: boolean
  /** Session-scoped exec() interception (mock table); null/undefined ⇒ real spawns. */
  execInterceptor?: ExecInterceptor | null
}

export class DeckController {
  readonly model: Model
  readonly clock: Clock
  readonly raster: RasterEngine

  readonly #execScope: ExecScope
  #releaseExecScope: () => void
  #handle: TransportHandle
  #serial: string | null
  #hostRoot: HostRoot
  #fiberRoot: ReturnType<typeof reconciler.createContainer>

  #keys = new Map<number, KeyEntry>()
  #pendingRaster = new Map<number, { scene: SceneNode | null }>()
  #flushing = false
  #commitPending = false
  #renderedListeners: Array<(changed: number[]) => void> = []
  #commitError: Error | null = null

  #input: InputMachine
  #pressedVersion = 0
  #pressListeners = new Set<() => void>()
  #handlerErrorListeners = new Set<(position: number, handler: string, error: unknown) => void>()

  #brightness = 100
  #brightnessListeners = new Set<() => void>()
  #warnedPositions = new Set<number>()
  #closed = false
  // Device unplugged: rendering state stays alive, pushes stop, one event
  // fires — the CLI decides whether to wait for a replug (start/dev do).
  #detached = false
  #deviceLostListeners = new Set<() => void>()

  // Debug render metrics (§6.2): counted per 10 s window, logged to stderr so
  // performance regressions are visible as text an agent loop can read.
  #metricsTimer: number | null = null
  #metrics = { flushes: 0, sceneSkips: 0, dedupSkips: 0, renderMsTotal: 0, renderMsPeak: 0 }

  constructor(options: ControllerOptions) {
    this.model = options.model
    this.#execScope = { interceptor: options.execInterceptor ?? null }
    this.#releaseExecScope = registerExecScope(this.#execScope)
    // App code reached through timers (usePoller) runs inside this session's
    // exec scope, like render() and key handlers below.
    this.clock = new ScopedClock(options.clock ?? new SystemClock(), (fn) => this.runInScope(fn))
    this.raster = new RasterEngine(options.assetDir)
    this.#handle = options.handle
    this.#serial = options.serial ?? null
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
        for (const listener of [...this.#pressListeners]) listener()
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
      (error) => {
        console.error(`[inkdeck] caught error: ${error instanceof Error ? error.message : error}`)
      },
      () => {},
      () => {},
      null,
    )

    this.#attachHandle(this.#handle)

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
    console.error(
      `[inkdeck] metrics(10s): flushes=${m.flushes} scene-skip=${pct(m.sceneSkips)} dedup=${pct(m.dedupSkips)} render avg=${avg}ms peak=${m.renderMsPeak.toFixed(1)}ms`,
    )
    this.#metrics = { flushes: 0, sceneSkips: 0, dedupSkips: 0, renderMsTotal: 0, renderMsPeak: 0 }
  }

  get keyCount(): number {
    return this.model.columns * this.model.rows
  }

  get deckInfo(): DeckInfo {
    return {
      model: this.model.id,
      columns: this.model.columns,
      rows: this.model.rows,
      keyCount: this.keyCount,
      serial: this.#serial,
    }
  }

  async start(): Promise<void> {
    // Reset on startup (§5.2) so stale images from a previous process clear.
    await this.#handle.sendFeature(encodeReset())
    await this.#handle.sendFeature(encodeBrightness(this.#brightness))
  }

  // ---- device lifecycle (unplug / replug) ----

  get detached(): boolean {
    return this.#detached
  }

  /** Fires once per unplug. Pair with replaceHandle() after a replug. */
  onDeviceLost(listener: () => void): () => void {
    this.#deviceLostListeners.add(listener)
    return () => this.#deviceLostListeners.delete(listener)
  }

  #attachHandle(handle: TransportHandle): void {
    handle.onInput((report) => {
      if (handle !== this.#handle) return // stale handle after a replug
      this.#onInputReport(report)
    })
    handle.onDisconnect(() => {
      if (handle !== this.#handle) return
      this.#onDeviceRemoved()
    })
  }

  #onDeviceRemoved(): void {
    if (this.#closed || this.#detached) return
    this.#detached = true
    this.#pendingRaster.clear() // replaceHandle repaints everything anyway
    for (const listener of [...this.#deviceLostListeners]) listener()
  }

  /**
   * Reattach after a replug: close the old handle, wire the new one, resend
   * reset + brightness, and repaint every mounted key from its cached scene.
   */
  async replaceHandle(handle: TransportHandle): Promise<void> {
    if (this.#closed) throw new Error('[inkdeck] controller is shut down')
    await this.#handle.close().catch(() => {})
    this.#handle = handle
    this.#attachHandle(handle)
    this.#detached = false
    try {
      await this.start()
    } catch (error) {
      // The deck dropped again mid-handshake: stay detached (pushes stay
      // silent) so the caller can acquire it once more; the caller decides.
      this.#detached = true
      throw error
    }
    for (const [position, entry] of this.#keys) {
      entry.rgbaHash = null // force the push past output dedup
      this.#scheduleRaster(position, entry.scene)
    }
  }

  /** Run app-facing work inside this session's exec scope. */
  runInScope<T>(fn: () => T): T {
    return runInExecScope(this.#execScope, fn)
  }

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
   * drained, and the system has stayed idle across two macrotask checks (so
   * scheduler-deferred commits from effects or input handlers are caught).
   */
  async settled(): Promise<void> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let idleChecks = 0
    while (idleChecks < 2) {
      this.#throwCommitError()
      const busy = this.#commitPending || this.#flushing || this.#pendingRaster.size > 0
      idleChecks = busy ? 0 : idleChecks + 1
      await sleep(5)
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
    this.#renderedListeners.push(listener)
    return () => {
      this.#renderedListeners = this.#renderedListeners.filter((l) => l !== listener)
    }
  }

  /** Structural + pixel snapshot of every mounted key (manifest source, §11.1). */
  keySnapshots(): KeySnapshot[] {
    const out: KeySnapshot[] = []
    for (const [position, entry] of [...this.#keys.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({
        position,
        scene: entry.scene,
        text: entry.error ? [] : collectText(entry.scene),
        error: entry.error,
        hasPress: entry.hasPress,
        hasLongPress: entry.hasLongPress,
        imageHash: entry.rgbaHash,
        rgba: entry.rgba,
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
    // While detached only the state updates; replaceHandle resends it.
    if (!this.#detached) {
      void this.#handle.sendFeature(encodeBrightness(clamped)).catch((error) => {
        if (error instanceof DeviceDisconnectedError) return
        console.error(`[inkdeck] failed to set brightness: ${error}`)
      })
    }
    for (const listener of this.#brightnessListeners) listener()
  }

  subscribeBrightness(listener: () => void): () => void {
    this.#brightnessListeners.add(listener)
    return () => this.#brightnessListeners.delete(listener)
  }

  // ---- key press state (useKeyState) ----

  isPressed(position: number): boolean {
    return this.#input.isPressed(position)
  }

  get pressedVersion(): number {
    return this.#pressedVersion
  }

  subscribePressed(listener: () => void): () => void {
    this.#pressListeners.add(listener)
    return () => {
      this.#pressListeners.delete(listener)
    }
  }

  // ---- commit walk ----

  #onCommit(): void {
    try {
      this.#walkCommit()
    } catch (error) {
      // Recorded rather than rethrown into React's commit phase; render/check
      // surface it via settled() and exit non-zero (§10).
      this.#commitError = error instanceof Error ? error : new Error(String(error))
    }
  }

  #walkCommit(): void {
    const decks = findElements(this.#hostRoot.children, DECK_TYPE)
    if (decks.length === 0) {
      if (this.#hostRoot.children.length > 0) {
        throw new Error(
          '[inkdeck] the app must render a <Deck> at its root (import { Deck } from "@jackadamson/inkdeck")',
        )
      }
      // Empty tree (unmounted) — clear all keys.
      this.#syncKeys(new Map())
      return
    }
    if (decks.length > 1) {
      throw new Error('[inkdeck] only one <Deck> may be mounted at a time')
    }
    const deck = decks[0]

    const brightness = deck.props.brightness
    if (typeof brightness === 'number') this.setBrightness(brightness)

    const keyElements = findElements(deck.children, KEY_TYPE)
    const byPosition = new Map<number, HostElement>()
    for (const key of keyElements) {
      if (key.hidden) continue
      const position = Number(key.props.position)
      if (!Number.isInteger(position) || position < 0) {
        throw new Error(`[inkdeck] <Key position={${String(key.props.position)}}> — position must be a non-negative integer`)
      }
      const existing = byPosition.get(position)
      if (existing) {
        // Last-wins is a debugging nightmare on a physical grid (§7.1).
        throw new Error(
          `[inkdeck] two <Key> elements are mounted with position={${position}}.\n\nFirst:\n${existing.props.stack}\n\nSecond:\n${key.props.stack}`,
        )
      }
      if (position >= this.keyCount) {
        if (!this.#warnedPositions.has(position)) {
          this.#warnedPositions.add(position)
          console.error(
            `[inkdeck] <Key position={${position}}> is beyond this ${this.model.id}'s ${this.keyCount} keys (0-${this.keyCount - 1}) — not rendered. Lower the position or run on a larger model.`,
          )
        }
        continue
      }
      byPosition.set(position, key)
    }
    this.#syncKeys(byPosition)
  }

  #syncKeys(byPosition: Map<number, HostElement>): void {
    // Unmounted keys are cleared to black (§7.1).
    for (const position of [...this.#keys.keys()]) {
      if (!byPosition.has(position)) {
        this.#keys.delete(position)
        this.#scheduleRaster(position, null)
      }
    }

    for (const [position, element] of byPosition) {
      const errorElement = findElements(element.children, KEY_ERROR_TYPE)[0]
      const scene = errorElement
        ? this.raster.errorTileScene()
        : this.#buildScene(element.children)
      const hash = sceneHash(scene)
      const prev = this.#keys.get(position)
      const entry: KeyEntry = {
        scene,
        sceneHash: hash,
        error: errorElement ? String(errorElement.props.message ?? 'render error') : null,
        hasPress: typeof element.props.onPress === 'function',
        hasLongPress: typeof element.props.onLongPress === 'function',
        onPress: element.props.onPress as KeyEntry['onPress'],
        onLongPress: element.props.onLongPress as KeyEntry['onLongPress'],
        longPressMs:
          typeof element.props.longPressMs === 'number'
            ? element.props.longPressMs
            : DEFAULT_LONG_PRESS_MS,
        rgba: prev?.rgba ?? null,
        rgbaHash: prev?.rgbaHash ?? null,
      }
      this.#keys.set(position, entry)
      // Scene hash unchanged ⇒ no raster work for that key (§6.2 step 1).
      if (!prev || prev.sceneHash !== hash) {
        this.#scheduleRaster(position, scene)
      } else {
        this.#metrics.sceneSkips++
      }
    }
  }

  #buildScene(children: HostNode[]): SceneNode | null {
    const nodes = children
      .filter((c) => !c.hidden)
      .map((c) => this.#toScene(c))
      .filter((c): c is SceneNode => c !== null)
    if (nodes.length === 0) return null
    if (nodes.length === 1) return nodes[0]
    return { kind: 'element', tag: 'div', children: nodes }
  }

  #toScene(node: HostNode): SceneNode | null {
    if (node.kind === 'text') {
      return { kind: 'text', text: node.text }
    }
    const el: SceneElement = {
      kind: 'element',
      tag: node.type,
      children: [],
    }
    const className = node.props.className
    if (typeof className === 'string' && className.length > 0) el.className = className
    const style = node.props.style
    if (style && typeof style === 'object') el.style = style as Record<string, unknown>
    if (node.type === 'img') {
      el.src = typeof node.props.src === 'string' ? node.props.src : undefined
      return el
    }
    if (node.type === 'svg') {
      el.svg = serializeSvg(node)
      return el
    }
    el.children = node.children
      .filter((c) => !c.hidden)
      .map((c) => this.#toScene(c))
      .filter((c): c is SceneNode => c !== null)
    return el
  }

  // ---- raster + flush (§6.2) ----

  #scheduleRaster(position: number, scene: SceneNode | null): void {
    if (this.#closed) return // shutdown unmount clears via reset instead
    if (this.#detached) return // scenes stay cached; replaceHandle repaints all
    // Coalesced: three commits while a JPEG is in flight ⇒ only the newest
    // scene renders (§6.2 step 3).
    this.#pendingRaster.set(position, { scene })
    void this.#flushLoop()
  }

  async #flushLoop(): Promise<void> {
    if (this.#flushing) return
    this.#flushing = true
    try {
      // Rounds: each pass drains the keys pending at its start, then emits
      // one `rendered` for the round, so listeners (agent, simulator, dev)
      // keep up under continuous animation instead of waiting for a full
      // drain that may never come.
      while (this.#pendingRaster.size > 0 && !this.#closed && !this.#detached) {
        const changed = new Set<number>()
        const roundSize = this.#pendingRaster.size
        for (let i = 0; i < roundSize && this.#pendingRaster.size > 0 && !this.#closed && !this.#detached; i++) {
          const position = this.#nextFlushPosition()
          const { scene } = this.#pendingRaster.get(position)!
          this.#pendingRaster.delete(position)
          try {
            const didChange = await this.#rasterAndPush(position, scene)
            if (didChange) changed.add(position)
          } catch (error) {
            if (error instanceof DeviceDisconnectedError || this.#detached) {
              this.#pendingRaster.clear() // unplugged mid-flush: one event, no per-key flood
              break
            }
            // A failed device write may be an unplug the transport has not
            // flagged yet (removal detection polls, §DECISIONS): give detection
            // one cycle before treating it as a real per-key failure.
            if (error instanceof Error && error.message.includes('IOHIDDeviceSetReport')) {
              await new Promise((resolve) => setTimeout(resolve, DISCONNECT_GRACE_MS))
              if (this.#detached) {
                this.#pendingRaster.clear()
                break
              }
            }
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[inkdeck] [key ${position}] raster/push failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
            if (await this.#paintRasterFailure(position, message)) changed.add(position)
          }
        }
        if (changed.size > 0) {
          const sorted = [...changed].sort((a, b) => a - b)
          for (const listener of [...this.#renderedListeners]) listener(sorted)
        }
      }
    } finally {
      this.#flushing = false
    }
  }

  /**
   * A scene that cannot be rasterized (missing image, bad SVG, …) is recorded
   * on the entry — so `check`/the manifest see it structurally — and the
   * error tile is painted so the key does not silently keep stale pixels.
   */
  async #paintRasterFailure(position: number, message: string): Promise<boolean> {
    const entry = this.#keys.get(position)
    if (!entry) return false
    entry.error = `raster failed: ${message}`
    try {
      return await this.#rasterAndPush(position, this.raster.errorTileScene())
    } catch {
      return false
    }
  }

  /** Slots whose change was caused by user input in the last 500 ms flush first (§6.2). */
  #nextFlushPosition(): number {
    const now = this.clock.now()
    let best: number | null = null
    for (const position of this.#pendingRaster.keys()) {
      if (now - this.#input.lastInputAt(position) <= INPUT_PRIORITY_WINDOW_MS) {
        return position
      }
      if (best === null) best = position
    }
    return best!
  }

  async #rasterAndPush(position: number, scene: SceneNode | null): Promise<boolean> {
    const started = performance.now()
    const rgba = await this.raster.renderScene(scene, this.model)
    const rgbaHash = Bun.hash(rgba).toString(16)
    const entry = this.#keys.get(position)
    // Output dedup: identical pixels ⇒ skip encoding and the HID write (§6.2 step 2).
    if (entry?.rgbaHash === rgbaHash) {
      this.#metrics.dedupSkips++
      return false
    }
    const jpeg = await this.raster.rgbaToJpeg(rgba, this.model)
    for (const packet of encodeKeyImagePackets(this.model, position, jpeg)) {
      await this.#handle.writeOutput(packet)
    }
    // Recorded only after the last packet succeeded: a failed write must not
    // be deduped away as "already on the device".
    if (entry) {
      entry.rgba = rgba
      entry.rgbaHash = rgbaHash
    }
    const elapsed = performance.now() - started
    this.#metrics.flushes++
    this.#metrics.renderMsTotal += elapsed
    this.#metrics.renderMsPeak = Math.max(this.#metrics.renderMsPeak, elapsed)
    return true
  }

  // ---- input (§5.2 input reports → key events) ----

  #onInputReport(report: Uint8Array): void {
    const states = parseInputReport(this.model, report)
    if (!states) return
    this.#input.apply(states)
  }

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
   * error events — and to stderr otherwise (§10).
   */
  onHandlerError(listener: (position: number, handler: string, error: unknown) => void): () => void {
    this.#handlerErrorListeners.add(listener)
    return () => this.#handlerErrorListeners.delete(listener)
  }

  #reportHandlerError(position: number, name: string, error: unknown): void {
    if (this.#handlerErrorListeners.size > 0) {
      for (const listener of [...this.#handlerErrorListeners]) listener(position, name, error)
      return
    }
    console.error(`[inkdeck] [key ${position}] ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
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
    try {
      await this.#handle.sendFeature(encodeReset())
    } catch {
      // Device may already be gone; reset is best-effort on the way out.
    }
    await this.#handle.close()
  }
}

// SVG subtrees are serialized to markup and rasterized by Takumi as an image
// source — mirrors @takumi-rs/helpers' JSX handling.
const SVG_CAMEL_ATTRS = new Set([
  'viewBox',
  'preserveAspectRatio',
  'gradientUnits',
  'gradientTransform',
  'patternUnits',
  'patternTransform',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'markerUnits',
  'refX',
  'refY',
  'markerWidth',
  'markerHeight',
  'textLength',
  'lengthAdjust',
])

function serializeSvg(element: HostElement): string {
  const attrs: string[] = []
  for (const [key, value] of Object.entries(element.props)) {
    if (key === 'children' || value == null || typeof value === 'function') continue
    let name: string
    if (key === 'className') name = 'class'
    else if (key === 'style') {
      if (typeof value === 'object') {
        const css = Object.entries(value as Record<string, unknown>)
          .map(([k, v]) => `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}:${String(v)}`)
          .join(';')
        attrs.push(`style="${escapeXml(css)}"`)
      }
      continue
    } else if (SVG_CAMEL_ATTRS.has(key)) name = key
    else name = key.replace(/([A-Z])/g, '-$1').toLowerCase()
    attrs.push(`${name}="${escapeXml(String(value))}"`)
  }
  if (element.type === 'svg' && !('xmlns' in element.props)) {
    attrs.push('xmlns="http://www.w3.org/2000/svg"')
  }
  const children = element.children
    .filter((c) => !c.hidden)
    .map((c) => (c.kind === 'text' ? escapeXml(c.text) : serializeSvg(c)))
    .join('')
  return `<${element.type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${children}</${element.type}>`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
