// Static app configuration: `export const config = { … }` from the app file (SPEC §8).

import type { RenderableModelId } from './device/models.js'

export interface InkdeckConfig {
  /** Default simulator/headless model when no hardware is attached. */
  model?: RenderableModelId
  /** Extra font files (paths relative to the app file). */
  fonts?: string[]
}
