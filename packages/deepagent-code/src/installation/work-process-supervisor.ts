export * as NativeWorkProcessSupervisor from "./work-process-supervisor"

import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { isUtf8 } from "node:buffer"
import { spawn } from "node:child_process"
import { Config, Context, Effect, Option, Schema } from "effect"
import { WorkProcessSupervisorSchema } from "@deepagent-code/core/session/work-process-supervisor.schema"
import { WorkCommandV2Schema } from "@deepagent-code/core/session/work-command-v2.schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { NativeInstallation } from "./native-installation"
import type { WindowsWorkCommandRuntime } from "./windows-work-command-runtime"
import { WindowsWorkCommandDescription } from "./windows-work-command-description"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Stream = Schema.Struct({
  sha256: Digest,
  captured_sha256: Digest,
  bytes: Counter,
  captured_bytes: Counter,
  eof: Schema.Literal(true),
})
const Watchdog = Schema.Struct({
  poll_ms: Counter.check(Schema.isGreaterThanOrEqualTo(10), Schema.isLessThanOrEqualTo(100)),
  cpu_micros: Counter,
  observed_threads_max: Schema.NullOr(Counter),
  observed_output_bytes_max: Schema.NullOr(Counter),
  triggered: Schema.Array(Schema.Literals(["wall_time", "cpu_total", "threads", "output_bytes"])).check(
    Schema.isMaxLength(4),
  ),
})
const Event = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    version: Schema.Literal(2),
    nonce: Digest,
    work_id: Schema.String,
    command_id: Schema.String,
    recipe_hash: Digest,
    control_revision: Counter,
    root_pid: Counter,
    containment: Schema.Literals(["linux-cgroup2-single-payload-v1", "win32-job-appcontainer-single-payload-v1"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("data"),
    version: Schema.Literal(2),
    nonce: Digest,
    stream: Schema.Literals(["stdout", "stderr"]),
    hex: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{2}){1,8192}$/)),
  }),
  Schema.Struct({
    kind: Schema.Literal("stopped"),
    version: Schema.Literal(2),
    nonce: Digest,
    root_exit: Schema.Literal(true),
    tree_empty: Schema.Literal(true),
    stdout: Stream,
    stderr: Stream,
    cancelled: Schema.Boolean,
    exit_code: Schema.NullOr(Schema.Int),
    signal: Schema.optional(Schema.NullOr(Schema.Int)),
    elapsed_ms: Counter,
    watchdog: Watchdog,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    version: Schema.Literal(2),
    nonce: Digest,
    code: Schema.String,
  }),
])
const decodeEvent = (input: string) =>
  Option.flatMap(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input),
    Schema.decodeUnknownOption(Event, { onExcessProperty: "error" }),
  )
const Identity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("posix"), device: Schema.String, inode: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("windows"), volume_serial: Schema.String, file_id: Schema.String }),
])
const Image = Schema.Struct({ path: Schema.String, identity: Identity, sha256: Digest, bytes: Counter })
const InputFile = Schema.Struct({ relative: Schema.String, identity: Identity, sha256: Digest, bytes: Counter })
export const Binding = Schema.Struct({
  workID: Schema.String,
  commandID: Schema.String,
  recipeHash: Digest,
  controlRevision: Counter.check(Schema.isGreaterThan(0)),
})
export type Binding = typeof Binding.Type
export const Request = Schema.Struct({
  binding: Binding,
  configuration: WorkProcessSupervisorSchema.Configuration,
  workspace: Schema.String,
  workspaceIdentity: WorkProcessSupervisorSchema.Identity,
  executable: Image,
  inputs: Schema.Array(InputFile).check(Schema.isMaxLength(256)),
  outputs: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  argv: Schema.Array(Schema.String).check(Schema.isMaxLength(64)),
  cwd: Schema.optional(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(600_000)),
  stdoutBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_048_576)),
  stderrBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_048_576)),
})
export type Request = typeof Request.Type
export class Error extends Schema.TaggedErrorClass<Error>()("WorkProcessSupervisorError", {
  code: Schema.Literals([
    "SUPERVISOR_UNAVAILABLE",
    "SUPERVISOR_INVALID",
    "SUPERVISOR_UNKNOWN",
    "SUPERVISOR_AUTH_REQUIRED",
  ]),
  message: Schema.String,
}) {}
const refusal = (code: Error["code"]) => new Error({ code, message: "Native process supervision is unavailable" })
declare const originalReady: unique symbol
declare const originalStop: unique symbol
export interface Ready {
  readonly [originalReady]: true
}
export interface StopProof {
  readonly [originalStop]: true
}
export type Completion = Readonly<{ proof: StopProof; result: ReturnType<ReturnType<typeof projection>["finish"]>;
  stdout: Buffer; stderr: Buffer }>

