import { Effect, Exit, Schema } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import type { ValidationCommandInput } from "@deepagent-code/core/deepagent/validation"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { resolveDataPath } from "@deepagent-code/core/global-path"
import { FixedWhich } from "@/util/fixed-which"

declare const handleBrand: unique symbol
declare const receiptBrand: unique symbol
export interface Handle {
  readonly [handleBrand]: true
}
export interface Receipt {
  readonly [receiptBrand]: true
}
export type Profile = "darwin-single-process-v1" | "posix-process-group-v1"
export type Snapshot = Readonly<{
  instanceID: string
  handleID: string
  commandHash: string
  cwd: string
  cwdHash: string
  profile: Profile
  profileHash: string
  timeoutMs: number
  stdoutLimit: number
  stderrLimit: number
}>
export type Output = Readonly<{
  hash: string
  bytes: number
  capturedBytes: number
  truncated: boolean
  complete: boolean
  text: string
}>
export type View = Readonly<{
  snapshot: Snapshot
  state: "exited" | "cancelled_before_dispatch" | "stop_confirmed" | "unknown"
  outcome: "passed" | "failed" | "cancelled" | null
  containment: "single-process" | "posix-group"
  stopProof: "not_requested" | "not_started" | "owned_process_exit" | "unconfirmed"
  reason:
    | "command_exit"
    | "cancelled"
    | "timeout"
    | "scope_closed"
    | "spawn_failed"
    | "output_incomplete"
    | "containment_unconfirmed"
    | "dispatch_refused"
  startedAt: number | null
  endedAt: number
  exitCode: number | null
  signal: string | null
  stdout: Output
  stderr: Output
}>
export class Error extends Schema.TaggedErrorClass<Error>()("OwnedValidationError", {
  code: Schema.Literals(["INVALID_INPUT", "PROFILE_UNAVAILABLE", "HANDLE_UNAVAILABLE", "CAPACITY", "SPAWN_FAILED"]),
  message: Schema.String,
}) {}
export type Hooks<E = never, R = never> = {
  readonly onPrepared?: (snapshot: Snapshot) => Effect.Effect<void, E, R>
  readonly onDispatch?: (snapshot: Snapshot) => Effect.Effect<void, E, R>
}

const instanceID = randomUUID()
const limit = 1_048_576
const commandLimit = 65_536
const lifetime = { live: 0 }
export const VALIDATION_CUSTODY_LIMIT = 128
const sandbox = "(version 1)(allow default)(deny process-fork)(deny network*)(deny appleevent-send)(deny mach-lookup)"
const fixedPath = [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter)
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
type Completion = { exitCode: number | null; signal: string | null; error: boolean }
type Entry = {
  active: boolean
  used: boolean
  prepared: boolean
  released: boolean
  snapshot: Snapshot
  argv: string[]
  env: NodeJS.ProcessEnv
  directory: { dev: number; ino: number }
  receipt?: Receipt
  process?: ChildProcess
  completion?: Promise<Completion>
  stdout?: ReturnType<typeof capture>
  stderr?: ReturnType<typeof capture>
  stopReason?: View["reason"]
  startedAt: number | null
}
const handles = new WeakMap<Handle, Entry>()
const receipts = new WeakMap<Receipt, View>()
// Unknown is a retained outcome, even after the original root exits or its
// Scope closes. It consumes the same admission capacity as a live validation.
const quarantine = new Set<Entry>()

export function inspectCustody() {
  return Object.freeze({ limit: VALIDATION_CUSTODY_LIMIT, live: lifetime.live - quarantine.size,
    quarantine: quarantine.size })
}

/** Preparation is not execution permission. The caller supplies its current-control and
 * durable effect journal gates in run's hooks; neither an ID nor this snapshot grants access. */
