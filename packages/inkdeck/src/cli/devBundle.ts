// Hot reload for `dev` (SPEC §18.2): Bun's ESM registry has no invalidation
// API, and cache-busting `import(app?gen)` re-evaluates only the entry file —
// modules it imports stay stale. So each reload bundles the app's whole
// module graph (Bun.build, react + inkdeck external so the app shares the
// renderer's React) into one fresh module and imports that. The bundle is
// written next to the app (not a temp dir) so bare specifiers resolve from
// the app's node_modules and import.meta.dir stays the app directory.

import { unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ComponentType } from 'react'
import type { InkdeckConfig } from '../config.js'

export const DEV_BUNDLE_NAME = '.inkdeck-dev.js'

export interface BundledApp {
  App: ComponentType
  config: InkdeckConfig
}

const EXTERNAL = ['react', 'react/*', 'react-dom', 'react-dom/*', '@jackadamson/inkdeck', '@jackadamson/inkdeck/*']
// This package's own source root: anything resolving into it (a workspace
// or path import of the library) must stay external too, or the bundle would
// carry a second copy of the renderer with its own DeckContext.
const LIBRARY_ROOT = resolve(import.meta.dir, '..')

const keepLibraryExternal: import('bun').BunPlugin = {
  name: 'inkdeck-external',
  setup(build) {
    // Path imports only (bare specifiers are covered by EXTERNAL). Pure path
    // math, deliberately not Bun.resolveSync: calling it from onResolve under
    // `bun test` breaks later builds of rewritten files (Bun 1.3.11).
    build.onResolve({ filter: /^[./]/ }, (args) => {
      if (args.kind.startsWith('entry-point')) return undefined
      const target = resolve(dirname(args.importer), args.path)
      return target.startsWith(`${LIBRARY_ROOT}/`) ? { path: target, external: true } : undefined
    })
  },
}

let generation = 0

/** Bundle + import the app graph as a fresh module (never served from the registry). */
export async function loadAppBundle(appPath: string): Promise<BundledApp> {
  const outFile = join(dirname(appPath), DEV_BUNDLE_NAME)
  generation++
  const result = await Bun.build({
    entrypoints: [appPath],
    target: 'bun',
    format: 'esm',
    external: EXTERNAL,
    plugins: [keepLibraryExternal],
    sourcemap: 'inline',
    throw: false,
  })
  if (!result.success || result.outputs.length === 0) {
    const detail = result.logs.map((log) => log.message ?? String(log)).join('\n')
    throw new Error(`[inkdeck] bundling ${appPath} failed:\n${detail}`)
  }
  await Bun.write(outFile, await result.outputs[0]!.text())
  const mod = await import(`${outFile}?inkdeck-reload=${generation}`)
  const App = mod.default
  if (typeof App !== 'function') {
    throw new Error(`[inkdeck] ${appPath} must default-export a React component`)
  }
  const config: InkdeckConfig = mod.config && typeof mod.config === 'object' ? mod.config : {}
  return { App, config }
}

/** Best-effort removal of the bundle file on exit. */
export async function removeAppBundle(appPath: string): Promise<void> {
  await unlink(join(dirname(appPath), DEV_BUNDLE_NAME)).catch(() => {})
}
