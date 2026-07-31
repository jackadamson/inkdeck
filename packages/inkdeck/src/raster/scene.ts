// The per-key scene tree: a small, JSON-serializable snapshot of a <Key>'s
// children, captured at commit time. It is the unit of dirty diffing (hash it,
// SPEC §6.2), the input to the raster layer, and the source of the manifest's
// structural view (§11.1) — so it must stay plain data.

export type SceneNode = SceneElement | SceneText

export interface SceneElement {
  kind: 'element'
  /** One of the supported subset: div, span, p, img, svg (§7.1). */
  tag: string
  /** Tailwind utility classes (resolved by Takumi). */
  className?: string
  /** Inline style for dynamic values. */
  style?: Record<string, unknown>
  /** img only: file path or data buffer reference. */
  src?: string
  /** svg only: serialized markup of the svg subtree. */
  svg?: string
  children: SceneNode[]
}

export interface SceneText {
  kind: 'text'
  text: string
}

/** Stable JSON for hashing: key order is deterministic by construction. */
export function sceneHash(scene: SceneNode | null): string {
  const json = JSON.stringify(scene)
  return Bun.hash(json).toString(16)
}

/** Collect every #text node in document order (manifest `text` field, §11.1). */
export function collectText(scene: SceneNode | null): string[] {
  const out: string[] = []
  const walk = (node: SceneNode): void => {
    if (node.kind === 'text') {
      if (node.text.length > 0) out.push(node.text)
      return
    }
    for (const child of node.children) walk(child)
  }
  if (scene) walk(scene)
  return out
}
