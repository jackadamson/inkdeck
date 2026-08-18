# inkdeck — Implementation Specification

**inkdeck** (`@jackadamson/inkdeck`) is a custom React renderer whose render target is an Elgato Stream Deck. Think **Ink, but the "terminal" is a grid of physical LCD keys**. Developers who know React should be able to build personal workflow tools (mute toggles, Docker dashboards, deploy buttons) in a single `app.tsx`, with hot reload, a browser simulator, and a first-class feedback loop for coding agents.

This document is the source of truth for scope, constraints, and behavior. Sections marked **[P1]** are post-MVP; everything else is v1.

---

## 1. Goals

1. **React-native DX.** An app is a default-exported React component. State, hooks, effects, conditional rendering all work as expected. No new mental model beyond "a `<Key>` owns one physical key slot."
2. **Zero Elgato software.** Talk to the device directly over USB HID. The official Stream Deck app must not be required (and must be *closed* while our process holds the device — it claims exclusive access).
3. **Minimal, pre-approved dependency tree.** See §2. This is a hard constraint, not a preference.
4. **Agent-first feedback loop.** A coding agent must be able to render the app headlessly, inspect what every key shows (structurally and visually), simulate presses, and observe the resulting state — all via CLI/stdio, no hardware, no eyes.
5. **Deterministic rendering.** Same app + same state ⇒ byte-identical key images on every machine — achieved by construction: the renderer cannot see system fonts, so every glyph comes from bundled font data (§6.1). This is what makes golden tests sane.

## 2. Runtime & allowed dependencies

**Runtime: Bun** (pin a version in `.tool-versions`/`engines`; develop and CI against that pin). TypeScript and JSX run natively — no build step, no `tsx` package.

**Package identity:** published as `@jackadamson/inkdeck` — scoped, so provenance is tied to a verifiable owner (typosquat/dependency-confusion resistant); optionally dual-published to the unscoped `inkdeck` name (which is free) to pre-empt squatting of the name colleagues will type from memory. The CLI binary is `inkdeck`. The scaffold package is `@jackadamson/create-inkdeck`, reachable via `bun create @jackadamson/inkdeck`.

**Allowed npm dependencies (exhaustive):**

