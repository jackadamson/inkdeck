// Public hooks (SPEC §7.2).

import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { DeckContext } from './context.js'
import type { DeckController, DeckInfo } from './controller.js'

function useController(hook: string): DeckController {
  const controller = useContext(DeckContext)
  if (!controller) {
    throw new Error(`[inkdeck] ${hook} must be used inside an app rendered by inkdeck (under <Deck>)`)
  }
  return controller
}

/**
 * Connected (or simulated) deck geometry plus grid helpers. The object is
 * stable for the life of the session (safe as an effect dependency); serial
 * is null in headless. `coordsOf`/`positionOf` convert between row-major key
 * positions and (row, col) so grid apps stop hand-rolling `position % columns`.
 */
export function useDeckInfo(): DeckInfo {
  return useController('useDeckInfo').deckInfo
}

/** [brightness, setBrightness]; the setter identity is stable. */
export function useBrightness(): [number, (percent: number) => void] {
  const controller = useController('useBrightness')
  const value = useSyncExternalStore(
    (cb) => controller.subscribeBrightness(cb),
    () => controller.brightness,
  )
  const set = useCallback((percent: number) => controller.setBrightness(percent), [controller])
  return [value, set]
}

export function useKeyState(position: number): { pressed: boolean } {
  const controller = useController('useKeyState')
  const pressed = useSyncExternalStore(
    (cb) => controller.subscribePressed(cb),
    () => controller.isPressed(position),
  )
  return { pressed }
}

export interface Poller {
  /** Run the poller now (e.g. right after acting, instead of waiting for the next tick). */
  refresh: () => void
}

/**
 * Interval built on the injectable clock (§11.3): fires immediately, then
 * every ms. Always calls the *latest* callback (props/state read inside it
 * are current, not mount-time values). Returns { refresh } for on-demand runs.
 */
export function usePoller(fn: () => unknown, ms: number): Poller {
  const controller = useController('usePoller')
  const latest = useRef(fn)
  latest.current = fn
  const run = useCallback((): void => {
    const report = (error: unknown): void => {
      controller.logger.error(`[inkdeck] usePoller callback failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
    }
    try {
      const result = controller.runInScope(() => latest.current())
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).catch(report)
      }
    } catch (error) {
      report(error)
    }
  }, [controller])
  useEffect(() => {
    run()
    const id = controller.clock.setInterval(run, ms)
    return () => controller.clock.clearInterval(id)
  }, [controller, ms, run])
  return useMemo(() => ({ refresh: run }), [run])
}
