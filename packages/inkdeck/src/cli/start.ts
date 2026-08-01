// `inkdeck start <app.tsx> [--device S]` — run once against hardware (SPEC §9).
// `inkdeck dev` reuses this with watch=true: minimal re-render-on-save for M2;
// the no-flicker hot-reload polish (changed-set logging, module cache surgery)
// is M4.

import { watch } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { hardwareTransport, selectDevice } from '../device/discovery.js'
import { requireRenderableModel } from '../device/models.js'
import { DeckController } from '../renderer/controller.js'
import { loadApp } from './headless.js'

export interface StartOptions {
  device?: string
  watch?: boolean
  debug?: boolean
}

export async function startCommand(appPath: string, options: StartOptions = {}): Promise<number> {
  const app = await loadApp(appPath)

  const { transport, reason } = await hardwareTransport()
  if (!transport) {
    console.error(`[inkdeck] ${reason}`)
    return 1
  }
  const devices = await transport.list()
  const info = selectDevice(devices, options.device)
  const model = requireRenderableModel(info.model)
  console.error(`[inkdeck] using ${model.id} ${info.serial} (${model.columns}×${model.rows})`)

  const handle = await transport.open(info.path)
  const controller = new DeckController({
    model,
    handle,
    serial: info.serial,
    assetDir: app.appDir,
    debug: options.debug,
  })

  let exitCode = 0
  let shuttingDown = false
  const shutdown = async (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    exitCode = code
    // Clear deck, reset, close transport, exit (§9).
    await controller.shutdown()
    process.exit(exitCode)
  }
  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  try {
    if (app.config.fonts?.length) {
      await controller.raster.loadAppFonts(app.config.fonts, app.appDir)
    }
    await controller.start()
    controller.render(createElement(app.App))
    await controller.settled()
  } catch (error) {
    console.error(`[inkdeck] ${error instanceof Error ? (error.stack ?? error.message) : error}`)
    await shutdown(1)
    return 1
  }

  if (options.watch) {
    let generation = 0
    let reloading = false
    watch(app.appPath, () => {
      if (reloading) return
      reloading = true
      // Debounce editor save bursts (write + rename events).
      setTimeout(() => void reload(), 50)
    })
    const reload = async () => {
      generation++
      try {
        // Cache-busting dynamic import: the transport handle and controller
        // stay alive; only the app module is re-evaluated (§9 dev semantics).
        const mod = await import(`${app.appPath}?inkdeck-reload=${generation}`)
        const App = mod.default as ComponentType
        if (typeof App !== 'function') {
          console.error(`[inkdeck] ${appPath} no longer default-exports a component — keeping the previous render`)
          return
        }
        controller.render(createElement(App))
        await controller.settled()
        console.error(`[inkdeck] reloaded ${appPath}`)
      } catch (error) {
        // A broken save must not kill the session; keep watching (§10).
        console.error(`[inkdeck] reload failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
      } finally {
        reloading = false
      }
    }
    console.error(`[inkdeck] watching ${appPath} — save to reload, Ctrl-C to exit`)
  }

  // Long-running from here: the IOKit run-loop pump interval keeps the
  // process alive, and exit happens through the signal handlers above —
  // resolving would let index.ts process.exit() and kill the session.
  return new Promise<number>(() => {})
}
