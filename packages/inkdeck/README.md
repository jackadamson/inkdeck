# inkdeck

**React on an Elgato Stream Deck.** Think [Ink](https://github.com/vadimdemedes/ink), but the
"terminal" is a grid of physical LCD keys: an app is a default-exported React component, a
`<Key>` owns one key slot, and inside it you write ordinary JSX styled with Tailwind-style
utilities. Runs on [Bun](https://bun.sh), talks raw USB HID to the deck (no Elgato software),
and ships a browser simulator plus a headless feedback loop built for coding agents.

```tsx
import { Deck, Key, exec, usePoller } from '@jackadamson/inkdeck'

export default function App() {
  const [muted, setMuted] = useState<boolean | null>(null)
  const { refresh } = usePoller(async () => {
    const { stdout } = await exec(['osascript', '-e', 'input volume of (get volume settings)'])
    setMuted(Number(stdout) === 0)
  }, 1000)
  return (
    <Deck>
      <Key position={0} onPress={async () => { await exec(['osascript', '-e', `set volume input volume ${muted ? 75 : 0}`]); refresh() }}>
        <div className={`flex h-full w-full flex-col items-center justify-center ${muted ? 'bg-[#b91c1c]' : 'bg-[#0a7d33]'}`}>
          <span className="text-[12px] uppercase text-white/70">mic</span>
          <span className="text-[18px] font-bold text-white">{muted ? 'MUTED' : 'LIVE'}</span>
        </div>
      </Key>
    </Deck>
  )
}
```

## Why not the Elgato SDK?

The Stream Deck app's plugin SDK renders images you hand it and requires the Elgato app running.
inkdeck is the other way round: your React tree *is* the deck. Diffing decides which keys
rasterize, output dedup decides which keys are pushed, and the whole pipeline runs headlessly
against a virtual device — so `bun test`, `inkdeck check` and an agent harness see exactly what
the hardware would show, byte for byte.

## Quick start (30 seconds)

```sh
bun create @jackadamson/inkdeck my-deck && cd my-deck
bun run dev --simulate        # no hardware: opens a browser simulator URL
bun run dev                   # on the attached deck, hot reload on save
```

Quit the Elgato Stream Deck app first — it holds the device exclusively. If opening still
fails, grant your terminal Input Monitoring permission (System Settings → Privacy & Security).

## Components and hooks

| API | What it does |
|---|---|
| `<Deck brightness?>` | The root. Brightness 0–100 is applied whenever it changes; omitting it leaves the last value (default 100). |
| `<Key position \| row+col onPress? onLongPress? longPressMs?>` | Owns one key slot. `onPress` fires on key-down — unless `onLongPress` is set, in which case a short press is only known on release, so it fires on key-up. Handlers may be async; failures are logged, never fatal. Several children get an implicit flex-row `div`. |
| `<Image src>` | `<img>` that also accepts in-memory bytes (`Uint8Array`). Paths are relative to the app file; `http(s):`/`data:` are rejected (no network). |
| `useDeckInfo()` | `{ model, columns, rows, keyCount, serial, coordsOf(position), positionOf(row, col) }` — stable object. |
| `useBrightness()` | `[value, set]` with a stable setter. |
| `useKeyState(position)` | `{ pressed }` — live physical state. |
| `usePoller(fn, ms)` | Runs `fn` now and every `ms` on the injectable clock (frozen in tests); always calls the latest `fn`. Returns `{ refresh }` to re-poll immediately after acting. |
| `exec(argv)` | `Bun.spawn` wrapper (`{ stdout, stderr, exitCode }`, 127 for a missing binary) that the harness can mock per session. Prefer it over `Bun.spawn`. |
| `export const config` | `{ defaultModel?: 'mk2' \| 'xl' \| 'neo' \| 'original-v2', fonts?: string[] }` — headless/simulator model (never constrains hardware) and extra font files. |

Content elements: `div`, `span`, `p`, `img`, `svg` (any SVG subtree). Errors thrown while
rendering a key paint that key's error tile only; the boundary retries on the next render.

### Styling that works

Rasterization is [Takumi](https://github.com/kane50613/takumi)'s CSS subset: flexbox layout
(`div` defaults to `display: flex`), no CSS grid. Known-good Tailwind utilities from the reference
apps: layout `flex flex-col items-* justify-* gap-* w-full h-full p-* m-* rounded-*`; colour
`bg-[#hex] text-white text-white/70` (arbitrary `[...]` values generally work); text
`text-[Npx] font-bold uppercase tracking-wide`. Fonts are explicit — bundled Inter (regular +
bold) plus whatever `config.fonts` lists; there are no system fonts by design, which is what
makes renders byte-identical on every machine.

## CLI

| Command | Purpose |
|---|---|
| `inkdeck dev <app.tsx> [--device S] [--simulate [--model M]]` | Run + hot reload on save (the whole app module graph is re-bundled). |
| `inkdeck start <app.tsx> [--device S] [--simulate [--model M]]` | Run without watching. `start`/`dev` wait for the deck and survive unplug/replug. |
| `inkdeck check <app.tsx>` | Typecheck + one headless render; exit 1 on type errors, a duplicate position, or any key on its error tile. |
| `inkdeck render <app.tsx> --out DIR [--model M]` | PNG per key + `manifest.json` (structural: text per key, errors, handlers). |
| `inkdeck agent <app.tsx> [--model M] [--freeze-time] [--mock-exec F]` | JSON-lines harness over stdio: `press/release/tap/snapshot/advanceTime/writeFrames/exit`. |
| `inkdeck list` | Attached decks (serial, model). |
| `inkdeck create <dir>` | Scaffold an app (or `bun create @jackadamson/inkdeck <dir>`). |

## The agent feedback loop

Structure beats pixels. Every headless surface returns a **manifest** — model, grid, and per key
`text[]` (in document order), `error`, `hasPress`, `hasLongPress`, `hash` — so a coding agent can
verify state without looking at images:

- `inkdeck check` after every edit;
- `inkdeck render` when it wants frames;
- `inkdeck agent app.tsx --freeze-time --mock-exec mocks.json` for a scripted session: every
  command ends with exactly one ack (`state`/`frames`/`exit`, or `error`) that echoes the
  command's optional `id`; `rendered` notifications fire only when pixels change;
- in `bun test`: `renderDeck(<App/>, { freezeTime, mockExec })` from `@jackadamson/inkdeck/testing`
  (`deck.key(0).text`, `deck.tap(0)`, `deck.advanceTime(ms)`, `deck.unmatchedExecs`).

`--freeze-time` makes pollers/long-press timers deterministic; `--mock-exec` answers `exec()` from a
table so no real subprocess ever runs in a test (unmatched commands surface as errors, not hangs).
The scaffold ships a `CLAUDE.md` that teaches this loop on turn one; the protocol reference lives
in `packages/create-inkdeck/templates/CLAUDE.md`.

## Limitations (honest list)

- **macOS only** for hardware (IOKit over `bun:ffi`); Linux/Windows run headless, simulator and tests.
- **Gen-2 JPEG models only:** MK.2, original v2, XL, Neo keys. Mini (gen-1 BMP) and Plus (dials/LCD)
  are discovered but not rendered.
- **XL is the only hardware-verified model**; the others follow the same protocol.
- The Elgato Stream Deck app must be closed while inkdeck holds the device.
- Hot reload re-bundles the app's own module graph; the running process's `node_modules` are not reloaded.

## Repository

`packages/inkdeck` (library + CLI), `packages/create-inkdeck` (scaffold), `examples/` (mic-mute,
aurora), `skills/inkdeck` (agent skill). `SPEC.md` is the original design document — where it and
the code differ, `DECISIONS.md` records why and this README plus `skills/inkdeck/SKILL.md` describe
what actually ships. Develop with `bun install`, `bun run lint`, `bun run typecheck`, `bun test`,
`bun run check:examples`. MIT.
