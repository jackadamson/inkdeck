# inkdeck Roadmap

Tracks implementation progress against [SPEC.md](./SPEC.md) §13 milestones.
Status legend: ✅ done · 🔨 in progress · ⬜ not started · ⏸ blocked (reason noted)

## M0 — Foundations ✅

- ✅ Monorepo scaffold: Bun workspaces, `packages/inkdeck`, pinned Bun 1.3.11 (`.tool-versions`, `engines`)
- ✅ Dependency validation: `@takumi-rs/core` + `@takumi-rs/helpers` **v2.5.4** (spec's raster assumptions predate Takumi v2 — see DECISIONS.md), `sharp` 0.34.5, `react` 19, `react-reconciler` 0.32 — all install and load on pinned Bun
- ✅ Takumi + sharp smoke test as `bun test` (`src/raster/takumi.test.ts`: styled div + bundled font → raw RGBA → sharp → JPEG → decode confirms dimensions + determinism)
- ✅ Bundled OFL default font: Inter 4.1 regular + bold, `src/raster/assets/fonts/` (+ OFL license text)
- ✅ Transport interface (`src/transport/iface.ts` — the five-operation surface, §4.1)
- ✅ VirtualTransport (`src/transport/virtual.ts` — consumes framed bytes and un-frames them; synthesizes input reports)
- ✅ Device model table + gen-2 protocol framing (`src/device/models.ts`, `src/device/protocol.ts`), transcribed from `Julusian/node-elgato-stream-deck` with per-value citations
- ✅ IOKitTransport + `cf.ts` CoreFoundation helpers (`bun:ffi`, darwin-only; CF tests skip off-macOS)
- ✅ CLI skeleton + `inkdeck list` (exit 0, no throw, with no device / on non-macOS)
- ✅ Acceptance: `bun test packages/inkdeck/src/transport` green (16 pass overall; CF suites run on darwin)

## M1 — Headless renderer ✅

- ✅ react-reconciler hostConfig (mutation mode, react-reconciler 0.32 / React 19; host tree → per-key scene trees)
- ✅ `<Deck>` / `<Key>` components; duplicate `position` fails the commit with **both** component stacks; out-of-range position warns once and is skipped
- ✅ Per-key error boundary + fallback error tile (red tile, error surfaced structurally in the manifest); exported `<ErrorBoundary fallback onError>`
- ✅ Element subset inside `<Key>`: `div`, `span`, `p`, `img`, `svg` — `className` (Tailwind via Takumi `tw`) + inline `style`; svg subtrees serialized to markup and rasterized by Takumi
- ✅ Hooks: `useDeckInfo`, `useBrightness`, `useKeyState`, `usePoller` (on the injectable clock; `SystemClock`/`FrozenClock` in `renderer/clock.ts`)
- ✅ `exec` wrapper over `Bun.spawn` with interceptor seam for `--mock-exec` (M3)
- ✅ Scene hashing (skip render) + RGBA output dedup (skip push) + coalesced flush with input-priority ordering (§6.2)
- ✅ Raster pipeline: scene → Takumi RGBA → sharp model transform → JPEG 4:4:4 (device) / PNG (render command) from the same RGBA buffer
- ✅ Manifest builder (§11.1: text in document order, image hash, error, hasPress/hasLongPress)
- ✅ `inkdeck render <app> --out DIR --model M` (PNGs + manifest.json)
- ✅ `inkdeck check <app>` (typecheck via dynamically resolved `typescript` + one headless render; exit 0/1)
- ✅ Reference example `examples/mic-mute/app.tsx` (+ `mocks.json` for the M3 harness)
- ✅ Acceptance (all covered in `bun test`, 31 pass):
  - `inkdeck render examples/mic-mute/app.tsx --out DIR --model mk2` writes `key-0.png` + §11.1 manifest
  - `check` exits 0 on the example, 1 on a type error, 1 on a key that renders its error tile
  - duplicate `position` fails with both stacks; a throwing component paints the fallback tile on its key only

## M2 — Hardware end-to-end ⬜ (⏸ needs a physical MK.2/XL on macOS — not possible in this container)

- ⬜ Verify transcribed constants on hardware (product IDs, input offsets, packet framing — treat as unverified until then)
- ⬜ Exercise IOKitTransport for real: images, brightness, presses, reset-on-exit; fix what the FFI ceremony got wrong
- ⬜ `inkdeck start` / `inkdeck dev` (minimal, no hot reload yet) against hardware
- ⬜ `examples/mic-mute/HARDWARE.md` manual checklist
- ⬜ Acceptance: checklist passes; press-to-repaint < 100 ms

## M3 — Agent harness + simulator ⬜

- ⬜ `inkdeck agent` JSON-lines protocol (§11.2) with `--freeze-time` (FrozenClock exists) / `--mock-exec` (interceptor seam exists; wire `mocks.json` format)
- ⬜ `@jackadamson/inkdeck/testing` helper (`renderDeck`) + example's harness-based test
- ⬜ Browser simulator (`--simulate`) as a client of the harness pipeline (§16: loopback only, ephemeral port, session token, Origin/Host validation)
- ⬜ Precise `rendered`-event sequencing for the harness (today `settled()` uses quiescence polling — fine for render/check, too coarse for scripted sessions)
- ⬜ Acceptance: `harness/protocol.test.ts` scripted session passes; example's test passes with mocked `osascript`

## M4 — Polish ⬜

- ⬜ `dev` hot reload without flicker (keep transport handle alive; only dirty keys repaint, changed set logged)
- ⬜ Scaffold `create-inkdeck` + CLAUDE.md template; `skills/inkdeck/SKILL.md`
- ⬜ Determinism pass: byte-identical JPEGs across repeated runs **and across machines** (same-machine determinism already tested)
- ⬜ Debug render metrics to stderr every 10 s (flush/skip/dedup rates, avg/peak render ms)

## Decisions

Recorded in [DECISIONS.md](./DECISIONS.md): Takumi v2 mapping (`className`→`tw`),
Inter as the bundled OFL face, exported-components-only JSX surface, gen-1 Mini
excluded from v1 render targets, `typescript` resolution strategy for `check`,
press semantics, commit-error surfacing, `exec` 127 semantics, CF data-symbol
binding via dlsym.

## Known gaps / risks

- Model constants and the entire IOKit/CF FFI layer are **unverified on hardware** (M2 gate); values are cited to the reference repo but hand-transcribed.
- `settled()` quiescence polling adds ~10 ms latency and is not event-precise — needs tightening for the M3 harness protocol.
- Takumi v2 resolves Tailwind via `tw`; the supported utility subset is not yet documented for app authors (§18.6 — do this with the scaffold README in M4).
