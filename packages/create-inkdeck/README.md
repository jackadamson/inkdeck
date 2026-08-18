# create-inkdeck

Scaffold a new [inkdeck](https://github.com/jackadamson/inkdeck) app — React on an Elgato
Stream Deck. Requires [Bun](https://bun.sh) ≥ 1.3.11.

```sh
bun create @jackadamson/inkdeck my-deck
cd my-deck && bun install
bun run dev --simulate   # browser simulator, no hardware
bun run dev              # on the attached deck, hot reload on save
```

You get a working mic-mute app (`app.tsx`), a `bun test` harness test with mocked subprocesses
(`app.test.tsx`, `mocks.json`), `tsconfig.json`, `.gitignore`, a README, and a `CLAUDE.md` that
teaches coding agents the headless feedback loop (`inkdeck check` / `render` / `agent`).

For the component and hook API, CLI reference and limitations see the
[`@jackadamson/inkdeck` README](https://github.com/jackadamson/inkdeck/tree/main/packages/inkdeck#readme).
MIT.
