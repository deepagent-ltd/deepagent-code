import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import { Effect, Option, Schema } from "effect"
import { NativeInstallation } from "./native-installation"
import { NativeWindowsWorkFactory } from "./windows-work-factory"

export class Error extends Schema.TaggedErrorClass<Error>()("WindowsWorkFileHelperError", {
  code: Schema.Literals(["WINDOWS_WORK_HELPER_UNAVAILABLE", "WINDOWS_WORK_HELPER_CHANGED", "WINDOWS_WORK_HELPER_UNKNOWN"]),
}) {}
const unavailable = () => new Error({ code: "WINDOWS_WORK_HELPER_UNAVAILABLE" })
const assets = new WeakMap<object, { installation: NativeInstallation.VerifiedInstalledComponents;
  factory: NativeWindowsWorkFactory.Interface }>()
const children = new Set<HelperProcess>()
const capacity = { opening: 0 }

/** The public fields describe the original held image; only this exact object
 * can launch through the original Root factory. Paths and hashes are not ports. */
export const asset = Effect.fn("WindowsWorkFileHelper.asset")(function* (installation: NativeInstallation.VerifiedInstalledComponents) {
  if (process.platform !== "win32") return yield* unavailable()
  const supplied = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  if (Option.isNone(supplied)) return yield* unavailable()
  const factory = supplied.value
  yield* NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(unavailable))
  const inventory = yield* NativeInstallation.inventory(installation).pipe(Effect.mapError(unavailable))
  yield* factory.current.pipe(Effect.mapError(unavailable))
  const image = factory.description.helper
  if (factory.description.target !== `${process.platform}-${process.arch}` || image.system ||
    image.assetPath !== `packages/work-file-helper/bin/${factory.description.target}/deepagent-work-file-helper.exe` ||
    image.bytes > 16_777_216 || !inventory.some((entry) => entry.path === image.assetPath &&
      entry.sha256 === image.sha256 && entry.bytes === image.bytes)) return yield* unavailable()
  const value = Object.freeze({ filename: image.path, hash: image.sha256,
    identity: `${image.identity.volumeSerial}:${image.identity.fileID}` })
  assets.set(value, { installation, factory })
  return value
})
export type Asset = Readonly<{ filename: string; hash: string; identity: string }>

export const launch = Effect.fn("WindowsWorkFileHelper.launch")(function* (value: Asset) {
  const original = assets.get(value)
  const supplied = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  if (Option.isNone(supplied)) return yield* unavailable()
  const factory = supplied.value
  if (process.platform !== "win32" || !original || original.factory !== factory ||
    children.size + capacity.opening >= 8) return yield* unavailable()
  capacity.opening++
  return yield* Effect.gen(function* () {
    yield* NativeInstallation.requireCurrent(original.installation).pipe(Effect.mapError(unavailable))
    // launchHelper checks this same original factory before its Native launch.
    // Keep that final check instead of repeating its complete image graph here.
    return yield* Effect.acquireRelease(factory.launchHelper.pipe(Effect.mapError(unavailable), Effect.map((child) => {
      const process = new HelperProcess(child)
      children.add(process)
      return process
    })), (process) => Effect.promise(() => process.retire()))
  }).pipe(Effect.ensuring(Effect.sync(() => { capacity.opening-- })))
})

/** The Node stream shape is an adapter over one original Native child. A close
 * event is emitted only after Native has joined the job, writer and both EOFs. */
export type Process = Effect.Success<ReturnType<typeof launch>>
class HelperProcess extends EventEmitter {
  readonly pid: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  exitCode: number | null = null
  readonly signalCode = null
  private readonly child: NativeWindowsWorkFactory.Child
  private readonly state = { retired: false, stopped: false, closed: false, failed: false,
    stdoutBlocked: false, stderrBlocked: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }

