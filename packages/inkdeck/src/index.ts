// Public API of @jackadamson/inkdeck.

export { Deck, Key, ErrorBoundary, type DeckProps, type KeyProps, type ErrorBoundaryProps } from './renderer/components.js'
export { useDeckInfo, useBrightness, useKeyState, usePoller, type Poller } from './renderer/hooks.js'
export { exec, type ExecResult } from './renderer/exec.js'
export type { DeckInfo } from './renderer/controller.js'
export type { ModelId } from './device/models.js'

export type { InkdeckConfig } from './config.js'