/** Captured once by the owning Root. It must compare the original Ready binding
 * to current Work/source/control and commit admission before returning. */
export const Authority = Context.Reference<
  | {
      authorize: (ready: Ready, request: Request) => Effect.Effect<void, Error>
    }
  | undefined
>("NativeWorkProcessSupervisor.Authority", { defaultValue: () => undefined })
/** Operator-provisioned OS resource; never populated from Recipe/HTTP fields. */
export const Environment = Context.Reference<{ delegatedCgroup: string } | undefined>(
  "NativeWorkProcessSupervisor.Environment",
  { defaultValue: () => undefined },
)
/** Only local provisioning selects the delegated kernel resource. A recipe or
 * request cannot set this value; the native backend validates its controllers. */
export const provisionedEnvironment = Effect.gen(function* () {
  const current = yield* Environment
  if (current) return current
  const configured = yield* Config.string("DEEPAGENT_CODE_WORK_CGROUP").pipe(Config.option)
  return Option.isSome(configured) && path.isAbsolute(configured.value) ? { delegatedCgroup: configured.value } : undefined
})
export const requireProvisioning = Effect.gen(function* () {
  const configured = yield* provisionedEnvironment
  if (process.platform !== "linux" || !configured) return yield* refusal("SUPERVISOR_UNAVAILABLE")
  return yield* Effect.tryPromise({ try: async () => {
    if (await fs.realpath(configured.delegatedCgroup) !== configured.delegatedCgroup) throw refusal("SUPERVISOR_UNAVAILABLE")
    const file = await fs.open(configured.delegatedCgroup, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const observed = await file.stat({ bigint: true })
      const filesystem = await fs.statfs(configured.delegatedCgroup)
      if (observed.uid !== BigInt(process.getuid!()) || (observed.mode & 0o022n) !== 0n || filesystem.type !== 0x63677270)
        throw refusal("SUPERVISOR_UNAVAILABLE")
      const controllers = await fs.readFile(path.join(configured.delegatedCgroup, "cgroup.controllers"), "utf8")
      const enabled = await fs.readFile(path.join(configured.delegatedCgroup, "cgroup.subtree_control"), "utf8")
      if (!["cpu", "memory", "pids"].every((name) => controllers.split(/\s+/).includes(name) && enabled.split(/\s+/).includes(name)))
        throw refusal("SUPERVISOR_UNAVAILABLE")
      return configured
    } finally { await file.close() }
  }, catch: () => refusal("SUPERVISOR_UNAVAILABLE") })
})

/** Windows provisioning is the same original Root factory's installed command
 * capability, rather than a Linux cgroup configuration or a decoded recipe. */
