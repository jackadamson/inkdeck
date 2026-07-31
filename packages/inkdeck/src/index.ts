// Public API of @jackadamson/inkdeck.

export { Deck, Key, ErrorBoundary, type DeckProps, type KeyProps, type ErrorBoundaryProps } from './renderer/components.js'
export { useDeckInfo, useBrightness, useKeyState, usePoller } from './renderer/hooks.js'
export { exec, type ExecResult } from './renderer/exec.js'
export type { DeckInfo } from './renderer/controller.js'
export type { ModelId } from './device/models.js'

/** Optional static app configuration: `export const config = { … }` (SPEC §8). */
export interface InkdeckConfig {
  /** Default simulator/headless model when no hardware is attached. */
  model?: import('./device/models.js').ModelId
  /** Extra font files (paths relative to the app file). */
  fonts?: string[]
}
