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

## M2 — Hardware end-to-end ✅ (verified on a Stream Deck XL, macOS 15.6.1 Apple Silicon, 2026-08-01)

- ✅ Verify transcribed constants on hardware — all gen-2 values checked out on the XL (productId 0x006c, 8×4 @ 96×96, image/brightness/reset framing, serial/firmware feature reads 0x06/0x05, key data at raw offset 4, row-major positions)
- ✅ Exercise IOKitTransport for real — and fix what the FFI ceremony got wrong:
  - **tagged pointers**: Apple Silicon CF returns small CFNumbers/short CFStrings as full-64-bit tagged pointers; `FFIType.ptr`'s double representation corrupted them (segfault). CF refs now cross the FFI as `bigint` (`FFIType.u64`) — see DECISIONS.md
  - **input reports**: the IOKit callback buffer already includes the report ID; the transport was re-prepending it, shifting every report by one byte
  - idempotent feature reports (brightness/reset) retry once on transient IOReturn errors (observed one `kIOReturnBadArgument` after an image burst)
- ✅ `inkdeck start` / `inkdeck dev` (minimal watch: cache-busting re-import, transport handle stays alive, broken saves keep the session running; no-flicker/changed-set polish stays in M4)
- ✅ `packages/inkdeck/scripts/hardware-smoke.ts` — automated per-operation hardware check (all PASS)
- ✅ `examples/mic-mute/HARDWARE.md` manual checklist (all human-verifiable items confirmed; two low-risk items left noted for a rainy day: poll-reconcile without press, failure-UX messages)
- ✅ Contact-bounce debounce: key-down within 30 ms of the same key's release is dropped (user-reported double toggle on hardware; runs on the injectable clock, unit-tested with FrozenClock)
- ✅ Acceptance: checklist passes; press-to-repaint human-verified "very responsive" (measured scene→RGBA→JPEG→HID ≈ 1 ms median/key on XL)

## M3 — Agent harness + simulator ✅

- ✅ `inkdeck agent` JSON-lines protocol (§11.2): press/release/tap/snapshot/advanceTime/writeFrames/exit → ready/rendered/state/frames/error/log/exit events; `--freeze-time` + `--mock-exec` (unmatched commands resolve exit 127 and emit an `error` event — a visible gap, never a hang or a real spawn)
- ✅ Frozen-time `tap` advances the clock through the hold and past the 30 ms contact-bounce window after release
- ✅ `@jackadamson/inkdeck/testing` (`renderDeck`: key()/tap()/advanceTime()/settled()/unmatchedExecs) + `examples/mic-mute/app.test.tsx` (poll → optimistic toggle → reconcile, all with mocked `osascript`)
- ✅ Browser simulator (`--simulate` on dev/start) as a client of the harness pipeline; §16 posture tested per rejection path (loopback + ephemeral port, token required on the WS handshake, Origin validated, forged Host 403s, self-contained page, server-rendered PNGs only)
- ✅ `rendered`-event sequencing: the agent processes commands strictly sequentially — each command's effects drain (settled) and are acknowledged before the next stdin line is read; `rendered` fires only on actual pixel change, everything else acks with `state`. settled() stays quiescence-based (2 idle macrotask checks); event-precise commit hooks were not needed for a deterministic scripted session
- ✅ Acceptance: `harness/protocol.test.ts` scripted session passes (ready → press → rendered → snapshot → reconcile, malformed-input errors, writeFrames, EOF exit 0); example's test passes with mocked `osascript`

## M4 — Polish ✅

- ✅ `dev` hot reload: transport handle stays alive across reloads; only dirty keys repaint and the changed set is logged (`repainted keys [0]` / `no visual change`); watcher observes the **parent directory** (editors save via write-rename, which kills a file-scoped watcher after the first save — found live); unit test proves a re-render with one key changed repaints only that key
- ✅ Scaffold: `packages/create-inkdeck` (`bun create @jackadamson/inkdeck <dir>`, `inkdeck create <dir>` delegates) — app.tsx/mocks.json/app.test.tsx (the reference app + harness test), package.json (dev/start/check/test/render), tsconfig, .gitignore, README (documents the known-good Tailwind subset, §18.6), CLAUDE.md (agent workflow + full §11.2 protocol reference)
- ✅ `skills/inkdeck/SKILL.md` — architecture, feedback loop, invariants, patterns
- ✅ Determinism pass: two fresh processes produce byte-identical PNGs/hashes (`raster/determinism.test.ts`); golden SHA-256s for the reference key (RGBA/JPEG/PNG) committed in `raster/golden.json`, recorded on macOS arm64 — cross-machine byte-identity **verified on Linux x64 / Bun 1.3.14 (review 2026-08-18)** and locked in by the CI matrix (`.github/workflows/ci.yml`; a mismatch there is a real finding, not a golden refresh)
- ✅ Debug render metrics every 10 s with `--debug` (verified on hardware: `metrics(10s): flushes=2 scene-skip=0% dedup=0% render avg=6.0ms peak=9.4ms`)

## Decisions

Recorded in [DECISIONS.md](./DECISIONS.md): Takumi v2 mapping (`className`→`tw`),
Inter as the bundled OFL face, exported-components-only JSX surface, gen-1 Mini
excluded from v1 render targets, `typescript` resolution strategy for `check`,
press semantics, commit-error surfacing, `exec` 127 semantics, CF data-symbol
binding via dlsym.

## Post-M4 hardening

- ✅ Unplug/replug resilience (2026-08-01): `onDisconnect` on the transport handle (+ `DeviceDisconnectedError`), controller detach state + `replaceHandle` full repaint, `start`/`dev` wait for the device at startup and reconnect on unplug. Removal is detected by polling the run-loop-scheduled IOHIDManager's device set — the device-level removal callback never fires on macOS 15.6/arm64 (see DECISIONS.md). Verified live on the XL, plus headless tests via `VirtualHandle.simulateDisconnect()`.

## Known gaps / risks

- Hardware verification covers the **XL only** — MK.2/V2/Neo share the gen-2 protocol and should Just Work, but their product IDs/geometry are still transcription-only.
- ✅ `settled()` tightened (2026-08-18): each pass flushes React passive effects + sync work, tracks the commit count and yields 0 ms macrotasks instead of 5 ms sleeps — no timed floor under frozen time + mocked exec. Still a quiescence heuristic for real I/O (a real subprocess in flight is not awaited).
- Takumi v2 resolves Tailwind via `tw`; the supported utility subset is not yet documented for app authors (§18.6 — do this with the scaffold README in M4).
