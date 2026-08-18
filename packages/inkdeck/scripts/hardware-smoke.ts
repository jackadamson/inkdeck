// Hardware smoke test (M2): exercises every TransportHandle operation against
// a real, attached Stream Deck. Run with:
//
//   bun packages/inkdeck/scripts/hardware-smoke.ts [--hold-seconds N]
//
// Verifies programmatically: list, open, getFeature (serial + firmware
// version), brightness sweep, framed image packets to the first row of keys,
// input reports (press keys while it waits), reset, close. Items a human must
// eyeball (images actually visible, colors right) live in
// examples/mic-mute/HARDWARE.md.

import { parseArgs } from 'node:util'
import { RasterEngine } from '../src/raster/takumi.js'
import { IOKitTransport } from '../src/transport/iokit.js'
import { requireRenderableModel } from '../src/device/models.js'
import { encodeBrightness, encodeKeyImagePackets, encodeReset, parseInputReport } from '../src/device/protocol.js'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { 'hold-seconds': { type: 'string' } },
})
const HOLD_SECONDS = Number(values['hold-seconds'] ?? 8)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function step(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Feature report ids/offsets: node-elgato-stream-deck
// packages/core/src/services/properties/gen2.ts — firmware version is feature
// report 0x05 (string from byte 6), serial number feature report 0x06 (string
// from byte 2), both 32 bytes.
function featureString(report: Uint8Array, offset: number): string {
  const bytes = report.subarray(offset)
  const nul = bytes.indexOf(0)
  return new TextDecoder().decode(bytes.subarray(0, nul === -1 ? bytes.length : nul))
}

const transport = new IOKitTransport()
const devices = await transport.list()
step('list() finds a Stream Deck', devices.length > 0, devices.map((d) => `${d.serial} (${d.model})`).join(', '))
if (devices.length === 0) process.exit(1)

const info = devices[0]
const model = requireRenderableModel(info.model)
const handle = await transport.open(info.path)
step('open() succeeds', true, info.path)

let exiting = false
async function cleanup(code: number) {
  if (exiting) return
  exiting = true
  try {
    await handle.sendFeature(encodeReset())
    await handle.close()
  } catch {
    // best-effort on the way out
  }
  process.exit(code)
}
process.on('SIGINT', () => void cleanup(130))

try {
  // getFeature: serial should match what IOKit's device property reported.
  const serialReport = await handle.getFeature(0x06, 32)
  const serial = featureString(serialReport, 2)
  step(
    'getFeature(0x06) serial matches IOKit property',
    serial === info.serial,
    `feature="${serial}" iokit="${info.serial}"`,
  )

  const fwReport = await handle.getFeature(0x05, 32)
  const firmware = featureString(fwReport, 6)
  step('getFeature(0x05) firmware version reads', /^[\w.]+$/.test(firmware) && firmware.length >= 3, firmware)

  // Brightness sweep (visible as a dim→bright ramp).
  for (const pct of [10, 40, 70, 100]) {
    await handle.sendFeature(encodeBrightness(pct))
    await sleep(120)
  }
  step('sendFeature(brightness) sweep 10→100', true)

  // Push a distinct solid-color tile to each key of the first row.
  const colors = [
    { r: 220, g: 50, b: 47 },
    { r: 133, g: 153, b: 0 },
    { r: 38, g: 139, b: 210 },
    { r: 181, g: 137, b: 0 },
    { r: 211, g: 54, b: 130 },
    { r: 42, g: 161, b: 152 },
    { r: 203, g: 75, b: 22 },
    { r: 108, g: 113, b: 196 },
  ]
  let packetsSent = 0
  const raster = new RasterEngine()
  for (let key = 0; key < Math.min(model.columns, colors.length); key++) {
    const { r, g, b } = colors[key]!
    const rgba = await raster.renderScene(
      {
        kind: 'element',
        tag: 'div',
        className: 'h-full w-full',
        style: { backgroundColor: `rgb(${r}, ${g}, ${b})` },
        children: [],
      },
      model,
    )
    const jpeg = await raster.rgbaToJpeg(rgba, model)
    for (const packet of encodeKeyImagePackets(model, key, jpeg)) {
      await handle.writeOutput(packet)
      packetsSent++
    }
  }
  step('writeOutput() framed image packets accepted', true, `${packetsSent} packets, first row colored`)

  // Input reports: needs a human finger; report what arrives either way.
  const events: string[] = []
  handle.onInput((report) => {
    const states = parseInputReport(model, report)
    if (!states) return
    const down = states.flatMap((s, i) => (s ? [i] : []))
    events.push(`down=[${down.join(',')}]`)
  })
  console.log(`\n>>> Press any keys on the deck in the next ${HOLD_SECONDS}s to test input reports <<<\n`)
  await sleep(HOLD_SECONDS * 1000)
  if (events.length > 0) {
    step('input reports parse as key states', true, events.slice(0, 6).join(' '))
  } else {
    console.log(`SKIP  input reports — no keys were pressed within ${HOLD_SECONDS}s (rerun and press a key)`)
  }

  await handle.sendFeature(encodeReset())
  step('sendFeature(reset) restores logo', true)
} catch (error) {
  step('smoke run', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await handle.close()
  step('close()', true)
}

console.log(failures === 0 ? '\nAll programmatic checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
