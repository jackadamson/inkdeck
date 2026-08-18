// SceneBuilder: host tree → per-position key definitions. Pure functions over
// the committed HostTree; the controller diffs and schedules from the result.
// Validation (one <Deck>, integer positions, no duplicates) lives here too.

import { errorTileScene, type SceneElement, type SceneNode, type SceneTag } from '../raster/scene.js'
import { serializeSvg } from '../raster/svg.js'
import {
  CONTENT_TYPES,
  DECK_TYPE,
  KEY_ERROR_TYPE,
  KEY_TYPE,
  findElements,
  type HostElement,
  type HostNode,
  type HostRoot,
} from './hostTree.js'

export interface SceneBuildContext {
  /** Registers <img src={bytes}> with the raster engine; returns the scene src key. */
  registerInlineImage: (bytes: Uint8Array) => string
}

export const DEFAULT_LONG_PRESS_MS = 500

export interface KeyDefinition {
  scene: SceneNode | null
  /** Boundary error message when the key's subtree threw. */
  error: string | null
  onPress?: () => unknown
  onLongPress?: () => unknown
  longPressMs: number
}

export interface CommitScenes {
  keys: Map<number, KeyDefinition>
  /** <Deck brightness>, when set. */
  brightness: number | null
  /** Positions ≥ keyCount that were mounted (and skipped). */
  outOfRange: number[]
}

/**
 * Walk a committed host tree. Throws on structural errors the app must fix
 * (no <Deck> at the root, several <Deck>s, non-integer or duplicate positions).
 */
export function buildCommitScenes(root: HostRoot, keyCount: number, ctx: SceneBuildContext): CommitScenes {
  const decks = findElements(root.children, DECK_TYPE)
  if (decks.length === 0) {
    if (root.children.length > 0) {
      throw new Error(
        '[inkdeck] the app must render a <Deck> at its root (import { Deck } from "@jackadamson/inkdeck")',
      )
    }
    return { keys: new Map(), brightness: null, outOfRange: [] } // unmounted
  }
  if (decks.length > 1) {
    throw new Error('[inkdeck] only one <Deck> may be mounted at a time')
  }
  const deck = decks[0]!
  const brightness = typeof deck.props.brightness === 'number' ? deck.props.brightness : null

  const byPosition = new Map<number, HostElement>()
  const outOfRange: number[] = []
  for (const key of findElements(deck.children, KEY_TYPE)) {
    if (key.hidden) continue
    const position = Number(key.props.position)
    if (!Number.isInteger(position) || position < 0) {
      throw new Error(
        `[inkdeck] <Key position={${String(key.props.position)}}> — position must be a non-negative integer`,
      )
    }
    const existing = byPosition.get(position)
    if (existing) {
      // Last-wins is a debugging nightmare on a physical grid (§7.1).
      throw new Error(
        `[inkdeck] two <Key> elements are mounted with position={${position}}.\n\nFirst:\n${existing.props.stack}\n\nSecond:\n${key.props.stack}`,
      )
    }
    if (position >= keyCount) {
      outOfRange.push(position)
      continue
    }
    byPosition.set(position, key)
  }

  const keys = new Map<number, KeyDefinition>()
  for (const [position, element] of byPosition) {
    const errorElement = findElements(element.children, KEY_ERROR_TYPE)[0]
    keys.set(position, {
      scene: errorElement ? errorTileScene() : hostToScene(element.children, ctx),
      error: errorElement ? String(errorElement.props.message ?? 'render error') : null,
      onPress: typeof element.props.onPress === 'function' ? (element.props.onPress as () => unknown) : undefined,
      onLongPress:
        typeof element.props.onLongPress === 'function' ? (element.props.onLongPress as () => unknown) : undefined,
      longPressMs: typeof element.props.longPressMs === 'number' ? element.props.longPressMs : DEFAULT_LONG_PRESS_MS,
    })
  }
  return { keys, brightness, outOfRange }
}

/** A <Key>'s children as a scene: one root node, or an implicit wrapping div. */
export function hostToScene(children: HostNode[], ctx: SceneBuildContext): SceneNode | null {
  const nodes = children
    .filter((c) => !c.hidden)
    .map((c) => nodeToScene(c, ctx))
    .filter((c): c is SceneNode => c !== null)
  if (nodes.length === 0) return null
  if (nodes.length === 1) return nodes[0]!
  return { kind: 'element', tag: 'div', children: nodes }
}

function nodeToScene(node: HostNode, ctx: SceneBuildContext): SceneNode | null {
  if (node.kind === 'text') {
    return { kind: 'text', text: node.text }
  }
  if (!CONTENT_TYPES.has(node.type)) {
    // createInstance already rejects these outside <svg>; svg subtrees never reach here.
    throw new Error(`[inkdeck] unsupported element <${node.type}> inside a <Key>`)
  }
  const el: SceneElement = { kind: 'element', tag: node.type as SceneTag, children: [] }
  const className = node.props.className
  if (typeof className === 'string' && className.length > 0) el.className = className
  const style = node.props.style
  if (style && typeof style === 'object') el.style = style as Record<string, unknown>
  if (el.tag === 'img') {
    const src = node.props.src
    if (typeof src === 'string') el.src = src
    else if (src instanceof Uint8Array) el.src = ctx.registerInlineImage(src)
    return el
  }
  if (el.tag === 'svg') {
    el.svg = serializeSvg(node)
    return el
  }
  el.children = node.children
    .filter((c) => !c.hidden)
    .map((c) => nodeToScene(c, ctx))
    .filter((c): c is SceneNode => c !== null)
  return el
}
