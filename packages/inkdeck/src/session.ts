// The one way to boot a deck (hardware or virtual): build the raster engine
// with fonts loaded, construct the controller, handshake, render, settle.
// `start`/`dev`, `render`/`check`, the agent, the simulator and the testing
// helper all go through bootDeck.

import type { ReactNode } from 'react'
import type { Model } from './device/models.js'
import { RasterEngine } from './raster/takumi.js'
import type { Clock } from './renderer/clock.js'
import { DeckController } from './renderer/controller.js'
import type { ExecInterceptor } from './renderer/exec.js'
import type { Logger } from './renderer/logger.js'
import type { TransportHandle } from './transport/iface.js'
import { openVirtualDeck, type VirtualHandle } from './transport/virtual.js'

export type BootTarget =
  | { kind: 'hardware'; handle: TransportHandle; model: Model; serial: string }
  | { kind: 'virtual'; model: Model }

export interface BootOptions {
  element: ReactNode
  target: BootTarget
  clock?: Clock
  execInterceptor?: ExecInterceptor | null
  logger?: Logger
  debug?: boolean
  /** Base directory for app-relative img/font paths. */
  assetDir?: string
  /** Extra font files (relative to assetDir). */
  fonts?: string[]
}

export interface DeckSession {
  controller: DeckController
  /** The transport handle in use (a VirtualHandle for virtual targets). */
  handle: TransportHandle
  /** Set for virtual targets: press/release keys, inspect pushed images. */
  virtual: VirtualHandle | null
}

/**
 * Boot: fonts → controller → reset/brightness → first render → settled.
 * On failure the controller is shut down before the error propagates.
 */
export async function bootDeck(options: BootOptions): Promise<DeckSession> {
  const raster = new RasterEngine(options.assetDir)
  if (options.fonts?.length && options.assetDir) {
    await raster.loadAppFonts(options.fonts, options.assetDir)
  }
  let handle: TransportHandle
  let virtual: VirtualHandle | null = null
  let serial: string
  if (options.target.kind === 'virtual') {
    const opened = await openVirtualDeck(options.target.model)
    handle = opened.handle
    virtual = opened.handle
    serial = opened.serial
  } else {
    handle = options.target.handle
    serial = options.target.serial
  }
  const controller = new DeckController({
    model: options.target.model,
    handle,
    serial,
    clock: options.clock,
    raster,
    logger: options.logger,
    debug: options.debug,
    execInterceptor: options.execInterceptor,
  })
  try {
    await controller.start()
    controller.render(options.element)
    await controller.settled()
  } catch (error) {
    await controller.shutdown().catch(() => {})
    throw error
  }
  return { controller, handle, virtual }
}
