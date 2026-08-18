// Load an app module (default export + optional config) for the CLI commands.

import { dirname, resolve } from 'node:path'
import type { ComponentType } from 'react'
import type { InkdeckConfig } from '../config.js'
import { requireRenderableModel, type Model } from '../device/models.js'

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
  return requireRenderableModel(flagModel ?? app.config.defaultModel ?? 'mk2')
}
