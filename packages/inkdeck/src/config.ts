// Static app configuration: `export const config = { … }` from the app file (SPEC §8).

import type { RenderableModelId } from './device/models.js'

export interface InkdeckConfig {
  /**
   * Model for the simulator/headless commands (render, check, agent,
   * --simulate) when no --model flag is given. It never constrains hardware:
   * `start`/`dev` render on whatever deck is attached.
   */
  defaultModel?: RenderableModelId
  /** Extra font files (paths relative to the app file). */
  fonts?: string[]
}
