// The subprocess boundary (SPEC §7.3). A thin wrapper over Bun.spawn that
// exists only so the agent harness / testing helper can intercept it
// (--mock-exec, §11.3).
//
// Interception is *session-scoped*: each DeckController runs app code
// (render, handlers, pollers) inside an AsyncLocalStorage scope carrying that
// session's interceptor, so two live sessions in one process never see each
// other's mocks and shutting one down cannot strip the other's.
//
// React's scheduler drains every root from one shared task loop, so effects
// can run outside the AsyncLocalStorage context of the session that owns them.
// exec() therefore resolves its scope as: the async-local scope if present;
// otherwise the only live session's scope when exactly one is live; otherwise
// (ambiguous) it refuses to spawn while any mocked session is live. A mocked
// session can never fall through to a real Bun.spawn.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecInterceptor = (cmd: string[]) => Promise<ExecResult> | ExecResult | null

export interface ExecScope {
  /** null ⇒ real subprocesses. */
  interceptor: ExecInterceptor | null
}

const asyncScope = new AsyncLocalStorage<ExecScope>()
const liveScopes = new Set<ExecScope>()

/** Run `fn` with `scope` as the exec context (propagates through awaits and timers). */
export function runInExecScope<T>(scope: ExecScope | null, fn: () => T): T {
  return scope ? asyncScope.run(scope, fn) : fn()
}

/** Register a session's scope as live; returns the release function. */
export function registerExecScope(scope: ExecScope): () => void {
  liveScopes.add(scope)
  return () => {
    liveScopes.delete(scope)
  }
}

function resolveScope(): ExecScope | null | 'ambiguous' {
  const local = asyncScope.getStore()
  if (local) return local
  if (liveScopes.size === 0) return null
  if (liveScopes.size === 1) return liveScopes.values().next().value ?? null
  return 'ambiguous'
}

export async function exec(cmd: string[]): Promise<ExecResult> {
  if (cmd.length === 0) throw new Error('[inkdeck] exec requires a non-empty command array')
  const scope = resolveScope()
  if (scope === 'ambiguous') {
    if ([...liveScopes].some((s) => s.interceptor)) {
      const message = `[inkdeck] exec() could not be attributed to one deck session while --mock-exec is active; refusing to spawn: ${cmd.join(' ')}`
      console.error(message)
      return { stdout: '', stderr: message, exitCode: 127 }
    }
  } else if (scope?.interceptor) {
    const mocked = await scope.interceptor(cmd)
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