export const prepare = Effect.fn("OwnedValidation.prepare")(function* (input: {
  readonly cwd: string
  readonly command: ValidationCommandInput
  readonly profile: Profile
  readonly timeoutMs?: number
}) {
  const timeoutMs = input.timeoutMs ?? 120_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !path.isAbsolute(input.cwd))
    return yield* refusal("INVALID_INPUT")
  if (input.profile !== "darwin-single-process-v1" && input.profile !== "posix-process-group-v1")
    return yield* refusal("PROFILE_UNAVAILABLE")
  if (input.profile === "darwin-single-process-v1" && process.platform !== "darwin")
    return yield* refusal("PROFILE_UNAVAILABLE")
  if (process.platform !== "darwin" && process.platform !== "linux") return yield* refusal("PROFILE_UNAVAILABLE")
  if (lifetime.live >= VALIDATION_CUSTODY_LIMIT) return yield* refusal("CAPACITY")
  const command =
    typeof input.command === "string" ? { transport: "posix" as const, script: input.command } : input.command
  const text = yield* Effect.try({ try: () => CanonicalJson.stringify(command), catch: () => refusal("INVALID_INPUT") })
  if (Buffer.byteLength(text) > commandLimit) return yield* refusal("INVALID_INPUT")
  const argv = command.transport === "argv" ? [command.executable, ...command.args] : ["/bin/sh", "-c", command.script]
  if (argv.length > 1024 || argv.some((part) => typeof part !== "string" || part.includes("\0")) || !argv[0])
    return yield* refusal("INVALID_INPUT")
  const cwd = yield* Effect.tryPromise({ try: () => fs.realpath(input.cwd), catch: () => refusal("INVALID_INPUT") })
  const directory = yield* Effect.tryPromise({ try: () => fs.stat(cwd), catch: () => refusal("INVALID_INPUT") })
  if (!directory.isDirectory()) return yield* refusal("INVALID_INPUT")
  const executable = yield* Effect.tryPromise({
    try: () => FixedWhich.find(argv[0]!, { cwd, PATH: fixedPath }),
    catch: () => refusal("INVALID_INPUT"),
  })
  if (!executable) return yield* refusal("INVALID_INPUT")
  argv[0] = executable
  if (input.profile === "darwin-single-process-v1") {
    yield* Effect.tryPromise({
      try: () => fs.access("/usr/bin/sandbox-exec", fs.constants.X_OK),
      catch: () => refusal("PROFILE_UNAVAILABLE"),
    })
  }
  const snapshot = Object.freeze({
    instanceID,
    handleID: randomUUID(),
    commandHash: hash(text),
    cwd,
    cwdHash: hash(cwd),
    profile: input.profile,
    profileHash: hash(
      CanonicalJson.stringify({
        containment: input.profile === "darwin-single-process-v1" ? sandbox : "posix-detached-group.v1",
        environment: "private-home-fixed-env-v1",
        PATH: fixedPath,
        cwd: "native-identity-recheck-v1",
      }),
    ),
    timeoutMs,
    stdoutLimit: limit,
    stderrLimit: limit,
  })
  const handle = Object.freeze(Object.create(null)) as Handle
  const entry: Entry = {
    active: true,
    used: false,
    prepared: false,
    released: false,
    snapshot,
    argv,
    env: yield* privateEnvironment(),
    directory: { dev: directory.dev, ino: directory.ino },
    startedAt: null,
  }
  return yield* Effect.acquireRelease(
    Effect.suspend(() => {
      if (lifetime.live >= VALIDATION_CUSTODY_LIMIT) return refusal("CAPACITY")
      lifetime.live++
      handles.set(handle, entry)
      return Effect.succeed(handle)
    }),
    () =>
      Effect.gen(function* () {
        entry.active = false
        if (entry.process && !entry.receipt) yield* stop(entry, "scope_closed")
        release(entry)
      }),
  )
})

export function snapshot(handle: Handle) {
  return handles.get(handle)?.snapshot
}
/** Only this module's actual live handles or native receipts are accepted. A serialized view
 * is evidence to journal, never a way to reconstitute an executable handle after a crash. */
