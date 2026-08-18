---
name: inkdeck
description: Working on or with inkdeck — a custom React renderer targeting Elgato Stream Decks. Load when editing the inkdeck library, building an inkdeck app, or debugging deck rendering/input.
---

# inkdeck

**inkdeck** (`@jackadamson/inkdeck`) renders React to an Elgato Stream Deck
over raw USB HID — think Ink, but the "terminal" is a grid of LCD keys. Runtime
is Bun (pinned in `.tool-versions`); deps are locked to react/react-reconciler,
Takumi (raster + JPEG/PNG encode) — do not add packages (SPEC §2 is exhaustive).

## Architecture (4 layers, strictly separated)

```
React app (app.tsx default-exports a component)
Renderer   react-reconciler hostConfig → per-key scene trees → dirty diffing
           packages/inkdeck/src/renderer/ (controller.ts is the heart)
Raster     scene → Takumi RGBA → Takumi JPEG(device)/PNG(files), same buffer
           packages/inkdeck/src/raster/   fonts are explicit — determinism
Device     model tables + gen-2 report framing
           packages/inkdeck/src/device/   (hardware-verified on an XL)
Transport  five-op interface: IOKitTransport (bun:ffi) | VirtualTransport
           packages/inkdeck/src/transport/
```

The renderer only touches hardware through the `Transport` seam — everything
above it runs identically headless. The simulator and agent harness depend on
this; never bypass it.

## The feedback loop (no hardware, no eyes)

- `inkdeck check app.tsx` — typecheck + headless render, exit 0/1. After every edit.
- `inkdeck render app.tsx --out DIR --model mk2` — PNGs + `manifest.json`
  (structural: text per key in document order, error, hasPress/hasLongPress).
  Read the manifest, not the pixels.
- `inkdeck agent app.tsx --freeze-time --mock-exec mocks.json` — JSON-lines
  stdio: commands `press/release/tap/snapshot/advanceTime/writeFrames/exit`,
  events `ready/rendered/state/frames/error/log/exit`. Every command ends
  with exactly one terminal ack (`state`/`frames`/`exit`, or `error`) that
  echoes the command's optional `id`; `rendered` is a notification that fires
  only on real pixel change; malformed input → `error` event. Full reference:
  scaffold template `packages/create-inkdeck/templates/CLAUDE.md`.
- In `bun test`: `renderDeck` from `@jackadamson/inkdeck/testing`
  (`deck.key(0).text`, `deck.tap(0)`, `deck.advanceTime(ms)`,
  `deck.unmatchedExecs`).

## Invariants to preserve when editing the library

- **Determinism**: same app + state ⇒ byte-identical images. No system fonts,
  no `Date.now()` in render paths (use the injectable `Clock`), goldens in
  `src/raster/golden.json` (`INKDECK_UPDATE_GOLDEN=1` only for intentional
  changes).
- **FFI**: CF/IOKit refs cross `bun:ffi` as `bigint` (`FFIType.u64`), never
  `FFIType.ptr` — Apple Silicon tagged pointers corrupt in doubles. IOKit
  input callback buffers already include the report ID.
- **Input**: `onPress` fires on key-down (unless `onLongPress` competes);
  30 ms contact-bounce debounce drops rapid re-downs, never releases. Timing
  runs on the injectable clock so `--freeze-time` controls it.
- **Security (§16)**: zero open ports except `--simulate`, which binds
  127.0.0.1 on an ephemeral port with a session token + Origin + Host checks
  on the WS handshake — a synthetic press is RCE-equivalent (`onPress` →
  `exec`). The agent protocol must stay stdio-only.
- Errors inside a `<Key>` paint that key's error tile only and surface in the
  manifest `error` field; duplicate `position` throws with both stacks.

## Common patterns

- Poll external state: `const { refresh } = usePoller(async () => { ... await exec([...]) }, ms)` — always calls the latest callback; `refresh()` re-polls now (e.g. right after acting)
  + optimistic update in `onPress`, next poll reconciles (see
  `examples/mic-mute/app.tsx`, the reference app + test).
- Hardware debugging: `bun packages/inkdeck/scripts/hardware-smoke.ts`
  exercises every transport op with PASS/FAIL; the manual checklist is
  `examples/mic-mute/HARDWARE.md`. Quit the Elgato app first.
- Decisions live in `DECISIONS.md`; milestone status in `ROADMAP.md`; the
  spec (`SPEC.md`) is the source of truth for scope and constraints.
