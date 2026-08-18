// Shared plumbing for headless commands (render/check; agent reuses it in M3).

import { dirname, resolve } from 'node:path'
import { createElement, type ComponentType } from 'react'
import type { InkdeckConfig } from '../config.js'
import { requireRenderableModel, type Model } from '../device/models.js'
import { VirtualTransport } from '../transport/virtual.js'
import { DeckController } from '../renderer/controller.js'
import type { Clock } from '../renderer/clock.js'

export interface LoadedApp {
  App: ComponentType
  config: InkdeckConfig
  appPath: string
  appDir: string
}

export async function loadApp(path: string): Promise<LoadedApp> {
  const appPath = resolve(path)
  if (!(await Bun.file(appPath).exists())) {
    throw new Error(`[inkdeck] app file not found: ${appPath}`)
  }
  const mod = await import(appPath)
  const App = mod.default
  if (typeof App !== 'function') {
    throw new Error(
      `[inkdeck] ${path} must default-export a React component (export default function App() { … })`,
    )
  }
  const config: InkdeckConfig = mod.config && typeof mod.config === 'object' ? mod.config : {}
  return { App, config, appPath, appDir: dirname(appPath) }
}

export function resolveHeadlessModel(app: LoadedApp, flagModel?: string): Model {
  return requireRenderableModel(flagModel ?? app.config.model ?? 'mk2')
}

export interface HeadlessDeck {
  controller: DeckController
  transport: VirtualTransport
}

/** Mount the app against a VirtualTransport and wait for the first settle. */
export async function startHeadless(app: LoadedApp, model: Model, clock?: Clock): Promise<HeadlessDeck> {
  const transport = new VirtualTransport(model)
  const handle = await transport.open('virtual:0')
  const controller = new DeckController({
    model,
    handle,
    serial: transport.serial,
    clock,
    assetDir: app.appDir,
  })
  if (app.config.fonts?.length) {
    await controller.raster.loadAppFonts(app.config.fonts, app.appDir)
  }
  await controller.start()
  controller.render(createElement(app.App))
  await controller.settled()
  return { controller, transport }
}
