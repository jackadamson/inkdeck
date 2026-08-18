// <img> handling: file paths (app-relative), in-memory bytes via <Image>,
// rejected URL schemes, and scene-hash stability for style key order.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Deck, Image, Key } from '../index.js'
import { buildManifest } from '../harness/manifest.js'
import { mountVirtual } from '../test/helpers.js'
import { sceneHash } from './scene.js'

const dir = mkdtempSync(join(tmpdir(), 'inkdeck-img-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function solidPng(r: number, g: number, b: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r, g, b, alpha: 1 } } })
      .png()
      .toBuffer(),
  )
}

describe('<img>', () => {
  test('renders an app-relative file and identical in-memory bytes to the same pixels', async () => {
    const png = await solidPng(200, 30, 30)
    writeFileSync(join(dir, 'red.png'), png)
    const { controller } = await mountVirtual(
      <Deck>
        <Key position={0}>
          <img src="red.png" className="h-full w-full" />
        </Key>
        <Key position={1}>
          <Image src={png} className="h-full w-full" />
        </Key>
      </Deck>,
      { assetDir: dir },
    )
    const [a, b] = buildManifest(controller).keys
    expect(a!.error).toBeNull()
    expect(b!.error).toBeNull()
    expect(a!.hash).toBe(b!.hash)
    // A red image ⇒ red-dominant pixels.
    const rgba = controller.keyRgba(0)!
    expect(rgba[0]).toBeGreaterThan(150)
    expect(rgba[1]).toBeLessThan(80)
    await controller.shutdown()
  })

  test('http(s)/data URLs are rejected with a targeted message; the key shows the error tile', async () => {
    const errors: string[] = []
    const { controller } = await mountVirtual(
      <Deck>
        <Key position={0}>
          <img src="https://example.com/x.png" />
        </Key>
      </Deck>,
      { assetDir: dir, logger: { error: (l) => errors.push(l) } },
    )
    const key = buildManifest(controller).keys[0]!
    expect(key.error).toContain('remote and data: URLs are not supported')
    expect(errors.some((e) => e.includes('raster failed'))).toBe(true)
    await controller.shutdown()
  })
})

describe('sceneHash', () => {
  test('is independent of style key order', () => {
    const a = { kind: 'element' as const, tag: 'div' as const, style: { width: 1, height: 2 }, children: [] }
    const b = { kind: 'element' as const, tag: 'div' as const, style: { height: 2, width: 1 }, children: [] }
    expect(sceneHash(a)).toBe(sceneHash(b))
    expect(sceneHash(a)).not.toBe(sceneHash({ ...a, style: { width: 2, height: 2 } }))
  })
})
