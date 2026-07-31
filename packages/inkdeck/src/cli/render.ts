// `inkdeck render <app.tsx> --out DIR [--model M]` — headless one-shot:
// PNGs + manifest.json (SPEC §9, §11.1).

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildManifest } from '../harness/manifest.js'
import { loadApp, resolveHeadlessModel, startHeadless } from './headless.js'

export async function renderCommand(appPath: string, outDir: string, modelFlag?: string): Promise<void> {
  const app = await loadApp(appPath)
  const model = resolveHeadlessModel(app, modelFlag)
  const { controller } = await startHeadless(app, model)

  await mkdir(outDir, { recursive: true })
  const manifest = buildManifest(controller)
  for (const snapshot of controller.keySnapshots()) {
    if (!snapshot.rgba) continue
    const png = await controller.raster.rgbaToPng(snapshot.rgba, model)
    await Bun.write(join(outDir, `key-${snapshot.position}.png`), png)
  }
  await Bun.write(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await controller.shutdown()
  console.error(`[inkdeck] wrote ${manifest.keys.length} key(s) + manifest.json to ${outDir}`)
}
