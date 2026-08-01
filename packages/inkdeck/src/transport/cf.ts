// CoreFoundation helpers for the IOKit transport (macOS only).
//
// All the fiddly pointer ceremony lives here (SPEC §4.2). Constants are
// transcribed from the SDK headers cited next to each value.

import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi'

const CF_PATH = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'

// CFStringBuiltInEncodings, CoreFoundation/CFString.h
export const kCFStringEncodingUTF8 = 0x08000100
// CFNumberType, CoreFoundation/CFNumber.h
export const kCFNumberSInt32Type = 3

let cfLib: ReturnType<typeof openCF> | null = null

function openCF() {
  return dlopen(CF_PATH, {
    CFStringCreateWithCString: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.u32],
      returns: FFIType.ptr,
    },
    CFStringGetCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32],
      returns: FFIType.bool,
    },
    CFNumberCreate: {
      args: [FFIType.ptr, FFIType.i64, FFIType.ptr],
      returns: FFIType.ptr,
    },
    CFNumberGetValue: {
      args: [FFIType.ptr, FFIType.i64, FFIType.ptr],
      returns: FFIType.bool,
    },
    CFDictionaryCreate: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    CFSetGetCount: { args: [FFIType.ptr], returns: FFIType.i64 },
    CFSetGetValues: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CFRunLoopGetCurrent: { args: [], returns: FFIType.ptr },
    CFRunLoopRunInMode: {
      args: [FFIType.ptr, FFIType.f64, FFIType.bool],
      returns: FFIType.i32,
    },
  })
}

function cf() {
  if (!cfLib) cfLib = openCF()
  return cfLib.symbols
}

// The CFDictionary key/value callback structs (kCFTypeDictionaryKeyCallBacks /
// kCFTypeDictionaryValueCallBacks) are *data* symbols, which bun:ffi's dlopen
// cannot bind directly — so resolve them with dlsym(RTLD_DEFAULT, …) from libSystem.
let dlLib: ReturnType<typeof openDl> | null = null
function openDl() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
  })
}
const RTLD_DEFAULT = -2 // dlfcn.h

function dataSymbol(name: string): Pointer {
  if (!dlLib) dlLib = openDl()
  const cName = Buffer.from(`${name}\0`, 'utf8')
  const p = dlLib.symbols.dlsym(RTLD_DEFAULT as unknown as Pointer, cName as never)
  if (!p) throw new Error(`[inkdeck] dlsym failed for CoreFoundation symbol ${name}`)
  return p
}

/** Create a CFString from a JS string. Caller owns the returned ref (CFRelease it). */
export function cfString(value: string): Pointer {
  const cstr = Buffer.from(`${value}\0`, 'utf8')
  const result = cf().CFStringCreateWithCString(null, cstr as never, kCFStringEncodingUTF8)
  if (!result) throw new Error(`[inkdeck] CFStringCreateWithCString failed for "${value}"`)
  return result
}

/** Create a CFNumber (SInt32) from a JS number. Caller owns the returned ref. */
export function cfNumber(value: number): Pointer {
  const storage = new Int32Array([value | 0])
  const result = cf().CFNumberCreate(null, kCFNumberSInt32Type, ptr(storage))
  if (!result) throw new Error(`[inkdeck] CFNumberCreate failed for ${value}`)
  return result
}

/**
 * Create a CFDictionary from CF-typed keys/values, using the standard CFType
 * callbacks so CFString keys compare by value (required for HID matching).
 * The input refs remain owned by the caller; the dictionary retains them.
 */
export function cfDictionary(entries: Array<[Pointer, Pointer]>): Pointer {
  const keys = new BigUint64Array(entries.length)
  const values = new BigUint64Array(entries.length)
  entries.forEach(([k, v], i) => {
    keys[i] = BigInt(k)
    values[i] = BigInt(v)
  })
  const result = cf().CFDictionaryCreate(
    null,
    ptr(keys),
    ptr(values),
    entries.length,
    dataSymbol('kCFTypeDictionaryKeyCallBacks'),
    dataSymbol('kCFTypeDictionaryValueCallBacks'),
  )
  if (!result) throw new Error('[inkdeck] CFDictionaryCreate failed')
  return result
}

/** Read a CFString into a JS string. Does not release the input. */
export function cfStringToJs(ref: Pointer, maxLength = 256): string {
  const buf = new Uint8Array(maxLength)
  const ok = cf().CFStringGetCString(ref, ptr(buf), maxLength, kCFStringEncodingUTF8)
  if (!ok) throw new Error('[inkdeck] CFStringGetCString failed')
  const nul = buf.indexOf(0)
  return new TextDecoder().decode(buf.subarray(0, nul === -1 ? maxLength : nul))
}

/** Read a CFNumber into a JS number (SInt32). Does not release the input. */
export function cfNumberToJs(ref: Pointer): number {
  const storage = new Int32Array(1)
  const ok = cf().CFNumberGetValue(ref, kCFNumberSInt32Type, ptr(storage))
  if (!ok) throw new Error('[inkdeck] CFNumberGetValue failed')
  return storage[0]
}

/** Copy the members of a CFSet into a JS array of pointers. */
export function cfSetToArray(set: Pointer): Pointer[] {
  const count = Number(cf().CFSetGetCount(set))
  if (count === 0) return []
  const storage = new BigUint64Array(count)
  cf().CFSetGetValues(set, ptr(storage))
  return Array.from(storage, (v) => Number(v) as Pointer)
}

export function cfRelease(ref: Pointer): void {
  cf().CFRelease(ref)
}

export function cfRunLoopGetCurrent(): Pointer {
  const loop = cf().CFRunLoopGetCurrent()
  if (!loop) throw new Error('[inkdeck] CFRunLoopGetCurrent returned NULL')
  return loop
}

/** Pump the current run loop once. `mode` is a CFString ref. */
export function cfRunLoopRunInMode(mode: Pointer, seconds: number, returnAfterSource: boolean): number {
  return cf().CFRunLoopRunInMode(mode, seconds, returnAfterSource)
}

export { toArrayBuffer }