export function inspect(value: Handle | Receipt): View | undefined {
  const entry = handles.get(value as Handle)
  return receipts.get(entry?.receipt ?? (value as Receipt))
}

/** One fiber, one dispatch. The native process API is deliberately not an injectable spawner:
 * a service-shaped mock must not manufacture an owned-process termination receipt. */
export function run<E = never, R = never>(handle: Handle, hooks: Hooks<E, R> = {}) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const entry = handles.get(handle)
      if (!entry?.active || entry.used) return yield* refusal("HANDLE_UNAVAILABLE")
      entry.used = true
      const result = yield* Effect.gen(function* () {
        yield* restore(hooks.onPrepared?.(entry.snapshot) ?? Effect.void)
        entry.prepared = true
        yield* restore(hooks.onDispatch?.(entry.snapshot) ?? Effect.void)
        if (!entry.active) return yield* refusal("HANDLE_UNAVAILABLE")
        // There is no asynchronous environment, path, or permission lookup after this final
        // caller gate. Captured immutable argv/env/profile select the actual native process.
        yield* Effect.try({
          try: () => dispatch(entry),
          catch: (error) => (error instanceof Error ? error : refusal("SPAWN_FAILED")),
        })
        const completed = yield* restore(Effect.promise(() => bounded(entry.completion!, entry.snapshot.timeoutMs)))
        if (entry.stopReason) return yield* stop(entry, entry.stopReason)
        if (!completed) return yield* stop(entry, "timeout")
        if (completed.error) {
          yield* stop(entry, "spawn_failed")
          return yield* refusal("SPAWN_FAILED")
        }
        yield* finishOutput(entry)
        if (entry.stopReason) return yield* stop(entry, entry.stopReason)
        const output = outputs(entry)
        const contained = entry.snapshot.profile === "darwin-single-process-v1"
        const known = contained && output.stdout.complete && output.stderr.complete
        return record(entry, {
          state: known ? "exited" : "unknown",
          outcome: known ? (completed.exitCode === 0 ? "passed" : "failed") : null,
          stopProof: contained ? "not_requested" : "unconfirmed",
          reason: !contained ? "containment_unconfirmed" : known ? "command_exit" : "output_incomplete",
          exitCode: completed.exitCode,
          signal: completed.signal,
          ...output,
        })
      }).pipe(Effect.exit)
      if (Exit.isSuccess(result)) {
        release(entry)
        return result.value
      }
      if (entry.process) yield* stop(entry, "cancelled")
      if (!entry.process && entry.prepared)
        record(entry, {
          state: "cancelled_before_dispatch",
          outcome: "cancelled",
          stopProof: "not_started",
          reason: "dispatch_refused",
          exitCode: null,
          signal: null,
          ...outputs(entry),
        })
      release(entry)
      // Do not turn a stop, owner loss or journal failure into a normal failed validation result.
      return yield* Effect.failCause(result.cause)
    }),
  )
}

function dispatch(entry: Entry) {
  // This checks the current inode immediately after the caller's final gate, without yielding.
  // Native spawn still accepts a path rather than a directory fd: it is NOT an atomic defense
  // against a hostile concurrent filesystem writer and this profile is NOT a filesystem sandbox.
  const current = statSync(entry.snapshot.cwd)
  if (
    !current.isDirectory() ||
    current.dev !== entry.directory.dev ||
    current.ino !== entry.directory.ino ||
    realpathSync(entry.snapshot.cwd) !== entry.snapshot.cwd
  )
    throw refusal("HANDLE_UNAVAILABLE")
  const argv =
    entry.snapshot.profile === "darwin-single-process-v1"
      ? ["/usr/bin/sandbox-exec", "-p", sandbox, ...entry.argv]
      : entry.argv
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: entry.snapshot.cwd,
    env: entry.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: entry.snapshot.profile === "posix-process-group-v1",
  })
  entry.process = child
  entry.startedAt = Date.now()
  entry.completion = new Promise((resolve) => {
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal, error: false }))
    child.once("error", () => resolve({ exitCode: null, signal: null, error: true }))
  })
  entry.stdout = capture(child.stdout!)
  entry.stderr = capture(child.stderr!)
}

