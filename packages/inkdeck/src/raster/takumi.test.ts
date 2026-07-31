// M0 smoke test (SPEC §13 M0): Takumi renders a styled div with the bundled
// font → raw RGBA → sharp → JPEG → decode confirms dimensions. If this breaks
// on the pinned Bun, stop and flag — do not work around it with a new package (§2).

import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { modelById } from '../device/models.js'
import { RasterEngine } from './takumi.js'
import type { SceneNode } from './scene.js'

const mk2 = modelById('mk2')!

const scene: SceneNode = {
  kind: 'element',
  tag: 'div',
  className: 'flex h-full w-full flex-col items-center justify-center gap-1 bg-[#0a7d33]',
  children: [
    {
      kind: 'element',
      tag: 'span',
      className: 'text-[12px] uppercase tracking-wide text-white/70',
      children: [{ kind: 'text', text: 'mic' }],
    },
    {
      kind: 'element',
      tag: 'span',
      className: 'text-[20px] font-bold text-white',
      children: [{ kind: 'text', text: 'LIVE' }],
    },
  ],
}

describe('raster pipeline (M0 smoke)', () => {
  test('scene → RGBA → sharp JPEG → decoded dimensions match the model', async () => {
    const engine = new RasterEngine()
    const rgba = await engine.renderScene(scene, mk2)
    expect(rgba.length).toBe(mk2.keyW * mk2.keyH * 4)

    // Bundled-font glyphs actually drew something over the background.
    let nonBackground = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (Math.abs(rgba[i] - 0x0a) > 32 || Math.abs(rgba[i + 1] - 0x7d) > 32) nonBackground++
    }
    expect(nonBackground).toBeGreaterThan(50)

    const jpeg = await engine.rgbaToJpeg(rgba, mk2)
    const meta = await sharp(Buffer.from(jpeg)).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(mk2.keyW)
    expect(meta.height).toBe(mk2.keyH)
    expect(meta.chromaSubsampling).toBe('4:4:4')

    const png = await engine.rgbaToPng(rgba, mk2)
    const pngMeta = await sharp(Buffer.from(png)).metadata()
    expect(pngMeta.format).toBe('png')
    expect(pngMeta.width).toBe(mk2.keyW)
    expect(pngMeta.height).toBe(mk2.keyH)
  })

  test('rendering is deterministic: identical scene ⇒ byte-identical RGBA and JPEG', async () => {
    const engine = new RasterEngine()
    const a = await engine.renderScene(scene, mk2)
    const b = await engine.renderScene(scene, mk2)
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
    const ja = await engine.rgbaToJpeg(a, mk2)
    const jb = await engine.rgbaToJpeg(b, mk2)
    expect(Buffer.compare(Buffer.from(ja), Buffer.from(jb))).toBe(0)
  })

  test('null scene renders solid black', async () => {
    const engine = new RasterEngine()
    const rgba = await engine.renderScene(null, mk2)
    for (let i = 0; i < 40; i += 4) {
      expect(rgba[i]).toBe(0)
      expect(rgba[i + 1]).toBe(0)
      expect(rgba[i + 2]).toBe(0)
    }
  })
})
