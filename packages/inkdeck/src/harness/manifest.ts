// Manifest (SPEC §11.1): the semantic tree captured before rasterization.
// Structure beats pixels for agents; PNGs are still written for visual checks.

import type { DeckController } from '../renderer/controller.js'

export interface KeyManifest {
  position: number
  image: string
  hash: string | null
  text: string[]
  error: string | null
  hasPress: boolean
  hasLongPress: boolean
}

export interface Manifest {
  model: string
  columns: number
  rows: number
  keys: KeyManifest[]
}

export function buildManifest(controller: DeckController): Manifest {
  const info = controller.deckInfo
  return {
    model: info.model,
    columns: info.columns,
    rows: info.rows,
    keys: controller.keySnapshots().map((snapshot) => ({
      position: snapshot.position,
      image: `key-${snapshot.position}.png`,
      hash: snapshot.imageHash,
      text: snapshot.text,
      error: snapshot.error,
      hasPress: snapshot.hasPress,
      hasLongPress: snapshot.hasLongPress,
    })),
  }
}