/** No provider, IM, OAuth, proxy or runtime-injection value is inherited from the host.
 * Adding an environment capability requires a new fixed, reviewed profile; hooks cannot add it.
 * Private HOME prevents accidental config discovery, not deliberate reads outside the cwd. */
const privateEnvironment = Effect.fn("OwnedValidation.privateEnvironment")(function* () {
  const state: { identity?: { dev: number; ino: number } } = {}
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const root = path.join(resolveDataPath(), "tmp")
        await fs.mkdir(root, { recursive: true, mode: 0o700 })
        return fs.mkdtemp(path.join(await fs.realpath(root), "dac-owned-validation-env-"))
      },
      catch: () => refusal("PROFILE_UNAVAILABLE"),
    }),
    (directory) =>
      Effect.tryPromise({
        try: async () => {
          const current = await fs.lstat(directory).catch((error: unknown) => {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
            throw error
          })
          if (!current) return
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            (state.identity && (current.dev !== state.identity.dev || current.ino !== state.identity.ino))
          )
            throw refusal("HANDLE_UNAVAILABLE")
          await fs.rm(directory, { recursive: true })
        },
        catch: () => refusal("PROFILE_UNAVAILABLE"),
      }).pipe(Effect.orDie),
  )
  yield* Effect.tryPromise({ try: () => fs.chmod(directory, 0o700), catch: () => refusal("PROFILE_UNAVAILABLE") })
  const stat = yield* Effect.tryPromise({ try: () => fs.lstat(directory), catch: () => refusal("PROFILE_UNAVAILABLE") })
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700)
    return yield* refusal("PROFILE_UNAVAILABLE")
  state.identity = { dev: stat.dev, ino: stat.ino }
  yield* Effect.tryPromise({
    try: () =>
      Promise.all(
        ["home", "tmp", "config", "data", "cache", "state"].map((name) =>
          fs.mkdir(path.join(directory, name), { mode: 0o700 }),
        ),
      ),
    catch: () => refusal("PROFILE_UNAVAILABLE"),
  })
  return {
    PATH: fixedPath,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
    TZ: "UTC",
    HOME: path.join(directory, "home"),
    TMPDIR: path.join(directory, "tmp"),
    TMP: path.join(directory, "tmp"),
    TEMP: path.join(directory, "tmp"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
  }
})

function stop(entry: Entry, reason: View["reason"]) {
  return Effect.gen(function* () {
    if (entry.receipt) return entry.receipt
    // Publish the stop intent before signalling. The normal wait may wake concurrently with
    // a scope finalizer and must not mistake our own SIGKILL for a business command failure.
    entry.stopReason ??= reason
    const child = entry.process
    if (!child || !entry.completion)
      return record(entry, {
        state: "cancelled_before_dispatch",
        outcome: "cancelled",
        stopProof: "not_started",
        reason,
        exitCode: null,
        signal: null,
        ...outputs(entry),
      })
    const signal = (value: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      // A group signal is best effort only. A descendant may have called setsid; this profile
      // NEVER converts group signalling or the parent's exit into proof of tree termination.
      if (entry.snapshot.profile === "posix-process-group-v1" && child.pid) {
        try {
          process.kill(-child.pid, value)
        } catch {
          /* Native handle fallback below. */
        }
      }
      try {
        child.kill(value)
      } catch {
        /* Only the exact wait below can confirm an exit. */
      }
    }
    signal("SIGTERM")
    const term = yield* Effect.promise(() => bounded(entry.completion!, 500))
    if (!term) signal("SIGKILL")
    const completion = term ?? (yield* Effect.promise(() => bounded(entry.completion!, 1500)))
    yield* finishOutput(entry)
    const confirmed =
      entry.snapshot.profile === "darwin-single-process-v1" && completion !== undefined && !completion.error
    return record(entry, {
      state: confirmed ? "stop_confirmed" : "unknown",
      outcome: confirmed ? "cancelled" : null,
      stopProof: confirmed ? "owned_process_exit" : "unconfirmed",
      reason: entry.stopReason,
      exitCode: completion?.exitCode ?? null,
      signal: completion?.signal ?? null,
      ...outputs(entry),
    })
  })
}

