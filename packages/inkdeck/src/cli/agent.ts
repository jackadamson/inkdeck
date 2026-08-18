// `inkdeck agent <app.tsx> [--model M] [--freeze-time] [--mock-exec F]`
// JSON-lines protocol over stdio (SPEC §11.2). One JSON object per line:
// commands on stdin, events on stdout, framework logs mirrored as log events.
//
// Guarantees (§11.2): every command is acknowledged by at least one event
// (rendered when it changed pixels, state otherwise, frames for writeFrames,
// exit for exit); rendered fires only when key content actually changed;
// malformed input yields an error event, never a crash; EOF exits cleanly.

import { HarnessSession } from '../harness/session.js'
import { loadMockExecFile } from '../harness/mockExec.js'
import { loadApp, resolveHeadlessModel } from './loadApp.js'
import type { Logger } from '../renderer/logger.js'
import { createElement } from 'react'

interface AgentFlags {
  model?: string
  freezeTime?: boolean
  mockExec?: string
}

/** Optional client-supplied correlation id, echoed on the command's events. */
type CommandId = { id?: string | number }

type Command = CommandId &
  (
    | { cmd: 'press' | 'release'; position: number }
    | { cmd: 'tap'; position: number; holdMs?: number }
    | { cmd: 'snapshot' }
    | { cmd: 'advanceTime'; ms: number }
    | { cmd: 'writeFrames'; dir: string }
    | { cmd: 'exit' }
  )

export async function agentCommand(appPath: string, flags: AgentFlags): Promise<number> {
  const emit = (event: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }

  // Framework diagnostics become log events so agents see them in-band; the
  // real stderr still gets a copy for humans running the harness by hand.
  const logger: Logger = {
    error(line: string): void {
      emit({ event: 'log', stream: 'stderr', line })
      console.error(line)
    },
  }

  const app = await loadApp(appPath)
  const model = resolveHeadlessModel(app, flags.model)
  const mockExec = flags.mockExec ? await loadMockExecFile(flags.mockExec) : undefined

  const session = await HarnessSession.start({
    model,
    element: createElement(app.App),
    freezeTime: flags.freezeTime,
    mockExec,
    onUnmatchedExec: (command) => {
      emit({ event: 'error', scope: 'exec', message: `no mock matches command: ${command}` })
    },
    assetDir: app.appDir,
    fonts: app.config.fonts,
    logger,
  })

  // The command being processed, so notifications emitted meanwhile can be
  // correlated by clients (unsolicited poller renders interleave otherwise).
  let inFlight: CommandId = {}
  const tagged = (event: Record<string, unknown>): Record<string, unknown> =>
    inFlight.id === undefined ? event : { ...event, id: inFlight.id }
  session.controller.onRendered((changed) => {
    emit(tagged({ event: 'rendered', changed, manifest: session.manifest() }))
  })
  session.controller.onHandlerError((position, handler, error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    emit({ event: 'error', scope: handler === 'onLongPress' ? 'longPress' : 'press', position, message })
    console.error(`[inkdeck] [key ${position}] ${handler} failed: ${message}`)
  })

  emit({ event: 'ready', manifest: session.manifest() })

  const shutdown = async (code: number): Promise<never> => {
    await session.shutdown()
    process.exit(code)
  }
  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  const requireNumber = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`"${field}" must be a finite number`)
    }
    return value
  }

  // Every command ends with exactly one terminal ack carrying its id:
  // state / frames / exit, or error. `rendered` events are notifications.
  const handle = async (command: Command): Promise<void> => {
    switch (command.cmd) {
      case 'press':
        session.press(requireNumber(command.position, 'position'))
        break
      case 'release':
        session.release(requireNumber(command.position, 'position'))
        break
      case 'tap':
        await session.tap(
          requireNumber(command.position, 'position'),
          command.holdMs === undefined ? undefined : requireNumber(command.holdMs, 'holdMs'),
        )
        break
      case 'snapshot':
        break
      case 'advanceTime':
        session.advanceTime(requireNumber(command.ms, 'ms'))
        break
      case 'writeFrames': {
        if (typeof command.dir !== 'string' || command.dir.length === 0) {
          throw new Error('"dir" must be a non-empty string')
        }
        await session.settled()
        const manifest = await session.writeFrames(command.dir)
        emit(tagged({ event: 'frames', dir: command.dir, keys: manifest.keys.length }))
        return
      }
      case 'exit':
        emit(tagged({ event: 'exit' }))
        await shutdown(0)
        return
      default:
        throw new Error(`unknown cmd "${(command as { cmd?: unknown }).cmd}"`)
    }
    // press/release/tap/advanceTime/snapshot: let the effects drain (any
    // rendered notifications go out first), then ack with the manifest.
    await session.settled()
    emit(tagged({ event: 'state', manifest: session.manifest() }))
  }

  // Commands run strictly sequentially: the next stdin line is not processed
  // until the previous command's effects have drained and been acknowledged.
  for await (const line of console) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: Command
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      emit({ event: 'error', scope: 'protocol', message: `malformed JSON line: ${trimmed.slice(0, 200)}` })
      continue
    }
    inFlight = parsed && typeof parsed === 'object' && parsed.id !== undefined ? { id: parsed.id } : {}
    try {
      await handle(parsed)
    } catch (error) {
      emit(
        tagged({
          event: 'error',
          scope: 'protocol',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      inFlight = {}
    }
  }

  // EOF on stdin ⇒ clean exit (§11.2).
  await shutdown(0)
  return 0
}
