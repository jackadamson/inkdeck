// --mock-exec (SPEC §11.3): intercepts exec() with canned results so agents
// and tests never spawn real subprocesses. The mock file maps command matchers
// (exact string or regex over the space-joined argv) to results; unmatched
// commands surface as an error event naming the command — a visible gap
// instead of a hang or a surprise real execution.

import type { Clock } from '../renderer/clock.js'
import type { ExecInterceptor, ExecResult } from '../renderer/exec.js'

export interface ExecMock {
  /** Matcher, compared against the space-joined argv. */
  match: string
  /** Treat `match` as a regular expression (default: exact string). */
  regex?: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  /** Delay before resolving, on the harness clock (frozen time honors this). */
  delayMs?: number
}

export interface MockExecConfig {
  mocks: ExecMock[]
}

/** Accepts the §11.3 file shape ({ mocks: [...] }) or a bare array. */
export function normalizeMockExecConfig(raw: unknown, source: string): MockExecConfig {
  const mocks = Array.isArray(raw) ? raw : (raw as { mocks?: unknown })?.mocks
  if (!Array.isArray(mocks)) {
    throw new Error(`[inkdeck] ${source}: expected { "mocks": [ { "match": …, … } ] } or a bare array`)
  }
  for (const [i, mock] of mocks.entries()) {
    if (typeof (mock as ExecMock).match !== 'string') {
      throw new Error(`[inkdeck] ${source}: mocks[${i}] is missing a string "match"`)
    }
  }
  return { mocks: mocks as ExecMock[] }
}

export async function loadMockExecFile(path: string): Promise<MockExecConfig> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`[inkdeck] --mock-exec file not found: ${path}`)
  }
  let raw: unknown
  try {
    raw = await file.json()
  } catch (error) {
    throw new Error(
      `[inkdeck] --mock-exec ${path} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    )
  }
  return normalizeMockExecConfig(raw, path)
}

export interface MockExecOptions {
  /** Delays run on this clock so --freeze-time controls them. */
  clock: Clock
  /** Called when no mock matches (the harness emits an error event). */
  onUnmatched?: (command: string) => void
}

/**
 * Build the exec() interceptor. Every command resolves from the mock table;
 * unmatched commands never reach a real Bun.spawn — they resolve with exit
 * code 127 and report the gap through onUnmatched.
 */
export function createMockExecInterceptor(config: MockExecConfig, options: MockExecOptions): ExecInterceptor {
  const compiled = config.mocks.map((mock) => ({
    mock,
    test: mock.regex
      ? (joined: string) => new RegExp(mock.match).test(joined)
      : (joined: string) => joined === mock.match,
  }))
  return (cmd: string[]): Promise<ExecResult> => {
    const joined = cmd.join(' ')
    const hit = compiled.find((c) => c.test(joined))
    if (!hit) {
      options.onUnmatched?.(joined)
      return Promise.resolve({
        stdout: '',
        stderr: `[inkdeck] --mock-exec: no mock matches command: ${joined}`,
        exitCode: 127,
      })
    }
    const result: ExecResult = {
      stdout: hit.mock.stdout ?? '',
      stderr: hit.mock.stderr ?? '',
      exitCode: hit.mock.exitCode ?? 0,
    }
    const delay = hit.mock.delayMs ?? 0
    if (delay <= 0) return Promise.resolve(result)
    return new Promise((resolve) => {
      options.clock.setTimeout(() => resolve(result), delay)
    })
  }
}
