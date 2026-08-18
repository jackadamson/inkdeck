// `inkdeck check <app.tsx>` — typecheck + one headless render; exit 0/1 (SPEC §9).
//
// Typechecking uses the TypeScript compiler resolved from the app's project
// (or inkdeck's own devDependency). typescript is deliberately NOT a runtime
// dependency of the published package (§2's approved list) — see DECISIONS.md.

import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { bootDeck } from '../session.js'
import { loadApp, resolveHeadlessModel } from './loadApp.js'

type Ts = typeof import('typescript')

async function loadTypescript(appDir: string): Promise<Ts | null> {
  // typescript is a CJS package; load it with require() semantics. Dynamic
  // import() of the CJS bundle can yield a namespace missing dynamically
  // assigned members (ts.sys is undefined on some Bun/resolution combinations).
  // Prefer the app project's own typescript so its version wins.
  const requirers = [
    () => createRequire(join(appDir, 'package.json'))('typescript'),
    () => createRequire(import.meta.url)('typescript'),
  ]
  for (const load of requirers) {
    try {
      const mod = load()
      const ts = (mod?.default ?? mod) as Ts
      if (ts?.sys) return ts
    } catch {
      // try next
    }
  }
  return null
}

function findTsconfig(ts: Ts, appDir: string): string | undefined {
  return ts.findConfigFile(appDir, ts.sys.fileExists, 'tsconfig.json')
}

export async function checkCommand(appPath: string): Promise<number> {
  const resolved = resolve(appPath)
  const appDir = existsSync(resolved) ? dirname(resolved) : process.cwd()

  // 1. Typecheck
  const ts = await loadTypescript(appDir)
  if (!ts) {
    console.error(
      "[inkdeck] check: could not resolve the `typescript` package. Add it to your app's devDependencies (`bun add -d typescript`) to enable typechecking.",
    )
    return 1
  }
  const configPath = findTsconfig(ts, appDir)
  let compilerOptions: import('typescript').CompilerOptions = {
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    types: ['bun'],
  }
  if (configPath) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      { noEmit: true },
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          console.error(
            `[inkdeck] check: failed to parse ${configPath}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
          )
        },
      },
    )
    if (parsed) compilerOptions = { ...parsed.options, noEmit: true }
  }
  const program = ts.createProgram([appPath], compilerOptions)
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getOptionsDiagnostics(),
  ]
  if (diagnostics.length > 0) {
    const host = {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (f: string) => f,
      getNewLine: () => '\n',
    }
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
    console.error(`[inkdeck] check: ${diagnostics.length} type error(s) in ${appPath}`)
    return 1
  }

  // 2. One headless render
  try {
    const app = await loadApp(appPath)
    const model = resolveHeadlessModel(app)
    const { controller } = await bootDeck({
      element: createElement(app.App),
      target: { kind: 'virtual', model },
      assetDir: app.appDir,
      fonts: app.config.fonts,
    })
    const errored = controller.keySnapshots().filter((s) => s.error)
    await controller.shutdown()
    if (errored.length > 0) {
      for (const snapshot of errored) {
        console.error(`[inkdeck] check: key ${snapshot.position} rendered its error tile: ${snapshot.error}`)
      }
      return 1
    }
  } catch (error) {
    console.error(
      `[inkdeck] check: headless render failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
    )
    return 1
  }

  console.error(`[inkdeck] check: ${appPath} OK`)
  return 0
}
