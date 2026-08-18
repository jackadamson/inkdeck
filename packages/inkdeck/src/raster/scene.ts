// The per-key scene tree: a small, JSON-serializable snapshot of a <Key>'s
// children, captured at commit time. It is the unit of dirty diffing (hash it,
// SPEC §6.2), the input to the raster layer, and the source of the manifest's
// structural view (§11.1) — so it must stay plain data.

export type SceneNode = SceneElement | SceneText

/** Elements allowed inside a <Key> (SPEC §7.1); anything inside <svg> is serialized, not modelled. */
export type SceneTag = 'div' | 'span' | 'p' | 'img' | 'svg'

/** Scene src prefix for in-memory image bytes registered with the raster engine. */
export const INLINE_IMAGE_PREFIX = 'inline:'

export interface SceneElement {
  kind: 'element'
  tag: SceneTag
  /** Tailwind utility classes (resolved by Takumi). */
  className?: string
  /** Inline style for dynamic values. */
  style?: Record<string, unknown>
  /** img only: file path (app-relative or absolute) or an `inline:<hash>` key for registered bytes. */
  src?: string
  /** svg only: serialized markup of the svg subtree. */
  svg?: string
  children: SceneNode[]
}

export interface SceneText {
  kind: 'text'
  text: string
}

/**
 * Stable JSON for hashing. Framework keys are emitted in a fixed order, but a
 * user `style` object's key order is whatever the app wrote, so object keys
 * are sorted before hashing — `{a,b}` and `{b,a}` are the same scene.
 */
export function sceneHash(scene: SceneNode | null): string {
  return Bun.hash(stableStringify(scene)).toString(16)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

/** Every <img> src in a scene, deduplicated, in document order. */
export function collectImageSources(scene: SceneNode | null): string[] {
  const out = new Set<string>()
  const walk = (node: SceneNode): void => {
    if (node.kind === 'text') return
    if (node.tag === 'img' && node.src) out.add(node.src)
    for (const child of node.children) walk(child)
  }
  if (scene) walk(scene)
  return [...out]
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

/** The minimal fallback error tile painted when a key's boundary trips or its scene cannot be rasterized (SPEC §7.1, §10). */
export function errorTileScene(): SceneNode {
  return {
    kind: 'element',
    tag: 'div',
    className: 'flex h-full w-full flex-col items-center justify-center gap-1 bg-[#7f1d1d]',
    children: [
      {
        kind: 'element',
        tag: 'span',
        className: 'text-[28px] font-bold text-white',
        children: [{ kind: 'text', text: '!' }],
      },
      {
        kind: 'element',
        tag: 'span',
        className: 'text-[11px] uppercase tracking-wide text-white/80',
        children: [{ kind: 'text', text: 'error' }],
      },
    ],
  }
}
