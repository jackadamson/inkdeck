// The subprocess boundary (SPEC §7.3). A thin wrapper over Bun.spawn that
// exists only so the agent harness can intercept it (--mock-exec, §11.3).

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecInterceptor = (cmd: string[]) => Promise<ExecResult> | ExecResult | null

let interceptor: ExecInterceptor | null = null

/** Install a mock layer (used by `inkdeck agent --mock-exec`). Pass null to remove. */
export function setExecInterceptor(fn: ExecInterceptor | null): void {
  interceptor = fn
}

export async function exec(cmd: string[]): Promise<ExecResult> {
  if (cmd.length === 0) throw new Error('[inkdeck] exec requires a non-empty command array')
  if (interceptor) {
    const mocked = await interceptor(cmd)
    if (mocked) return mocked
  }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    // Missing executable etc. — shell semantics (127) instead of a throw, so
    // pollers degrade gracefully on machines without the tool.
    return { stdout: '', stderr: String(error instanceof Error ? error.message : error), exitCode: 127 }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}
