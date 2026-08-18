// Public hooks (SPEC §7.2).

import { useContext, useEffect, useSyncExternalStore } from 'react'
import { DeckContext } from './context.js'
import type { DeckController, DeckInfo } from './controller.js'

function useController(hook: string): DeckController {
  const controller = useContext(DeckContext)
  if (!controller) {
    throw new Error(`[inkdeck] ${hook} must be used inside an app rendered by inkdeck (under <Deck>)`)
  }
  return controller
}

/** Connected (or simulated) deck geometry. Null-safe in headless: serial is null. */
export function useDeckInfo(): DeckInfo {
  return useController('useDeckInfo').deckInfo
}

export function useBrightness(): [number, (n: number) => void] {
  const controller = useController('useBrightness')
  const value = useSyncExternalStore(
    (cb) => controller.subscribeBrightness(cb),
    () => controller.brightness,
  )
  return [value, (n: number) => controller.setBrightness(n)]
}

export function useKeyState(position: number): { pressed: boolean } {
  const controller = useController('useKeyState')
  const pressed = useSyncExternalStore(
    (cb) => controller.subscribePressed(cb),
    () => controller.isPressed(position),
  )
  return { pressed }
}

/** Interval built on the injectable clock (§11.3): fires immediately, then every ms. */
export function usePoller(fn: () => void | Promise<void>, ms: number): void {
  const controller = useController('usePoller')
  useEffect(() => {
    const run = (): void => {
      try {
        const result = controller.runInScope(fn)
        if (result && typeof result.then === 'function') {
          void result.catch((error) => {
            console.error(`[inkdeck] usePoller callback failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
          })
        }
      } catch (error) {
        console.error(`[inkdeck] usePoller callback failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
      }
    }
    run()
    const id = controller.clock.setInterval(run, ms)
    return () => controller.clock.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fn identity is intentionally not a dependency
  }, [controller, ms])
}
