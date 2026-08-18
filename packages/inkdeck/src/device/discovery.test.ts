import { afterEach, describe, expect, test } from 'bun:test'
import type { DeviceInfo } from '../transport/iface.js'
import { selectDevice } from './discovery.js'

const dev = (serial: string): DeviceInfo => ({ path: `iokit:${serial}`, vendorId: 0x0fd9, productId: 0x6c, serial, model: 'xl' })

describe('selectDevice precedence', () => {
  const env = process.env.INKDECK_DEVICE
  afterEach(() => {
    if (env === undefined) delete process.env.INKDECK_DEVICE
    else process.env.INKDECK_DEVICE = env
  })

  test('sole device is selected; none is absent; several is ambiguous', () => {
    delete process.env.INKDECK_DEVICE
    expect(selectDevice([dev('A')])).toEqual({ kind: 'selected', device: dev('A') })
    expect(selectDevice([]).kind).toBe('absent')
    const many = selectDevice([dev('A'), dev('B')])
    expect(many.kind).toBe('ambiguous')
    expect((many as { message: string }).message).toContain('A (xl)')
  })

  test('--device beats INKDECK_DEVICE beats sole device; a missing wanted serial is absent (wait), listing candidates', () => {
    process.env.INKDECK_DEVICE = 'B'
    expect(selectDevice([dev('A'), dev('B')])).toEqual({ kind: 'selected', device: dev('B') })
    expect(selectDevice([dev('A'), dev('B')], 'A')).toEqual({ kind: 'selected', device: dev('A') })
    const missing = selectDevice([dev('A')], 'Z')
    expect(missing.kind).toBe('absent')
    expect((missing as { message: string }).message).toContain('A (xl)')
  })
})
