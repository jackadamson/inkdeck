// CF helper tests run on macOS only — the CoreFoundation framework does not
// exist elsewhere. On other platforms the suite is skipped (hardware is
// optional for M0; SPEC §13).

import { describe, expect, test } from 'bun:test'

const darwin = process.platform === 'darwin'

describe.skipIf(!darwin)('CoreFoundation helpers (darwin)', () => {
  test('cfString round-trips through cfStringToJs', async () => {
    const { cfString, cfStringToJs, cfRelease } = await import('./cf.js')
    const ref = cfString('inkdeck-test')
    expect(cfStringToJs(ref)).toBe('inkdeck-test')
    cfRelease(ref)
  })

  test('cfNumber round-trips through cfNumberToJs', async () => {
    const { cfNumber, cfNumberToJs, cfRelease } = await import('./cf.js')
    const ref = cfNumber(0x0fd9)
    expect(cfNumberToJs(ref)).toBe(0x0fd9)
    cfRelease(ref)
  })

  test('cfDictionary builds with CFType callbacks', async () => {
    const { cfString, cfNumber, cfDictionary, cfRelease } = await import('./cf.js')
    const key = cfString('VendorID')
    const value = cfNumber(0x0fd9)
    const dict = cfDictionary([[key, value]])
    expect(dict).toBeTruthy()
    cfRelease(dict)
    cfRelease(value)
    cfRelease(key)
  })
})

describe('transport platform guards', () => {
  test.skipIf(darwin)('IOKitTransport refuses to load off-macOS', async () => {
    const { IOKitTransport } = await import('./iokit.js')
    const transport = new IOKitTransport()
    expect(transport.list()).rejects.toThrow('only available on macOS')
  })
})
