// The mutable host tree the reconciler maintains. Plain objects; the
// controller walks this on every commit to derive per-key scenes.

export const DECK_TYPE = 'inkdeck-deck'
export const KEY_TYPE = 'inkdeck-key'
export const KEY_ERROR_TYPE = 'inkdeck-keyerror'

/** Elements allowed inside a <Key> (SPEC §7.1). */
export const CONTENT_TYPES = new Set(['div', 'span', 'p', 'img', 'svg'])

export interface HostElement {
  kind: 'element'
  type: string
  props: Record<string, unknown>
  children: HostNode[]
  hidden: boolean
}

export interface HostText {
  kind: 'text'
  text: string
  hidden: boolean
}

export type HostNode = HostElement | HostText

export interface HostRoot {
  kind: 'root'
  children: HostNode[]
  /** Set by the controller; invoked from resetAfterCommit. */
  onCommit: (() => void) | null
}

export function createHostRoot(): HostRoot {
  return { kind: 'root', children: [], onCommit: null }
}

/** Depth-first search for elements of a given type. Does not descend into matches. */
export function findElements(nodes: HostNode[], type: string): HostElement[] {
  const out: HostElement[] = []
  for (const node of nodes) {
    if (node.kind !== 'element') continue
    if (node.type === type) {
      out.push(node)
    } else {
      out.push(...findElements(node.children, type))
    }
  }
  return out
}