export const requireWindowsProvisioning = Effect.gen(function* () {
  if (process.platform !== "win32") return yield* refusal("SUPERVISOR_UNAVAILABLE")
  const { NativeWindowsWorkFactory } = yield* Effect.promise(() => import("./windows-work-factory"))
  const original = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  if (Option.isNone(original) || !original.value.commandAvailable ||
    original.value.description.target !== `${process.platform}-${process.arch}`)
    return yield* refusal("SUPERVISOR_UNAVAILABLE")
  yield* original.value.current.pipe(Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")))
})

/** Approval/cold verification reads actual signed assets without creating a
 * Ready handle, an execution authority, or a supervisor process. */
export const inspectRuntime = Effect.fn("NativeWorkProcessSupervisor.inspectRuntime")(function* (
  installation: NativeInstallation.VerifiedInstalledComponents,
) {
  if (process.platform === "win32") {
    const { NativeWindowsWorkFactory } = yield* Effect.promise(() => import("./windows-work-factory"))
    const captured = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
    if (Option.isNone(captured)) return yield* refusal("SUPERVISOR_UNAVAILABLE")
    const factory = captured.value
    yield* NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")))
    yield* factory.current.pipe(Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")))
    const payload = factory.description.payload
    return Object.freeze({ supervisorHash: factory.description.supervisor.sha256, executable: Object.freeze({
      assetPath: payload.assetPath!, platform: factory.description.target, sha256: payload.sha256, bytes: payload.bytes,
      identity: payload.identity,
    }) })
  }
  if (process.platform !== "linux" || !Schema.is(WorkProcessSupervisorSchema.Target)(`${process.platform}-${process.arch}`))
    return yield* refusal("SUPERVISOR_UNAVAILABLE")
  yield* NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")))
  const target = `${process.platform}-${process.arch}` as "linux-arm64" | "linux-x64"
  const inventory = yield* NativeInstallation.inventory(installation)
  const directory = yield* NativeInstallation.assetDirectory(installation)
  const supervisor = inventory.find((entry) => entry.path === `packages/work-file-helper/bin/${target}/deepagent-work-process-supervisor`)
  const runtime = inventory.find((entry) => entry.path === `packages/work-file-helper/bin/${target}/bun-command-runtime`)
  if (!supervisor || !runtime) return yield* refusal("SUPERVISOR_UNAVAILABLE")
  const helper = yield* Effect.tryPromise({ try: () => verifiedFile(path.join(directory, "deepagent-work-process-supervisor"), supervisor), catch: () => refusal("SUPERVISOR_UNAVAILABLE") })
  yield* Effect.addFinalizer(() => Effect.promise(() => helper.close()))
  const file = yield* Effect.tryPromise({ try: () => verifiedFile(path.join(directory, "bun-command-runtime"), runtime), catch: () => refusal("SUPERVISOR_UNAVAILABLE") })
  yield* Effect.addFinalizer(() => Effect.promise(() => file.close()))
  const observed = yield* Effect.tryPromise({ try: () => file.stat({ bigint: true }), catch: () => refusal("SUPERVISOR_UNAVAILABLE") })
  return Object.freeze({ supervisorHash: supervisor.sha256, executable: Object.freeze({ assetPath: runtime.path,
    platform: target, sha256: runtime.sha256, bytes: runtime.bytes,
    identity: Object.freeze({ kind: "posix" as const, device: observed.dev.toString(), inode: observed.ino.toString() }) }) })
}, Effect.scoped)

type ReadyDescription = Readonly<
  Binding & { nonce: string; rootPID: number; containment: WorkProcessSupervisorSchema.Isolation["id"] }
>
const readyHandles = new WeakMap<Ready, { active: () => boolean; value: ReadyDescription }>()
const windowsStops = new WeakMap<StopProof, { active: () => boolean; workspace: WindowsWorkCommandRuntime.Workspace;
  retirement: WindowsWorkCommandDescription.Observation }>()
/** Only an original managed child can mint this association. A copied Stop
 * description or a different Workspace cannot authenticate Native retirement. */
export function describeWindowsStop(handle: StopProof, workspace: WindowsWorkCommandRuntime.Workspace) {
  const original = windowsStops.get(handle)
  return original?.active() && original.workspace === workspace ? original.retirement : undefined
}
export function describeReady(handle: Ready) {
  const entry = readyHandles.get(handle)
  return entry?.active() ? entry.value : undefined
}

/** Protocol validation is public and grants no stop authority. Only make's
 * original signed child/Scope path may wrap its result in a StopProof. */
export function projection(
  binding: Binding,
  nonce: string,
  containment: WorkProcessSupervisorSchema.Isolation["id"],
  limits: { stdoutBytes: number; stderrBytes: number },
) {
  const state = {
    ready: undefined as Extract<typeof Event.Type, { kind: "ready" }> | undefined,
    stopped: undefined as Extract<typeof Event.Type, { kind: "stopped" }> | undefined,
    stdout: { hash: createHash("sha256"), bytes: 0 },
    stderr: { hash: createHash("sha256"), bytes: 0 },
    pending: Buffer.alloc(0),
  }
  return {
    feed(chunk: Uint8Array) {
      // Native frames are bounded independently of the stream chunk boundary.
      const input = Buffer.concat([state.pending, chunk])
      const facts: (typeof Event.Type)[] = []
      const offset = { value: 0 }
      while (input.length - offset.value >= 4) {
        const bytes = input.readUInt32BE(offset.value)
        if (bytes === 0 || bytes > 65_536) throw refusal("SUPERVISOR_INVALID")
        if (input.length - offset.value < bytes + 4) break
        const body = input.subarray(offset.value + 4, offset.value + 4 + bytes)
        if (!isUtf8(body)) throw refusal("SUPERVISOR_INVALID")
        const decoded = decodeEvent(body.toString("utf8"))
        if (Option.isNone(decoded) || decoded.value.nonce !== nonce || state.stopped)
          throw refusal("SUPERVISOR_INVALID")
        const event = decoded.value
        if (event.kind === "unavailable") throw refusal("SUPERVISOR_UNKNOWN")
        if (event.kind === "ready") {
          if (
            state.ready ||
            event.work_id !== binding.workID ||
            event.command_id !== binding.commandID ||
            event.recipe_hash !== binding.recipeHash ||
            event.control_revision !== binding.controlRevision ||
            event.root_pid < 1 ||
            event.containment !== containment
          )
            throw refusal("SUPERVISOR_INVALID")
          state.ready = event
        }
        if (event.kind === "data") {
          if (!state.ready) throw refusal("SUPERVISOR_INVALID")
          const data = Buffer.from(event.hex, "hex")
          const stream = state[event.stream]
          stream.bytes += data.length
          if (stream.bytes > (event.stream === "stdout" ? limits.stdoutBytes : limits.stderrBytes))
            throw refusal("SUPERVISOR_INVALID")
          stream.hash.update(data)
        }
        if (event.kind === "stopped") {
          if (!state.ready) throw refusal("SUPERVISOR_INVALID")
          for (const name of ["stdout", "stderr"] as const) {
            const summary = event[name]
            if (
              summary.captured_bytes !== state[name].bytes ||
              summary.captured_bytes > summary.bytes ||
              summary.captured_sha256 !== state[name].hash.digest("hex") ||
              (summary.bytes === summary.captured_bytes && summary.sha256 !== summary.captured_sha256)
            )
              throw refusal("SUPERVISOR_INVALID")
          }
          state.stopped = event
        }
        facts.push(event)
        offset.value += bytes + 4
      }
      state.pending = input.subarray(offset.value)
      if (state.pending.length > 65_540) throw refusal("SUPERVISOR_INVALID")
      return facts
    },
    finish() {
      if (!state.stopped || state.pending.length !== 0) throw refusal("SUPERVISOR_UNKNOWN")
      return state.stopped
    },
  }
}

export const make = Effect.fn("NativeWorkProcessSupervisor.make")(function* (
  installation: NativeInstallation.VerifiedInstalledComponents,
  workspace?: WindowsWorkCommandRuntime.Workspace,
) {
  const authority = yield* Authority
  const context = yield* Effect.context()
  const environment = process.platform === "linux" ? yield* requireProvisioning : undefined
  const configuration = `${process.platform}-${process.arch}`
  if (!authority || !Schema.is(WorkProcessSupervisorSchema.Target)(configuration))
    return yield* refusal("SUPERVISOR_AUTH_REQUIRED")
  if (process.platform === "win32") {
    if (!workspace) return yield* refusal("SUPERVISOR_UNAVAILABLE")
    return yield* makeWindows(installation, workspace, authority, context)
  }
  if (process.platform !== "linux" || !environment) return yield* refusal("SUPERVISOR_UNAVAILABLE")
  const inventory = yield* NativeInstallation.inventory(installation).pipe(
    Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")),
  )
  const installed = yield* NativeInstallation.describe(installation).pipe(
    Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")),
  )
  if (installed.target !== configuration) return yield* refusal("SUPERVISOR_UNAVAILABLE")
  const directory = yield* NativeInstallation.assetDirectory(installation).pipe(
    Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")),
  )
  const helperPath = `packages/work-file-helper/bin/${configuration}/deepagent-work-process-supervisor`
  const component = inventory.find((entry) => entry.path === helperPath)
  if (!component) return yield* refusal("SUPERVISOR_UNAVAILABLE")
  const runtimeComponent = inventory.find(
    (entry) => entry.path === `packages/work-file-helper/bin/${configuration}/bun-command-runtime`,
  )
  if (!runtimeComponent) return yield* refusal("SUPERVISOR_UNAVAILABLE")
  const helper = yield* Effect.tryPromise({
    try: () => verifiedFile(path.join(directory, "deepagent-work-process-supervisor"), component),
    catch: () => refusal("SUPERVISOR_UNAVAILABLE"),
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => helper.close()))
  const lifetime = { active: true }
  const runtimeFile = yield* Effect.tryPromise({
    try: () => verifiedFile(path.join(directory, "bun-command-runtime"), runtimeComponent),
    catch: () => refusal("SUPERVISOR_UNAVAILABLE"),
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => runtimeFile.close()))
  const runtimeStat = yield* Effect.tryPromise({
    try: () => runtimeFile.stat({ bigint: true }),
    catch: () => refusal("SUPERVISOR_UNAVAILABLE"),
  })
  const executable: typeof Image.Type = Object.freeze({
    path: path.join(directory, "bun-command-runtime"),
    identity: Object.freeze({
      kind: "posix" as const,
      device: runtimeStat.dev.toString(),
      inode: runtimeStat.ino.toString(),
    }),
    sha256: runtimeComponent.sha256,
    bytes: runtimeComponent.bytes,
  })
  const stops = new WeakMap<StopProof, { result: ReturnType<ReturnType<typeof projection>["finish"]>;
    supervision: WorkCommandV2Schema.Supervision }>()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      lifetime.active = false
    }),
  )
  const current = () =>
    NativeInstallation.requireCurrent(installation).pipe(
      Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")),
      Effect.tap(() =>
        Effect.tryPromise({
          try: () => currentFile(helper, path.join(directory, "deepagent-work-process-supervisor"), component),
          catch: () => refusal("SUPERVISOR_UNAVAILABLE"),
        }),
      ),
      Effect.tap(() =>
        Effect.tryPromise({
          try: () => currentFile(runtimeFile, executable.path, runtimeComponent),
          catch: () => refusal("SUPERVISOR_UNAVAILABLE"),
        }),
      ),
      Effect.flatMap(() => (lifetime.active ? Effect.void : Effect.fail(refusal("SUPERVISOR_UNAVAILABLE")))),
    )
  return {
    describeStop(handle: StopProof) {
      return lifetime.active ? stops.get(handle) : undefined
    },
    executable: () => current().pipe(Effect.as(executable)),
    execute: Effect.fn("NativeWorkProcessSupervisor.execute")(function* (input: Request,
      onStopped?: (completed: Completion) => void) {
      yield* current()
      const decoded = Option.flatMap(
        Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(JSON.stringify(input)),
        Schema.decodeUnknownOption(Request, { onExcessProperty: "error" }),
      )
      if (
        Option.isNone(decoded) ||
        decoded.value.configuration.target !== configuration ||
        decoded.value.configuration.isolation.id !== "linux-cgroup2-single-payload-v1"
      )
        return yield* refusal("SUPERVISOR_INVALID")
      const request = frozen(decoded.value)
      const isolation = request.configuration.isolation
      if (isolation.id !== "linux-cgroup2-single-payload-v1") return yield* refusal("SUPERVISOR_INVALID")
      const runtime = inventory.find(
        (entry) => entry.path === `packages/work-file-helper/bin/${configuration}/bun-command-runtime`,
      )
      if (
        !runtime ||
        request.executable.path !== path.join(directory, "bun-command-runtime") ||
        request.executable.sha256 !== runtime.sha256 ||
        request.executable.bytes !== runtime.bytes ||
        request.executable.identity.kind !== "posix" || executable.identity.kind !== "posix" ||
        request.executable.identity.device !== executable.identity.device ||
        request.executable.identity.inode !== executable.identity.inode
      )
        return yield* refusal("SUPERVISOR_INVALID")
      const closure = inventory.filter((entry) =>
        entry.path.startsWith(`packages/work-file-helper/bin/${configuration}/runtime-closure/`),
      )
      // Dynamic-library closure must be an explicit installed component inventory.
      if (closure.length > 128) return yield* refusal("SUPERVISOR_UNAVAILABLE")
      const libraries = yield* Effect.forEach(closure, (component) =>
        Effect.tryPromise({
          try: async () => {
            const relative = component.path.slice(
              `packages/work-file-helper/bin/${configuration}/runtime-closure/`.length,
            )
            if (
              !/^(lib|lib64|usr\/lib|usr\/lib64)\//.test(relative) ||
              relative.split("/").some((part) => !part || part === "." || part === "..")
            )
              throw refusal("SUPERVISOR_UNAVAILABLE")
            const file = await verifiedFile(path.join(directory, "runtime-closure", relative), component, false)
            const observed = await file.stat({ bigint: true })
            return {
              file,
              image: {
                path: path.join(directory, "runtime-closure", relative),
                mount_path: `/${relative}`,
                identity: { kind: "posix" as const, device: observed.dev.toString(), inode: observed.ino.toString() },
                bytes: component.bytes,
                sha256: component.sha256,
              },
            }
          },
          catch: () => refusal("SUPERVISOR_UNAVAILABLE"),
        }).pipe(Effect.tap((entry) => Effect.addFinalizer(() => Effect.promise(() => entry.file.close())))),
      )
      const nonce = randomBytes(32).toString("hex")
      const native = {
        version: 2,
        nonce,
        work_id: request.binding.workID,
        command_id: request.binding.commandID,
        recipe_hash: request.binding.recipeHash,
        control_revision: request.binding.controlRevision,
        workspace: request.workspace,
        workspace_identity: identity(request.workspaceIdentity),
        executable: request.executable,
        inputs: request.inputs,
        outputs: request.outputs,
        argv: request.argv,
        cwd: request.cwd ?? null,
        env: request.env,
        isolation: {
          id: isolation.id,
          cpu: {
            quota_micros: isolation.cpu.quotaMicros,
            period_micros: isolation.cpu.periodMicros,
            total_watchdog_micros: isolation.cpu.totalWatchdogMicros,
            poll_ms: isolation.cpu.pollMs,
          },
          memory_max_bytes: isolation.memory.maxBytes,
          memory_swap_max_bytes: 0,
          tasks_max: 66,
          delegated_cgroup: environment.delegatedCgroup,
          runtime_files: libraries.map((entry) => entry.image),
        },
        timeout_ms: request.timeoutMs,
        stdout_bytes: request.stdoutBytes,
        stderr_bytes: request.stderrBytes,
      }
      const handle = Object.freeze(Object.create(null)) as Ready
      const observe = projection(request.binding, nonce, isolation.id, request)
      const captured = { rootPID: 0, stdout: [] as Buffer[], stderr: [] as Buffer[] }
      return yield* Effect.callback<Completion, Error>((resume, signal) => {
        const pending = (async () => {
          const child = spawn(`/proc/${process.pid}/fd/${helper.fd}`, [], { stdio: "pipe", env: {} })
          const ended = new Promise<number | null>((resolve, reject) => {
            child.once("close", resolve)
            child.once("error", reject)
          })
          const job = { done: false, sentCancel: false, stdinFailed: false }
          child.stdin.on("error", () => {
            job.stdinFailed = true
          })
          const cancel = () => {
            if (
              job.done ||
              job.sentCancel ||
              child.exitCode !== null ||
              child.signalCode !== null ||
              child.stdin.destroyed
            )
              return
            job.sentCancel = true
            child.stdin.write(frame({ action: "cancel", version: 2, nonce }))
          }
          signal.addEventListener("abort", cancel, { once: true })
          const timeout = setTimeout(cancel, request.timeoutMs + 1000)
          const force = setTimeout(() => {
            if (!job.done) child.kill("SIGKILL")
          }, request.timeoutMs + 7000)
          const diagnostics = { bytes: 0 }
          const stderr = (async () => {
            for await (const chunk of child.stderr) {
              diagnostics.bytes += Buffer.byteLength(chunk)
              if (diagnostics.bytes > 8192) {
                cancel()
                throw refusal("SUPERVISOR_UNKNOWN")
              }
            }
          })()
          try {
            child.stdin.write(frame(native))
            for await (const chunk of child.stdout) {
              for (const event of observe.feed(chunk)) {
                if (event.kind === "data") captured[event.stream].push(Buffer.from(event.hex, "hex"))
                if (event.kind !== "ready") continue
                captured.rootPID = event.root_pid
                readyHandles.set(handle, {
                  active: () => lifetime.active && !job.done,
                  value: Object.freeze({
                    ...request.binding,
                    nonce,
                    rootPID: event.root_pid,
                    containment: event.containment,
                  }),
                })
                await Effect.runPromise(authority.authorize(handle, request).pipe(Effect.provide(context)), { signal })
                await Effect.runPromise(current().pipe(Effect.provide(context)))
                if (signal.aborted || job.sentCancel || job.stdinFailed || !describeReady(handle))
                  throw refusal("SUPERVISOR_UNKNOWN")
                child.stdin.write(frame({ action: "continue", version: 2, nonce }))
              }
            }
            const code = await ended
            await stderr
            if (code !== 0 || diagnostics.bytes !== 0) throw refusal("SUPERVISOR_UNKNOWN")
            const result = observe.finish()
            await Effect.runPromise(current().pipe(Effect.provide(context)))
            const proof = Object.freeze(Object.create(null)) as StopProof
            const supervision: WorkCommandV2Schema.Supervision = { version: 2, target: configuration,
              supervisorHash: component.sha256, isolationHash: Hash.sha256(CanonicalJson.stringify(request.configuration.isolation)),
              stopHash: Hash.sha256(CanonicalJson.stringify(result)), nonce, rootPID: captured.rootPID,
              rootExit: true, treeEmpty: true, stdoutEOF: true, stderrEOF: true }
            stops.set(proof, frozen({ result, supervision }))
            const completed = { proof, result, stdout: Buffer.concat(captured.stdout), stderr: Buffer.concat(captured.stderr) }
            onStopped?.(completed)
            return completed
          } finally {
            cancel()
            job.done = true
            readyHandles.delete(handle)
            signal.removeEventListener("abort", cancel)
            clearTimeout(timeout)
            clearTimeout(force)
            child.stdin.end()
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
            await ended.catch(() => undefined)
            await stderr.catch(() => undefined)
          }
        })()
        pending.then((value) => resume(Effect.succeed(value)), (error: unknown) => resume(Effect.fail(error instanceof Error ? error : refusal("SUPERVISOR_UNKNOWN"))))
        // Scope interruption waits for the exact child/EOF/containment protocol.
        // The observer retains only an original StopProof; abort itself proves nothing.
        return Effect.promise(() => pending.then(() => undefined, () => undefined))
      })
    }, Effect.scoped),
  }
})

