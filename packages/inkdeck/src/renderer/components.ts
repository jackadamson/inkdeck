// Public components (SPEC §7.1). <Deck> and <Key> render internal host
// elements; content inside a <Key> is ordinary JSX (div/span/p/img/svg).

import { Component, createElement, useMemo, type ReactNode } from 'react'
import { DeckContext } from './context.js'
import { DECK_TYPE, KEY_ERROR_TYPE, KEY_TYPE } from './hostTree.js'

export interface DeckProps {
  /** Runtime-reactive panel brightness, 0–100. */
  brightness?: number
  children?: ReactNode
}

export function Deck(props: DeckProps): ReactNode {
  return createElement(DECK_TYPE, { brightness: props.brightness }, props.children)
}

export interface KeyProps {
  /** The physical key slot this element owns (row-major, 0-based). */
  position: number
  /** May be async; rejections are caught and logged, never fatal (§10). */
  onPress?: () => unknown
  onLongPress?: () => unknown
  longPressMs?: number
  children?: ReactNode
}

export function Key(props: KeyProps): ReactNode {
  // Captured once per mount; used to build the duplicate-position error that
  // shows both component stacks (§7.1).
  const stack = useMemo(() => new Error('<Key> mounted here').stack ?? '(no stack)', [])
  return createElement(
    KEY_TYPE,
    {
      position: props.position,
      onPress: props.onPress,
      onLongPress: props.onLongPress,
      longPressMs: props.longPressMs,
      stack,
    },
    createElement(KeyBoundary, { position: props.position }, props.children),
  )
}

interface KeyBoundaryProps {
  position: number
  children?: ReactNode
}

interface BoundaryState {
  error: Error | null
}

/**
 * Root error boundary wrapped around every <Key> subtree (§7.1, §10): a render
 * throw paints the fallback error tile on that key only; the rest of the deck
 * keeps working.
 */
class KeyBoundary extends Component<KeyBoundaryProps, BoundaryState> {
  static contextType = DeckContext
  declare context: React.ContextType<typeof DeckContext>
  state: BoundaryState = { error: null }
  #lastLogged: string | null = null

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // A key that keeps failing on every parent render is logged once per
    // distinct message, not once per attempt.
    if (this.#lastLogged === error.message) return
    this.#lastLogged = error.message
    const line = `[inkdeck] [key ${this.props.position}] render error: ${error.message}${info.componentStack ?? ''}`
    if (this.context) this.context.logger.error(line)
    else console.error(line)
  }

  componentDidUpdate(prevProps: KeyBoundaryProps): void {
    // New children (the parent re-rendered) ⇒ try again, so a transient error
    // recovers on the next good render instead of sticking until a remount.
    if (this.state.error && prevProps.children !== this.props.children) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return createElement(KEY_ERROR_TYPE, { message: this.state.error.message })
    }
    return this.props.children
  }
}

export interface ErrorBoundaryProps {
  fallback?: ReactNode | ((error: Error) => ReactNode)
  onError?: (error: Error) => void
  children?: ReactNode
}

/** App-facing boundary for finer control than the built-in per-key one. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error)
  }

  render(): ReactNode {
    if (this.state.error) {
      const { fallback } = this.props
      if (typeof fallback === 'function') return fallback(this.state.error)
      return fallback ?? null
    }
    return this.props.children
  }
}

export interface ImageProps {
  /** File path (relative to the app file, or absolute) or the image bytes themselves. */
  src: string | Uint8Array
  className?: string
  style?: Record<string, unknown>
}

/** `<img>` that also accepts in-memory bytes (SPEC §6.1: "file path or Buffer"). */
export function Image(props: ImageProps): ReactNode {
  return createElement('img', { ...props })
}
