# DECISIONS

Implementation decisions on the open questions in SPEC §18 and other choices
made along the way. Newest last.

## Takumi is at v2 — the spec's raster assumptions were updated (2026-07-31)

The spec predates Takumi's 1.x/2.x line. We use `@takumi-rs/core` +
`@takumi-rs/helpers` **2.5.4**. Verified empirically on the pinned Bun:

- Tailwind utilities are resolved by the native core via the node-level `tw`
  field (`className` on Takumi nodes is only used with CSS `stylesheets`).
  inkdeck maps the JSX `className` prop → Takumi `tw`, so app code matches the
  spec's `className` API exactly.
- `render(node, { format: 'raw' })` returns raw RGBA — that buffer feeds sharp
  for both the device JPEG (with model transform) and the render/simulator PNG
  (untransformed), keeping all surfaces pixel-identical (§6.1).
- Fonts are registered per-renderer with `registerFont({ data, name })`;
  nothing system-wide leaks in, which is what makes rendering deterministic.

## §18.5 Default bundled font: Inter 4.1 (OFL)

`Inter-Regular.ttf` + `Inter-Bold.ttf` (static, not variable — deterministic
shaping and simple weight selection) from the official rsms/inter v4.1 release,
committed under `packages/inkdeck/src/raster/assets/fonts/` with the OFL
license text. Registered under the family name `Inter`; the per-key root
container defaults `fontFamily: Inter`, `fontSize: 16`, white on black.

## §18.3 JSX type surface: exported components only

`<Deck>`/`<Key>`/`<ErrorBoundary>` are typed exports. Content elements
(`div`, `span`, `p`, `img`, `svg`) use React's standard DOM typings — no
global `JSX.IntrinsicElements` augmentation, no namespace pollution. The
reconciler validates the element subset at runtime (unsupported tags throw
with the allowed list).

## §18.1 Model constants: transcribed, cited, unverified

Transcribed from `Julusian/node-elgato-stream-deck` master (files cited inline
in `src/device/models.ts` / `src/device/protocol.ts`). Notable corrections vs
the spec's from-memory §5 hints:

- Mini (all product IDs incl. 0x0090/0x00b3) is a **gen-1 BMP** device in the
  reference implementation, so it is *not* a v1 render target
  (`RENDERABLE_MODELS` = mk2, original-v2, xl, neo). Discovery still resolves it.
- Gen-2 input reports: raw layout `[0x01, inputType, …]` with key states at
  raw offset 4 (`KEY_DATA_OFFSET = 3` after the report ID is stripped);
  `inputType 0x00` = buttons, `0x02/0x03/0x04` = LCD/encoder/NFC ([P1]).

Everything remains flagged for on-hardware verification in M2.

## `inkdeck check` typechecking: `typescript` stays out of runtime deps

§2's approved dependency list has no compiler. `check` resolves `typescript`
dynamically — first from the app's own project, then from inkdeck's
devDependencies — and exits with a clear "add typescript to devDependencies"
message if neither exists. The scaffold (M4) will include `typescript` as a
devDependency, so `inkdeck check` works out of the box for scaffolded apps
without ever fetching anything at runtime (§16).

## Press semantics without a gesture system (v1)

- No `onLongPress`: `onPress` fires on **key-down** (instant feel, matches
  hardware buttons).
- With `onLongPress`: `onPress` fires on release before `longPressMs`
  (default 500 ms); `onLongPress` fires while held once the threshold passes.
  Timers run on the injectable clock, so `--freeze-time`/`advanceTime` will
  drive them (per §7.1's note about the future double-tap window).

## Commit-walk errors are recorded, not rethrown into React

Duplicate `position` (and other commit-time violations) are detected in the
commit walk. Throwing from inside React's commit phase would tear down the
reconciler mid-commit, so the controller records the error and surfaces it
from `settled()` — `render`/`check` then fail with exit 1 carrying both
component stacks. Same observable contract as "throw at commit time" (§7.1)
with a stable failure path.

## `exec` returns exit code 127 for missing executables

`Bun.spawn` throws when the binary doesn't exist; `exec` converts that into
`{ exitCode: 127, stderr: <message> }` (shell convention) so pollers on
machines without the tool (e.g. `osascript` off-macOS) degrade gracefully
instead of logging stack traces every tick.

## CoreFoundation dictionary callbacks via dlsym

`bun:ffi`'s `dlopen` binds functions, not data symbols, so
`kCFTypeDictionaryKeyCallBacks`/`kCFTypeDictionaryValueCallBacks` are resolved
with `dlsym(RTLD_DEFAULT, …)` through libSystem. The run-loop mode CFString is
created by value (`"kCFRunLoopDefaultMode"` — CFString comparison is by
contents) instead of binding the `kCFRunLoopDefaultMode` data symbol.
