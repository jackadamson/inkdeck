// IOKit HID transport for macOS hardware, bound with bun:ffi (SPEC §4.2).
// No compiled addon, no node-gyp. Only loadable on darwin.
//
// Object references (IOHIDManagerRef, IOHIDDeviceRef, CF property values) are
// carried as bigint via FFIType.u64 — see cf.ts for why FFIType.ptr's
// double-based representation corrupts tagged CF pointers on Apple Silicon.
// Property values (ProductID CFNumbers, short serial CFStrings) are exactly
// the refs that come back tagged.

import { dlopen, FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from 'bun:ffi'
import { modelByProductId, VENDOR_ID } from '../device/models.js'
import { DeviceDisconnectedError, TransportIOError, type DeviceInfo, type Transport, type TransportHandle } from './iface.js'
import {
  bufPtr,
  CF_NULL,
  type CFRef,
  cfDictionary,
  cfNumber,
  cfNumberToJs,
  cfRelease,
  cfRetain,
  cfRunLoopGetCurrent,
  cfRunLoopRunInMode,
  cfSetToArray,
  cfString,
  cfStringToJs,
} from './cf.js'

// IOKit/hid/IOHIDBase.h — IOHIDReportType
export const kIOHIDReportTypeInput = 0
export const kIOHIDReportTypeOutput = 1
export const kIOHIDReportTypeFeature = 2
// IOKit/hid/IOHIDManager.h — IOHIDOptionsType
const kIOHIDOptionsTypeNone = 0
// IOKit/IOReturn.h
const kIOReturnSuccess = 0

const IOKIT_PATH = '/System/Library/Frameworks/IOKit.framework/IOKit'

let ioLib: ReturnType<typeof openIOKit> | null = null

function openIOKit() {
  return dlopen(IOKIT_PATH, {
    IOHIDManagerCreate: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u64 },
    IOHIDManagerSetDeviceMatching: { args: [FFIType.u64, FFIType.u64], returns: FFIType.void },
    IOHIDManagerOpen: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    IOHIDManagerCopyDevices: { args: [FFIType.u64], returns: FFIType.u64 },
    IOHIDManagerScheduleWithRunLoop: {
      args: [FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.void,
    },
    IOHIDDeviceOpen: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    IOHIDDeviceClose: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    IOHIDDeviceGetProperty: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
    IOHIDDeviceSetReport: {
      // (device, IOHIDReportType, CFIndex reportID, const uint8_t *report, CFIndex length)
      args: [FFIType.u64, FFIType.i32, FFIType.i64, FFIType.u64, FFIType.i64],
      returns: FFIType.i32,
    },
    IOHIDDeviceGetReport: {
      // (device, IOHIDReportType, CFIndex reportID, uint8_t *report, CFIndex *pReportLength)
      args: [FFIType.u64, FFIType.i32, FFIType.i64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    IOHIDDeviceRegisterInputReportCallback: {
      // (device, uint8_t *report, CFIndex reportLength, IOHIDReportCallback, void *context)
      args: [FFIType.u64, FFIType.u64, FFIType.i64, FFIType.u64, FFIType.u64],
      returns: FFIType.void,
    },
    IOHIDDeviceRegisterRemovalCallback: {
      // (device, IOHIDCallback, void *context)
      args: [FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.void,
    },
    IOHIDDeviceScheduleWithRunLoop: {
      args: [FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.void,
    },
  })
}

function iokit() {
  if (process.platform !== 'darwin') {
    throw new Error('[inkdeck] IOKitTransport is only available on macOS (hardware support for other platforms is post-MVP)')
  }
  if (!ioLib) ioLib = openIOKit()
  return ioLib.symbols
}

// IOKit/hid/IOHIDKeys.h
const kIOHIDVendorIDKey = 'VendorID'
const kIOHIDProductIDKey = 'ProductID'
const kIOHIDSerialNumberKey = 'SerialNumber'

const INPUT_BUFFER_SIZE = 1024
const RUNLOOP_PUMP_MS = 4

function isElgatoAppRunning(): boolean {
  try {
    const proc = Bun.spawnSync(['pgrep', '-x', 'Stream Deck'])
    return proc.exitCode === 0
  } catch {
    return false
  }
}

function openFailureMessage(serial: string): string {
  const lines = [`[inkdeck] failed to open Stream Deck ${serial}.`]
  if (isElgatoAppRunning()) {
    lines.push(
      'The Elgato Stream Deck app is running and holds exclusive access to the device — quit it and retry.',
    )
  } else {
    lines.push(
      'The usual cause is missing Input Monitoring permission: System Settings → Privacy & Security → Input Monitoring, enable it for your terminal, then retry.',
    )
  }
  return lines.join('\n')
}

// How often open handles are checked against the manager's device set.
// Device-level IOHIDDeviceRegisterRemovalCallback is also registered but was
// observed to never fire (macOS 15.6/arm64, Bun 1.3.11) — the manager's set,
// drained via the run loop, is the reliable removal signal.
const REMOVAL_POLL_MS = 1000
// A failed report may be an unplug that removal polling has not flagged yet:
// a failing write waits this long (> one poll) for the verdict before it is
// reported as a plain I/O error, so callers never see a per-key error flood
// for what is really a disconnect.
const DISCONNECT_GRACE_MS = REMOVAL_POLL_MS + 200

export class IOKitTransport implements Transport {
  #manager: CFRef = CF_NULL
  #runLoopMode: CFRef = CF_NULL
  #devicesBySerial = new Map<string, CFRef>()
  #openHandles = new Map<string, IOKitHandle>()
  #removalPoll: ReturnType<typeof setInterval> | null = null
  #polling = false

  #ensureManager(): void {
    if (this.#manager) return
    const io = iokit()
    const manager = io.IOHIDManagerCreate(CF_NULL, kIOHIDOptionsTypeNone)
    if (!manager) throw new Error('[inkdeck] IOHIDManagerCreate failed')
    // Match on { VendorID: 0x0fd9 } only; the model is resolved from ProductID
    // afterwards (SPEC §4.2).
    const key = cfString(kIOHIDVendorIDKey)
    const value = cfNumber(VENDOR_ID)
    const matching = cfDictionary([[key, value]])
    io.IOHIDManagerSetDeviceMatching(manager, matching)
    cfRelease(matching)
    cfRelease(value)
    cfRelease(key)
    const rc = io.IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone)
    if (rc !== kIOReturnSuccess) {
      throw new Error(`[inkdeck] IOHIDManagerOpen failed (IOReturn 0x${(rc >>> 0).toString(16)})`)
    }
    // Without run-loop scheduling the manager's device set is frozen at open
    // time — CopyDevices never sees hot-plugged devices.
    this.#runLoopMode = cfString('kCFRunLoopDefaultMode')
    io.IOHIDManagerScheduleWithRunLoop(manager, cfRunLoopGetCurrent(), this.#runLoopMode)
    this.#manager = manager
  }

  #deviceProperty(device: CFRef, key: string): CFRef {
    const io = iokit()
    const cfKey = cfString(key)
    const value = io.IOHIDDeviceGetProperty(device, cfKey)
    cfRelease(cfKey)
    return value
  }

  async list(): Promise<DeviceInfo[]> {
    this.#ensureManager()
    const io = iokit()
    // Drain pending IOKit matching/removal callbacks so hot-plug arrivals and
    // departures are reflected (kCFRunLoopRunHandledSource = 4, CFRunLoop.h).
    // When a handle's pump is also running this is redundant but harmless.
    for (let i = 0; i < 16 && cfRunLoopRunInMode(this.#runLoopMode, 0, true) === 4; i++) {
      // draining
    }
    const set = io.IOHIDManagerCopyDevices(this.#manager)
    const devices = set ? cfSetToArray(set) : []
    const infos: DeviceInfo[] = []
    this.#devicesBySerial.clear()
    for (const device of devices) {
      const productIdRef = this.#deviceProperty(device, kIOHIDProductIDKey)
      if (!productIdRef) continue
      const productId = cfNumberToJs(productIdRef)
      const model = modelByProductId(productId)
      if (!model) continue // Elgato device we do not know (pedal, dock, …)
      const serialRef = this.#deviceProperty(device, kIOHIDSerialNumberKey)
      const serial = serialRef ? cfStringToJs(serialRef) : `unknown-${productId.toString(16)}`
      this.#devicesBySerial.set(serial, device)
      infos.push({
        path: `iokit:${serial}`,
        vendorId: VENDOR_ID,
        productId,
        serial,
        model: model.id,
      })
    }
    if (set) cfRelease(set)
    return infos
  }

  async open(path: string): Promise<TransportHandle> {
    const serial = path.replace(/^iokit:/, '')
    if (!this.#devicesBySerial.has(serial)) await this.list()
    const device = this.#devicesBySerial.get(serial)
    if (!device) {
      throw new Error(`[inkdeck] no Stream Deck with serial "${serial}" attached — run \`inkdeck list\` to see candidates`)
    }
    const io = iokit()
    const rc = io.IOHIDDeviceOpen(device, kIOHIDOptionsTypeNone)
    if (rc !== kIOReturnSuccess) {
      throw new Error(openFailureMessage(serial))
    }
    const handle = new IOKitHandle(device)
    this.#openHandles.set(serial, handle)
    this.#ensureRemovalPoll()
    return handle
  }

  #ensureRemovalPoll(): void {
    if (this.#removalPoll) return
    this.#removalPoll = setInterval(() => {
      if (this.#polling) return
      this.#polling = true
      void this.#checkRemovals().finally(() => {
        this.#polling = false
      })
    }, REMOVAL_POLL_MS)
  }

  async #checkRemovals(): Promise<void> {
    for (const [serial, handle] of this.#openHandles) {
      if (handle.isClosed) this.#openHandles.delete(serial)
    }
    if (this.#openHandles.size === 0) {
      if (this.#removalPoll) clearInterval(this.#removalPoll)
      this.#removalPoll = null
      return
    }
    await this.list()
    for (const [serial, handle] of this.#openHandles) {
      // Liveness is identity, not serial: an unplug/replug (or hub blip) that
      // completes between two polls yields a *new* IOHIDDeviceRef for the
      // same serial, and the old handle is just as dead as if it were absent.
      if (this.#devicesBySerial.get(serial) !== handle.device) {
        this.#openHandles.delete(serial)
        handle.markRemoved()
      }
    }
  }
}

class IOKitHandle implements TransportHandle {
  #device: CFRef
  #inputCbs: Array<(report: Uint8Array) => void> = []
  #disconnectCbs: Array<() => void> = []
  #inputBuffer = new Uint8Array(INPUT_BUFFER_SIZE)
  #callback: JSCallback | null = null
  #removalCallback: JSCallback | null = null
  #pump: ReturnType<typeof setInterval> | null = null
  #runLoopMode: CFRef
  #closed = false
  #dead = false

  constructor(device: CFRef) {
    // Retain: the manager drops its reference on removal, and this handle
    // may still be asked to write/close before the poll flags the removal.
    this.#device = cfRetain(device)
    // The default run loop mode's contents are the literal string below;
    // CFString comparison is by value, so a fresh CFString works for both
    // scheduling and pumping (avoids binding the kCFRunLoopDefaultMode data symbol).
    this.#runLoopMode = cfString('kCFRunLoopDefaultMode')
    this.#registerInput()
  }

  #registerInput(): void {
    const io = iokit()
    // IOHIDReportCallback: (void *context, IOReturn result, void *sender,
    //                       IOHIDReportType type, uint32_t reportID,
    //                       uint8_t *report, CFIndex reportLength)
    // The report buffer is a real heap pointer (never tagged), so FFIType.ptr
    // is safe here and is what toArrayBuffer wants.
    this.#callback = new JSCallback(
      (_ctx: Pointer, _result: number, _sender: Pointer, _type: number, _reportId: number, report: Pointer, length: number | bigint) => {
        const len = Number(length)
        if (len <= 0) return
        // For numbered-report devices the IOKit callback buffer already begins
        // with the report ID (verified on an XL: [0x01, 0x00, keyCountLE(2),
        // states…]) — pass it through as-is; the Transport contract wants the
        // ID as the first byte. Copy: the buffer is reused by IOKit.
        const data = new Uint8Array(toArrayBuffer(report, 0, len)).slice()
        for (const cb of this.#inputCbs) cb(data)
      },
      {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i64],
        returns: FFIType.void,
      },
    )
    if (!this.#callback.ptr) throw new Error('[inkdeck] JSCallback allocation failed')
    io.IOHIDDeviceRegisterInputReportCallback(
      this.#device,
      bufPtr(this.#inputBuffer),
      BigInt(this.#inputBuffer.length),
      BigInt(this.#callback.ptr),
      CF_NULL,
    )
    // Removal callback: the transport-level "device unplugged" signal
    // (IOHIDCallback: (void *context, IOReturn result, void *sender)).
    // Delivered by the same run-loop pump as input reports.
    this.#removalCallback = new JSCallback(
      (_ctx: Pointer, _result: number, _sender: Pointer) => {
        this.#onRemoved()
      },
      { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.void },
    )
    if (!this.#removalCallback.ptr) throw new Error('[inkdeck] JSCallback allocation failed')
    io.IOHIDDeviceRegisterRemovalCallback(this.#device, BigInt(this.#removalCallback.ptr), CF_NULL)
    io.IOHIDDeviceScheduleWithRunLoop(this.#device, cfRunLoopGetCurrent(), this.#runLoopMode)
    // Pump the run loop on an interval. The interval is also the process
    // keep-alive — do not rely on native handles to keep Bun's loop alive (SPEC §4.2).
    this.#pump = setInterval(() => {
      cfRunLoopRunInMode(this.#runLoopMode, 0, true)
    }, RUNLOOP_PUMP_MS)
  }

  #onRemoved(): void {
    if (this.#closed || this.#dead) return
    this.#dead = true
    // The pump keeps running until close() — it is the process keep-alive and
    // harmlessly pumps an empty run loop while the caller decides what to do.
    for (const cb of [...this.#disconnectCbs]) cb()
  }

  /** Transport-internal: the manager's device set no longer contains this
   *  device (the working removal signal — see REMOVAL_POLL_MS). */
  markRemoved(): void {
    this.#onRemoved()
  }

  get isClosed(): boolean {
    return this.#closed
  }

  /** The IOHIDDeviceRef this handle drives (identity check for removal detection). */
  get device(): CFRef {
    return this.#device
  }

  async writeOutput(report: Uint8Array): Promise<void> {
    this.#assertOpen()
    const io = iokit()
    // Report ID is the first byte of the framed packet; IOKit wants it split out.
    const rc = io.IOHIDDeviceSetReport(
      this.#device,
      kIOHIDReportTypeOutput,
      BigInt(report[0]),
      bufPtr(report),
      BigInt(report.length),
    )
    if (rc !== kIOReturnSuccess) {
      await this.#ioFailure(`IOHIDDeviceSetReport(output) failed (IOReturn 0x${(rc >>> 0).toString(16)})`)
    }
  }

  /** Classify a failed report: disconnect (after giving removal detection one
   *  poll cycle) or a genuine I/O error. Always throws. */
  async #ioFailure(detail: string): Promise<never> {
    const deadline = Date.now() + DISCONNECT_GRACE_MS
    while (!this.#dead && !this.#closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.#assertOpen()
    throw new TransportIOError(`[inkdeck] ${detail}`)
  }

  async sendFeature(report: Uint8Array): Promise<void> {
    this.#assertOpen()
    const io = iokit()
    // Feature reports (brightness/reset) are idempotent, and real hardware
    // occasionally rejects one transiently (observed: kIOReturnBadArgument
    // 0xe00002c2 on an XL right after an image burst) — retry once.
    let rc = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      rc = io.IOHIDDeviceSetReport(
        this.#device,
        kIOHIDReportTypeFeature,
        BigInt(report[0]),
        bufPtr(report),
        BigInt(report.length),
      )
      if (rc === kIOReturnSuccess) return
      await new Promise((resolve) => setTimeout(resolve, 20))
      this.#assertOpen() // don't retry against a device that vanished mid-wait
    }
    return this.#ioFailure(`IOHIDDeviceSetReport(feature) failed (IOReturn 0x${(rc >>> 0).toString(16)})`)
  }

  async getFeature(reportId: number, length: number): Promise<Uint8Array> {
    this.#assertOpen()
    const io = iokit()
    const buffer = new Uint8Array(length)
    buffer[0] = reportId
    const lengthStorage = new BigInt64Array([BigInt(length)])
    const rc = io.IOHIDDeviceGetReport(
      this.#device,
      kIOHIDReportTypeFeature,
      BigInt(reportId),
      bufPtr(buffer),
      bufPtr(lengthStorage),
    )
    if (rc !== kIOReturnSuccess) {
      await this.#ioFailure(`IOHIDDeviceGetReport failed (IOReturn 0x${(rc >>> 0).toString(16)})`)
    }
    return buffer.subarray(0, Number(lengthStorage[0]))
  }

  onInput(cb: (report: Uint8Array) => void): void {
    this.#inputCbs.push(cb)
  }

  onDisconnect(cb: () => void): void {
    this.#disconnectCbs.push(cb)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#pump) clearInterval(this.#pump)
    if (!this.#dead) iokit().IOHIDDeviceClose(this.#device, kIOHIDOptionsTypeNone)
    this.#callback?.close()
    this.#removalCallback?.close()
    cfRelease(this.#runLoopMode)
    cfRelease(this.#device)
  }

  #assertOpen(): void {
    if (this.#dead) throw new DeviceDisconnectedError()
    if (this.#closed) throw new Error('[inkdeck] IOKit handle is closed')
  }
}
