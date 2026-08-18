// Long-running commands (start/dev, simulate, agent) hand the process
// lifecycle back to cli/index.ts: they return a RunningCommand instead of
// installing signal handlers and calling process.exit themselves, so they can
// also be driven in-process by tests.

export interface RunningCommand {
  /** Resolves with the exit code when the command ends (on its own or via shutdown()). */
  done: Promise<number>
  /** Stop cleanly (idempotent). Resolves once cleanup has finished. */
  shutdown(): Promise<void>
}

/**
 * Build a RunningCommand around a cleanup routine. `finish(code)` ends the
 * command from inside (EOF, fatal error); `shutdown()` ends it from outside
 * (signal, test). Cleanup runs exactly once either way.
 */
export function longRunning(cleanup: () => Promise<void>): {
  running: RunningCommand
  finish: (code: number) => Promise<void>
} {
  let resolveDone: (code: number) => void = () => {}
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve
  })
  let ending: Promise<void> | null = null
  const end = (code: number): Promise<void> => {
    if (!ending) {
      ending = cleanup()
        .catch(() => {})
        .then(() => resolveDone(code))
    }
    return ending
  }
  return {
    running: { done, shutdown: () => end(0) },
    finish: end,
  }
}
