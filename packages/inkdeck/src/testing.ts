// @jackadamson/inkdeck/testing (SPEC §11.4): the agent harness wrapped
// in-process for `bun test`.
//
//   import { renderDeck } from '@jackadamson/inkdeck/testing'
//   const deck = await renderDeck(<App/>, { model: 'mk2', freezeTime: true, mockExec })
//   expect(deck.key(0).text).toContain('LIVE')
//   await deck.tap(0)
//   await deck.settled()
//   expect(deck.key(0).text).toContain('MUTED')

import type { ComponentType, ReactNode } from 'react'
import { requireRenderableModel } from './device/models.js'
import { HarnessSession, toElement } from './harness/session.js'
import { normalizeMockExecConfig, type ExecMock, type MockExecConfig } from './harness/mockExec.js'
import type { Manifest, KeyManifest } from './harness/manifest.js'

export interface RenderDeckOptions {
  /** Model id (default: 'mk2'). */
  model?: string
  /** Start the injectable clock frozen; drive it with deck.advanceTime(ms). */
  freezeTime?: boolean
  /** Mock table for exec() — the mocks.json shape, or a bare mock array. */
  mockExec?: MockExecConfig | ExecMock[]
  /** Base directory for app-relative img/font paths. */
  assetDir?: string
}

export interface TestKey extends KeyManifest {
  pressed: boolean
}

export interface TestDeck {
  /** Structural snapshot of one key (§11.1 manifest entry + pressed state). */
  key(position: number): TestKey
  /** Full manifest, §11.1. */
  manifest(): Manifest
  press(position: number): void
  release(position: number): void
  /** Press + release; under freezeTime the clock advances through the tap. */
  tap(position: number, holdMs?: number): Promise<void>
  /** Advance the frozen clock (throws unless freezeTime: true). */
  advanceTime(ms: number): void
  /** Resolve once React + rasterization have gone idle. */
  settled(): Promise<void>
  /** Commands exec() ran that no mock matched (empty when unmocked). */
  readonly unmatchedExecs: string[]
  shutdown(): Promise<void>
}

export async function renderDeck(
  app: ReactNode | ComponentType,
  options: RenderDeckOptions = {},
): Promise<TestDeck> {
  const model = requireRenderableModel(options.model ?? 'mk2')
  const unmatchedExecs: string[] = []
  const session = await HarnessSession.start({
    model,
    element: toElement(app),
    freezeTime: options.freezeTime,
    mockExec: options.mockExec
      ? normalizeMockExecConfig(options.mockExec, 'renderDeck({ mockExec })')
      : undefined,
    onUnmatchedExec: (command) => unmatchedExecs.push(command),
    assetDir: options.assetDir,
  })

  return {
    key(position: number): TestKey {
      const manifest = session.manifest()
      const key = manifest.keys.find((k) => k.position === position)
      if (!key) {
        const mounted = manifest.keys.map((k) => k.position).join(', ') || '(none)'
        throw new Error(`[inkdeck] no <Key> is mounted at position ${position} (mounted: ${mounted})`)
      }
      return { ...key, pressed: session.controller.isPressed(position) }
    },
    manifest: () => session.manifest(),
    press: (position) => session.press(position),
    release: (position) => session.release(position),
    tap: (position, holdMs) => session.tap(position, holdMs),
    advanceTime: (ms) => session.advanceTime(ms),
    settled: () => session.settled(),
    unmatchedExecs,
    shutdown: () => session.shutdown(),
  }
}
