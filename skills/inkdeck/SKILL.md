---
name: inkdeck
description: Build apps for an Elgato Stream Deck with inkdeck (@jackadamson/inkdeck) — React rendered to the deck's LCD keys over USB, running on Bun. Load when creating, editing, testing or debugging an inkdeck app (app.tsx with <Deck>/<Key>), or when someone wants "a Stream Deck button that does X".
---

# inkdeck — React on a Stream Deck

`@jackadamson/inkdeck` is a React renderer whose target is an Elgato Stream Deck:
an app is one `app.tsx` that default-exports a component; `<Deck>` is the
root; each `<Key position={n}>` owns one physical key and renders ordinary JSX
(`div/span/p/img/svg` + Tailwind-style `className`) into that key's LCD.
Everything is driven from Bun — no Elgato software, no browser. Apps are
usually small personal tools (mute toggles, deploy buttons, status tiles):
write the simplest thing that works, verify it headlessly, run it.

## 0. Create an app

```sh
bun create @jackadamson/inkdeck my-deck && cd my-deck   # or: bunx create-inkdeck my-deck
bun install
bun run dev --simulate       # browser simulator (prints a http://127.0.0.1:<port>/#<token> URL)
bun run dev                  # on the attached deck, hot reload on save
```

You get `app.tsx` (a dependency-free counter starter), `app.test.tsx`
(harness test), `mocks.json`, `tsconfig.json`, `package.json` scripts
(`dev`, `start`, `check`, `render`, `test`) and a `CLAUDE.md` with the full
agent protocol. Requirements: **Bun ≥ 1.3.11**; hardware works on **macOS
only** (headless/simulator/tests work everywhere). Before `dev`/`start`:
**quit the Elgato Stream Deck app** (it holds the device exclusively); if open
still fails, give the terminal *Input Monitoring* permission (System Settings
→ Privacy & Security). Supported for rendering: MK.2, original v2, XL, Neo
(gen-2 JPEG keys); Mini and Plus are only detected.

## 1. The dev loop (hacky is fine)

Typical session: edit `app.tsx` → `bun run check` → look at the manifest →
run it. Concretely:

| Command | Use it for |
|---|---|
| `bun run check` (= `inkdeck check app.tsx`) | tsc + one headless render. Exit 1 on type errors, a duplicate `position`, or any key showing its error tile. **Run after every edit** — it's ~1 s. |
| `inkdeck render app.tsx --out ./frames --model mk2` | `key-N.png` per key + `manifest.json` (per key: `text[]` in document order, `error`, `hasPress`, `hasLongPress`, `hash`). Read the manifest, not the pixels. |
| `inkdeck agent app.tsx --freeze-time --mock-exec mocks.json` | Scripted interaction over stdin/stdout JSON-lines: `{"cmd":"tap","position":0}`, `press/release`, `snapshot`, `advanceTime`, `writeFrames`, `exit`. Every command ends with exactly one ack event (`state`/`frames`/`exit`, or `error`) that echoes an optional `"id"`; `rendered` events are notifications when pixels change. Reference: the scaffold's `CLAUDE.md`. |
| `bun test` | Harness tests via `renderDeck` (below). No hardware, no real subprocesses. |
| `bun run dev [--simulate [--model xl]]` | Live. Saves re-bundle the whole app graph and repaint only keys whose pixels changed; a broken save logs `reload failed` and keeps watching. **Component state resets on reload** (the app remounts). |
| `bun run start`, `inkdeck list`, `--device <serial>` / `INKDECK_DEVICE` | Run without watching; list attached decks; pick one when several are attached. `start`/`dev` wait for a deck and survive unplug/replug. |

`export const config = { defaultModel: 'mk2', fonts: ['./MyFont.ttf'] }` sets
the model used by check/render/agent/simulate when no `--model` is given
(it never constrains hardware) and registers extra font files.

Testing in `bun test` (`@jackadamson/inkdeck/testing`):

