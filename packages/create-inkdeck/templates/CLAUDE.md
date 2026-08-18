# Working on this inkdeck app

This is a React app rendered to an Elgato Stream Deck (or a headless virtual
one). **You never need hardware, a browser, or eyes** — every feedback loop
below is CLI/stdio and returns structure, not pixels.

## The loop

1. Edit `app.tsx`.
2. `inkdeck check app.tsx` — typecheck + one headless render; exit 0/1. Run
   this after every edit.
3. To see what every key shows: `inkdeck render app.tsx --out ./frames --model mk2`,
   then read `frames/manifest.json` (structure first; the PNGs exist for
   visual double-checks).
4. To interact (press keys, advance time, watch state change):
   `inkdeck agent app.tsx --freeze-time --mock-exec mocks.json` and speak the
   JSON-lines protocol below.
5. `bun test` — the harness test in `app.test.tsx` (uses
   `@jackadamson/inkdeck/testing`, mocked subprocesses, frozen time).

## Manifest shape (structural snapshot)

```json
{
  "model": "mk2", "columns": 5, "rows": 3,
  "keys": [
    { "position": 0, "image": "key-0.png", "hash": "…",
      "text": ["mic", "LIVE"], "error": null,
      "hasPress": true, "hasLongPress": false }
  ]
}
```

`text` is every text node in the key's scene, in document order. A key whose
render threw reports `"error": "<message>"` — failures are structural, not
red pixels.

## Agent protocol (JSON-lines over stdio)

One JSON object per line. Commands on stdin, events on stdout. Any command
may carry an `"id"` (string or number); it is echoed on every event that
command produces.

Commands:

```
{"cmd":"press","position":0}       {"cmd":"release","position":0}
{"cmd":"tap","position":0}         // press+release; optional "holdMs" (long-press)
{"cmd":"snapshot"}                 // full manifest now
{"cmd":"advanceTime","ms":1000}    // frozen-clock only: drives pollers/timers
{"cmd":"writeFrames","dir":"./out"}
{"cmd":"exit"}
```

Events:

```
{"event":"ready","manifest":{…}}                          // once, at startup
{"event":"rendered","changed":[0],"manifest":{…},"id":…}  // notification: pixels changed
{"event":"state","manifest":{…},"id":…}                   // ack: press/release/tap/advanceTime/snapshot
{"event":"frames","dir":"./out","keys":1,"id":…}          // ack: writeFrames
{"event":"error","scope":"press","position":0,"message":"…","id":…}
{"event":"log","stream":"stderr","line":"…"}
{"event":"exit","id":…}
```

Guarantees: every command ends with exactly one terminal ack — `state`,
`frames` or `exit` (or `error`) — after its effects have settled, so "wait for
the ack, then read `manifest`" is always correct. `rendered` events are
notifications: they fire only on real pixel change, may arrive at any time
(pollers), and carry the `id` of the command in flight when there is one.
Malformed input yields an `error` event, never a crash; EOF on stdin exits
cleanly.

## Determinism switches

- `--freeze-time`: the clock (pollers, long-press timers, mock delays) only
  moves via `advanceTime`. Note: consecutive `tap`s advance the clock
  automatically past the 30 ms key-debounce window.
- `--mock-exec mocks.json`: every `exec()` resolves from the mock table
  (`match` is exact or, with `"regex": true`, a pattern over the space-joined
  argv). Unmatched commands resolve exit 127 **and** emit an `error` event
  naming the command — if you see one, add the missing mock.

## Rules

- Never require hardware; never skip `inkdeck check` after an edit.
- Styling is Takumi's CSS subset via Tailwind-style classes (see README
  "Supported styling") — no CSS grid, no system fonts.
- Use `exec()` from `@jackadamson/inkdeck` for subprocesses (it is what
  `--mock-exec` intercepts), not `Bun.spawn`.
- Two `<Key>`s with the same `position` is a commit-time error, not
  last-wins.
