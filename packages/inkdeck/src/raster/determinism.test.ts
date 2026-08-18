// M4 determinism pass (SPEC §13): same app + same state ⇒ byte-identical
// output — across repeated runs in fresh processes, and across machines.
// Fonts are explicit (§6.1), so nothing environment-dependent may leak in.
//
// The golden hashes in golden.json were recorded on macOS arm64 (Bun 1.3.11,
// takumi 2.5.4, sharp 0.34). A mismatch on another OS/arch is a REAL M4
// finding (a nondeterminism leak or a prebuild difference) — investigate, do
// not blindly regenerate. To regenerate after an intentional change:
//   INKDECK_UPDATE_GOLDEN=1 bun test packages/inkdeck/src/raster/determinism.test.ts

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { requireRenderableModel } from '../device/models.js'
import { HarnessSession } from '../harness/session.js'
import { normalizeMockExecConfig } from '../harness/mockExec.js'

const CLI = join(import.meta.dir, '..', 'cli', 'index.ts')
import { MIC_MUTE_APP as EXAMPLE } from '../test/helpers.js'
const GOLDEN_PATH = join(import.meta.dir, 'golden.json')

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

async function renderOnce(): Promise<{ png: Buffer; manifestHash: string }> {
  const out = mkdtempSync(join(tmpdir(), 'inkdeck-determinism-'))
  const proc = Bun.spawn([process.execPath, CLI, 'render', EXAMPLE, '--out', out, '--model', 'mk2'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`render exited ${code}: ${await new Response(proc.stderr).text()}`)
  const manifest = await Bun.file(join(out, 'manifest.json')).json()
  return { png: readFileSync(join(out, 'key-0.png')), manifestHash: manifest.keys[0].hash }
}

describe('determinism (M4)', () => {
  test('two fresh processes produce byte-identical PNGs and RGBA hashes', async () => {
    const [a, b] = await Promise.all([renderOnce(), renderOnce()])
    expect(a.manifestHash).toBe(b.manifestHash)
    expect(Buffer.compare(a.png, b.png)).toBe(0)
  }, 60000)

  test('reference output matches the committed golden hashes (cross-machine gate)', async () => {
    const { default: App } = await import(EXAMPLE)
    const mocks = normalizeMockExecConfig(await Bun.file(join(EXAMPLE, '..', 'mocks.json')).json(), 'mocks.json')
    const model = requireRenderableModel('mk2')
    const session = await HarnessSession.start({
      model,
      element: createElement(App),
      freezeTime: true,
      mockExec: mocks,
    })

    // Deterministic state: frozen clock, mount poll read the mocked volume 75.
    const snapshot = session.controller.keySnapshots().find((s) => s.position === 0)!
    expect(snapshot.text).toEqual(['mic', 'LIVE'])
    expect(snapshot.rgba).not.toBeNull()

    const rgba = snapshot.rgba!
    const jpeg = await session.controller.raster.rgbaToJpeg(rgba, model)
    const png = await session.controller.raster.rgbaToPng(rgba, model)
    const actual = {
      'mic-mute-key0-rgba': sha256(rgba),
      'mic-mute-key0-jpeg': sha256(jpeg),
      'mic-mute-key0-png': sha256(png),
    }
    await session.shutdown()

    if (process.env.INKDECK_UPDATE_GOLDEN === '1') {
      await Bun.write(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`)
      return
    }
    const goldens = await Bun.file(GOLDEN_PATH).json()
    expect(actual).toEqual(goldens)
  }, 60000)
})