```tsx
const deck = await renderDeck(<App />, { model: 'mk2', freezeTime: true, mockExec: mocks })
deck.key(0).text            // ['count', '0']  (also .error, .hasPress, .pressed)
await deck.tap(1)           // press+release; optional holdMs for long-press
deck.advanceTime(1000)      // frozen clock: fires pollers/timers
await deck.settled()        // wait for React + rasterization to go idle
deck.unmatchedExecs         // exec() calls no mock covered — should be []
await deck.shutdown()
```

`mocks.json` shape: `{ "mocks": [ { "match": "cmd arg", "regex"?: true,
"stdout"?: "", "stderr"?: "", "exitCode"?: 0, "delayMs"?: 0 } ] }` matched
against the space-joined argv; unmatched commands return exit 127 and are
reported (never spawned). No exec calls ⇒ `{ "mocks": [] }`.

## 2. API you need

```tsx
import { Deck, Key, Image, exec, useDeckInfo, useBrightness, useKeyState, usePoller } from '@jackadamson/inkdeck'
import type { InkdeckConfig } from '@jackadamson/inkdeck'
```

- **`<Deck brightness?>`** — root (exactly one). `brightness` 0–100 applies
  whenever the value changes; omit to leave the last value (default 100).
- **`<Key position={n} | row={r} col={c} onPress? onLongPress? longPressMs? >`**
  — positions are row-major from top-left (`0` is top-left; `columns` from
  `useDeckInfo`). Two `<Key>`s with the same position is a commit-time error
  (with both component stacks); a position beyond the model's key count warns
  once and is skipped. Handlers may be async; a throw/rejection is logged (and
  is an `error` event in the agent), never fatal.
- **`onPress`** fires on key-**down** — unless `onLongPress` is also set, in
  which case a short press is only known at release, so `onPress` fires on
  key-**up**. `onLongPress` fires after `longPressMs` (default 500) while held.
  There is no `onRelease`; use `useKeyState(position).pressed` for held state.
- **`<Image src>`** — like `<img>` but `src` may be a `Uint8Array`. Paths are
  relative to `app.tsx` (or absolute). `http(s):`/`data:` are rejected (no
  network by design) — fetch/generate bytes yourself and pass them.
- **`useDeckInfo()`** → `{ model, columns, rows, keyCount, serial | null,
  coordsOf(position), positionOf(row, col) }` (stable object; serial is null
  headless). Use it to lay out grid apps that adapt to the attached model.
- **`useBrightness()`** → `[value, set]`. **`useKeyState(position)`** → `{ pressed }`.
- **`usePoller(fn, ms)`** → `{ refresh }`. Runs `fn` immediately and every
  `ms`; always calls the *latest* `fn` (state read inside is current); pauses
  under frozen time until `advanceTime`. Call `refresh()` right after acting
  (e.g. after an `exec` that changes what you poll) instead of waiting a tick.
  This is also how you animate — there is no CSS animation/transition.
- **`exec(['cmd', ...args])`** → `{ stdout, stderr, exitCode }` (127 when the
  binary is missing — degrade gracefully). Argv array, no shell. **Always use
  it instead of `Bun.spawn`**: it is what tests/agent mock, per session.