  constructor(child: NativeWindowsWorkFactory.Child) {
    super()
    this.child = child
    this.pid = child.pid
    // Stream errors are reported once through the process event; they never
    // imply that a native job has joined or that its capacity can be released.
    this.on("error", () => undefined)
    this.stdout = new Readable({ highWaterMark: 65_536, read: () => {
      this.state.stdoutBlocked = false
      this.schedule(0)
    } })
    this.stderr = new Readable({ highWaterMark: 65_536, read: () => {
      this.state.stderrBlocked = false
      this.schedule(0)
    } })
    this.stdin = new Writable({ highWaterMark: 65_536, write: (bytes: Buffer, _encoding, callback) => {
      if (this.state.closed || this.state.retired || !Buffer.isBuffer(bytes) || bytes.length > 1_048_580) {
        callback(unavailable())
        return
      }
      try { this.child.write(bytes); callback() }
      catch { callback(new Error({ code: "WINDOWS_WORK_HELPER_UNKNOWN" })) }
    }, final: (callback) => {
      try { this.child.end(); callback() }
      catch { callback(new Error({ code: "WINDOWS_WORK_HELPER_UNKNOWN" })) }
    } })
    this.stdin.on("error", () => this.refuse())
    this.stdout.on("error", () => this.refuse())
    this.stderr.on("error", () => this.refuse())
    this.schedule(0)
  }

  // Only the original browser-file factory calls this before creating a stage.
  // This one-way Native mark prevents error/GC/Root retirement from killing a
  // live file custodian; it never authorizes another read, write or process.
  retainBrowserCustody() {
    if (this.state.retired || this.state.stopped || this.state.closed || this.state.failed) throw unavailable()
    this.child.retainBrowserCustody()
  }

  kill(_signal?: NodeJS.Signals | number) {
    if (this.state.closed) return false
    this.state.retired = true
    this.stop()
    this.schedule(0)
    return true
  }

  async retire() {
    this.kill()
    await new Promise<void>((resolve) => {
      if (this.state.closed) { resolve(); return }
      const done = () => { clearTimeout(timer); this.removeListener("close", done); resolve() }
      const timer = setTimeout(done, 1_000)
      this.once("close", done)
    })
    // Unconfirmed ownership remains in children. It cannot free an eight-child
    // slot, while its observer no longer holds the JavaScript process open.
    if (!this.state.closed) this.state.timer?.unref()
  }

  private stop() {
    if (this.state.stopped) return
    this.state.stopped = true
    try { this.child.stop() } catch { this.refuse(false) }
  }

  private refuse(stop = true) {
    this.state.retired = true
    if (!this.state.failed) {
      this.state.failed = true
      this.emit("error", new Error({ code: "WINDOWS_WORK_HELPER_UNKNOWN" }))
    }
    if (stop) this.stop()
  }

  private schedule(delay: number) {
    if (this.state.closed || this.state.timer) return
    this.state.timer = setTimeout(() => {
      this.state.timer = undefined
      this.poll()
    }, delay)
    if (this.state.retired) this.state.timer.unref()
  }

  private poll() {
    if (this.state.closed) return
    try {
      for (let count = 0; count < 4; count++) {
        if (!this.state.retired && (this.state.stdoutBlocked || this.state.stderrBlocked)) break
        const event = this.child.read()
        if (event.kind === "idle") break
        if (event.kind === "stdout") {
          if (!this.state.retired) this.state.stdoutBlocked = !this.stdout.push(event.bytes)
          else event.bytes.fill(0)
          continue
        }
        if (event.kind === "stderr") {
          if (!this.state.retired) this.state.stderrBlocked = !this.stderr.push(event.bytes)
          else event.bytes.fill(0)
          continue
        }
        // read(exit) is Native's joined observation, not a PID or stream error.
        if (!this.child.close()) break
        this.state.closed = true
        this.exitCode = event.exitCode
        this.stdout.push(null)
        this.stderr.push(null)
        this.stdin.destroy()
        children.delete(this)
        this.emit("close", event.exitCode, null)
        return
      }
      if (this.state.retired && this.child.close()) {
        this.state.closed = true
        this.stdout.push(null)
        this.stderr.push(null)
        this.stdin.destroy()
        children.delete(this)
        // Retired close may lack an observed exit code. Do not manufacture one.
        this.emit("close", null, null)
        return
      }
    } catch { this.refuse() }
    this.schedule(15)
  }
}

export * as WindowsWorkFileHelper from "./windows-work-file-helper"
