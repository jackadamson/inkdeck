---
name: inkdeck
description: Working on or with inkdeck — a custom React renderer targeting Elgato Stream Decks. Load when editing the inkdeck library, building an inkdeck app, or debugging deck rendering/input.
---

# inkdeck

**inkdeck** (`@jackadamson/inkdeck`) renders React to an Elgato Stream Deck
over raw USB HID — think Ink, but the "terminal" is a grid of LCD keys. Runtime
is Bun (≥ 1.3.11, pinned in `.tool-versions`); runtime deps are exactly
`react` (peer), `react-reconciler` (pinned) and `@takumi-rs/core` (raster +
JPEG/PNG encode) — do not add packages (SPEC §2 is exhaustive; Biome and
TypeScript are dev-only). macOS only for hardware; everything else runs
headless everywhere.

## Repo map

```
packages/inkdeck/            the library + CLI (@jackadamson/inkdeck)
  src/index.ts               public API barrel; src/testing.ts = renderDeck helper
  src/session.ts             bootDeck(): the ONE way to boot a deck (hardware|virtual)
  src/renderer/              controller.ts orchestrates: sceneBuilder (host tree → scenes),
                             flushQueue (raster+push), input.ts (InputMachine),
                             deviceLink.ts (handle lifecycle), hooks/components, exec.ts
  src/raster/                takumi.ts (RasterEngine), scene.ts, svg.ts, fonts, golden.json
  src/device/                model tables, gen-2 report framing, discovery/selectDevice
  src/transport/             iface.ts (Transport/TransportHandle), iokit.ts (bun:ffi), virtual.ts
  src/harness/               HarnessSession, manifest, mockExec, frames (write PNGs+manifest)
  src/cli/                   index.ts (owns signals/exit), start/dev, simulate, agent, render, check
  src/test/                  helpers.ts (mountVirtual, repo paths), imageInfo.ts, fixtures/
packages/create-inkdeck/     scaffold (bun create @jackadamson/inkdeck <dir>); templates/CLAUDE.md
                             is THE agent-protocol reference
examples/mic-mute, aurora    reference apps with tests; docs: README.md (living), DECISIONS.md
                             (why), ROADMAP.md (status), SPEC.md (original design, not the API ref)
```

Dev loop: `bun install`, `bun run lint` (Biome), `bun run typecheck`,
`bun test`, `bun run check:examples`. CI runs all four on macOS + Linux; the
Linux leg is the cross-machine determinism gate.

## App API (what an app author uses)

- `export default function App()` returns `<Deck brightness?>` with `<Key>`s.
- `<Key position={n} | row={r} col={c} onPress? onLongPress? longPressMs?>`:
  content is `div/span/p/img/svg` with Tailwind-style `className` (Takumi's
  flexbox subset, no grid) and inline `style` for dynamic values. Several
  children directly under `<Key>` get an implicit flex-row `div`. Duplicate
  positions throw at commit (both stacks); positions ≥ keyCount warn once.
- `onPress` fires on key-down — unless `onLongPress` is set, then a short press
  is only known on release so `onPress` fires on key-up (after the 30 ms
  bounce window). Handlers may be async; failures are logged/`error` events,
  never fatal. `useKeyState(position)` → `{ pressed }`.
- `<Image src>` = `<img>` accepting a path (relative to the app file, or
  absolute) **or** `Uint8Array` bytes. `http(s):`/`data:` are rejected (no
  network). A raster failure marks the key `error: "raster failed: …"` and
  paints the error tile.
- Hooks: `useDeckInfo()` (stable `{ model, columns, rows, keyCount, serial,
  coordsOf(position), positionOf(row, col) }`), `useBrightness()` (stable
  setter), `usePoller(fn, ms)` (runs now + every ms on the injectable clock,
  always the latest `fn`, returns `{ refresh }` — call it right after acting).
- `exec(argv)` → `{ stdout, stderr, exitCode }` (127 if the binary is
  missing). Always use it instead of `Bun.spawn`: it is what `--mock-exec`
  intercepts, per session.
- `export const config: InkdeckConfig = { defaultModel?: 'mk2'|'xl'|'neo'|'original-v2', fonts?: [...] }`
  — headless/simulator model (never constrains hardware) and extra fonts.
  Bundled Inter regular+bold; no system fonts by design (determinism).
- Errors inside a `<Key>` paint that key's error tile only, show up in the
  manifest `error`, and the boundary retries when the parent re-renders.

## CLI

`inkdeck dev|start <app> [--device S] [--simulate [--model M]] [--debug]`
(session-keeping: waits for the deck, survives unplug/replug; `dev` hot
reload re-bundles the whole app graph into `<appDir>/.inkdeck-dev.js` and
logs which keys repainted), `check <app>` (tsc + headless render, exit 1 on
type errors / duplicate position / any error tile), `render <app> --out DIR
[--model M]` (key-N.png + manifest.json), `agent <app> [--model M]
[--freeze-time] [--mock-exec F]`, `list`, `create <dir>`. Quit the Elgato app
first; the simulator prints a `http://127.0.0.1:<port>/#<token>` URL.

