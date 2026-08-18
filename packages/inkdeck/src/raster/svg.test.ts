import { describe, expect, test } from 'bun:test'
import type { HostElement } from '../renderer/hostTree.js'
import { serializeSvg, svgAttributeName } from './svg.js'

const el = (type: string, props: Record<string, unknown>, children: HostElement['children'] = []): HostElement => ({
  kind: 'element',
  type,
  props,
  children,
  hidden: false,
})

describe('serializeSvg', () => {
  test('hyphenates only SVG presentation attributes; camelCase attributes pass through', () => {
    expect(svgAttributeName('strokeWidth')).toBe('stroke-width')
    expect(svgAttributeName('fillOpacity')).toBe('fill-opacity')
    expect(svgAttributeName('stopColor')).toBe('stop-color')
    expect(svgAttributeName('fontSize')).toBe('font-size')
    expect(svgAttributeName('viewBox')).toBe('viewBox')
    expect(svgAttributeName('stdDeviation')).toBe('stdDeviation')
    expect(svgAttributeName('spreadMethod')).toBe('spreadMethod')
    expect(svgAttributeName('pathLength')).toBe('pathLength')
    expect(svgAttributeName('baseFrequency')).toBe('baseFrequency')
    expect(svgAttributeName('gradientUnits')).toBe('gradientUnits')
    expect(svgAttributeName('xlinkHref')).toBe('xlink:href')
    expect(svgAttributeName('className')).toBe('class')
  })

  test('serializes a filter subtree with the names the rasterizer expects', () => {
    const svg = el('svg', { viewBox: '0 0 10 10', className: 'x' }, [
      el('filter', { id: 'b' }, [el('feGaussianBlur', { stdDeviation: 2, in: 'SourceGraphic' })]),
      el('circle', { cx: 5, cy: 5, r: 4, fill: 'red', strokeWidth: 1.5, style: { fillOpacity: 0.5 } }),
    ])
    expect(serializeSvg(svg)).toBe(
      '<svg viewBox="0 0 10 10" class="x" xmlns="http://www.w3.org/2000/svg">' +
        '<filter id="b"><feGaussianBlur stdDeviation="2" in="SourceGraphic"></feGaussianBlur></filter>' +
        '<circle cx="5" cy="5" r="4" fill="red" stroke-width="1.5" style="fill-opacity:0.5"></circle>' +
        '</svg>',
    )
  })

  test('escapes text and attribute values', () => {
    const svg = el('svg', {}, [el('text', { 'data-x': 'a"b<c' }, [{ kind: 'text', text: '<&>', hidden: false }])])
    expect(serializeSvg(svg)).toContain('data-x="a&quot;b&lt;c"')
    expect(serializeSvg(svg)).toContain('>&lt;&amp;&gt;</text>')
  })
})
