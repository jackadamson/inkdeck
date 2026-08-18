# Hardware checklist (M2 acceptance record + re-verifications)

A dated record of what was verified on a physical deck; the ✅ items were true
on the date given and are re-checked when the relevant layer changes (latest:
2026-08-18, see the bottom).

Manual verification of the full stack on a physical Stream Deck. Run everything
from the repo root with the pinned Bun. Quit the Elgato Stream Deck app first —
it holds exclusive access to the device.

Status legend: ✅ verified · 👤 needs a human at the deck

## Automated smoke test

```
bun packages/inkdeck/scripts/hardware-smoke.ts
```

Exercises every `TransportHandle` operation and prints PASS/FAIL per step.
Press a key while it waits to cover input reports.

- ✅ `list()` finds the deck with model + serial (verified: XL `CL29J1A01442`, productId 0x006c)
- ✅ `open()` succeeds with the Elgato app closed
- ✅ `getFeature(0x06)` serial matches the IOKit device property
- ✅ `getFeature(0x05)` reads a plausible firmware version (verified: `1.00.008`)
- ✅ brightness feature reports accepted (sweep 10→100)
- ✅ framed JPEG image packets accepted for a full row of keys
- ✅ reset feature report accepted; deck returns to the Elgato logo
- ✅ first-row tiles actually show distinct solid colors during the run (human-verified 2026-08-01)
- ✅ press a key during the input window → `input reports parse as key states — down=[n]`
      with `n` matching the key you pressed (human-verified: top-left is 0, increasing
      left→right, top→bottom — presses of keys 0, 1, and 8 landed at exactly those positions)

## Reference app

```
bun packages/inkdeck/src/cli/index.ts start examples/mic-mute/app.tsx
```

- ✅ device auto-selected when it is the sole deck attached; model + serial logged
- ✅ key 0 shows the MIC tile (MUTED red / LIVE green matching the actual macOS
      input volume) — human-verified 2026-08-01
- ✅ pressing key 0 toggles mute; the tile repaints instantly — human-verified
      ("very responsive"; the measured scene→RGBA→JPEG→HID pipeline is ~1 ms/key
      on an XL, plus the ≤ 4 ms input-report pump, so < 100 ms with margin)
- 👤 `osascript -e 'set volume input volume 0'` from another terminal flips the
      tile to MUTED on the next poll (≤ 1 s) without a press
- ✅ Ctrl-C (SIGINT) / SIGTERM: deck clears to the Elgato logo, process exits 0

## Dev watch mode

```
bun packages/inkdeck/src/cli/index.ts dev examples/mic-mute/app.tsx
```

- ✅ edit + save `app.tsx` (or any module it imports — the whole app graph is
      re-bundled per save) → `[inkdeck] reloaded … — repainted keys […]` and the
      deck repaints (transport handle stays alive across reloads)
- ✅ save a file with a syntax error → `[inkdeck] reload failed: …`, session
      keeps running and keeps watching; fixing the file recovers
- ✅ Ctrl-C exits 0 and resets the deck

## Unplug / replug (verified 2026-08-01)

With `start` (or `dev`) running:

- ✅ unplug the deck → exactly one `[inkdeck] device disconnected` line — no
      per-key error flood; the process stays alive
- ✅ replug → `reconnected to <serial> — repainting`; the app's tiles return
      on their own with React state intact
- ✅ launching with no deck attached prints `waiting for a Stream Deck…` and
      picks the device up when it enumerates (autostart-on-login order-proof)

## Failure UX

- 👤 with the Elgato Stream Deck app running, `open` fails and the error says to
      quit the Elgato app
- 👤 with Input Monitoring denied for the terminal, the error points at
      System Settings → Privacy & Security → Input Monitoring

## Notes from the first hardware pass (2026-08-01, Stream Deck XL, macOS 15.6.1)

- All transcribed gen-2 constants checked out on the XL: productId 0x006c,
  8×4 @ 96×96, JPEG framing `[0x02, 0x07, key, isLast, lenLE(2), pageLE(2)]`
  with 1024-byte packets, brightness `[0x03, 0x08, pct]`, reset `[0x03, 0x02]`,
  serial/firmware feature reads at 0x06/0x05.
- One transient `kIOReturnBadArgument` was observed on a reset sent right after
  an image burst; `sendFeature` now retries idempotent feature reports once.
- The IOKit input callback's buffer **includes the report ID byte** — the
  transport originally re-prepended it (assuming node-hid-style stripping),
  shifting every input report by one and making presses parse as non-button
  reports. Raw XL report: `[0x01, 0x00, keyCountLE(2), states…]`, key data at
  offset 4, exactly as transcribed.
- Real key switches bounce; the controller now drops a key-down arriving
  within 30 ms of the same key's release (user-reported occasional double
  toggle → debounced; releases are never dropped).

## Re-verification 2026-08-18 (Stream Deck XL, Bun 1.3.11)

After the review-driven changes (`docs/review-2026-08-18.md`):

- ✅ Takumi-encoded JPEGs (sharp removed) accepted by the deck; aurora and the
      mic-mute tile look right — orientation, colours, crisp text (human-verified)
- ✅ `hardware-smoke.ts` all PASS with the new encoder
- ✅ concurrent per-round raster + identity-based removal detection: 12 s
      `start --debug` runs with no spurious `device disconnected`
- ✅ unplug/replug during `start`: one `device disconnected`, `waiting for
      Stream Deck <serial>…`, `reconnected … — repainting` (human-verified)
