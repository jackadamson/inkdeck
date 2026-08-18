// `inkdeck render <app.tsx> --out DIR [--model M]` — headless one-shot:
// PNGs + manifest.json (SPEC §9, §11.1).

import { createElement } from 'react'
import { writeFrames } from '../harness/frames.js'
import { bootDeck } from '../session.js'
import { loadApp, resolveHeadlessModel } from './loadApp.js'

export async function renderCommand(appPath: string, outDir: string, modelFlag?: string): Promise<void> {
  const app = await loadApp(appPath)
  const model = resolveHeadlessModel(app, modelFlag)
  const { controller } = await bootDeck({
    element: createElement(app.App),
    target: { kind: 'virtual', model },
    assetDir: app.appDir,
    fonts: app.config.fonts,
  })
  const manifest = await writeFrames(controller, outDir)
  await controller.shutdown()
  console.error(`[inkdeck] wrote ${manifest.keys.length} key(s) + manifest.json to ${outDir}`)
}