## The feedback loop (no hardware, no eyes)

- `inkdeck check app.tsx` after every edit.
- `inkdeck render` → read `manifest.json` (per key: `text[]` in document
  order, `error`, `hasPress`, `hasLongPress`, `hash`; `image` only when frames
  were written). Structure beats pixels.
- `inkdeck agent app.tsx --freeze-time --mock-exec mocks.json` — JSON-lines
  stdio: commands `press/release/tap/snapshot/advanceTime/writeFrames/exit`
  (optional `id`), events `ready/rendered/state/frames/error/log/exit`. Every
  command ends with exactly one terminal ack (`state`/`frames`/`exit`, or
  `error`) echoing its `id`; `rendered` is a notification on real pixel
  change; malformed input → `error` event, never a crash; EOF exits. Full
  reference: `packages/create-inkdeck/templates/CLAUDE.md`.
- `--freeze-time`: pollers/long-press/mock delays move only via
  `advanceTime`; `tap` advances past the debounce itself. `--mock-exec`:
  exact or regex match over the space-joined argv; unmatched ⇒ exit 127 +
  `error` event (add the mock).
- In `bun test`: `const deck = await renderDeck(<App/>, { model, freezeTime,
  mockExec, assetDir })` from `@jackadamson/inkdeck/testing`:
  `deck.key(0).text/error/pressed`, `manifest()`, `press/release/tap`,
  `advanceTime(ms)`, `settled()`, `unmatchedExecs`, `shutdown()`. Several
  sessions may be live at once; each sees only its own mocks.

## Invariants to preserve when editing the library

- **Determinism**: same app + state ⇒ byte-identical images. No system fonts,
  no `Date.now()`/`setTimeout` in app-facing paths (use the injectable
  `Clock`; `controller.clock` is scoped so timers run in the session's exec
  scope). Goldens in `src/raster/golden.json` — `INKDECK_UPDATE_GOLDEN=1` only
  for intentional changes (RGBA hash = raster; JPEG/PNG = encoder).
- **Transport seam**: the renderer touches hardware only through
  `TransportHandle` (writeOutput/sendFeature/getFeature/onInput/onDisconnect/
  close). `VirtualTransport` sits *below* framing, so headless = hardware
  bytes. Transports throw `DeviceDisconnectedError` (gone) or
  `TransportIOError` (rejected report); IOKit waits one removal-poll cycle
  before deciding which. Never match on error messages.
- **FFI**: CF/IOKit refs cross `bun:ffi` as `bigint` (`FFIType.u64`), never
  `FFIType.ptr` — Apple Silicon tagged pointers corrupt in doubles. Removal
  detection is manager polling by IOHIDDeviceRef identity (the removal
  callback never fires); handles CFRetain their device ref.
- **Input** (`renderer/input.ts`): physical release is deferred 30 ms and a
  re-press inside that window cancels it (contact bounce = still held);
  key-down is never delayed. Gestures: `press` (down, or on release when
  long-press armed) / `longPress`.
- **Pipeline** (`renderer/flushQueue.ts`): scene hash skip → per-round
  concurrent raster → sequential input-prioritised push → RGBA hash dedup →
  frame recorded only after the last packet lands → one `rendered` per round.
- **exec scoping** (`renderer/exec.ts`): AsyncLocalStorage per session +
  live-scope registry; a mocked session can never fall through to a real
  spawn. Framework logs go through the injected `Logger` (agent → `log`
  events), not bare `console.error`.
- **Lifecycle**: only `cli/index.ts` installs signal handlers / calls
  `process.exit`; long-running commands return `{ done, shutdown }`.
- **Security (§16)**: zero open ports except `--simulate` (127.0.0.1,
  ephemeral port, session token via timingSafeEqual + Origin + Host checks,
  strict CSP) — a synthetic press is RCE-equivalent. Agent protocol stays
  stdio-only; `<img>` never fetches.
- **Hot reload**: `Bun.build` per save with react/inkdeck external (plugin
  keeps path imports of the library external — no second DeckContext);
  do not call `Bun.resolveSync` inside an `onResolve` hook (breaks under
  `bun test`, see DECISIONS).

## Common patterns

- Poll + act: `const { refresh } = usePoller(async () => {…exec…}, 1000)`,
  optimistic `setState` in `onPress`, then `refresh()` — see
  `examples/mic-mute/app.tsx` and its test.
- Full-deck animation on the clock: `examples/aurora/app.tsx` (SVG per key,
  120 ms tick, `useDeckInfo` grid helpers).
- Hardware debugging: `bun packages/inkdeck/scripts/hardware-smoke.ts`
  (PASS/FAIL per transport op), `inkdeck start … --debug` prints 10 s
  metrics; manual checklist `examples/mic-mute/HARDWARE.md`.
- Tests: `mountVirtual(<…/>, { clock, logger, assetDir })` from
  `src/test/helpers.ts`; capture diagnostics via a `Logger`, never by
  patching `console.error`.
