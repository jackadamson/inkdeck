#!/usr/bin/env bun
// inkdeck CLI (SPEC §9). Arg parsing via util.parseArgs — no CLI helper deps (§2).

import { parseArgs } from 'node:util'

const USAGE = `Usage:
  inkdeck render <app.tsx> --out DIR [--model M]   headless one-shot: PNGs + manifest.json
  inkdeck check <app.tsx>                          typecheck + one headless render; exit 0/1
  inkdeck list                                     attached devices: model, serial
  inkdeck dev <app.tsx> [--device S]               watch + hot reload         (M2/M4)
  inkdeck start <app.tsx> [--device S]             run once, no watch         (M2)
  inkdeck agent <app.tsx> [--model M] [...]        JSON-lines harness         (M3)
`

async function main(): Promise<number> {
  const [command, ...rest] = Bun.argv.slice(2)

  switch (command) {
    case 'render': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          out: { type: 'string' },
          model: { type: 'string' },
        },
        allowPositionals: true,
      })
      const app = positionals[0]
      if (!app || !values.out) {
        console.error('[inkdeck] render requires <app.tsx> and --out DIR')
        console.error(USAGE)
        return 1
      }
      const { renderCommand } = await import('./render.js')
      await renderCommand(app, values.out, values.model)
      return 0
    }

    case 'check': {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true })
      const app = positionals[0]
      if (!app) {
        console.error('[inkdeck] check requires <app.tsx>')
        return 1
      }
      const { checkCommand } = await import('./check.js')
      return await checkCommand(app)
    }

    case 'list': {
      const { listCommand } = await import('./list.js')
      await listCommand()
      return 0
    }

    case 'dev':
    case 'start':
    case 'agent':
    case 'create':
      console.error(`[inkdeck] "${command}" is not implemented yet — it lands in a later milestone (see ROADMAP.md).`)
      return 1

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return command === undefined ? 1 : 0

    default:
      console.error(`[inkdeck] unknown command "${command}"`)
      console.error(USAGE)
      return 1
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[inkdeck] ${error instanceof Error ? (error.stack ?? error.message) : error}`)
    process.exit(1)
  },
)
