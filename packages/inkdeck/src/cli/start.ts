// `inkdeck start <app.tsx> [--device S]` — run once against hardware (SPEC §9).
// `inkdeck dev` reuses this with watch=true: minimal re-render-on-save for M2;
// the no-flicker hot-reload polish (changed-set logging, module cache surgery)
// is M4.

import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { hardwareTransport } from '../device/discovery.js'
import { requireRenderableModel } from '../device/models.js'
import { DeckController } from '../renderer/controller.js'
import type { DeviceInfo, Transport, TransportHandle } from '../transport/iface.js'
import { loadApp } from './headless.js'

export interface StartOptions {
  device?: string
  watch?: boolean
  debug?: boolean
}

const DEVICE_POLL_MS = 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolve the target device, waiting for it to appear if necessary — both
 * `start` and `dev` are session-keeping (autostart on login must survive the
 * deck enumerating late, or an unplug/replug; see DECISIONS.md). Ambiguity
 * (multiple decks, nothing selected) still fails fast: waiting cannot
 * resolve a choice only the user can make.
 */
async function waitForDevice(transport: Transport, wanted: string | undefined): Promise<DeviceInfo> {
  let announced = false
  for (;;) {
    const devices = await transport.list()
    if (wanted) {
      const match = devices.find((d) => d.serial === wanted)
      if (match) return match
    } else {
      if (devices.length === 1) return devices[0]
      if (devices.length > 1) {
        const listing = devices.map((d) => `  ${d.serial} (${d.model})`).join('\n')
        throw new Error(
          `[inkdeck] multiple Stream Decks attached — pick one with --device <serial> or INKDECK_DEVICE:\n${listing}`,
        )
      }
    }
    if (!announced) {
      announced = true
      console.error(`[inkdeck] waiting for ${wanted ? `Stream Deck ${wanted}` : 'a Stream Deck'}…`)
    }
    await sleep(DEVICE_POLL_MS)
  }
}

/** waitForDevice + open, retrying open failures (Elgato app still running,
 *  device still settling after enumeration) without spamming. */
async function acquireDevice(
  transport: Transport,
  wanted: string | undefined,
): Promise<{ info: DeviceInfo; handle: TransportHandle }> {
  let lastFailure = ''
  for (;;) {
    const info = await waitForDevice(transport, wanted)
    try {
      return { info, handle: await transport.open(info.path) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastFailure) {
        lastFailure = message
        console.error(message)
        console.error('[inkdeck] retrying every 2 s…')
      }
      await sleep(2000)
    }
  }
}

/**
 * Minimal reload-on-save (M2 semantics; the no-flicker/changed-set polish is
 * M4): cache-busting dynamic import so the transport handle and controller
 * stay alive; a broken save logs and keeps watching (§10). Shared by
 * `dev` (hardware) and `dev --simulate`.
 */
export function watchApp(absPath: string, displayPath: string, controller: DeckController): void {
  let generation = 0
  let reloading = false
  // Prove only dirty keys repaint (§13 M4): collect the repainted positions
  // across each reload and log the set.
  let repainted: number[] = []
  controller.onRendered((changed) => {
    repainted.push(...changed)
  })
  const reload = async () => {
    generation++
    try {
      const mod = await import(`${absPath}?inkdeck-reload=${generation}`)
      const App = mod.default as ComponentType
      if (typeof App !== 'function') {
        console.error(`[inkdeck] ${displayPath} no longer default-exports a component — keeping the previous render`)
        return
      }
      repainted = []
      controller.render(createElement(App))
      await controller.settled()
      const changedSet = [...new Set(repainted)].sort((a, b) => a - b)
      console.error(
        changedSet.length > 0
          ? `[inkdeck] reloaded ${displayPath} — repainted keys [${changedSet.join(', ')}]`
          : `[inkdeck] reloaded ${displayPath} — no visual change`,
      )
    } catch (error) {
      console.error(`[inkdeck] reload failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
    } finally {
      reloading = false
    }
  }
  // Watch the parent directory, not the file: editors (and sed -i) save via
  // write-to-temp + rename, which replaces the inode and silently kills a
  // file-scoped watcher after the first save.
  const base = basename(absPath)
  watch(dirname(absPath), (_event, filename) => {
    if (filename && filename !== base) return
    if (reloading) return
    reloading = true
    // Debounce editor save bursts (write + rename events).
    setTimeout(() => void reload(), 50)
  })
  console.error(`[inkdeck] watching ${displayPath} — save to reload, Ctrl-C to exit`)
}

export async function startCommand(appPath: string, options: StartOptions = {}): Promise<number> {
  const app = await loadApp(appPath)

  const { transport, reason } = await hardwareTransport()
  if (!transport) {
    console.error(`[inkdeck] ${reason}`)
    return 1
  }

  let controller: DeckController | null = null
  let shuttingDown = false
  const shutdown = async (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    // Clear deck, reset, close transport, exit (§9).
    await controller?.shutdown()
    process.exit(code)
  }
  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  const wanted = options.device ?? process.env.INKDECK_DEVICE
  const { info, handle } = await acquireDevice(transport, wanted)
  const model = requireRenderableModel(info.model)
  console.error(`[inkdeck] using ${model.id} ${info.serial} (${model.columns}×${model.rows})`)

  controller = new DeckController({
    model,
    handle,
    serial: info.serial,
    assetDir: app.appDir,
    debug: options.debug,
  })
  const deck = controller

  // Unplug ⇒ one line, keep the React tree alive, wait for the same deck to
  // come back, reattach, repaint everything. Autostart survives replugs.
  deck.onDeviceLost(() => {
    void (async () => {
      console.error('[inkdeck] device disconnected')
      try {
        const { handle: reopened } = await acquireDevice(transport, info.serial)
        if (shuttingDown) return
        await deck.replaceHandle(reopened)
        console.error(`[inkdeck] reconnected to ${info.serial} — repainting`)
      } catch (error) {
        console.error(`[inkdeck] reconnect failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
        await shutdown(1)
      }
    })()
  })

  try {
    if (app.config.fonts?.length) {
      await deck.raster.loadAppFonts(app.config.fonts, app.appDir)
    }
    await deck.start()
    deck.render(createElement(app.App))
    await deck.settled()
  } catch (error) {
    console.error(`[inkdeck] ${error instanceof Error ? (error.stack ?? error.message) : error}`)
    await shutdown(1)
    return 1
  }

  if (options.watch) {
    watchApp(app.appPath, appPath, deck)
  }

  // Long-running from here: the IOKit run-loop pump interval keeps the
  // process alive, and exit happens through the signal handlers above —
  // resolving would let index.ts process.exit() and kill the session.
  return new Promise<number>(() => {})
}
