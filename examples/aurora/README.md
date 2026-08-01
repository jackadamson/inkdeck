# aurora

A purely decorative example: the whole deck becomes one continuous plasma
field. Every key samples a shared 2D interference field at its corners and
blends them with radial gradients, and the geometry includes the bezel gaps —
so color (and light ripples) flow seamlessly across the physical device.

- **Press any key** — a ripple of light expands from it across the deck.
- **Hold a key** — it glows white while pressed.
- **Long-press** — cycles the palette: aurora → ember → abyss → candy.

All motion runs on the injectable clock (`usePoller`), so the animation is
fully deterministic: `--freeze-time` pins it, `advanceTime` steps it, and two
identical sessions produce byte-identical frames (see `app.test.tsx`).

```sh
bun run check    # typecheck + headless render
bun run render   # PNGs + manifest into ./frames
bun test         # harness test: animation, ripples, palettes, determinism
inkdeck start app.tsx   # on a real deck (quit the Elgato app first)
```
