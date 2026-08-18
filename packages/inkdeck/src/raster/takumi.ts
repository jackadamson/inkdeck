// Raster pipeline (SPEC §6): scene tree → Takumi node → raw RGBA → sharp.
// The JPEG (device push) and PNG (render command / simulator) are encoded from
// the same RGBA buffer so every surface shows identical pixels.

import { join } from 'node:path'
import { Renderer } from '@takumi-rs/core'
import sharp from 'sharp'
import type { Model } from '../device/models.js'
import { registerAppFonts, registerBundledFonts } from './fonts.js'
import type { SceneElement, SceneNode } from './scene.js'

interface TakumiNode {
  type: 'container' | 'text' | 'image'
  [key: string]: unknown
}

export class RasterEngine {
  #renderer: Renderer
  #ready: Promise<void>
  /** Base directory for resolving relative img src paths (the app's directory). */
  #assetDir: string
  #imageCache = new Map<string, Uint8Array>()

  constructor(assetDir = process.cwd()) {
    this.#renderer = new Renderer()
    this.#assetDir = assetDir
    this.#ready = registerBundledFonts(this.#renderer)
  }

  /** Drop cached <img> bytes (hot reload: a saved asset must be re-read). */
  clearImageCache(): void {
    this.#imageCache.clear()
  }

  async loadAppFonts(fontPaths: string[], appDir: string): Promise<void> {
    await this.#ready
    await registerAppFonts(this.#renderer, fontPaths, appDir)
  }

  /** Render a key scene to raw RGBA at the model's native key resolution. */
  async renderScene(scene: SceneNode | null, model: Model): Promise<Uint8Array> {
    await this.#ready
    const node = this.#rootNode(scene, model)
    const buffer = await this.#renderer.render(node as never, {
      width: model.keyW,
      height: model.keyH,
      format: 'raw',
    })
    return new Uint8Array(buffer)
  }

  /** Encode RGBA for the HID push: model flip/rotate transform + JPEG 4:4:4. */
  async rgbaToJpeg(rgba: Uint8Array, model: Model): Promise<Uint8Array> {
    let pipeline = sharp(Buffer.from(rgba), {
      raw: { width: model.keyW, height: model.keyH, channels: 4 },
    })
    if (model.transform.flipV) pipeline = pipeline.flip()
    if (model.transform.flipH) pipeline = pipeline.flop()
    if (model.transform.rotate !== 0) pipeline = pipeline.rotate(model.transform.rotate)
    const jpeg = await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()
    return new Uint8Array(jpeg)
  }

  /** Encode RGBA as PNG for render/simulator surfaces — untransformed (upright). */
  async rgbaToPng(rgba: Uint8Array, model: Model): Promise<Uint8Array> {
    const png = await sharp(Buffer.from(rgba), {
      raw: { width: model.keyW, height: model.keyH, channels: 4 },
    })
      .png()
      .toBuffer()
    return new Uint8Array(png)
  }

  /** The minimal fallback error tile painted when a key's boundary trips (SPEC §7.1, §10). */
  errorTileScene(): SceneNode {
    return {
      kind: 'element',
      tag: 'div',
      className: 'flex h-full w-full flex-col items-center justify-center gap-1 bg-[#7f1d1d]',
      children: [
        {
          kind: 'element',
          tag: 'span',
          className: 'text-[28px] font-bold text-white',
          children: [{ kind: 'text', text: '!' }],
        },
        {
          kind: 'element',
          tag: 'span',
          className: 'text-[11px] uppercase tracking-wide text-white/80',
          children: [{ kind: 'text', text: 'error' }],
        },
      ],
    }
  }

  /**
   * Wrap the key scene in a root container that fills the key, defaults the
   * background to black and text to white/16px Inter. A null scene (no
   * children / unmounted) renders black.
   */
  #rootNode(scene: SceneNode | null, model: Model): TakumiNode {
    return {
      type: 'container',
      style: {
        width: model.keyW,
        height: model.keyH,
        backgroundColor: '#000000',
        color: '#ffffff',
        fontSize: 16,
        fontFamily: 'Inter',
        display: 'flex',
      },
      children: scene ? [this.#toTakumi(scene)] : [],
    }
  }

  #toTakumi(node: SceneNode): TakumiNode {
    if (node.kind === 'text') {
      return { type: 'text', text: node.text }
    }
    return this.#elementToTakumi(node)
  }

  #elementToTakumi(el: SceneElement): TakumiNode {
    const meta: Record<string, unknown> = {}
    if (el.className) meta.tw = el.className // Takumi's Tailwind resolver (SPEC §2)
    if (el.style) meta.style = el.style

    if (el.tag === 'img') {
      if (!el.src) {
        throw new Error('[inkdeck] <img> requires a src prop — pass a file path (relative to the app file) or an absolute path')
      }
      return { type: 'image', src: this.#resolveImage(el.src), ...meta }
    }

    if (el.tag === 'svg') {
      // Serialized markup travels in the scene; Takumi rasterizes SVG passed as image src.
      return { type: 'image', src: el.svg ?? '<svg xmlns="http://www.w3.org/2000/svg"/>', ...meta }
    }

    // A span/p whose children are all text becomes a Takumi text node so the
    // element's own classes (font size, color, weight) style the glyphs directly.
    if ((el.tag === 'span' || el.tag === 'p') && el.children.every((c) => c.kind === 'text')) {
      const text = el.children.map((c) => (c.kind === 'text' ? c.text : '')).join('')
      return { type: 'text', text, ...meta }
    }

    return {
      type: 'container',
      children: el.children.map((c) => this.#toTakumi(c)),
      ...meta,
    }
  }

  #resolveImage(src: string): Uint8Array {
    const cached = this.#imageCache.get(src)
    if (cached) return cached
    const resolved = src.startsWith('/') ? src : join(this.#assetDir, src)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(require('node:fs').readFileSync(resolved))
    } catch {
      throw new Error(
        `[inkdeck] <img src="${src}"> could not be read (checked ${resolved}). Use a path relative to the app file or an absolute path.`,
      )
    }
    this.#imageCache.set(src, bytes)
    return bytes
  }
}
