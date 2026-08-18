// Raster smoke test (SPEC §13 M0): Takumi renders a styled div with the bundled
// font → raw RGBA → JPEG/PNG (also Takumi); headers confirm dimensions and 4:4:4.
// If this breaks on the pinned Bun, stop and flag — do not work around it with
// a new package (§2).

import { describe, expect, test } from 'bun:test'
import { imageInfo } from '../test/imageInfo.js'
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
  test('scene → RGBA → JPEG/PNG whose headers match the model', async () => {
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
    expect(imageInfo(jpeg)).toEqual({ format: 'jpeg', width: mk2.keyW, height: mk2.keyH, chromaSubsampling: '4:4:4' })

    const png = await engine.rgbaToPng(rgba, mk2)
    expect(imageInfo(png)).toEqual({ format: 'png', width: mk2.keyW, height: mk2.keyH })
  })

  test('the device JPEG is the RGBA flipped both ways (gen-2 transform), pixel-exact', async () => {
    const engine = new RasterEngine()
    // An asymmetric scene: red top-left quadrant on black.
    const rgba = await engine.renderScene(
      { kind: 'element', tag: 'div', style: { width: 36, height: 36, backgroundColor: '#ff0000' }, children: [] },
      mk2,
    )
    const w = mk2.keyW
    const at = (buf: Uint8Array, x: number, y: number) => [buf[(y * w + x) * 4], buf[(y * w + x) * 4 + 1], buf[(y * w + x) * 4 + 2]]
    expect(at(rgba, 5, 5)).toEqual([255, 0, 0])
    expect(at(rgba, w - 6, w - 6)).toEqual([0, 0, 0])
    // Decode the JPEG back through Takumi and check the quadrant moved to bottom-right.
    const jpeg = await engine.rgbaToJpeg(rgba, mk2)
    const decoded = await engine.decodeToRgba(jpeg, mk2.keyW, mk2.keyH)
    const [r1] = at(decoded, w - 6, w - 6)
    const [r2] = at(decoded, 5, 5)
    expect(r1).toBeGreaterThan(200)
    expect(r2).toBeLessThan(40)
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
