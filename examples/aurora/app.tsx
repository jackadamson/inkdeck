// Aurora: the whole deck as one continuous plasma field. Every key samples a
// shared 2D sine field at its corners and blends them with radial gradients,
// so color flows seamlessly across the grid (bezel gaps included in the
// geometry, so waves line up on the physical device). Press any key to launch
// a light ripple across the deck; hold a key for a white glow while pressed;
// long-press to cycle color palettes. Purely decorative, fully deterministic:
// all motion is driven by the injectable clock via usePoller.

import { useCallback, useRef, useState } from 'react'
import { Deck, Key, useDeckInfo, useKeyState, usePoller } from '@jackadamson/inkdeck'
import type { InkdeckConfig } from '@jackadamson/inkdeck'

export const config: InkdeckConfig = { defaultModel: 'xl' }

const TICK_MS = 120 // animation step; ~8 fps keeps full-deck redraws cheap
const VB = 100 // svg viewBox units per key face
const PITCH = 130 // key pitch in svg units — the ~30% bezel gap keeps ripples aligned across keys
const RIPPLE_SPEED = 3.4 // key-pitches per second
const RIPPLE_LIFE = 2.2 // seconds

interface Palette {
  name: string
  hue: number // base hue at field value 0
  span: number // hue swing across the field's [-1, 1] range
  sat: number
  light: number
}

const PALETTES: Palette[] = [
  { name: 'aurora', hue: 160, span: 95, sat: 85, light: 38 },
  { name: 'ember', hue: 18, span: 50, sat: 92, light: 40 },
  { name: 'abyss', hue: 240, span: 70, sat: 80, light: 36 },
  { name: 'candy', hue: 320, span: 110, sat: 75, light: 46 },
]

interface RippleState {
  col: number
  row: number
  born: number // tick when spawned
}

interface LiveRipple {
  col: number
  row: number
  age: number // seconds
}

