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
// Verified on real hardware for the XL (M2, see HARDWARE.md); the other gen-2
// models carry the same protocol per the source above but are unverified.

/** Every model discovery recognises (so `inkdeck list` can name it). */
export type KnownModelId = 'mk2' | 'xl' | 'mini' | 'plus' | 'neo' | 'original-v2'
/** Models the v1 render pipeline drives (gen-2 JPEG keys, no dial/LCD extras needed). */
export type RenderableModelId = 'mk2' | 'xl' | 'neo' | 'original-v2'
export type ModelId = KnownModelId

export interface Model {
  id: KnownModelId
  name: string
  productIds: number[]
  columns: number
  rows: number
  keyW: number
  keyH: number
  /** Image orientation the device expects (SPEC §5.3). */
  transform: { flipH: boolean; flipV: boolean }
  packetSize: number
  /** False ⇒ discovery only; `unsupported` says why rendering is post-MVP. */
  renderable: boolean
  unsupported?: string
}

export const VENDOR_ID = 0x0fd9

const GEN2_JPEG = {
  // generic-gen2.ts: JpegButtonLcdImagePacker transform { xFlip: true, yFlip: true }
  transform: { flipH: true, flipV: true },
  // imageWriter.ts: StreamdeckDefaultImageWriter MAX_PACKET_SIZE = 1024 (includes 8-byte header)
  packetSize: 1024,
  renderable: true,
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
    keyH: 96, // models/neo.ts (8 main keys; the 2 touch keys + 248×58 LCD strip are [P1])
    ...GEN2_JPEG,
  },
  {
    id: 'plus',
    name: 'Stream Deck +',
    productIds: [0x0084], // PLUS — dials/LCD are [P1]; keys unverified, listed for discovery only
    columns: 4,
    rows: 2,
    keyW: 120,
    keyH: 120, // models/plus.ts (4 dials + 800×100 LCD strip are [P1])
    transform: { flipH: false, flipV: false },
    packetSize: 1024,
    renderable: false,
    unsupported: 'dial/LCD devices are post-MVP',
  },
  {
    id: 'mini',
    name: 'Stream Deck Mini',
    productIds: [0x0063, 0x0090, 0x00b3], // MINI — gen-1 BMP protocol, rendering is [P1]
    columns: 3,
    rows: 2,
    keyW: 80,
    keyH: 80, // models/6-key.ts (gen-1: BMP images rotated 90°)
    transform: { flipH: false, flipV: false },
    packetSize: 1024,
    renderable: false,
    unsupported: 'gen-1 BMP devices are post-MVP',
  },
]

export const RENDERABLE_MODELS: RenderableModelId[] = MODELS.filter((m) => m.renderable).map((m) => m.id as RenderableModelId)

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
  if (!model.renderable) {
    throw new Error(
      `[inkdeck] model "${id}" is not renderable in v1 (${model.unsupported ?? 'unsupported'}). Use one of: ${RENDERABLE_MODELS.join(', ')}`,
    )
  }
  return model
}
