// Raster pipeline (SPEC §6): scene tree → Takumi node → raw RGBA, then JPEG
// (device push, model transform applied) and PNG (render command / simulator,
// upright) are encoded from that same RGBA buffer — also by Takumi, fed back
// as an RgbaImage node — so every surface shows identical pixels and the
// only native dependency is Takumi (SPEC §2).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Renderer, type ImageSource, type Node as TakumiNode } from '@takumi-rs/core'
import type { Model } from '../device/models.js'
import { registerAppFonts, registerBundledFonts } from './fonts.js'
import { collectImageSources, INLINE_IMAGE_PREFIX, type SceneElement, type SceneNode } from './scene.js'

export class RasterEngine {
  #renderer: Renderer
  #ready: Promise<void>
  /** Base directory for resolving relative img src paths (the app's directory). */
  #assetDir: string
  /** File-backed <img> bytes by src (invalidated on hot reload). */
  #fileImages = new Map<string, Promise<Uint8Array>>()
  /** In-memory <img src={bytes}> registered by content hash (see registerInlineImage). */
  #inlineImages = new Map<string, Uint8Array>()

  constructor(assetDir = process.cwd()) {
    this.#renderer = new Renderer()
    this.#assetDir = assetDir
    this.#ready = registerBundledFonts(this.#renderer)
  }

  /** Drop cached file-backed <img> bytes (hot reload: a saved asset must be re-read). */
  clearImageCache(): void {
    this.#fileImages.clear()
  }

  /** Register in-memory image bytes; returns the scene src key that refers to them. */
  registerInlineImage(bytes: Uint8Array): string {
    const key = `${INLINE_IMAGE_PREFIX}${Bun.hash(bytes).toString(16)}`
    if (!this.#inlineImages.has(key)) this.#inlineImages.set(key, bytes)
    return key
  }

  async loadAppFonts(fontPaths: string[], appDir: string): Promise<void> {
    await this.#ready
    await registerAppFonts(this.#renderer, fontPaths, appDir)
  }

  /** Render a key scene to raw RGBA at the model's native key resolution. */
  async renderScene(scene: SceneNode | null, model: Model): Promise<Uint8Array> {
    await this.#ready
    // Image bytes are loaded up front (async, cached) and handed to Takumi
    // by src, so its decoded-image cache works across frames.
    const images = await Promise.all(collectImageSources(scene).map((src) => this.#imageSource(src)))
    const node = this.#rootNode(scene, model)
    const buffer = await this.#renderer.render(node, {
      width: model.keyW,
      height: model.keyH,
      format: 'raw',
      images,
    })
    return new Uint8Array(buffer)
  }

  /** Decode an encoded image (JPEG/PNG bytes) to raw RGBA at the given size (tests, tooling). */
  async decodeToRgba(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    await this.#ready
    const src = `${INLINE_IMAGE_PREFIX}decode-${Bun.hash(bytes).toString(16)}`
    const node: TakumiNode = {
      type: 'container',
      style: { width, height, display: 'flex' },
      children: [{ type: 'image', src, style: { width, height } }],
    }
    const buffer = await this.#renderer.render(node, { width, height, format: 'raw', images: [{ src, data: bytes }] })
    return new Uint8Array(buffer)
  }

  /** Encode RGBA for the HID push: model flip/rotate transform + JPEG (4:4:4, q95). */
  async rgbaToJpeg(rgba: Uint8Array, model: Model): Promise<Uint8Array> {
    return this.#encodeRgba(rgba, model, 'jpeg', deviceTransformCss(model))
  }

  /** Encode RGBA as PNG for render/simulator surfaces — untransformed (upright). */
  async rgbaToPng(rgba: Uint8Array, model: Model): Promise<Uint8Array> {
    return this.#encodeRgba(rgba, model, 'png', null)
  }

  /**
   * Re-encode raw RGBA through Takumi as an RgbaImage node. Identity is
   * lossless and the CSS flip is pixel-exact (verified against libvips'
   * flip+flop: 0 differing bytes at 72² and 96²).
   */
  async #encodeRgba(
    rgba: Uint8Array,
    model: Model,
    format: 'jpeg' | 'png',
    transform: string | null,
  ): Promise<Uint8Array> {
    await this.#ready
    const { keyW: width, keyH: height } = model
    const node: TakumiNode = {
      type: 'container',
      style: { width, height, display: 'flex' },
      children: [
        {
          type: 'image',
          src: { width, height, data: rgba },
          style: { width, height, ...(transform ? { transform } : {}) },
        },
      ],
    }
    const buffer = await this.#renderer.render(node, {
      width,
      height,
      format,
      ...(format === 'jpeg' ? { quality: 95 } : {}),
    })
    return new Uint8Array(buffer)
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
    const meta: { tw?: string; style?: TakumiNode['style'] } = {}
    if (el.className) meta.tw = el.className // Takumi's Tailwind resolver (SPEC §2)
    if (el.style) meta.style = el.style as TakumiNode['style']

    if (el.tag === 'img') {
      if (!el.src) {
        throw new Error(
          '[inkdeck] <img> requires a src prop — a file path (relative to the app file), an absolute path, or image bytes',
        )
      }
      return { type: 'image', src: el.src, ...meta }
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

  /** Bytes for one <img src>: inline registry, or a file under the app dir (cached). */
  async #imageSource(src: string): Promise<ImageSource> {
    if (src.startsWith(INLINE_IMAGE_PREFIX)) {
      const data = this.#inlineImages.get(src)
      if (!data) throw new Error(`[inkdeck] <img> refers to unregistered image bytes (${src})`)
      return { src, data }
    }
    if (/^(https?|data):/i.test(src)) {
      throw new Error(
        `[inkdeck] <img src="${src.slice(0, 40)}…"> — remote and data: URLs are not supported (no network, SPEC §16). Use a file path relative to the app file, or pass the image bytes.`,
      )
    }
    let pending = this.#fileImages.get(src)
    if (!pending) {
      const resolved = src.startsWith('/') ? src : join(this.#assetDir, src)
      pending = readFile(resolved)
        .then((buffer) => new Uint8Array(buffer))
        .catch(() => {
          this.#fileImages.delete(src) // do not cache the failure
          throw new Error(
            `[inkdeck] <img src="${src}"> could not be read (checked ${resolved}). Use a path relative to the app file or an absolute path.`,
          )
        })
      this.#fileImages.set(src, pending)
    }
    return { src, data: await pending }
  }
}

/** The model's image transform (SPEC §5.3) as CSS applied to the RGBA node. */
function deviceTransformCss(model: Model): string | null {
  const { flipH, flipV } = model.transform
  if (flipH && flipV) return 'scale(-1, -1)'
  if (flipH) return 'scaleX(-1)'
  if (flipV) return 'scaleY(-1)'
  return null
}