function capture(stream: Readable) {
  const state: { bytes: number; captured: number; complete: boolean; active: boolean; result?: Output } = {
    bytes: 0,
    captured: 0,
    complete: false,
    active: true,
  }
  const digest = createHash("sha256")
  const chunks: Buffer[] = []
  const data = (chunk: Buffer) => {
    if (!state.active) return
    digest.update(chunk)
    state.bytes += chunk.byteLength
    const count = Math.min(chunk.byteLength, limit - state.captured)
    if (count > 0) {
      chunks.push(Buffer.from(chunk.subarray(0, count)))
      state.captured += count
    }
  }
  stream.on("data", data)
  const drained = new Promise<void>((resolve) => {
    stream.once("end", () => {
      state.complete = true
      resolve()
    })
    stream.once("error", () => resolve())
    stream.once("close", () => resolve())
  })
  return {
    drained,
    close: () => stream.destroy(),
    finish: () => {
      if (state.result) return state.result
      state.active = false
      stream.off("data", data)
      // Invalid UTF-8 expands to replacement characters. Bound the rendered text as well as
      // retained raw bytes; the hash and byte count always describe the actual observed stream.
      const decoded = Buffer.from(Buffer.concat(chunks).toString("utf8"))
      state.result = Object.freeze({
        hash: digest.digest("hex"),
        bytes: state.bytes,
        capturedBytes: state.captured,
        truncated: state.bytes > state.captured || decoded.byteLength > limit,
        complete: state.complete,
        text: new TextDecoder().decode(decoded.subarray(0, limit), { stream: true }),
      })
      return state.result
    },
  }
}

function finishOutput(entry: Entry) {
  return Effect.promise(async () => {
    const complete = await bounded(Promise.all([entry.stdout?.drained, entry.stderr?.drained]), 300)
    if (complete === undefined) {
      entry.stdout?.close()
      entry.stderr?.close()
    }
  })
}
function outputs(entry: Entry) {
  const empty = () =>
    Object.freeze({ hash: hash(""), bytes: 0, capturedBytes: 0, truncated: false, complete: true, text: "" })
  return { stdout: entry.stdout?.finish() ?? empty(), stderr: entry.stderr?.finish() ?? empty() }
}
function record(entry: Entry, view: Omit<View, "snapshot" | "containment" | "startedAt" | "endedAt">) {
  if (entry.receipt) return entry.receipt
  const receipt = Object.freeze(Object.create(null)) as Receipt
  receipts.set(
    receipt,
    Object.freeze({
      ...view,
      snapshot: entry.snapshot,
      containment: entry.snapshot.profile === "darwin-single-process-v1" ? "single-process" : "posix-group",
      startedAt: entry.startedAt,
      endedAt: Date.now(),
    }),
  )
  entry.receipt = receipt
  return receipt
}
function release(entry: Entry) {
  if (entry.released || quarantine.has(entry)) return
  if (entry.receipt && receipts.get(entry.receipt)?.state === "unknown") {
    quarantine.add(entry)
    return
  }
  entry.released = true
  lifetime.live--
  entry.env = {}
  entry.argv = []
}
function bounded<A>(promise: Promise<A>, milliseconds: number): Promise<A | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
function refusal(code: Error["code"]) {
  return new Error({ code, message: "Owned validation is unavailable" })
}

export * as OwnedValidation from "./owned-validation"
