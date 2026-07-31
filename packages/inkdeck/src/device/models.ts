// Per-model constants for Elgato Stream Deck devices.
//
// Transcribed from the MIT-licensed reference implementation
// github.com/Julusian/node-elgato-stream-deck (fetched 2026-07-31, master):
//   - product IDs:        packages/core/src/index.ts (DEVICE_MODELS2)
//   - grid + key pixels:  packages/core/src/models/{15-key,32-key,6-key,neo}.ts
//   - gen2 transform:     packages/core/src/models/generic-gen2.ts
//     (JpegButtonLcdImagePacker default `{ xFlip: true, yFlip: true }`)
//   - packet size:        packages/core/src/services/imageWriter/imageWriter.ts
//     (StreamdeckDefaultImageWriter MAX_PACKET_SIZE = 1024)
//
// NOT yet verified on real hardware — that is the M2 gate (SPEC §13).

export type ModelId = 'mk2' | 'xl' | 'mini' | 'plus' | 'neo' | 'original-v2'

export interface Model {
  id: ModelId
  name: string
  productIds: number[]
  columns: number
  rows: number
  keyW: number
  keyH: number
  imageFormat: 'jpeg' | 'bmp'
  transform: { flipH: boolean; flipV: boolean; rotate: 0 | 90 | 180 | 270 }
  packetSize: number
  hasDials?: boolean
  lcdStrip?: { w: number; h: number }
}

export const VENDOR_ID = 0x0fd9

const GEN2_JPEG = {
  imageFormat: 'jpeg' as const,
  // generic-gen2.ts: JpegButtonLcdImagePacker transform { xFlip: true, yFlip: true }
  transform: { flipH: true, flipV: true, rotate: 0 as const },
  // imageWriter.ts: StreamdeckDefaultImageWriter MAX_PACKET_SIZE = 1024 (includes 8-byte header)
  packetSize: 1024,
}

export const MODELS: Model[] = [
  {
    id: 'original-v2',
    name: 'Stream Deck (original v2)',
    productIds: [0x006d], // index.ts DEVICE_MODELS2 ORIGINALV2
    columns: 5,
    rows: 3,
    keyW: 72,
    keyH: 72, // models/15-key.ts generateButtonsGrid(5, 3, { width: 72, height: 72 })
    ...GEN2_JPEG,
  },
  {
    id: 'mk2',
    name: 'Stream Deck MK.2',
    productIds: [0x0080, 0x00a5], // ORIGINALMK2, ORIGINALMK2SCISSOR
    columns: 5,
    rows: 3,
    keyW: 72,
    keyH: 72, // models/15-key.ts
    ...GEN2_JPEG,
  },
  {
    id: 'xl',
    name: 'Stream Deck XL',
    productIds: [0x006c, 0x008f], // XL, XL v2
    columns: 8,
    rows: 4,
    keyW: 96,
    keyH: 96, // models/32-key.ts generateButtonsGrid(8, 4, { width: 96, height: 96 })
    ...GEN2_JPEG,
  },
  {
    id: 'neo',
    name: 'Stream Deck Neo',
    productIds: [0x009a], // NEO
    columns: 4,
    rows: 2,
    keyW: 96,
    keyH: 96, // models/neo.ts (8 main keys; the 2 touch keys + LCD strip are [P1])
    lcdStrip: { w: 248, h: 58 },
    ...GEN2_JPEG,
  },
  {
    id: 'plus',
    name: 'Stream Deck +',
    productIds: [0x0084], // PLUS — dials/LCD are [P1]; keys unverified, listed for discovery only
    columns: 4,
    rows: 2,
    keyW: 120,
    keyH: 120, // models/plus.ts
    imageFormat: 'jpeg',
    transform: { flipH: false, flipV: false, rotate: 0 },
    packetSize: 1024,
    hasDials: true,
    lcdStrip: { w: 800, h: 100 },
  },
  {
    id: 'mini',
    name: 'Stream Deck Mini',
    productIds: [0x0063, 0x0090, 0x00b3], // MINI — gen-1 BMP protocol, rendering is [P1]
    columns: 3,
    rows: 2,
    keyW: 80,
    keyH: 80, // models/6-key.ts
    imageFormat: 'bmp',
    transform: { flipH: false, flipV: false, rotate: 90 },
    packetSize: 1024,
  },
]

/** Models the v1 render pipeline supports (gen-2 JPEG devices, no dial/LCD extras needed). */
export const RENDERABLE_MODELS: ModelId[] = ['mk2', 'original-v2', 'xl', 'neo']

export function modelById(id: string): Model | undefined {
  return MODELS.find((m) => m.id === id)
}

export function modelByProductId(productId: number): Model | undefined {
  return MODELS.find((m) => m.productIds.includes(productId))
}

export function requireRenderableModel(id: string): Model {
  const model = modelById(id)
  if (!model) {
    const known = MODELS.map((m) => m.id).join(', ')
    throw new Error(`[inkdeck] unknown model "${id}". Known models: ${known}`)
  }
  if (!RENDERABLE_MODELS.includes(model.id)) {
    throw new Error(
      `[inkdeck] model "${id}" is not renderable in v1 (${model.imageFormat === 'bmp' ? 'gen-1 BMP devices are post-MVP' : 'dial/LCD devices are post-MVP'}). Use one of: ${RENDERABLE_MODELS.join(', ')}`,
    )
  }
  return model
}
