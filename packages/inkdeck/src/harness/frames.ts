// key-N.png + manifest.json for the current state — `render`'s output and the
// agent's writeFrames (SPEC §9, §11.1, §11.2) share this.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeckController } from '../renderer/controller.js'
import { buildManifest, type Manifest } from './manifest.js'

export async function writeFrames(controller: DeckController, dir: string): Promise<Manifest> {
  await mkdir(dir, { recursive: true })
  const manifest = buildManifest(controller)
  for (const snapshot of controller.keySnapshots()) {
    if (!snapshot.rgba) continue
    const png = await controller.raster.rgbaToPng(snapshot.rgba, controller.model)
    await Bun.write(join(dir, `key-${snapshot.position}.png`), png)
  }
  await Bun.write(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
