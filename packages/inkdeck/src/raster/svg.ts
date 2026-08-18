// SVG subtrees are serialized to markup and rasterized by Takumi as an image
// source. React SVG props are camelCase; only the *presentation attributes
// that SVG itself spells with hyphens* (strokeWidth → stroke-width, …) are
// converted — everything else (viewBox, stdDeviation, spreadMethod,
// pathLength, baseFrequency, …) is genuinely camelCase in SVG and passes
// through verbatim. Kebab-casing by default silently produced invalid names
// the rasterizer ignored (no blur, no gradient spread, wrong pixels).

import type { HostElement } from '../renderer/hostTree.js'

// Hyphenated SVG attributes (SVG 1.1/2 presentation + font/glyph attributes),
// as react-dom's possibleStandardNames spells them.
const HYPHENATED = [
  'accent-height',
  'alignment-baseline',
  'arabic-form',
  'baseline-shift',
  'cap-height',
  'clip-path',
  'clip-rule',
  'color-interpolation',
  'color-interpolation-filters',
  'color-profile',
  'color-rendering',
  'dominant-baseline',
  'enable-background',
  'fill-opacity',
  'fill-rule',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'glyph-name',
  'glyph-orientation-horizontal',
  'glyph-orientation-vertical',
  'horiz-adv-x',
  'horiz-origin-x',
  'image-rendering',
  'letter-spacing',
  'lighting-color',
  'marker-end',
  'marker-mid',
  'marker-start',
  'overline-position',
  'overline-thickness',
  'paint-order',
  'panose-1',
  'pointer-events',
  'rendering-intent',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'strikethrough-position',
  'strikethrough-thickness',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-rendering',
  'transform-origin',
  'underline-position',
  'underline-thickness',
  'unicode-bidi',
  'unicode-range',
  'units-per-em',
  'v-alphabetic',
  'v-hanging',
  'v-ideographic',
  'v-mathematical',
  'vector-effect',
  'vert-adv-y',
  'vert-origin-x',
  'vert-origin-y',
  'word-spacing',
  'writing-mode',
  'x-height',
]
// Namespaced attributes React spells as one camelCase word.
const NAMESPACED: Record<string, string> = {
  xlinkHref: 'xlink:href',
  xlinkTitle: 'xlink:title',
  xlinkRole: 'xlink:role',
  xlinkArcrole: 'xlink:arcrole',
  xlinkShow: 'xlink:show',
  xlinkActuate: 'xlink:actuate',
  xlinkType: 'xlink:type',
  xmlBase: 'xml:base',
  xmlLang: 'xml:lang',
  xmlSpace: 'xml:space',
  xmlnsXlink: 'xmlns:xlink',
}

const camel = (name: string): string => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const ATTRIBUTE_NAMES = new Map<string, string>([
  ...HYPHENATED.map((name): [string, string] => [camel(name), name]),
  ...Object.entries(NAMESPACED),
  ['className', 'class'],
  ['htmlFor', 'for'],
])

/** React prop name → SVG attribute name. */
export function svgAttributeName(prop: string): string {
  return ATTRIBUTE_NAMES.get(prop) ?? prop
}

export function serializeSvg(element: HostElement): string {
  const attrs: string[] = []
  for (const [key, value] of Object.entries(element.props)) {
    if (key === 'children' || value == null || typeof value === 'function') continue
    if (key === 'style') {
      if (typeof value === 'object') {
        const css = Object.entries(value as Record<string, unknown>)
          .map(([k, v]) => `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}:${String(v)}`)
          .join(';')
        attrs.push(`style="${escapeXml(css)}"`)
      }
      continue
    }
    if (typeof value === 'boolean') {
      if (value) attrs.push(`${svgAttributeName(key)}="true"`)
      continue
    }
    attrs.push(`${svgAttributeName(key)}="${escapeXml(String(value))}"`)
  }
  if (element.type === 'svg' && !('xmlns' in element.props)) {
    attrs.push('xmlns="http://www.w3.org/2000/svg"')
  }
  const children = element.children
    .filter((c) => !c.hidden)
    .map((c) => (c.kind === 'text' ? escapeXml(c.text) : serializeSvg(c)))
    .join('')
  return `<${element.type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${children}</${element.type}>`
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