| Package | Why | Status |
|---|---|---|
| `react` | the point | approved |
| `react-reconciler` | custom renderer host config | approved (it is in Ink's dependency tree, and Ink is approved) |
| `@takumi-rs/core` | raster core: scene tree → pixels; CSS flexbox, Tailwind `className` resolution, explicit font loading; also the JPEG (4:4:4) / PNG encoder and model flip via an RgbaImage node | approved |
| ~~`sharp`~~ | removed 2026-08-18: Takumi encodes JPEG/PNG and applies the flip pixel-exactly (DECISIONS) — one native dependency instead of two | retired |

**Explicitly disallowed:** `node-hid` (not approved — we replace it with `bun:ffi`, §4), `canvas`/`node-canvas`, `jpeg-js`, `pureimage`, any CLI/arg-parsing/chalk-style helper. If you feel you need a utility package, inline the ~50 lines instead. Arg parsing uses `util.parseArgs` (built into Bun's Node compat). Anything from the `bun:` namespace and Bun globals (`Bun.spawn`, `bun test`, `Bun.serve`) is fine.

**Native modules on Bun:** use current `@takumi-rs/core`; it ships N-API prebuilds as ordinary npm platform packages. Milestone 0's first task is a CI smoke test on the pinned Bun version: Takumi renders a styled `div` with the bundled font → raw RGBA → JPEG → header confirms dimensions and 4:4:4. If either breaks, stop and flag — do not work around it with a new package. Prebuilds arrive via `npm install` only; running code never fetches `.node` binaries or fonts over the network (§16). Tailwind-style `className` support is Takumi's built-in resolver — do **not** add a `tailwindcss` dependency.

## 3. Architecture overview

Four layers, strictly separated. **The renderer must only ever touch the device through the `Transport` interface** — the simulator and agent harness depend on this seam.

```
┌───────────────────────────────────────────────────────┐
│ React app (user's app.tsx)                            │
├───────────────────────────────────────────────────────┤
│ Renderer: react-reconciler hostConfig                 │
│   host elements → per-key scene trees → dirty diffing │
├───────────────────────────────────────────────────────┤
│ Raster: scene tree → Takumi RGBA → sharp JPEG  (§6)   │
├───────────────────────────────────────────────────────┤
│ Device: model tables + report framing  (§5)           │
├───────────────────────────────────────────────────────┤
│ Transport (interface, §4):                            │
│   IOKitTransport (bun:ffi, macOS hardware)            │
│   VirtualTransport (headless / agent / simulator)     │
└───────────────────────────────────────────────────────┘
```

Suggested repo layout (Bun workspaces monorepo — future packages land under `packages/`):

```
packages/
  inkdeck/             the core package (@jackadamson/inkdeck)
    src/
      transport/   iface.ts, iokit.ts, virtual.ts, cf.ts (CoreFoundation helpers)
      device/      models.ts, protocol.ts (framing), discovery.ts
      raster/      takumi.ts, fonts.ts, assets/fonts/*.ttf (bundled OFL default)
      renderer/    hostConfig.ts, components.ts, hooks.ts, clock.ts, exec.ts
      cli/         index.ts, dev.ts, agent.ts, check.ts, list.ts, simulate.ts
      harness/     protocol.ts (JSON-lines), manifest.ts
  create-inkdeck/      scaffold package (`bun create @jackadamson/inkdeck`); templates/ incl. CLAUDE.md
skills/        inkdeck/SKILL.md + references for coding agents (§12)
examples/      mic-mute/app.tsx (the reference app, §14 M2)
```

## 4. Transport layer

### 4.1 Interface

```ts
interface DeviceInfo {
  path: string          // opaque, transport-specific
  vendorId: number      // 0x0fd9
  productId: number
  serial: string        // stable identity; used by --device
  model: ModelId        // resolved from productId
}

interface Transport {
  list(): Promise<DeviceInfo[]>
  open(path: string): Promise<TransportHandle>
}

interface TransportHandle {
  writeOutput(report: Uint8Array): Promise<void>     // report ID = first byte
  sendFeature(report: Uint8Array): Promise<void>
  getFeature(reportId: number, length: number): Promise<Uint8Array>
  onInput(cb: (report: Uint8Array) => void): void
  close(): Promise<void>
}
```

Five operations. That is the whole surface node-hid was providing; do not let it grow.

### 4.2 IOKitTransport (macOS hardware, via `bun:ffi`)

Bind IOKit + CoreFoundation from the system frameworks with `dlopen` — no compiled addon, no node-gyp. Approximate binding list:

```
IOHIDManagerCreate, IOHIDManagerSetDeviceMatching, IOHIDManagerOpen,
IOHIDManagerCopyDevices,
IOHIDDeviceOpen, IOHIDDeviceClose, IOHIDDeviceGetProperty,
IOHIDDeviceSetReport, IOHIDDeviceGetReport,
IOHIDDeviceRegisterInputReportCallback,
IOHIDDeviceScheduleWithRunLoop,
CFRunLoopGetCurrent, CFRunLoopRunInMode,
CFDictionaryCreate, CFNumberCreate, CFStringCreateWithCString,
CFStringGetCString, CFSetGetCount, CFSetGetValues, CFRelease
```

Implementation notes (hard-won; follow them):

- **Matching dict:** match on `{ VendorID: 0x0fd9 }` only; resolve model from `ProductID` afterwards. Building the CFDictionary is fiddly pointer ceremony — isolate it in `cf.ts` with tests.
- **Report types:** `kIOHIDReportTypeInput = 0`, `Output = 1`, `Feature = 2`. Transcribe enum values from IOKit headers once; comment the source header next to each constant.
- **Input reports:** register the callback (`JSCallback` from `bun:ffi`), schedule the device on the current run loop, and pump with `CFRunLoopRunInMode(defaultMode, 0, true)` on a ~4 ms `setInterval`. The interval is also the process keep-alive — do not rely on native handles to keep Bun's event loop alive.
- **Serial number:** read via `IOHIDDeviceGetProperty(kIOHIDSerialNumberKey)`.
- **Failure UX:** if `open` fails, check whether the Elgato Stream Deck app is running (`pgrep`) and say so in the error message; also mention macOS Input Monitoring permission (System Settings → Privacy & Security) as the other usual suspect.

### 4.3 VirtualTransport

In-process fake used by `render`, `agent`, `check`, and the browser simulator. Holds the last-written image per key, exposes `pressKey(pos)` / `releaseKey(pos)` to synthesize input reports, and records brightness/reset feature calls. It must consume the **same framed bytes** as hardware (i.e. it sits below the protocol layer and un-frames them) so the full pipeline is exercised headlessly.

## 5. Stream Deck protocol layer

Reverse-engineered, stable, and documented by the MIT-licensed reference implementation: `github.com/Julusian/node-elgato-stream-deck` (`packages/core/src/models/`). **Transcribe constants from there and cite the file next to each table entry; verify on real hardware in M2. Do not trust the values below without checking — they are from memory and are indicative, not authoritative.**

### 5.1 Model table

One record per supported model:

```ts
interface Model {
  id: ModelId                 // 'mk2' | 'xl' | 'mini' | 'plus' | 'neo' | 'original-v2' | ...
  productIds: number[]        // e.g. MK.2 0x0080, XL 0x006c, V2 0x006d, Plus 0x0084, Neo 0x009a
  columns: number; rows: number
  keyW: number; keyH: number  // e.g. 72×72 (MK.2), 96×96 (XL, Plus)
  imageFormat: 'jpeg' | 'bmp' // bmp only on gen-1; gen-1 support is [P1]
  transform: { flipH: boolean; flipV: boolean; rotate: 0|90|180|270 }
  packetSize: number          // gen-2 image packets are 1024 bytes total
  hasDials?: boolean; lcdStrip?: { w: number; h: number }   // Plus [P1]
}
```

v1 targets **gen-2 JPEG devices**: MK.2, XL, V2, Mini (gen-2), Neo. Plus (dials/LCD) and gen-1 BMP devices are [P1].

### 5.2 Framing (gen-2)

- **Key image:** JPEG bytes split into `packetSize − 8` chunks; each packet is `[0x02, 0x07, keyIndex, isLastPacket, byteCountLE(2), pageNumberLE(2), ...payload, ...zeroPad]`, sent as output reports.
- **Brightness:** feature report `[0x03, 0x08, percent, 0…]` (padded to the feature report length).
- **Reset:** feature report `[0x03, 0x02, 0…]`. Send on startup and on clean shutdown.
- **Input report:** `[reportId, …, keyStates]` — one byte per key (0/1) at a small model-specific offset. Emit `keydown`/`keyup` per position on change.

Apply the model's flip/rotate transform at raster time (CSS `transform` on the RGBA image node when re-encoding), not by mangling JPEG bytes.

## 6. Rasterization pipeline

### 6.1 Scene → Takumi → JPEG

Each `<Key>`'s children form a small scene tree of standard elements (§7.1). The raster layer converts it to Takumi nodes (via `@takumi-rs/helpers`) and renders at the model's native key resolution:

- Layout and styling are Takumi's CSS subset: flexbox (`div` defaults to `display: flex`), Tailwind utility classes via `className`, inline `style` reserved for dynamic values (data-driven colors, computed sizes).
- Takumi renders to **raw RGBA**; that buffer is fed back to Takumi as an `RgbaImage` node with the model transform as CSS and encoded `{ format: 'jpeg', quality: 95 }` (4:4:4) for the HID push. The `render` command and simulator want PNGs — encode those from the **same RGBA buffer** so all three surfaces are pixel-identical.
- `img` sources (file path or Buffer) are resolved by the raster layer and handed to Takumi as image nodes.

**Fonts are explicit — this is the determinism mechanism.** Takumi cannot see system fonts; every font is loaded from file data. Ship one bundled OFL-licensed default (regular + bold) that is always registered; apps add faces via `export const config = { fonts: [...] }` (§8). No fontconfig, no runtime network fetch, no environment dependence.

### 6.2 Dirty diffing & flush

On every React commit:

1. **Scene hash (skip render):** recompute the scene per key slot and hash it (stable JSON). Unchanged hash ⇒ no work for that key.
2. **Output dedup (skip push):** after rasterizing, hash the raw RGBA buffer; if identical to the last frame pushed to that slot, skip encoding and the HID write. Catches re-renders that change the tree but not the pixels.
3. **Coalesced, priority-ordered flush:** rasterization is serialized per key and coalesced (three commits while a JPEG is in flight ⇒ only the newest scene renders). Device flushes run sequentially (USB writes serialize anyway); slots whose change was caused by user input in the last 500 ms flush first.

Target: press-to-photon under ~50 ms for a single-key change. In debug mode, log render metrics to stderr every 10 s — flush count, skip rate, dedup rate, avg/peak render ms — so performance regressions are visible as text the agent loop can read.

The browser simulator must display the **server-rendered PNGs**, never re-render text in the browser — hardware and simulator must always show identical pixels.

## 7. Renderer & component API

### 7.1 Host components & elements

`<Deck>` and `<Key>` are the framework's components; *inside* a `<Key>`, content is ordinary JSX using the element subset Takumi renders — `div`, `span`, `p`, `img`, `svg` — styled with `className` (Tailwind utilities) and `style`:

```tsx
<Deck brightness={80}>   // root; runtime-reactive settings
  <Key position={0} onPress={toggle} onLongPress={reset} longPressMs={500}>
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[#0a7d33]">
      <span className="text-[12px] uppercase tracking-wide text-white/70">mic</span>
      <span className="text-[20px] font-bold text-white">LIVE</span>
    </div>
  </Key>
</Deck>
```

Rules:

- Two `<Key>` elements mounted with the same `position` ⇒ **throw at commit time** with both component stacks. Last-wins is a debugging nightmare on a physical grid.
- `position` beyond the connected model's key count ⇒ warn once, don't render (lets one app serve XL and MK.2).
- Unmounted keys are cleared to black; a `<Key>` with no children renders black.
- `onPress` may be async; rejections are caught and logged (§10), never fatal.
- Every `<Key>` subtree is wrapped in a root error boundary: a render throw paints a minimal fallback error tile on **that key only** and logs the component stack to stderr — the rest of the deck keeps working (§10). An exported `<ErrorBoundary fallback onError>` gives apps finer control.
- `<Dial>`, `<Screen>` (Plus), `<Page>`/navigation, `onDoubleTap`: **[P1]**. Design them, don't build them — and note the gesture rule for later: when double-tap exists, single-tap must be delayed until the double-tap window closes, so the timing model has to run on the injectable clock (§11.3).

### 7.2 Hooks

```ts
useDeckInfo(): { model, columns, rows, keyCount, serial } // null-safe in headless
useBrightness(): [number, (n: number) => void]
useKeyState(position): { pressed: boolean }
usePoller(fn, ms): void        // interval built on the injectable clock (§11.3)
```

### 7.3 `deck.exec` — the subprocess boundary

```ts
import { exec } from '@jackadamson/inkdeck'
const { stdout, stderr, exitCode } = await exec(['osascript', '-e', '…'])
```

Thin wrapper over `Bun.spawn`. Exists **only** so the agent harness can intercept it (`--mock-exec`, §11.3). Apps may still use `Bun.spawn` directly, but the docs and scaffold use `exec` and say why.

## 8. Entry point & configuration

An app is a file that default-exports a component, with an optional static config export:

```tsx
export const config = { model: 'mk2', fonts: ['./NotoSans.ttf'] }   // pre-connection: simulator default model, extra fonts
export default function App() { … }
```

Settings live at exactly one of three levels — never two:

| Kind | Mechanism | Examples |
|---|---|---|
| Environmental (which surface) | CLI flags / env | `--device <serial>`, `--simulate [model]` |
| Pre-connection app defaults | `export const config` | default simulator model, extra `fonts` |
| Runtime-reactive | props on `<Deck>` | `brightness` |

Device selection precedence: `--device` flag > `INKDECK_DEVICE` env > sole attached device > error listing candidates (with serials). There is **no** Head-style declarative settings element in v1, and flags must never control app behavior (no `--brightness`).

## 9. CLI

Shipped as the package `bin` (`inkdeck`), arg parsing via `util.parseArgs`.

```
inkdeck dev <app.tsx> [--device S] [--simulate [model]]   # watch + hot reload
inkdeck start <app.tsx> [--device S]                      # run once, no watch
inkdeck render <app.tsx> --out DIR [--model M]            # headless one-shot: PNGs + manifest.json
inkdeck agent <app.tsx> [--model M] [--freeze-time] [--mock-exec F]  # JSON-lines harness (§11)
inkdeck check <app.tsx>                                   # typecheck + one headless render; exit 0/1
inkdeck list                                              # attached devices: model, serial
inkdeck create <dir>                                      # scaffold (§13)
```

- `dev` hot reload: keep the process + transport handle alive, re-import the app module on file change (`bun --hot` semantics or manual cache-busting dynamic import), re-render. The deck must not flicker on save; only dirty keys repaint.
- `--simulate` starts `Bun.serve` bound to **127.0.0.1 on a random ephemeral port**: one locally-served static vanilla-JS HTML page + a WebSocket pushing server-rendered key PNGs; clicks send press/release. No frontend framework; the page renders whatever model geometry the server announces. This is the only command that ever opens a socket, and it follows the §16 rules.
- All processes: SIGINT/SIGTERM ⇒ clear deck, reset, close transport, exit 0. A crash must exit non-zero — never hang.

## 10. Errors & logging

- Framework logs go to **stderr**, prefixed `[inkdeck]`; the app's own stdout is never touched.
- Rejected/thrown `onPress` ⇒ `[inkdeck] [key 3] onPress failed: <error + stack>`; display is left as-is.
- Render/commit errors inside a `<Key>` subtree ⇒ caught by that key's error boundary: component stack to stderr, a minimal fallback error tile on that key, every other key keeps working; `dev` keeps watching. Errors outside any `<Key>` (root scope) exit 1.
- Every warning states the fix, not just the problem (e.g. an unreadable `Image src` names the path that was checked).

## 11. Agent & test harness

This is a headline feature, not tooling garnish. The browser simulator is a *client* of this layer — build the machine interface first.

### 11.1 Manifest (structural snapshot)

Emitted by `render` (as `manifest.json`) and by `agent` (inline). The semantic tree, captured **before** rasterization:

```json
{
  "model": "mk2", "columns": 5, "rows": 3,
  "keys": [
    {
      "position": 0,
      "image": "key-0.png",
      "hash": "c0ffee…",
      "text": ["MIC", "MUTED"],
      "error": null,
      "hasPress": true, "hasLongPress": false
    }
  ]
}
```

Structure beats pixels for agents (the accessibility-tree lesson); PNGs are still written for visual checks. `text` collects every `#text` node in the key's scene in document order. A key whose error boundary tripped reports `"error": "<message>"` so agents see failures structurally, not as red pixels.

### 11.2 `inkdeck agent` — JSON-lines protocol over stdio

One JSON object per line. Commands (stdin) / events (stdout). Any command may
carry an `"id"` that is echoed on the events it produces:

```
→ {"cmd":"press","position":0}          → {"cmd":"release","position":0}
→ {"cmd":"tap","position":0}            // press+release incl. long-press timing via "holdMs"
→ {"cmd":"snapshot"}                    // full manifest now
→ {"cmd":"advanceTime","ms":1000}       // frozen-clock only
→ {"cmd":"writeFrames","dir":"./out"}   // dump PNGs on demand
→ {"cmd":"exit"}

← {"event":"ready","manifest":{…}}
← {"event":"rendered","changed":[0,3],"manifest":{…}}   // notification: pixels changed
← {"event":"state","manifest":{…}}                       // terminal ack (press/release/tap/advanceTime/snapshot)
← {"event":"frames","dir":"./out","keys":1}              // terminal ack (writeFrames)
← {"event":"error","scope":"press","position":0,"message":"…"}
← {"event":"log","stream":"stderr","line":"…"}
```

Guarantees: every command ends with exactly one terminal ack (`state`/`frames`/`exit`, or `error`) after its effects settled; `rendered` fires only when key content actually changed and may arrive unsolicited (pollers); malformed input ⇒ `error` event, not a crash; EOF on stdin ⇒ clean exit. The living reference is the scaffold's `CLAUDE.md` (`packages/create-inkdeck/templates/CLAUDE.md`).

### 11.3 Determinism switches

- `--freeze-time`: the injectable clock (which backs `usePoller`, `setInterval` usage inside the framework, and long-press timers) starts frozen; only `advanceTime` moves it.
- `--mock-exec mocks.json`: intercepts `exec()` (§7.3). Mock file maps command matchers (exact string or regex) → `{ stdout, stderr, exitCode, delayMs? }`. Unmatched commands ⇒ `error` event naming the command, so agents see gaps instead of hangs.

### 11.4 `bun test` integration

Export a test helper wrapping the harness in-process:

```ts
import { renderDeck } from '@jackadamson/inkdeck/testing'
const deck = await renderDeck(<App/>, { model: 'mk2', freezeTime: true, mockExec })
expect(deck.key(0).text).toContain('MUTED')
await deck.tap(0)
await deck.settled()
expect(deck.key(0).text).toContain('LIVE')
```

The reference example (§14 M2) ships with such a test.

## 12. Scaffold (`inkdeck create`)

Generates: `app.tsx` (the mic-mute example, §14), `package.json` (scripts: `dev`, `start`, `check`, `test`), `tsconfig.json`, `.gitignore`, `README.md`, and **`CLAUDE.md`** containing the agent workflow:

> After every edit run `inkdeck check app.tsx`. To inspect output run `inkdeck render app.tsx --out ./frames --model mk2` and read `frames/manifest.json`. To interact, run `inkdeck agent app.tsx --freeze-time --mock-exec mocks.json` and speak the JSON-lines protocol. Never require hardware.

(Include the full protocol reference in the file — an agent that discovers the loop on turn one will actually use it.)

The library repo itself also ships `skills/inkdeck/SKILL.md` — architecture summary, harness protocol, common patterns — so coding agents working on or with the library load the workflow into context on turn one.

## 13. Milestones & acceptance criteria

Each criterion is a command an implementing agent can run and self-verify. Land them in order; hardware appears only at M2.

**M0 — Foundations.** Takumi + sharp smoke test on pinned Bun (Takumi renders a styled `div` with the bundled font → raw RGBA → sharp → JPEG → decode confirms dimensions). `IOKitTransport.list()` prints attached decks with serials via `inkdeck list` (hardware optional: unit-test CF helpers regardless). ✅ `bun test packages/inkdeck/src/transport` green; `inkdeck list` runs without throwing when no device attached.

**M1 — Headless renderer.** hostConfig + `<Deck>/<Key>` + the Takumi element subset, scene diffing + output dedup, Takumi→sharp→JPEG, VirtualTransport, `render` + `check` commands. ✅ `inkdeck render examples/mic-mute/app.tsx --out /tmp/f --model mk2` writes PNGs + a manifest matching §11.1; `check` exits 0 on the example and 1 on a file with a type error; duplicate `position` throws with both stacks; a component that throws paints the fallback error tile on its key only.

**M2 — Hardware end-to-end.** Framing layer + IOKitTransport on a real MK.2/XL: images, brightness, presses, reset-on-exit. Reference mic-mute app works physically. ✅ manual checklist in `examples/mic-mute/HARDWARE.md` all pass; press-to-repaint feels instant (<100 ms).

**M3 — Agent harness + simulator.** `agent` protocol complete with `--freeze-time`/`--mock-exec`; `testing` helper; browser simulator as a client of the same pipeline. ✅ the scripted session in `harness/protocol.test.ts` (press → rendered → snapshot asserts) passes; `bun test` on the example's test file passes with mocked `osascript`.

**M4 — Polish.** `dev` hot reload without flicker, scaffold + CLAUDE.md, determinism pass. ✅ rendering the reference example produces byte-identical JPEGs across repeated runs **and across two different machines** (explicit fonts make this a hard requirement, not an aspiration); hot-reload edit repaints only changed keys (log the changed set to prove it).

## 14. Reference example (ships in `examples/mic-mute/`)

macOS mic-mute key: polls `osascript -e 'input volume of (get volume settings)'` via `exec` + `usePoller`, shows MUTED/LIVE labels with red/green background, `onPress` toggles with optimistic update, next poll reconciles. Includes `mocks.json` and a harness-based test. This app is the acceptance vehicle for M1–M4 and the scaffold template.

## 15. Non-goals (v1)

Windows/Linux transports; gen-1 BMP devices; Stream Deck Plus dials/LCD; pages/navigation; multiple simultaneous devices; coexisting with the running Elgato app; plugin/distribution story; Head-style declarative settings; hosted or remote devtools UIs and any network-exposed control surface beyond the §16 simulator; animation hooks (springs/tweens) — though the injectable clock must be designed so they can land at [P1] without rework.

## 16. Security posture

The default posture is **zero open ports**. `dev`, `start`, `check`, `render`, and `list` never listen on anything; `agent` speaks JSON-lines over **stdio only** and must never grow a socket transport. The threat that matters: a synthetic key press is arbitrary command execution (`onPress` → `exec`), so any channel that can inject presses is RCE-equivalent and is treated accordingly.

The simulator (`--simulate`) is the one exception, with these non-negotiable rules:

- Bind `127.0.0.1` only, on a **random ephemeral port** — no fixed or well-known port range for drive-by web pages to scan.
- Generate a per-session random token, print the URL as `http://127.0.0.1:<port>/#<token>`, and require the token on the WebSocket handshake. A malicious website can attempt requests against localhost but cannot read the token from the user's terminal.
- Validate the `Origin` header on every WebSocket upgrade, accepting only the simulator's own origin. WebSockets are **not** subject to CORS — without this check, any web page can open a socket to localhost.
- Validate the `Host` header against `127.0.0.1:<port>` to defeat DNS rebinding.
- Serve the UI locally from that same origin. No hosted UI, no `Access-Control-Allow-Origin: *`, no port-scan "discovery" of running instances, no SSE bridge for external pages.
- No runtime downloads of any kind: native prebuilds and fonts arrive via `npm install` and the package tarball, never fetched by running code (§2).

Browser-side mitigations (Chrome's local-network-access protections) add attacker friction but are someone else's policy — the token + Origin + Host checks must stand on their own.

## 17. Prior art — `fcannizzaro/streamdeck-react`

An existing, well-built project (Apache-2.0, `github.com/fcannizzaro/streamdeck-react`) with the same "React on a Stream Deck" pitch and a different architecture: a wrapper over the official Elgato plugin SDK — the Elgato app must run, users place actions in the Elgato UI, and each action instance gets an isolated React root. Study it; several choices in this spec are adopted from it, and the implementing agent should not reinvent what it already validates.

**Adopted here:** Takumi as the raster core with explicit fonts; output-pixel dedup before the hardware push; interactive-first sequential flushing; per-key error boundaries with a fallback error tile; debug render metrics with skip rates; shipping an agent skill alongside the code.

**Deliberately not adopted:** the Elgato SDK layer (bypassing it is this project's reason to exist); per-action isolated roots (our single tree makes cross-key state plain React); runtime download of `.node` binaries from npm (supply-chain surface — prebuilds install through npm only); runtime Google-Fonts fetching as the default (we bundle); the hosted-devtools pattern — fixed port range 39400–39499, wildcard CORS, browser-side discovery scanning (§16).

**Deferred to [P1]:** spring/tween animation hooks and the adaptive-debounce/priority machinery behind them; tap-vs-double-tap gating; suspend/resume root pooling when `<Page>` navigation lands.

## 18. Open questions (decide during implementation, record in DECISIONS.md)

1. Exact per-model constants (product IDs, offsets, packet sizes) — transcribe from the reference repo and verify on hardware; treat §5 numbers as hints.
2. `bun --hot` vs manual module-cache-busting for `dev` — whichever reliably preserves the transport handle on the pinned Bun.
3. JSX type surface: global `JSX.IntrinsicElements` vs exported components only (lean: exported components; avoids polluting the global namespace).
4. Whether `usePoller` pauses while the deck is "asleep" (brightness 0) — nice battery/CPU touch, decide when idle handling lands.
5. Default bundled font: which OFL face (Inter is the obvious candidate) and which weights ship.
6. Which Tailwind utility subset Takumi resolves — document the supported set in the scaffold README so devs and agents don't guess.

## Appendix A — protocol/reference pointers

- Reference implementation to transcribe from (MIT): `github.com/Julusian/node-elgato-stream-deck`, esp. `packages/core/src/models/*` (framing, per-model tables) and `packages/node/src/hid.ts` (report plumbing being replaced by our transport).
- IOKit headers for constants: `IOKit/hid/IOHIDManager.h`, `IOHIDDevice.h`, `IOHIDKeys.h`.
- Takumi renderer (`@takumi-rs/core`, `@takumi-rs/helpers`): consult the package READMEs/docs for the supported CSS subset, Tailwind class resolution, raw-RGBA output, and the font-loading API before writing the raster layer.
- Vendor ID for all Stream Decks: `0x0fd9`.