/** The shared plasma field: smooth, loop-free interference of four sines. */
function field(x: number, y: number, t: number, cx: number, cy: number): number {
  return (
    (Math.sin(x * 0.55 + t * 0.65) +
      Math.sin(y * 0.85 - t * 0.45) +
      Math.sin((x + y) * 0.45 + t * 0.3) +
      Math.sin(Math.hypot(x - cx, y - cy) * 0.9 - t * 0.8)) /
    4
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** hsl → hex with integer-rounded inputs so equal states hash identically. */
function hslHex(h: number, s: number, l: number): string {
  h = ((Math.round(h) % 360) + 360) % 360
  const sn = clamp(Math.round(s), 0, 100) / 100
  const ln = clamp(Math.round(l), 0, 100) / 100
  const a = sn * Math.min(ln, 1 - ln)
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12
    const c = ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

/** Field value at a deck-space point (key units) → palette color. */
function sample(x: number, y: number, t: number, p: Palette, cx: number, cy: number): string {
  const v = field(x, y, t, cx, cy)
  // A decorrelated second read drives lightness so the field shimmers instead
  // of just rotating hues.
  const w = field(x * 1.4 + 7.3, y * 1.4 - 2.1, t * 1.2, cx, cy)
  return hslHex(p.hue + v * p.span, p.sat + w * 10, p.light + w * 16)
}

const round1 = (v: number): number => Math.round(v * 10) / 10
const round2 = (v: number): number => Math.round(v * 100) / 100

interface TileProps {
  position: number
  col: number
  row: number
  t: number
  palette: Palette
  ripples: LiveRipple[]
  cx: number
  cy: number
}

function Tile({ position, col, row, t, palette, ripples, cx, cy }: TileProps) {
  const { pressed } = useKeyState(position)

  const center = sample(col + 0.5, row + 0.5, t, palette, cx, cy)
  const corners = [
    { id: 'tl', px: 0, py: 0, color: sample(col, row, t, palette, cx, cy) },
    { id: 'tr', px: VB, py: 0, color: sample(col + 1, row, t, palette, cx, cy) },
    { id: 'br', px: VB, py: VB, color: sample(col + 1, row + 1, t, palette, cx, cy) },
    { id: 'bl', px: 0, py: VB, color: sample(col, row + 1, t, palette, cx, cy) },
  ]

  return (
    <svg viewBox={`0 0 ${VB} ${VB}`} className="h-full w-full">
      <defs>
        {corners.map((c) => (
          <radialGradient
            key={c.id}
            id={`g-${c.id}`}
            gradientUnits="userSpaceOnUse"
            cx={c.px}
            cy={c.py}
            r={VB * 1.1}
          >
            <stop offset="0" stopColor={c.color} stopOpacity="0.85" />
            <stop offset="1" stopColor={c.color} stopOpacity="0" />
          </radialGradient>
        ))}
        <radialGradient
          id="press"
          gradientUnits="userSpaceOnUse"
          cx={VB / 2}
          cy={VB / 2}
          r={VB * 0.7}
        >
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Center color underneath, one corner gradient per quadrant on top —
          together they approximate bilinear interpolation of the field, and
          adjacent keys share corner samples, so the deck reads as one surface. */}
      <rect x="0" y="0" width={VB} height={VB} fill={center} />
      {corners.map((c) => (
        <rect key={c.id} x="0" y="0" width={VB} height={VB} fill={`url(#g-${c.id})`} />
      ))}

      {/* Expanding light rings, drawn in deck-space so they cross key borders. */}
      {ripples.map((r, i) => {
        const ox = (r.col - col) * PITCH + VB / 2
        const oy = (r.row - row) * PITCH + VB / 2
        const radius = round1(VB * 0.15 + r.age * RIPPLE_SPEED * PITCH)
        const fade = round2(clamp(1 - r.age / RIPPLE_LIFE, 0, 1))
        return (
          <g key={i}>
            <circle
              cx={ox}
              cy={oy}
              r={radius}
              fill="none"
              stroke="#ffffff"
              strokeWidth={14}
              strokeOpacity={round2(fade * 0.3)}
            />
            <circle
              cx={ox}
              cy={oy}
              r={radius}
              fill="none"
              stroke="#ffffff"
              strokeWidth={4}
              strokeOpacity={round2(fade * 0.9)}
            />
          </g>
        )
      })}

      {pressed && <rect x="0" y="0" width={VB} height={VB} fill="url(#press)" />}
    </svg>
  )
}

export default function App() {
  const { columns, rows } = useDeckInfo()
  const [tick, setTick] = useState(0)
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [ripples, setRipples] = useState<RippleState[]>([])

  // splash is memoised (stable handler identity), so it reads the current
  // tick through a ref instead of a stale closure.
  const tickRef = useRef(0)
  tickRef.current = tick

  usePoller(() => setTick((v) => v + 1), TICK_MS)

  const splash = useCallback((col: number, row: number) => {
    const born = tickRef.current
    setRipples((prev) => [
      ...prev.filter((r) => ((born - r.born) * TICK_MS) / 1000 < RIPPLE_LIFE),
      { col, row, born },
    ])
  }, [])

  const nextPalette = useCallback(() => {
    setPaletteIndex((i) => (i + 1) % PALETTES.length)
  }, [])

  const t = (tick * TICK_MS) / 1000
  const palette = PALETTES[paletteIndex] ?? PALETTES[0]!
  const cx = columns / 2
  const cy = rows / 2
  const live: LiveRipple[] = ripples
    .map((r) => ({ col: r.col, row: r.row, age: ((tick - r.born) * TICK_MS) / 1000 }))
    .filter((r) => r.age >= 0 && r.age < RIPPLE_LIFE)

  return (
    <Deck>
      {Array.from({ length: columns * rows }, (_, position) => {
        const col = position % columns
        const row = Math.floor(position / columns)
        return (
          <Key
            key={position}
            position={position}
            onPress={() => splash(col, row)}
            onLongPress={nextPalette}
          >
            <Tile
              position={position}
              col={col}
              row={row}
              t={t}
              palette={palette}
              ripples={live}
              cx={cx}
              cy={cy}
            />
          </Key>
        )
      })}
    </Deck>
  )
}