/** The Windows port derives execution only from the original Root's opaque
 * Workspace. Request image/path fields are checked, never used to spawn. */
function makeWindows(installation: NativeInstallation.VerifiedInstalledComponents,
  workspace: WindowsWorkCommandRuntime.Workspace,
  authority: NonNullable<Context.Service.Shape<typeof Authority>>,
  context: Context.Context<never>) {
  return Effect.gen(function* () {
    const { NativeWindowsWorkFactory } = yield* Effect.promise(() => import("./windows-work-factory"))
    const { WindowsWorkCommandRuntime } = yield* Effect.promise(() => import("./windows-work-command-runtime"))
    const capturedFactory = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
    const capturedRuntime = yield* Effect.serviceOption(WindowsWorkCommandRuntime.Service)
    if (Option.isNone(capturedFactory) || Option.isNone(capturedRuntime)) return yield* refusal("SUPERVISOR_UNAVAILABLE")
    const factory = capturedFactory.value
    const runtime = capturedRuntime.value
    const lifetime = { active: true }
    const stops = new WeakMap<StopProof, { result: ReturnType<ReturnType<typeof projection>["finish"]>;
      supervision: WorkCommandV2Schema.Supervision }>()
    yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false }))
    const current = NativeInstallation.requireCurrent(installation).pipe(
      Effect.andThen(factory.current), Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")),
      Effect.andThen(Effect.suspend(() => lifetime.active ? Effect.void : Effect.fail(refusal("SUPERVISOR_UNAVAILABLE")))))
    yield* current
    const configuration = factory.description.target
    const payload = factory.description.payload
    const executable: typeof Image.Type = Object.freeze({ path: payload.path, sha256: payload.sha256, bytes: payload.bytes,
      identity: Object.freeze({ kind: "windows" as const, volume_serial: payload.identity.volumeSerial,
        file_id: payload.identity.fileID }) })
    return {
      describeStop: (handle: StopProof) => lifetime.active ? stops.get(handle) : undefined,
      executable: () => current.pipe(Effect.as(executable)),
      execute: Effect.fn("NativeWorkProcessSupervisor.executeWindows")(function* (input: Request,
        onStopped?: (completed: Completion) => void) {
        yield* current
        const decoded = Schema.decodeUnknownOption(Request, { onExcessProperty: "error" })(input)
        if (Option.isNone(decoded) || decoded.value.configuration.target !== configuration ||
          decoded.value.configuration.isolation.id !== "win32-job-appcontainer-single-payload-v1" ||
          decoded.value.workspace !== workspace.directory ||
          CanonicalJson.stringify(decoded.value.workspaceIdentity) !== CanonicalJson.stringify(workspace.identity) ||
          CanonicalJson.stringify(decoded.value.executable) !== CanonicalJson.stringify(executable))
          return yield* refusal("SUPERVISOR_INVALID")
        const request = frozen(decoded.value)
        const isolation = request.configuration.isolation
        if (isolation.id !== "win32-job-appcontainer-single-payload-v1") return yield* refusal("SUPERVISOR_INVALID")
        const nonce = randomBytes(32).toString("hex")
        const child = yield* runtime.launchCommand(workspace, { version: 2, nonce,
          work_id: request.binding.workID, command_id: request.binding.commandID,
          recipe_hash: request.binding.recipeHash, control_revision: request.binding.controlRevision,
          inputs: request.inputs.map((entry) => entry.relative), outputs: [...request.outputs], argv: [...request.argv],
          cwd: request.cwd ?? null, env: { ...request.env },
          cpu: { hard_cap_percent: isolation.cpu.hardCapPercent, job_user_time_limit_100ns: isolation.cpu.jobUserTimeLimit100ns,
            total_watchdog_micros: isolation.cpu.totalWatchdogMicros, poll_ms: isolation.cpu.pollMs },
          job_commit_max_bytes: isolation.memory.jobCommitMaxBytes,
          timeout_ms: request.timeoutMs, stdout_bytes: request.stdoutBytes, stderr_bytes: request.stderrBytes,
        }).pipe(Effect.mapError(() => refusal("SUPERVISOR_UNAVAILABLE")))
        const handle = Object.freeze(Object.create(null)) as Ready
        const observe = projection(request.binding, nonce, isolation.id, request)
        const captured = { rootPID: 0, stdout: [] as Buffer[], stderr: [] as Buffer[] }
        return yield* Effect.callback<Completion, Error>((resume, signal) => {
          const state = { done: false, cancelled: false, joined: false }
          const cancel = () => {
            if (state.done || state.cancelled) return
            state.cancelled = true
            try { child.cancel() } catch {}
          }
          const pending = (async () => {
            signal.addEventListener("abort", cancel, { once: true })
            const timeout = setTimeout(cancel, request.timeoutMs + 1000)
            try {
              const deadline = Date.now() + request.timeoutMs + 7000
              while (Date.now() < deadline) {
                const value = child.read()
                if (value.kind === "stderr" && value.bytes.length) throw refusal("SUPERVISOR_UNKNOWN")
                if (value.kind === "stdout") for (const event of observe.feed(value.bytes)) {
                  if (event.kind === "data") captured[event.stream].push(Buffer.from(event.hex, "hex"))
                  if (event.kind !== "ready") continue
                  captured.rootPID = event.root_pid
                  readyHandles.set(handle, { active: () => lifetime.active && !state.done,
                    value: Object.freeze({ ...request.binding, nonce, rootPID: event.root_pid, containment: event.containment }) })
                  await Effect.runPromise(authority.authorize(handle, request).pipe(Effect.provide(context)), { signal })
                  await Effect.runPromise(current.pipe(Effect.provide(context)))
                  if (signal.aborted || state.cancelled || !describeReady(handle)) throw refusal("SUPERVISOR_UNKNOWN")
                  child.control("continue")
                }
                if (value.kind === "exit") {
                  if (value.exitCode !== 0) throw refusal("SUPERVISOR_UNKNOWN")
                  const result = observe.finish()
                  const retirement = WindowsWorkCommandDescription.decode(child.describe())
                  if (Option.isNone(retirement) || retirement.value.phase !== "retired" || !retirement.value.aclRestoreHash ||
                    !child.close()) throw refusal("SUPERVISOR_UNKNOWN")
                  state.joined = true
                  await Effect.runPromise(current.pipe(Effect.provide(context)))
                  const proof = Object.freeze(Object.create(null)) as StopProof
                  const supervision: WorkCommandV2Schema.Supervision = { version: 2, target: configuration,
                    supervisorHash: factory.description.supervisor.sha256,
                    isolationHash: Hash.sha256(CanonicalJson.stringify(isolation)), stopHash: Hash.sha256(CanonicalJson.stringify(result)),
                    nonce, rootPID: captured.rootPID, rootExit: true, treeEmpty: true, stdoutEOF: true, stderrEOF: true }
                  stops.set(proof, frozen({ result, supervision }))
                  windowsStops.set(proof, { active: () => lifetime.active && factory.isCurrent(), workspace, retirement: frozen(retirement.value) })
                  const completed = { proof, result, stdout: Buffer.concat(captured.stdout), stderr: Buffer.concat(captured.stderr) }
                  onStopped?.(completed)
                  return completed
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 15))
              }
              throw refusal("SUPERVISOR_UNKNOWN")
            } finally {
              try { cancel() } catch {}
              readyHandles.delete(handle)
              signal.removeEventListener("abort", cancel)
              clearTimeout(timeout)
              if (!state.joined) {
                const deadline = Date.now() + 5000
                while (Date.now() < deadline) {
                  try {
                    const observed = child.read()
                    if (observed.kind === "exit" && child.close()) { state.joined = true; break }
                  } catch { break }
                  await new Promise<void>((resolve) => setTimeout(resolve, 15))
                }
              }
              // A failed join preserves Native custody; it never mints Stop or
              // releases the workspace reservation because a Promise rejected.
              state.done = true
            }
          })()
          pending.then((completed) => resume(Effect.succeed(completed)), (error: unknown) =>
            resume(Effect.fail(error instanceof Error ? error : refusal("SUPERVISOR_UNKNOWN"))))
          return Effect.promise(() => pending.then(() => undefined, () => undefined))
        })
      }, Effect.scoped),
    }
  })
}

