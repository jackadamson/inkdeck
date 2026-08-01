// CoreFoundation helpers for the IOKit transport (macOS only).
//
// All the fiddly pointer ceremony lives here (SPEC §4.2). Constants are
// transcribed from the SDK headers cited next to each value.
//
// CF references are carried as `bigint` (FFIType.u64), never FFIType.ptr:
// on Apple Silicon, CF returns tagged pointers for small CFNumbers and short
// CFStrings — the object lives in the pointer bits and uses all 64 of them.
// FFIType.ptr surfaces pointers as JS doubles, which round above 2^53, so a
// tagged ref would come back corrupted and segfault on the next CF call.

import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'

/** A CoreFoundation object reference, bit-exact. 0n means NULL. */
export type CFRef = bigint

export const CF_NULL: CFRef = 0n

const CF_PATH = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'

// CFStringBuiltInEncodings, CoreFoundation/CFString.h
export const kCFStringEncodingUTF8 = 0x08000100
// CFNumberType, CoreFoundation/CFNumber.h
export const kCFNumberSInt32Type = 3

let cfLib: ReturnType<typeof openCF> | null = null

function openCF() {
  return dlopen(CF_PATH, {
    CFStringCreateWithCString: {
      args: [FFIType.u64, FFIType.cstring, FFIType.u32],
      returns: FFIType.u64,
    },
    CFStringGetCString: {
      args: [FFIType.u64, FFIType.u64, FFIType.i64, FFIType.u32],
      returns: FFIType.bool,
    },
    CFNumberCreate: {
      args: [FFIType.u64, FFIType.i64, FFIType.u64],
      returns: FFIType.u64,
    },
    CFNumberGetValue: {
      args: [FFIType.u64, FFIType.i64, FFIType.u64],
      returns: FFIType.bool,
    },
    CFDictionaryCreate: {
      args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.i64, FFIType.u64, FFIType.u64],
      returns: FFIType.u64,
    },
    CFSetGetCount: { args: [FFIType.u64], returns: FFIType.i64 },
    CFSetGetValues: { args: [FFIType.u64, FFIType.u64], returns: FFIType.void },
    CFRelease: { args: [FFIType.u64], returns: FFIType.void },
    CFRunLoopGetCurrent: { args: [], returns: FFIType.u64 },
    CFRunLoopRunInMode: {
      args: [FFIType.u64, FFIType.f64, FFIType.bool],
      returns: FFIType.i32,
    },
  })
}

function cf() {
  if (!cfLib) cfLib = openCF()
  return cfLib.symbols
}

/** Address of a TypedArray's storage as a CFRef-compatible bigint. */
export function bufPtr(view: ArrayBufferView): bigint {
  return BigInt(ptr(view as never))
}

// The CFDictionary key/value callback structs (kCFTypeDictionaryKeyCallBacks /
// kCFTypeDictionaryValueCallBacks) are *data* symbols, which bun:ffi's dlopen
// cannot bind directly — so resolve them with dlsym(RTLD_DEFAULT, …) from libSystem.
let dlLib: ReturnType<typeof openDl> | null = null
function openDl() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    dlsym: { args: [FFIType.i64, FFIType.cstring], returns: FFIType.u64 },
  })
}
const RTLD_DEFAULT = -2n // dlfcn.h: (void *)-2

function dataSymbol(name: string): CFRef {
  if (!dlLib) dlLib = openDl()
  const cName = Buffer.from(`${name}\0`, 'utf8')
  const p = dlLib.symbols.dlsym(RTLD_DEFAULT, cName as never)
  if (!p) throw new Error(`[inkdeck] dlsym failed for CoreFoundation symbol ${name}`)
  return p
}

/** Create a CFString from a JS string. Caller owns the returned ref (CFRelease it). */
export function cfString(value: string): CFRef {
  const cstr = Buffer.from(`${value}\0`, 'utf8')
  const result = cf().CFStringCreateWithCString(CF_NULL, cstr as never, kCFStringEncodingUTF8)
  if (!result) throw new Error(`[inkdeck] CFStringCreateWithCString failed for "${value}"`)
  return result
}

/** Create a CFNumber (SInt32) from a JS number. Caller owns the returned ref. */
export function cfNumber(value: number): CFRef {
  const storage = new Int32Array([value | 0])
  const result = cf().CFNumberCreate(CF_NULL, BigInt(kCFNumberSInt32Type), bufPtr(storage))
  if (!result) throw new Error(`[inkdeck] CFNumberCreate failed for ${value}`)
  return result
}

/**
 * Create a CFDictionary from CF-typed keys/values, using the standard CFType
 * callbacks so CFString keys compare by value (required for HID matching).
 * The input refs remain owned by the caller; the dictionary retains them.
 */
export function cfDictionary(entries: Array<[CFRef, CFRef]>): CFRef {
  const keys = new BigUint64Array(entries.length)
  const values = new BigUint64Array(entries.length)
  entries.forEach(([k, v], i) => {
    keys[i] = k
    values[i] = v
  })
  const result = cf().CFDictionaryCreate(
    CF_NULL,
    bufPtr(keys),
    bufPtr(values),
    BigInt(entries.length),
    dataSymbol('kCFTypeDictionaryKeyCallBacks'),
    dataSymbol('kCFTypeDictionaryValueCallBacks'),
  )
  if (!result) throw new Error('[inkdeck] CFDictionaryCreate failed')
  return result
}

/** Read a CFString into a JS string. Does not release the input. */
export function cfStringToJs(ref: CFRef, maxLength = 256): string {
  const buf = new Uint8Array(maxLength)
  const ok = cf().CFStringGetCString(ref, bufPtr(buf), BigInt(maxLength), kCFStringEncodingUTF8)
  if (!ok) throw new Error('[inkdeck] CFStringGetCString failed')
  const nul = buf.indexOf(0)
  return new TextDecoder().decode(buf.subarray(0, nul === -1 ? maxLength : nul))
}

/** Read a CFNumber into a JS number (SInt32). Does not release the input. */
export function cfNumberToJs(ref: CFRef): number {
  const storage = new Int32Array(1)
  const ok = cf().CFNumberGetValue(ref, BigInt(kCFNumberSInt32Type), bufPtr(storage))
  if (!ok) throw new Error('[inkdeck] CFNumberGetValue failed')
  return storage[0]
}

/** Copy the members of a CFSet into a JS array of refs. */
export function cfSetToArray(set: CFRef): CFRef[] {
  const count = Number(cf().CFSetGetCount(set))
  if (count === 0) return []
  const storage = new BigUint64Array(count)
  cf().CFSetGetValues(set, bufPtr(storage))
  return Array.from(storage)
}

export function cfRelease(ref: CFRef): void {
  cf().CFRelease(ref)
}

export function cfRunLoopGetCurrent(): CFRef {
  const loop = cf().CFRunLoopGetCurrent()
  if (!loop) throw new Error('[inkdeck] CFRunLoopGetCurrent returned NULL')
  return loop
}

/** Pump the current run loop once. `mode` is a CFString ref. */
export function cfRunLoopRunInMode(mode: CFRef, seconds: number, returnAfterSource: boolean): number {
  return cf().CFRunLoopRunInMode(mode, seconds, returnAfterSource)
}

export { toArrayBuffer }