- Errors thrown while rendering inside a `<Key>` paint that key's red error
  tile only (manifest `error` = message) and retry on the next render; an
  error outside any key (in `<Deck>`'s own render) fails `check`.

## 3. How this differs from React on the web

- **No DOM, no browser APIs, no events besides key presses.** No `onClick`,
  hover, focus, scroll, `window`, CSS `:hover`, media queries. Input is
  `onPress`/`onLongPress`/`useKeyState` per key.
- **Elements are a fixed subset**: `div`, `span`, `p`, `img` (`<Image>`),
  `svg` (any SVG subtree — it is serialized and rasterized as an image).
  Anything else inside a `<Key>` throws at mount. Text must be inside a
  `span`/`p` (a `span`/`p` whose children are all text becomes one text run and
  its own classes style the glyphs).
- **Layout is Takumi's CSS subset via `className`**: flexbox only (`div` is
  `display: flex` by default), **no CSS grid**, no `position: absolute`
  tricks you'd rely on in a browser, no transitions/animations/keyframes, no
  external stylesheets. Known-good utilities: `flex flex-col items-center
  justify-center gap-* w-full h-full p-* m-* rounded-*`, `bg-[#hex]`,
  `text-white text-white/70`, `text-[Npx] font-bold uppercase tracking-wide`,
  arbitrary `[…]` values generally. Inline `style={{…}}` (camelCase, px
  numbers) for dynamic values. Prefer explicit sizes (`text-[24px]`, `style`
  widths) over fractional utilities like `h-1/2` inside nested containers.
- **Fonts are explicit** — bundled Inter regular + bold; add faces via
  `config.fonts`. No system fonts, ever (that is what makes renders
  byte-identical everywhere). Emoji need a font that has them.
- **A key is tiny** (72–120 px square). One or two short lines of text at
  12–28 px; think "tile", not "page". Nothing scrolls, wraps generously, or
  overflows visibly — clip happens at the key edge.
- **Several children directly under `<Key>`** get an implicit flex-**row**
  `div`; give the key a single root `div` when you want control.
- **Timers**: use `usePoller` (injectable clock ⇒ deterministic tests) rather
  than raw `setInterval`; raw timers still work but tests can't freeze them.
- **Suspense** hides the key's content (blank) while suspended; there is no
  fallback rendering per key beyond your own conditional JSX.
- **Rendering cost model**: a key re-rasterizes only when its scene (JSX
  structure/classes/style/text) changes; identical pixels are never re-sent.
  Whole-deck animation at ~8 fps (120 ms tick) is comfortable on an XL; go
  much faster and frames coalesce (graceful, but no smoother).

## 4. Gotchas

- **Bun-only.** `npm`/`node` won't run it; use `bun run …`, `bunx inkdeck …`.
- **Quit the Elgato app** or `open` fails; grant Input Monitoring if it still does.
- **Position vs model**: an app written for a 5×3 MK.2 shows nothing on keys
  ≥ 15 of an XL only if you hard-code — use `useDeckInfo()` for anything grid-shaped.
- **`onLongPress` changes when `onPress` fires** (key-up instead of key-down)
  and adds ~30 ms release latency (contact-bounce window). Don't add
  `onLongPress` casually to a key that should feel instant.
- **Optimistic UI + polling**: after an `exec` that changes the world, call
  the poller's `refresh()`; otherwise the tile shows the old value until the
  next tick.
- **`exec` returns exit 127, not a throw, for a missing command** — check
  `exitCode` before parsing `stdout`.
- **`--freeze-time` tests**: nothing time-based happens until
  `deck.advanceTime(ms)`; `tap()` advances the clock through the hold and past
  the debounce itself, so consecutive taps are distinct presses.
- **Hot reload resets state** and re-bundles the app's own files only
  (`node_modules` changes need a restart). Save-time syntax errors don't kill
  the session.
- **Images**: relative to the app file, not cwd; no URLs; a missing file marks
  the key `error: raster failed: …` and paints the error tile (so `check`
  fails — good).
- **`check` failing on "two <Key> elements are mounted with position"** is
  usually a `.map()` without unique positions, or a conditional key colliding
  with a static one.
- **Duplicate/unsupported element** errors name the tag: e.g. `<button>`,
  `<h1>`, `<b>` are not allowed — use `span` with classes.
- **The simulator is loopback-only with a token URL**; a "disconnected"
  banner means the process exited — restart and reload the page.
- Reference apps in the repo: `examples/mic-mute` (poll `osascript` + toggle
  + mocked tests) and `examples/aurora` (whole-deck SVG animation, ripples on
  press, palettes on long-press). Library README:
  https://github.com/jackadamson/inkdeck#readme
