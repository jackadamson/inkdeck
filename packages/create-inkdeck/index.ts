#!/usr/bin/env bun
// Scaffold (SPEC §12): `bun create @jackadamson/inkdeck <dir>` runs this bin;
// `inkdeck create <dir>` delegates here. Copies templates/ into the target,
// renaming *.tmpl (npm strips files named .gitignore/package.json from
// published template dirs, so those ship with a .tmpl suffix).

import { cp, mkdir, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TEMPLATES = join(import.meta.dir, 'templates')

export async function createProject(targetDir: string): Promise<void> {
  const target = resolve(targetDir)
  if (existsSync(target) && (await readdir(target)).length > 0) {
    throw new Error(`[inkdeck] ${target} exists and is not empty — pick a new directory`)
  }
  await mkdir(target, { recursive: true })
  await cp(TEMPLATES, target, { recursive: true })
  for (const entry of await readdir(target)) {
    if (entry.endsWith('.tmpl')) {
      const bare = entry.slice(0, -'.tmpl'.length)
      await rename(join(target, entry), join(target, bare === 'gitignore' ? '.gitignore' : bare))
    }
  }
  console.error(`[inkdeck] scaffolded ${target}`)
  console.error('')
  console.error('Next steps:')
  console.error(`  cd ${targetDir}`)
  console.error('  bun install')
  console.error('  bun run check          # typecheck + headless render')
  console.error('  bun test               # harness test with mocked osascript')
  console.error('  bun run dev            # hardware (or: bun run dev --simulate)')
  console.error('')
  console.error('Working with a coding agent? CLAUDE.md has the full agent workflow.')
}

if (import.meta.main) {
  const dir = Bun.argv[2]
  if (!dir) {
    console.error('Usage: bun create @jackadamson/inkdeck <dir>')
    process.exit(1)
  }
  createProject(dir).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
