// `inkdeck list` — attached devices: model, serial (SPEC §9). Never throws
// when no device is attached.

import { hardwareTransport } from '../device/discovery.js'

export async function listCommand(): Promise<void> {
  const { transport, reason } = await hardwareTransport()
  if (!transport) {
    console.error(`[inkdeck] ${reason}`)
    console.log('No devices.')
    return
  }
  try {
    const devices = await transport.list()
    if (devices.length === 0) {
      console.log('No Stream Decks attached.')
      return
    }
    for (const device of devices) {
      console.log(`${device.serial}\t${device.model}\t(productId 0x${device.productId.toString(16).padStart(4, '0')})`)
    }
  } catch (error) {
    console.error(`[inkdeck] list failed: ${error instanceof Error ? error.message : error}`)
    console.log('No devices.')
  }
}
