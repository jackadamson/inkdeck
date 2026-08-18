// react-reconciler host config (mutation mode) for react-reconciler 0.32 /
// React 19. Host elements mutate the HostTree; resetAfterCommit notifies the
// controller, which diffs per-key scenes.

import ReactReconciler from 'react-reconciler'
import { DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants.js'
import { createContext } from 'react'
import type { HostElement, HostNode, HostRoot, HostText } from './hostTree.js'
import { CONTENT_TYPES, DECK_TYPE, KEY_ERROR_TYPE, KEY_TYPE } from './hostTree.js'

type Props = Record<string, unknown>
type HostContext = 'root' | 'svg'

const VALID_TYPES = new Set([DECK_TYPE, KEY_TYPE, KEY_ERROR_TYPE, ...CONTENT_TYPES])

let currentUpdatePriority: number = NoEventPriority

const HostTransitionContext = createContext<null>(null)

/** Insert `child` before `before` (or append when null), moving it if already present. */
function insertChild(siblings: HostNode[], child: HostNode, before: HostNode | null): void {
  const existing = siblings.indexOf(child)
  if (existing !== -1) siblings.splice(existing, 1)
  const index = before ? siblings.indexOf(before) : -1
  siblings.splice(index === -1 ? siblings.length : index, 0, child)
}

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1 as const,

  createInstance(type: string, props: Props, _root: HostRoot, hostContext: HostContext): HostElement {
    // Anything goes inside an <svg> subtree — it is serialized to markup and
    // rasterized whole; outside svg only the supported subset is allowed.
    if (hostContext !== 'svg' && !VALID_TYPES.has(type)) {
      throw new Error(
        `[inkdeck] unsupported element <${type}>. Inside a <Key> use one of: div, span, p, img, svg (SPEC §7.1).`,
      )
    }
    return { kind: 'element', type, props, children: [], hidden: false }
  },

  createTextInstance(text: string): HostText {
    return { kind: 'text', text, hidden: false }
  },

  appendInitialChild(parent: HostElement, child: HostNode): void {
    parent.children.push(child)
  },

  finalizeInitialChildren(): boolean {
    return false
  },

  shouldSetTextContent(): boolean {
    return false
  },

  getRootHostContext(): HostContext {
    return 'root'
  },

  getChildHostContext(parentContext: HostContext, type: string): HostContext {
    return type === 'svg' || parentContext === 'svg' ? 'svg' : 'root'
  },

  getPublicInstance(instance: HostElement | HostText): HostElement | HostText {
    return instance
  },

  prepareForCommit(): null {
    return null
  },

  resetAfterCommit(container: HostRoot): void {
    container.onCommit?.()
  },

  preparePortalMount(): void {},

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,

  beforeActiveInstanceBlur(): void {},
  afterActiveInstanceBlur(): void {},
  prepareScopeUpdate(): void {},
  getInstanceFromScope(): null {
    return null
  },
  getInstanceFromNode(): null {
    return null
  },
  detachDeletedInstance(): void {},

  // Mutation methods.
  //
  // React *moves* keyed children by re-inserting them without a removeChild
  // first, so every insert must evict an existing occurrence of `child` or
  // the tree ends up holding the same node twice (duplicated manifest text,
  // spurious duplicate-position errors).
  appendChild(parent: HostElement, child: HostNode): void {
    insertChild(parent.children, child, null)
  },

  appendChildToContainer(container: HostRoot, child: HostNode): void {
    insertChild(container.children, child, null)
  },

  insertBefore(parent: HostElement, child: HostNode, before: HostNode): void {
    insertChild(parent.children, child, before)
  },

  insertInContainerBefore(container: HostRoot, child: HostNode, before: HostNode): void {
    insertChild(container.children, child, before)
  },

  removeChild(parent: HostElement, child: HostNode): void {
    const index = parent.children.indexOf(child)
    if (index !== -1) parent.children.splice(index, 1)
  },

  removeChildFromContainer(container: HostRoot, child: HostNode): void {
    const index = container.children.indexOf(child)
    if (index !== -1) container.children.splice(index, 1)
  },

  clearContainer(container: HostRoot): void {
    container.children.length = 0
  },

  resetTextContent(instance: HostElement): void {
    instance.children = instance.children.filter((c) => c.kind !== 'text')
  },

  commitTextUpdate(textInstance: HostText, _oldText: string, newText: string): void {
    textInstance.text = newText
  },

  commitMount(): void {},

  commitUpdate(instance: HostElement, _type: string, _prevProps: Props, nextProps: Props): void {
    instance.props = nextProps
  },

  hideInstance(instance: HostElement): void {
    instance.hidden = true
  },

  hideTextInstance(instance: HostText): void {
    instance.hidden = true
  },

  unhideInstance(instance: HostElement): void {
    instance.hidden = false
  },

  unhideTextInstance(instance: HostText): void {
    instance.hidden = false
  },

  // React 19 additions
  NotPendingTransition: null,
  // React's public Context type lacks the reconciler's internal fields; the
  // runtime object is the same thing.
  HostTransitionContext: HostTransitionContext as unknown as Parameters<typeof ReactReconciler>[0]['HostTransitionContext'],

  setCurrentUpdatePriority(newPriority: number): void {
    currentUpdatePriority = newPriority
  },
  getCurrentUpdatePriority(): number {
    return currentUpdatePriority
  },
  resolveUpdatePriority(): number {
    return currentUpdatePriority !== NoEventPriority ? currentUpdatePriority : DefaultEventPriority
  },

  resetFormInstance(): void {},
  requestPostPaintCallback(): void {},
  shouldAttemptEagerTransition(): boolean {
    return false
  },
  trackSchedulerEvent(): void {},
  resolveEventType(): null {
    return null
  },
  resolveEventTimeStamp(): number {
    return -1
  },
  maySuspendCommit(): boolean {
    return false
  },
  preloadInstance(): boolean {
    return true
  },
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  waitForCommitToBeReady(): null {
    return null
  },
}

export const reconciler = ReactReconciler(hostConfig)

/**
 * Force pending passive effects and sync-lane work to run now. Both exist
 * on the 0.32 runtime (flushPassiveEffects/flushSyncWork) but are missing
 * from the published types, hence the structural cast.
 */
export function flushReact(): void {
  const r = reconciler as unknown as { flushPassiveEffects?: () => boolean; flushSyncWork?: () => void }
  r.flushPassiveEffects?.()
  r.flushSyncWork?.()
}
