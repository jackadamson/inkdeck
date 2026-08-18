// Manifest (SPEC §11.1): the semantic tree captured before rasterization.
// Structure beats pixels for agents; PNGs are still written for visual checks.

import type { ModelId } from '../device/models.js'
import type { DeckController } from '../renderer/controller.js'

export interface KeyManifest {
  position: number
  /** File name of the key's PNG — present only in manifests written next to frames (render, writeFrames). */
  image?: string
  hash: string | null
  text: string[]
  error: string | null
  hasPress: boolean
  hasLongPress: boolean
}

export interface Manifest {
  model: ModelId
  columns: number
  rows: number
  keys: KeyManifest[]
}

export function buildManifest(controller: DeckController, options: { withImages?: boolean } = {}): Manifest {
  const info = controller.deckInfo
  return {
    model: info.model,
    columns: info.columns,
    rows: info.rows,
    keys: controller.keySnapshots().map((snapshot) => ({
      position: snapshot.position,
      ...(options.withImages ? { image: `key-${snapshot.position}.png` } : {}),
      hash: snapshot.imageHash,
      text: snapshot.text,
      error: snapshot.error,
      hasPress: snapshot.hasPress,
      hasLongPress: snapshot.hasLongPress,
    })),
  }
}
