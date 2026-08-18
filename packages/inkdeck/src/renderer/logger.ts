// Framework diagnostics go through an injected Logger instead of a bare
// console.error, so the agent can turn them into `log` events and tests can
// capture them without monkey-patching a process global.

export interface Logger {
  /** One diagnostic line (already prefixed with `[inkdeck]`). */
  error(line: string): void
}

export const stderrLogger: Logger = {
  error(line: string): void {
    console.error(line)
  },
}

/** stack if available, else message, else String(). */
export function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