function identity(value: WorkProcessSupervisorSchema.Identity) {
  return value.kind === "posix"
    ? value
    : { kind: "windows" as const, volume_serial: value.volumeSerial, file_id: value.fileID }
}
function frame(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length < 1 || bytes.length > 65_536) throw refusal("SUPERVISOR_INVALID")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(bytes.length)
  return Buffer.concat([header, bytes])
}
async function verifiedFile(filename: string, component: { bytes: number; sha256: string }, executable = true) {
  if (component.bytes < 1 || component.bytes > 268_435_456 || (await fs.realpath(filename)) !== filename)
    throw refusal("SUPERVISOR_UNAVAILABLE")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  await currentFile(file, filename, component, executable).catch(async (error: unknown) => {
    await file.close()
    throw error
  })
  return file
}
async function currentFile(
  file: Awaited<ReturnType<typeof fs.open>>,
  filename: string,
  component: { bytes: number; sha256: string },
  executable = true,
) {
  const actual = await file.stat({ bigint: true })
  const hash = createHash("sha256")
  const buffer = Buffer.alloc(65_536)
  const cursor = { bytes: 0 }
  while (cursor.bytes <= component.bytes) {
    const read = await file.read(buffer, 0, buffer.length, cursor.bytes)
    if (!read.bytesRead) break
    cursor.bytes += read.bytesRead
    hash.update(buffer.subarray(0, read.bytesRead))
  }
  if (
    !actual.isFile() ||
    actual.nlink !== 1n ||
    actual.size !== BigInt(component.bytes) ||
    (actual.mode & 0o022n) !== 0n ||
    (executable && (actual.mode & 0o111n) === 0n) ||
    (actual.uid !== 0n && actual.uid !== BigInt(process.getuid!())) ||
    cursor.bytes !== component.bytes ||
    hash.digest("hex") !== component.sha256
  )
    throw refusal("SUPERVISOR_UNAVAILABLE")
  const named = await fs.lstat(filename, { bigint: true })
  const after = await file.stat({ bigint: true })
  if (
    [actual, named].some(
      (stat) =>
        [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(":") !==
        [after.dev, after.ino, after.size, after.ctimeNs, after.mtimeNs].join(":"),
    )
  ) {
    throw refusal("SUPERVISOR_UNAVAILABLE")
  }
}
function frozen<A>(value: A): A {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }
  return value
}
