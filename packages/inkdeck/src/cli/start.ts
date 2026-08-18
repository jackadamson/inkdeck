// `inkdeck start <app.tsx> [--device S]` — run against hardware (SPEC §9),
// waiting for the deck and surviving unplug/replug. `inkdeck dev` reuses this
// with watch=true (hot reload, see watchApp).

import { watch } from 'node:fs'
import { dirname, sep } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { hardwareTransport } from '../device/discovery.js'
import { requireRenderableModel } from '../device/models.js'
import { DeckController } from '../renderer/controller.js'
import {
  DeviceDisconnectedError,
  TransportIOError,
  type DeviceInfo,
  type Transport,
  type TransportHandle,
} from '../transport/iface.js'
import { loadApp } from './headless.js'
import { DEV_BUNDLE_NAME, loadAppBundle, removeAppBundle } from './devBundle.js'

export interface StartOptions {
  device?: string
  watch?: boolean
  debug?: boolean
}

const DEVICE_POLL_MS = 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Errors that mean "the device went away / rejected us", as opposed to a bug. */
function isDeviceError(error: unknown): boolean {
  return error instanceof DeviceDisconnectedError || error instanceof TransportIOError
}

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
 * Reload-on-save for `dev` (hardware and --simulate). Every save re-bundles
 * the app's whole module graph (see devBundle.ts) and re-renders into the
 * live controller, so the transport handle stays open and only keys whose
 * pixels changed repaint (§13 M4). A broken save logs and keeps watching (§10).
 */
export function watchApp(absPath: string, displayPath: string, controller: DeckController): () => void {
  const appDir = dirname(absPath)
  let reloading = false
  let dirty = false
  let repainted: number[] = []
  const unsubscribe = controller.onRendered((changed) => {
    repainted.push(...changed)
  })
  const reload = async (): Promise<void> => {
    reloading = true
    do {
      dirty = false
      try {
        const bundle = await loadAppBundle(absPath)
        // Image bytes are cached by src; a saved asset must be re-read.
        controller.raster.clearImageCache()
        if (bundle.config.fonts?.length) {
          await controller.raster.loadAppFonts(bundle.config.fonts, appDir)
        }
        repainted = []
        controller.render(createElement(bundle.App))
        await controller.settled()
        const changedSet = [...new Set(repainted)].sort((a, b) => a - b)
        console.error(
          changedSet.length > 0
            ? `[inkdeck] reloaded ${displayPath} — repainted keys [${changedSet.join(', ')}]`
            : `[inkdeck] reloaded ${displayPath} — no visual change`,
        )
      } catch (error) {
        console.error(`[inkdeck] reload failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
      }
    } while (dirty) // a save landed mid-reload: go again with the latest files
    reloading = false
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (reloading) {
      dirty = true
      return
    }
    // Debounce editor save bursts (write + rename events).
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void reload()
    }, 50)
  }
  // Watch the app directory recursively (editors save via write-to-temp +
  // rename, which kills a file-scoped watcher; and imported modules live
  // anywhere under the app dir). Skip node_modules, VCS dirs and our own
  // bundle output.
  const watcher = watch(appDir, { recursive: true }, (_event, filename) => {
    if (!filename) return schedule()
    const rel = String(filename)
    if (rel === DEV_BUNDLE_NAME || rel.split(sep).some((part) => part === 'node_modules' || part === '.git')) return
    schedule()
  })
  console.error(`[inkdeck] watching ${displayPath} (and everything under ${appDir}) — save to reload, Ctrl-C to exit`)
  return () => {
    watcher.close()
    if (timer) clearTimeout(timer)
    unsubscribe()
    void removeAppBundle(absPath)
  }
}

export async function startCommand(appPath: string, options: StartOptions = {}): Promise<number> {
  const app = await loadApp(appPath)

  const { transport, reason } = await hardwareTransport()
  if (!transport) {
    console.error(`[inkdeck] ${reason}`)
    return 1
  }

  let controller: DeckController | null = null
  let stopWatch: (() => void) | null = null
  let shuttingDown = false
  const shutdown = async (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    stopWatch?.()
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
  // come back, reattach, repaint everything. Autostart survives replugs, and
  // a deck that drops again mid-handshake is simply waited for again — only
  // a non-device error ends the session.
  deck.onDeviceLost(() => {
    void (async () => {
      console.error('[inkdeck] device disconnected')
      for (;;) {
        const { handle: reopened } = await acquireDevice(transport, info.serial)
        if (shuttingDown) return
        try {
          await deck.replaceHandle(reopened)
          console.error(`[inkdeck] reconnected to ${info.serial} — repainting`)
          return
        } catch (error) {
          if (isDeviceError(error)) {
            console.error(`[inkdeck] reconnect handshake failed (${error instanceof Error ? error.message : error}) — waiting for the deck again`)
            await reopened.close().catch(() => {})
            await sleep(DEVICE_POLL_MS)
            continue
          }
          console.error(`[inkdeck] reconnect failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
          await shutdown(1)
          return
        }
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
    stopWatch = watchApp(app.appPath, appPath, deck)
  }

  // Long-running from here: the IOKit run-loop pump interval keeps the
  // process alive, and exit happens through the signal handlers above —
  // resolving would let index.ts process.exit() and kill the session.
  return new Promise<number>(() => {})
}
