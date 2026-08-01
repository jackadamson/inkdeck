// CLI acceptance (SPEC §13 M1): render writes PNGs + manifest; check exits 0
// on the example and 1 on a type error; list never throws with no device.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const CLI = join(import.meta.dir, 'index.ts')
const EXAMPLE = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'mic-mute', 'app.tsx')

async function runCli(args: string[], cwd?: string) {
  const proc = Bun.spawn(['bun', CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('inkdeck CLI', () => {
  test('render writes PNGs + a §11.1 manifest for the reference example', async () => {
    const out = mkdtempSync(join(tmpdir(), 'inkdeck-render-'))
    const result = await runCli(['render', EXAMPLE, '--out', out, '--model', 'mk2'])
    expect(result.exitCode).toBe(0)

    const manifest = await Bun.file(join(out, 'manifest.json')).json()
    expect(manifest.model).toBe('mk2')
    expect(manifest.columns).toBe(5)
    expect(manifest.rows).toBe(3)
    expect(manifest.keys.length).toBe(1)
    const key0 = manifest.keys[0]
    expect(key0.position).toBe(0)
    expect(key0.image).toBe('key-0.png')
    expect(typeof key0.hash).toBe('string')
    expect(key0.text).toContain('mic')
    expect(key0.error).toBeNull()
    expect(key0.hasPress).toBe(true)
    expect(key0.hasLongPress).toBe(false)

    const meta = await sharp(join(out, 'key-0.png')).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(72)
    expect(meta.height).toBe(72)
  }, 30000)

  test('check exits 0 on the reference example', async () => {
    const result = await runCli(['check', 'app.tsx'], join(EXAMPLE, '..'))
    expect(result.stderr).toContain('OK')
    expect(result.exitCode).toBe(0)
  }, 60000)

  test('check exits 1 on a file with a type error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkdeck-badapp-'))
    const bad = join(dir, 'app.tsx')
    writeFileSync(
      bad,
      [
        'export default function App() {',
        "  const wrong: number = 'not a number'",
        '  return null',
        '}',
        '',
      ].join('\n'),
    )
    const result = await runCli(['check', bad])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('TS2322')
  }, 60000)

  test('check exits 1 when a key renders its error tile', async () => {
    const fixture = join(import.meta.dir, '..', '..', '..', 'test-fixtures', 'throws-at-render.tsx')
    const result = await runCli(['check', 'throws-at-render.tsx'], join(fixture, '..'))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('error tile')
    expect(result.stderr).toContain('kaboom')
  }, 60000)

  test('list runs without throwing when no device is attached', async () => {
    const result = await runCli(['list'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toLowerCase()).toContain('no')
  })

  test('unknown command exits 1 with usage', async () => {
    const result = await runCli(['frobnicate'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unknown command')
  })
})
