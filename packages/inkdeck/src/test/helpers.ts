// Shared test plumbing: repo paths and a one-call virtual mount.

import { join } from 'node:path'
import type { ReactNode } from 'react'
import { modelById, type Model } from '../device/models.js'
import type { Clock } from '../renderer/clock.js'
import { DeckController } from '../renderer/controller.js'
import type { Logger } from '../renderer/logger.js'
import { openVirtualDeck, type VirtualHandle } from '../transport/virtual.js'

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
export const EXAMPLES_DIR = join(REPO_ROOT, 'examples')
export const CLI = join(import.meta.dir, '..', 'cli', 'index.ts')
export const MIC_MUTE_APP = join(EXAMPLES_DIR, 'mic-mute', 'app.tsx')
export const MIC_MUTE_MOCKS = join(EXAMPLES_DIR, 'mic-mute', 'mocks.json')

export const mk2: Model = modelById('mk2')!

export interface MountOptions {
  model?: Model
  clock?: Clock
  logger?: Logger
  assetDir?: string
}

/** Controller on a virtual deck, started, rendered and settled. */
export async function mountVirtual(
  element: ReactNode,
  options: MountOptions = {},
): Promise<{ controller: DeckController; handle: VirtualHandle }> {
  const model = options.model ?? mk2
  const { handle, serial } = await openVirtualDeck(model)
  const controller = new DeckController({
    model,
    handle,
    serial,
    clock: options.clock,
    logger: options.logger,
    assetDir: options.assetDir,
  })
  await controller.start()
  controller.render(element)
  await controller.settled()
  return { controller, handle }
}
