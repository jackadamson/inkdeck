// Hardware transport selection and --device precedence (SPEC §8).

import type { DeviceInfo, Transport } from '../transport/iface.js'

/**
 * The hardware transport for this platform, or null with a reason when the
 * platform has none (v1 ships macOS only, SPEC §15).
 */
export async function hardwareTransport(): Promise<{ transport: Transport | null; reason?: string }> {
  if (process.platform === 'darwin') {
    const { IOKitTransport } = await import('../transport/iokit.js')
    return { transport: new IOKitTransport() }
  }
  return {
    transport: null,
    reason: `hardware transport is not available on ${process.platform} (v1 supports macOS only; Windows/Linux are post-MVP)`,
  }
}

export type DeviceSelection =
  | { kind: 'selected'; device: DeviceInfo }
  /** Nothing usable yet — a session-keeping caller waits, a one-shot caller errors. */
  | { kind: 'absent'; message: string }
  /** A choice only the user can make (several decks, none named). */
  | { kind: 'ambiguous'; message: string }

/**
 * Device selection precedence: --device flag > INKDECK_DEVICE env > sole
 * attached device > ambiguity listing candidates with serials.
 */
export function selectDevice(devices: DeviceInfo[], flagSerial?: string): DeviceSelection {
  const wanted = flagSerial ?? process.env.INKDECK_DEVICE
  const listing = devices.length ? devices.map((d) => `  ${d.serial} (${d.model})`).join('\n') : '  (none attached)'
  if (wanted) {
    const match = devices.find((d) => d.serial === wanted)
    if (match) return { kind: 'selected', device: match }
    return {
      kind: 'absent',
      message: `[inkdeck] no attached Stream Deck has serial "${wanted}". Attached devices:\n${listing}`,
    }
  }
  if (devices.length === 1) return { kind: 'selected', device: devices[0]! }
  if (devices.length === 0) {
    return { kind: 'absent', message: '[inkdeck] no Stream Deck attached. Connect one, or use --simulate.' }
  }
  return {
    kind: 'ambiguous',
    message: `[inkdeck] multiple Stream Decks attached — pick one with --device <serial> or INKDECK_DEVICE:\n${listing}`,
  }
}
