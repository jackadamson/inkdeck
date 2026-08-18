// Hot reload must pick up edits in modules the app *imports*, not only the
// entry file (a cache-busted import of the entry alone left them stale).

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { modelById } from '../device/models.js'
import { DeckController } from '../renderer/controller.js'
import { VirtualTransport } from '../transport/virtual.js'
import { buildManifest } from '../harness/manifest.js'
import { loadAppBundle } from './devBundle.js'
import { loadApp } from './headless.js'
import { watchApp } from './start.js'

const INKDECK = join(import.meta.dir, '..', 'index.ts')
const dir = mkdtempSync(join(tmpdir(), 'inkdeck-hot-'))
// The app needs react resolvable from its own directory, like a real app.
symlinkSync(join(import.meta.dir, '..', '..', 'node_modules'), join(dir, 'node_modules'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function writeApp(label: string): void {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'dep.ts'), `export const LABEL = ${JSON.stringify(label)}\n`)
  writeFileSync(
    join(dir, 'app.tsx'),
    `import { Deck, Key } from ${JSON.stringify(INKDECK)}
import { LABEL } from './lib/dep.ts'
export default function App() {
  return <Deck><Key position={0}><span className="text-white">{LABEL}</span></Key></Deck>
}
`,
  )
}

describe('dev hot reload', () => {
  test('loadAppBundle re-evaluates transitive modules', async () => {
    writeApp('v1')
    const appPath = join(dir, 'app.tsx')
    // Bundling only proves the graph is fresh; render both to compare.
    const first = await loadAppBundle(appPath)
    writeApp('v2')
    const second = await loadAppBundle(appPath)
    expect(first.App).not.toBe(second.App)
    // The entry re-imported through the plain registry would still see v1.
    const mk2 = modelById('mk2')!
    const transport = new VirtualTransport(mk2)
    const handle = await transport.open('virtual:0')
    const controller = new DeckController({ model: mk2, handle, assetDir: dir })
    await controller.start()
    controller.render(createElement(second.App))
    await controller.settled()
    expect(buildManifest(controller).keys[0]!.text).toEqual(['v2'])
    await controller.shutdown()
  })

  test('watchApp reloads when an imported module is saved', async () => {
    writeApp('one')
    const app = await loadApp(join(dir, 'app.tsx'))
    const mk2 = modelById('mk2')!
    const transport = new VirtualTransport(mk2)
    const handle = await transport.open('virtual:0')
    const controller = new DeckController({ model: mk2, handle, assetDir: dir })
    await controller.start()
    controller.render(createElement(app.App))
    await controller.settled()
    expect(buildManifest(controller).keys[0]!.text).toEqual(['one'])

    const rendered = new Promise<void>((resolve) => {
      const off = controller.onRendered(() => {
        off()
        resolve()
      })
    })
    const stop = watchApp(app.appPath, 'app.tsx', controller)
    await new Promise((resolve) => setTimeout(resolve, 100)) // watcher warm-up
    writeFileSync(join(dir, 'lib', 'dep.ts'), `export const LABEL = 'two'\n`)
    await Promise.race([rendered, new Promise((_, reject) => setTimeout(() => reject(new Error('no reload within 5 s')), 5000))])
    await controller.settled()
    expect(buildManifest(controller).keys[0]!.text).toEqual(['two'])
    stop()
    await controller.shutdown()
  }, 10000)
})
