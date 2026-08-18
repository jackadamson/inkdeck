// Public API of @jackadamson/inkdeck.

export {
  Deck,
  Key,
  Image,
  ErrorBoundary,
  type DeckProps,
  type KeyProps,
  type ImageProps,
  type ErrorBoundaryProps,
} from './renderer/components.js'
export { useDeckInfo, useBrightness, useKeyState, usePoller, type Poller } from './renderer/hooks.js'
export { exec, type ExecResult } from './renderer/exec.js'
export type { DeckInfo } from './renderer/controller.js'
export type { ModelId, KnownModelId, RenderableModelId } from './device/models.js'

export type { InkdeckConfig } from './config.js'
