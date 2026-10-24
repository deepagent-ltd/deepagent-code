export * as DpapiHelper from "./dpapi-helper"

import { Effect, Exit, Option, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { NativeInstallation } from "@/installation/native-installation"
import { NativeWindowsWorkFactory } from "@/installation/windows-work-factory"
import { WindowsWorkFileHelper } from "@/installation/windows-work-file-helper"
import type { Codec } from "./dpapi"

const unavailable = () => new Error("The current managed DPAPI helper is unavailable")
const Response = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.Literal("mcp-dpapi"),
  status: Schema.Literal("dpapi"),
  code: Schema.Null,
  payload_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(98_304)),
})

/** The same original Root factory holds the executable and its system imports.
 * The child only accepts one fixed operation; no path or executable is input. */
export const make = Effect.gen(function* () {
  const factory = yield* NativeWindowsWorkFactory.Service
  const installation = yield* NativeInstallation.current()
  const asset = yield* WindowsWorkFileHelper.asset(installation)
  const bridge = yield* EffectBridge.make()
  const run = async <A, E>(effect: Effect.Effect<A, E>) => {
    const result = await bridge.promise(effect.pipe(Effect.result))
    if (result._tag === "Failure") throw result.failure
    return result.success
  }
  const crypt = (bytes: Uint8Array, protect: boolean) => {
    if (bytes.byteLength > (protect ? 65_536 : 98_304)) return Promise.reject(unavailable())
    // The signal directly terminates the owned Job. EffectBridge's separate
    // graceful-interruption delay is deliberately not used for this deadline.
    const signal = AbortSignal.timeout(10_000)
    return run(
      Effect.gen(function* () {
        signal.throwIfAborted()
        const child = yield* WindowsWorkFileHelper.launch(asset)
        const decoded = yield* scopedExchange(child, bytes, protect, signal)
        return yield* factory.current.pipe(
          Effect.tap(() => Effect.sync(() => signal.throwIfAborted())),
          Effect.as(decoded),
          Effect.onError(() => Effect.sync(() => decoded.fill(0))),
        )
      }).pipe(Effect.scoped, Effect.provideService(NativeWindowsWorkFactory.Service, factory)),
    )
  }
  return Object.freeze({
    id: "native-helper-crypt32-current-user",
    available: async () => {
      await run(factory.current)
      return true
    },
    protect: (bytes: Uint8Array) => crypt(bytes, true),
    unprotect: (bytes: Uint8Array) => crypt(bytes, false),
  }) satisfies Codec
})

/** Acquisition is uninterruptible until the plaintext has a registered release.
 * Failed or interrupted scopes clear late results; a successful scope transfers
 * ownership to SecretStore, whose existing finally clears the returned bytes. */
export function scopedExchange(...args: Parameters<typeof exchange>) {
  return Effect.acquireRelease(
    Effect.tryPromise({ try: () => exchange(...args), catch: unavailable }),
    (bytes, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => bytes.fill(0))),
  )
}

/** A bounded one-request exchange over the original qualified child adapter.
 * Exported for transport boundary tests; it cannot choose or launch a process. */
export function exchange(
  child: Pick<WindowsWorkFileHelper.Process, "stdin" | "stdout" | "stderr" | "kill"> & {
    on: (event: "error", listener: () => void) => unknown
    once: (event: "close", listener: (code: number | null) => void) => unknown
    removeListener: (event: "error", listener: () => void) => unknown
  },
  bytes: Uint8Array,
  protect: boolean,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const limit = protect ? 98_304 : 65_536
  if (bytes.byteLength > (protect ? 65_536 : 98_304))
    return new Promise((_, reject) => {
      child.once("close", () => reject(unavailable()))
      child.kill()
    })
  const header = Buffer.from(
    JSON.stringify({
      version: 1,
      id: "mcp-dpapi",
      op: protect ? "mcp_dpapi_protect" : "mcp_dpapi_unprotect",
      length: bytes.byteLength,
    }),
  )
  const wire = Buffer.alloc(4 + header.length + bytes.byteLength)
  wire.writeUInt32BE(header.length)
  header.copy(wire, 4)
  wire.set(bytes, 4 + header.length)
  const output = Buffer.alloc(4 + 1024 + limit)
  const state = { received: 0, errors: 0, failure: undefined as Error | undefined }
  return new Promise<Uint8Array>((resolve, reject) => {
    const fail = () => {
      state.failure ??= unavailable()
      // HelperProcess.kill uses the original Native TerminateJobObject. We
      // still wait for its real joined close instead of racing a fake timeout.
      child.kill()
    }
    const abort = () => fail()
    const stdout = (chunk: Buffer) => {
      try {
        if (!Buffer.isBuffer(chunk) || state.received + chunk.length > output.length) {
          fail()
          return
        }
        if (!state.failure) {
          chunk.copy(output, state.received)
          state.received += chunk.length
        }
      } finally {
        if (Buffer.isBuffer(chunk)) chunk.fill(0)
      }
    }
    const stderr = (chunk: Buffer) => {
      try {
        if (!Buffer.isBuffer(chunk) || state.errors + chunk.length > 4096) {
          fail()
          return
        }
        state.errors += chunk.length
      } finally {
        if (Buffer.isBuffer(chunk)) chunk.fill(0)
      }
    }
    const close = (code: number | null) => {
      signal.removeEventListener("abort", abort)
      child.removeListener("error", fail)
      child.stdin.removeListener("error", fail)
      child.stdout.removeListener("data", stdout)
      child.stderr.removeListener("data", stderr)
      try {
        if (signal.aborted || state.failure || code !== 0 || state.errors !== 0 || state.received < 4)
          throw unavailable()
        const length = output.readUInt32BE(0)
        if (length === 0 || length > 1024 || state.received < 4 + length) throw unavailable()
        const response = Option.flatMap(
          Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(output.subarray(4, 4 + length).toString("utf8")),
          Schema.decodeUnknownOption(Response),
        )
        if (
          Option.isNone(response) ||
          response.value.payload_bytes > limit ||
          state.received !== 4 + length + response.value.payload_bytes
        )
          throw unavailable()
        resolve(Buffer.from(output.subarray(4 + length, state.received)))
      } catch {
        reject(unavailable())
      } finally {
        wire.fill(0)
        output.fill(0)
      }
    }
    child.on("error", fail)
    child.stdin.on("error", fail)
    child.once("close", close)
    child.stdout.on("data", stdout)
    child.stderr.on("data", stderr)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) {
      fail()
      return
    }
    // Native owns a zeroing queue copy before this write callback returns.
    // Closing stdin lets the helper reject trailing bytes before invoking DPAPI.
    try {
      child.stdin.end(wire, () => wire.fill(0))
    } catch {
      fail()
    }
  })
}
