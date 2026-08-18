#!/usr/bin/env bun
// inkdeck CLI (SPEC §9). Arg parsing via util.parseArgs — no CLI helper deps (§2).

import { parseArgs as nodeParseArgs } from 'node:util'

const USAGE = `Usage:
  inkdeck render <app.tsx> --out DIR [--model M]   headless one-shot: PNGs + manifest.json
  inkdeck check <app.tsx>                          typecheck + one headless render; exit 0/1
  inkdeck list                                     attached devices: model, serial
  inkdeck dev <app.tsx> [--device S] [--simulate [--model M]]    watch + reload on save
  inkdeck start <app.tsx> [--device S] [--simulate [--model M]]  run once, no watch
  inkdeck agent <app.tsx> [--model M] [--freeze-time] [--mock-exec F]
                                                   JSON-lines harness (SPEC §11.2)
  inkdeck create <dir>                             scaffold a new app
`

/** A bad invocation: printed as one line + usage, no stack trace. */
class UsageError extends Error {}

/** util.parseArgs in strict mode; unknown flags/missing values become UsageErrors. */
const parseArgs: typeof nodeParseArgs = (config) => {
  try {
    return nodeParseArgs(config)
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (code.startsWith('ERR_PARSE_ARGS')) throw new UsageError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

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
    case 'start': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          device: { type: 'string' },
          debug: { type: 'boolean' },
          simulate: { type: 'boolean' },
          model: { type: 'string' }, // simulator model override (§8: --simulate --model xl)
        },
        allowPositionals: true,
      })
      const app = positionals[0]
      if (!app) {
        console.error(`[inkdeck] ${command} requires <app.tsx>`)
        console.error(USAGE)
        return 1
      }
      if (values.simulate) {
        const { simulateCommand } = await import('./simulate.js')
        return await simulateCommand(app, { model: values.model, watch: command === 'dev' })
      }
      const { startCommand } = await import('./start.js')
      return await startCommand(app, {
        device: values.device,
        debug: values.debug,
        watch: command === 'dev',
      })
    }

    case 'agent': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          model: { type: 'string' },
          'freeze-time': { type: 'boolean' },
          'mock-exec': { type: 'string' },
        },
        allowPositionals: true,
      })
      const app = positionals[0]
      if (!app) {
        console.error('[inkdeck] agent requires <app.tsx>')
        console.error(USAGE)
        return 1
      }
      const { agentCommand } = await import('./agent.js')
      return await agentCommand(app, {
        model: values.model,
        freezeTime: values['freeze-time'],
        mockExec: values['mock-exec'],
      })
    }

    case 'create': {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true })
      const dir = positionals[0]
      if (!dir) {
        console.error('[inkdeck] create requires <dir>')
        return 1
      }
      // The scaffold lives in @jackadamson/create-inkdeck (§2 keeps it out of
      // this package's dependency tree). Try the installed package; in the
      // monorepo (development only) fall back to the workspace sibling;
      // otherwise point at bun create.
      const sibling = new URL('../../../create-inkdeck/index.ts', import.meta.url)
      const candidates = ['@jackadamson/create-inkdeck']
      if (await Bun.file(sibling).exists()) candidates.push(sibling.href)
      for (const specifier of candidates) {
        let mod: { createProject: (dir: string) => Promise<void> }
        try {
          mod = await import(specifier)
        } catch {
          continue
        }
        await mod.createProject(dir)
        return 0
      }
      console.error(`[inkdeck] the scaffold package is not installed — run: bun create @jackadamson/inkdeck ${dir}`)
      return 1
    }

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
    if (error instanceof UsageError) {
      console.error(`[inkdeck] ${error.message}`)
      console.error(USAGE)
    } else {
      console.error(`[inkdeck] ${error instanceof Error ? (error.stack ?? error.message) : error}`)
    }
    process.exit(1)
  },
)
