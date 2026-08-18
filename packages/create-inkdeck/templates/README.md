# My inkdeck app

A React app whose render target is an Elgato Stream Deck, built with
[`@jackadamson/inkdeck`](https://github.com/jackadamson/inkdeck).

```
bun install
bun run dev                 # run on the attached Stream Deck, reload on save
bun run dev --simulate      # no hardware: browser simulator on a local URL
bun run check               # typecheck + one headless render (exit 0/1)
bun test                    # harness test, no hardware, mocked subprocesses
```

Quit the Elgato Stream Deck app before `dev`/`start` — it holds exclusive
access to the device. If opening still fails, grant your terminal Input
Monitoring permission (System Settings → Privacy & Security).

## Writing the app

`app.tsx` default-exports a component. A `<Key>` owns one physical key slot;
inside it you write ordinary JSX (`div`, `span`, `p`, `img`, `svg`) styled
with Tailwind-style `className` utilities and inline `style` for dynamic
values:

```tsx
<Deck brightness={80}>
  <Key position={0} onPress={toggle} onLongPress={reset} longPressMs={500}>
    <div className="flex h-full w-full flex-col items-center justify-center bg-[#0a7d33]">
      <span className="text-[12px] uppercase text-white/70">mic</span>
      <span className="text-[18px] font-bold text-white">LIVE</span>
    </div>
  </Key>
</Deck>
```

Hooks: `useDeckInfo()` (geometry + `coordsOf`/`positionOf`), `useBrightness()`,
`useKeyState(position)`, `usePoller(fn, ms)` (returns `{ refresh }`). Subprocesses: `exec(['cmd', ...args])` (interceptable by
the test harness — prefer it over `Bun.spawn`).

## Supported styling

Rasterization is [Takumi](https://github.com/kane50613/takumi)'s CSS subset:
flexbox layout (every `div` defaults to `display: flex`), no CSS grid. The
Tailwind utilities known-good from the reference apps:

- layout: `flex`, `flex-col`, `items-*`, `justify-*`, `gap-*`, `w-full`,
  `h-full`, `p-*`, `m-*`, `rounded-*`
- color: `bg-[#hex]`, `text-white`, `text-white/70` (opacity shorthand),
  arbitrary values via `[...]` generally work
- text: `text-[Npx]`, `font-bold`, `uppercase`, `tracking-wide`

Fonts are explicit: the bundled Inter (regular + bold) is always available;
add faces with `export const config = { fonts: ['./MyFont.ttf'] }`. There are
no system fonts by design — that is what makes renders byte-identical on
every machine.

## Feedback loop (also for coding agents)

See [CLAUDE.md](./CLAUDE.md): headless rendering, the structural manifest,
and the JSON-lines agent protocol. None of it needs hardware.
