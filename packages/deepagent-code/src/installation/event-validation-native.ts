import { Effect, Layer, Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { Global } from "@deepagent-code/core/global"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { WorkFileHelper } from "./work-file-helper"
import { WorkCommandRuntime } from "./work-command-runtime"
import { EventValidationPlatform } from "./event-validation-platform"
import type { EventValidationLinux } from "./event-validation-linux"

const failure = () => new EventValidationSchema.Error({ code: "VALIDATION_UNAVAILABLE", message: "Installed project validation is unavailable or changed" })
const Reply = Schema.Struct({ version: Schema.Literal(1), id: Schema.String, status: Schema.String,
  code: Schema.NullOr(Schema.String), root: Schema.NullOr(WorkCommandSchema.Identity), payload_bytes: EventValidationSchema.Count,
  observation: Schema.NullOr(Schema.Struct({ identity: WorkCommandSchema.Identity, offset: EventValidationSchema.Count,
    file_bytes: EventValidationSchema.Count, scanned_bytes: EventValidationSchema.Count,
    observed_sha256: EventValidationSchema.Digest, page_sha256: EventValidationSchema.Digest, snapshot: Schema.Literal("stream_observation") })),
  snapshot: Schema.optional(Schema.Struct({ workspace: WorkCommandSchema.Identity, manifest_sha256: EventValidationSchema.Digest,
    files: EventValidationSchema.Count, bytes: EventValidationSchema.Count, output_files: EventValidationSchema.Count })),
})
type Configuration = EventValidationSchema.Configuration
type Workspace = Awaited<ReturnType<typeof WorkCommandRuntime.createWorkspace>>
type Asset = Effect.Success<ReturnType<typeof WorkFileHelper.validationAsset>>
type Entry = { configuration: Configuration; observation: EventValidationSchema.Content; workspace: Workspace;
  asset: Asset; executable: string | null; deadline: number; used: boolean; dispatched: boolean; active: boolean; cleaned: boolean;
  copiedInputs?: Awaited<ReturnType<typeof EventValidationLinux.copiedInputs>>;
  snapshot: NonNullable<ReturnType<EventValidation.Native["Service"]["snapshot"]>>;
  result?: EventValidationSchema.Result; outputs?: { relative: string; sha256: string; bytes: number }[]; preparation?: PreparationEntry }
type PreparationEntry = { input: EventValidation.PreparationInput; configuration: Configuration; configHash: string; contentHash: string;
  id: string; attempted: boolean; used: boolean; preparing: boolean; executing: boolean; dispatched: boolean; workspace?: Workspace; disposition?: EventValidation.PreparationDisposition;
  snapshot?: { snapshotHash: string; incarnation: string } }

/** The same fixed helper and runtime used by managed Work commands; this factory adds
 * no executable/path/env override. Rule authorization remains in the durable caller. */
export const layer = Layer.effect(EventValidation.Native, Effect.gen(function* () {
  const global = yield* Global.Service
  const approvals = new WeakMap<EventValidation.Approval, { configHash: string; active: boolean }>()
  const observations = new WeakMap<EventValidation.Observation, { configuration: string; content: EventValidationSchema.Content }>()
  const handles = new WeakMap<EventValidation.Handle, Entry>()
  const preparations = new WeakMap<EventValidation.Preparation, PreparationEntry>()
  const active = new Set<Entry>()
  const lifetime = { active: true, capturing: 0 }
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    lifetime.active = false
    // Process lifetime is held by execute's interruptible Effect, never reconstructed
    // from a PID. Unknown private workspaces intentionally survive scope closure.
    await Promise.all([...active].map(async (entry) => { entry.active = false; await entry.workspace.file.close() }))
  }))
  const current = (configuration: Configuration) => Effect.gen(function* () {
    if (!lifetime.active || !EventValidationPlatform.supports(configuration.recipe)) return yield* failure()
    const asset = yield* WorkFileHelper.validationAsset(configuration.helperHash).pipe(
      Effect.tapError(() => Effect.logWarning('event_validation_current_refused {"stage":"native-helper"}')),
      Effect.mapError(failure),
    )
    const recipe = configuration.recipe
    const executable = recipe.schemaVersion === "work-command-recipe.v2"
      ? yield* Effect.gen(function* () {
          const { EventValidationLinux } = yield* Effect.promise(() => import("./event-validation-linux"))
          yield* EventValidationLinux.current(asset, configuration)
          return null
        })
      : yield* Effect.tryPromise({ try: () => WorkCommandRuntime.verifiedMacRecipeRuntime(asset.installation, recipe), catch: failure }).pipe(
          Effect.tapError(() => Effect.logWarning('event_validation_current_refused {"stage":"native-recipe-runtime"}')),
        )
    const root = yield* WorkFileHelper.inspectRoot(configuration.scope.canonicalRoot).pipe(
      Effect.tapError(() => Effect.logWarning('event_validation_current_refused {"stage":"native-project-root"}')),
      Effect.mapError(failure),
    )
    if (EventValidation.hash(root.rootIdentity) !== EventValidation.hash(configuration.scope.rootIdentity) || root.helperHash !== configuration.helperHash) {
      yield* Effect.logWarning('event_validation_current_refused {"stage":"native-project-identity"}')
      return yield* failure()
    }
    return { asset, executable }
  })
  const service: EventValidation.Native["Service"] = EventValidation.Native.of({
    approve: (configuration) => Effect.gen(function* () {
      yield* current(configuration)
      const approval = Object.freeze({}) as EventValidation.Approval
      approvals.set(approval, { configHash: EventValidation.hash(configuration), active: true })
      return approval
    }),
    approved: (approval, configuration) => lifetime.active && approvals.get(approval)?.active === true &&
      approvals.get(approval)?.configHash === EventValidation.hash(configuration),
    observe: (configuration) => Effect.gen(function* () {
      if (lifetime.capturing >= 8) return yield* failure()
      lifetime.capturing++
      return yield* Effect.gen(function* () {
        const captured = yield* current(configuration)
        const content = yield* Effect.tryPromise({ try: (signal) => withChannel(captured.asset, configuration, undefined, signal, async (request) => {
          const files: EventValidationSchema.Content["files"][number][] = []
          for (const relative of [...configuration.watch].sort()) {
            const reply = await request({ op: "observe", relative, scan_limit: 16_777_216, deadline_ms: 10_000 })
            if (reply.code !== null || EventValidation.hash(reply.root) !== EventValidation.hash(configuration.scope.rootIdentity)) throw failure()
            if (reply.status === "missing" && reply.observation === null) {
              files.push({ relative, identity: null, sha256: null, bytes: 0, missing: true })
              continue
            }
            const observed = reply.observation
            if (reply.status !== "observed" || !observed || observed.offset !== 0 || observed.scanned_bytes !== observed.file_bytes || observed.file_bytes > 16_777_216 ||
              files.reduce((sum, item) => sum + item.bytes, observed.file_bytes) > 67_108_864) throw failure()
            files.push({ relative, identity: observed.identity, sha256: observed.observed_sha256, bytes: observed.file_bytes, missing: false })
          }
          return { files, contentHash: EventValidation.hash({ scope: configuration.scope,
            files: files.map((file) => ({ relative: file.relative, sha256: file.sha256, bytes: file.bytes, missing: file.missing })) }), observedAt: Date.now() }
        }), catch: failure })
        yield* captured.asset.current.pipe(Effect.mapError(failure))
        const observation = Object.freeze({}) as EventValidation.Observation
        observations.set(observation, { configuration: EventValidation.hash(configuration), content })
        return observation
      }).pipe(Effect.ensuring(Effect.sync(() => { lifetime.capturing-- })))
    }),
    content: (observation, configuration) => {
      const entry = observations.get(observation)
      return lifetime.active && entry?.configuration === EventValidation.hash(configuration) ? structuredClone(entry.content) : undefined
    },
    preparation: (configuration, observation, claim) => Effect.gen(function* () {
      const content = observations.get(observation)
      const input = EventValidation.inspectPreparationClaim(claim, service)
      if (!lifetime.active || !input || !content || content.configuration !== EventValidation.hash(configuration) ||
        input.configHash !== content.configuration || input.contentHash !== content.content.contentHash) return yield* failure()
      const value = Object.freeze({}) as EventValidation.Preparation
      preparations.set(value, { input: { ...input }, configuration: structuredClone(configuration), configHash: content.configuration,
        contentHash: content.content.contentHash, id: randomUUID(), attempted: false, used: false, preparing: false, executing: false, dispatched: false })
      return value
    }),
    cleanupPreparation: (preparation) => Effect.gen(function* () {
      const entry = preparations.get(preparation)
      if (!lifetime.active || !entry || entry.preparing || entry.executing || entry.dispatched) return yield* failure()
      if (entry.disposition) return
      if (entry.attempted && !entry.workspace) return yield* failure()
      if (entry.workspace) yield* Effect.tryPromise({ try: () => WorkCommandRuntime.cleanupPreparedWorkspace(entry.workspace!,
        [...entry.configuration.recipe.inputs, ...entry.configuration.recipe.outputs]), catch: failure })
      entry.disposition = { ...entry.input, preparationID: entry.id, configHash: entry.configHash, contentHash: entry.contentHash,
        kind: entry.workspace ? "partial_workspace_cleaned" : "no_workspace_created",
        workspaceIdentity: entry.workspace?.identity ?? null, observedAt: Date.now(),
        snapshotHash: entry.snapshot?.snapshotHash ?? null, incarnation: entry.snapshot?.incarnation ?? null }
    }),
    disposition: (preparation) => {
      const entry = preparations.get(preparation)
      return lifetime.active && entry?.disposition ? structuredClone(entry.disposition) : undefined
    },
    prepare: (configuration, observation, workspaceBasename, deadline, preparation) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const content = observations.get(observation)
      const pending = preparation ? preparations.get(preparation) : undefined
      if (preparation && (!pending || pending.used || pending.disposition || pending.input.workspaceBasename !== workspaceBasename || pending.input.deadline !== deadline ||
        pending.configHash !== EventValidation.hash(configuration) || pending.contentHash !== content?.content.contentHash)) return yield* failure()
      if (configuration.recipe.schemaVersion === "work-command-recipe.v2" && !pending?.input.supervisorBinding) return yield* failure()
      if (pending) { pending.used = true; pending.preparing = true }
      if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > configuration.expiresAt || !lifetime.active || !content || content.configuration !== EventValidation.hash(configuration) || active.size >= 8) return yield* failure()
      if (configuration.recipe.inputs.some((relative) => !content.content.files.some((file) => file.relative === relative && !file.missing))) return yield* failure()
      const captured = yield* restore(current(configuration))
      const workspace = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => WorkCommandRuntime.createWorkspace(global.data, workspaceBasename, configuration.scope.canonicalRoot,
          pending ? { creating: () => { pending.attempted = true }, created: value => { pending.workspace = value } } : undefined), catch: failure }),
        (value) => Effect.promise(() => value.file.close()))
      const inputs = content.content.files.filter((item) => configuration.recipe.inputs.includes(item.relative))
      const snapshot = yield* restore(Effect.callback<NonNullable<typeof Reply.Type.snapshot>, EventValidationSchema.Error>((resume, signal) => {
        const pending = withChannel(captured.asset, configuration, workspace, signal, async (request) => {
        const reply = await request({ op: "snapshot_workspace", workspace: workspace.directory, workspace_identity: workspace.identity,
          inputs: inputs.map((item) => ({ relative: item.relative, identity: item.identity, sha256: item.sha256, bytes: item.bytes })),
          outputs: configuration.recipe.outputs, deadline_ms: 30_000 })
        if (reply.status !== "snapshot_ready" || !reply.snapshot || EventValidation.hash(reply.snapshot.workspace) !== EventValidation.hash(workspace.identity) ||
          reply.snapshot.files !== inputs.length || reply.snapshot.bytes !== inputs.reduce((sum, item) => sum + item.bytes, 0) ||
          reply.snapshot.output_files !== configuration.recipe.outputs.length) throw failure()
        return reply.snapshot
        }).then(value => resume(Effect.succeed(value)), () => resume(Effect.fail(failure())))
        // Abort is only a request: join exact helper exit before partial cleanup.
        return Effect.promise(() => pending)
      }))
      yield* captured.asset.current.pipe(Effect.mapError(failure))
      const handle = Object.freeze({}) as EventValidation.Handle
      const entry: Entry = { configuration: structuredClone(configuration), observation: content.content, workspace, asset: captured.asset,
        executable: captured.executable?.filename ?? null, deadline, used: false, dispatched: false, active: true, cleaned: false, preparation: pending,
        snapshot: { snapshotHash: snapshot.manifest_sha256, incarnation: randomUUID(), configHash: content.configuration,
          contentHash: content.content.contentHash, workspaceBasename, workspaceIdentity: workspace.identity } }
      if (configuration.recipe.schemaVersion === "work-command-recipe.v2") {
        const { EventValidationLinux } = yield* Effect.promise(() => import("./event-validation-linux"))
        entry.copiedInputs = yield* Effect.tryPromise({ try: () => EventValidationLinux.copiedInputs(workspace, configuration, content.content), catch: failure })
      }
      handles.set(handle, entry); active.add(entry)
      if (pending) pending.snapshot = entry.snapshot
      yield* Effect.addFinalizer(() => Effect.promise(async () => { entry.active = false; active.delete(entry) }))
      return handle
    })).pipe(Effect.ensuring(Effect.sync(() => {
      const pending = preparation ? preparations.get(preparation) : undefined
      if (pending) pending.preparing = false
    }))),
    snapshot: (handle) => {
      const entry = handles.get(handle)
      return lifetime.active && entry?.active ? structuredClone(entry.snapshot) : undefined
    },
    execute: (handle, hooks) => Effect.gen(function* () {
      const entry = handles.get(handle)
      if (!entry?.active || entry.used || !lifetime.active) return yield* failure()
      if (entry.preparation) entry.preparation.executing = true
      yield* current(entry.configuration)
      yield* Effect.tryPromise({ try: () => WorkCommandRuntime.currentWorkspace(entry.workspace), catch: failure })
      entry.used = true
      const context = yield* Effect.context()
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        if (entry.configuration.recipe.schemaVersion === "work-command-recipe.v2") {
          const { EventValidationLinux } = yield* Effect.promise(() => import("./event-validation-linux"))
          if (!entry.preparation || !entry.copiedInputs) return yield* failure()
          return yield* restore(EventValidationLinux.execute({ asset: entry.asset, configuration: entry.configuration,
            workspace: entry.workspace, deadline: entry.deadline, preparation: entry.preparation.input, inputs: entry.copiedInputs }, {
            beforeDispatch: hooks.beforeDispatch.pipe(Effect.andThen(Effect.sync(() => {
              entry.dispatched = true
              entry.preparation!.dispatched = true
            }))), started: hooks.started,
          }, (result) => { entry.result = result }))
        }
        const executable = entry.executable
        const recipe = entry.configuration.recipe
        if (executable === null) return yield* failure()
        yield* hooks.beforeDispatch
        entry.dispatched = true
        if (entry.preparation) entry.preparation.dispatched = true
        yield* restore(Effect.callback<void, EventValidationSchema.Error>((resume, signal) => {
          const pending = WorkCommandRuntime.execute({ helper: entry.asset.filename, executable,
            workspace: entry.workspace.directory, identity: entry.workspace.identity, recipe,
            parameters: entry.configuration.parameters, deadline: entry.deadline, signal,
            onStarted: (pid) => Effect.runPromise(hooks.started(pid).pipe(Effect.provide(context))),
          }).then((value) => {
            const stream = (output: typeof value.stdout) => ({ sha256: output.sha256, bytes: output.bytes,
              capturedBytes: output.capturedBytes, truncated: output.truncated, complete: output.complete,
              excerpt: excerpt(output.text), excerptTruncated: Buffer.byteLength(output.text) > 65_536 || output.truncated })
            entry.result = { outcome: value.outcome === "cancelled" ? "cancelled" : value.exitCode === 0 ? "passed" : "failed",
              exitCode: value.exitCode, signal: value.signal, stdout: stream(value.stdout), stderr: stream(value.stderr),
              stopConfirmed: value.stopConfirmed, endedAt: Date.now() }
            resume(Effect.void)
          }, () => resume(Effect.fail(failure())))
          return Effect.promise(() => pending)
        }))
      }))
    }).pipe(Effect.ensuring(Effect.sync(() => {
      const entry = handles.get(handle)
      if (entry?.preparation) entry.preparation.executing = false
    }))),
    result: (handle) => {
      const entry = handles.get(handle)
      return lifetime.active && entry?.active && entry.result ? structuredClone(entry.result) : undefined
    },
    cleanup: (handle) => Effect.gen(function* () {
      const entry = handles.get(handle)
      if (!entry?.active || (entry.dispatched && (!entry.result?.stopConfirmed || !entry.result.stdout.complete || !entry.result.stderr.complete))) return yield* failure()
      if (entry.cleaned) return
      entry.outputs = yield* Effect.tryPromise({ try: () => Promise.all(entry.configuration.recipe.outputs.map(async (relative) =>
        (await WorkCommandRuntime.readOutput(entry.workspace, relative)).description)), catch: failure })
      const inputs = entry.observation.files.filter((item) => entry.configuration.recipe.inputs.includes(item.relative))
        .map((item) => ({ relative: item.relative, bytes: item.bytes, sha256: item.sha256! }))
      yield* Effect.tryPromise({ try: () => WorkCommandRuntime.cleanupWorkspace(entry.workspace, [...inputs, ...entry.outputs!]), catch: failure })
      entry.cleaned = true
    }),
    cleaned: (handle) => handles.get(handle)?.cleaned === true,
  })
  return service
}))

function excerpt(text: string) {
  const bytes = Buffer.from(text)
  if (bytes.length <= 65_536) return text
  const end = { value: 65_536 }
  while ((bytes[end.value]! & 0xc0) === 0x80) end.value--
  return bytes.subarray(0, end.value).toString("utf8")
}

/** Strict bounded helper framing; one request in flight, exact owned-process teardown.
 * The private channel accepts only operations assembled above, never external JSON. */
async function withChannel<A>(asset: Asset, configuration: Configuration, workspace: Workspace | undefined,
  signal: AbortSignal, body: (request: (value: Record<string, unknown>) => Promise<typeof Reply.Type>) => Promise<A>) {
  if (signal.aborted) throw failure()
  const helper = asset.filename
  const policy = process.platform === "darwin" ? workspace ? WorkCommandRuntime.snapshotProfile({ helper, root: configuration.scope.canonicalRoot,
    workspace: workspace.directory, inputs: configuration.recipe.inputs }) : WorkFileHelper.sandboxProfile({ filename: helper,
    root: configuration.scope.canonicalRoot, read: configuration.watch.map((path) => ({ kind: "file" as const, path })), write: [], deny: [] }) : undefined
  const linux = process.platform === "linux" ? await (async () => {
    const { EventValidationLinux } = await import("./event-validation-linux")
    return EventValidationLinux.openHelper(helper, configuration.helperHash)
  })() : undefined
  if (!linux && policy === undefined) throw failure()
  const child = await (async () => {
    try {
      if (signal.aborted) throw failure()
      await linux?.current()
      if (linux) await Effect.runPromise(asset.current)
      return linux ? spawn(linux.executable, [], { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"] })
        : spawn("/usr/bin/sandbox-exec", ["-p", policy!, "--", helper], { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) { await linux?.close(); throw error }
  })()
  const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()) })
  const state = { buffer: Buffer.alloc(0), pending: undefined as { id: string; resolve: (value: typeof Reply.Type) => void; reject: (error: EventValidationSchema.Error) => void } | undefined }
  const abort = () => { state.pending?.reject(failure()); state.pending = undefined; child.kill("SIGKILL") }
  signal.addEventListener("abort", abort, { once: true })
  child.stdin.once("error", abort); child.stdout.once("error", abort); child.stderr.once("error", abort)
  if (linux) {
    const diagnostics = { bytes: 0 }
    child.stderr.on("data", (bytes: Buffer) => {
      diagnostics.bytes += bytes.length
      if (diagnostics.bytes > 8192) abort()
    })
  }
  if (!linux) child.stderr.resume()
  child.once("error", abort); child.once("close", () => state.pending?.reject(failure()))
  child.stdout.on("data", (bytes: Buffer) => {
    if (!state.pending || state.buffer.length + bytes.length > 65_544) { abort(); return }
    state.buffer = Buffer.concat([state.buffer, bytes])
    if (state.buffer.length < 4) return
    const length = state.buffer.readUInt32BE(0)
    if (length < 1 || length > 65_536) { abort(); return }
    if (state.buffer.length < 4 + length) return
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Reply), { onExcessProperty: "error" })(state.buffer.subarray(4, 4 + length).toString("utf8"))
    if (Option.isNone(decoded) || decoded.value.id !== state.pending.id || decoded.value.payload_bytes !== 0) { abort(); return }
    const total = 4 + length + decoded.value.payload_bytes
    if (state.buffer.length < total) return
    if (state.buffer.length !== total || (decoded.value.observation &&
      createHash("sha256").update(state.buffer.subarray(4 + length)).digest("hex") !== decoded.value.observation.page_sha256)) { abort(); return }
    const pending = state.pending; state.pending = undefined; state.buffer = Buffer.alloc(0); pending.resolve(decoded.value)
  })
  const request = async (value: Record<string, unknown>) => {
    if (linux && !["open_root", "observe", "snapshot_workspace", "check_root", "close"].includes(String(value.op))) throw failure()
    await linux?.current()
    if (linux) await Effect.runPromise(asset.current)
    return new Promise<typeof Reply.Type>((resolve, reject) => {
    if (state.pending || signal.aborted || child.exitCode !== null || child.signalCode !== null) { reject(failure()); return }
    const id = randomUUID()
    const bytes = Buffer.from(JSON.stringify({ ...value, version: 1, id }))
    if (bytes.length > 65_536) { reject(failure()); return }
    const timer = setTimeout(abort, 30_000)
    state.pending = { id, resolve: (reply) => { clearTimeout(timer); resolve(reply) }, reject: (error) => { clearTimeout(timer); reject(error) } }
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); child.stdin.write(Buffer.concat([size, bytes]))
    })
  }
  try {
    const ready = await request({ op: "open_root", path: configuration.scope.canonicalRoot, expected: configuration.scope.rootIdentity })
    if (ready.status !== "ready" || EventValidation.hash(ready.root) !== EventValidation.hash(configuration.scope.rootIdentity)) throw failure()
    const result = await body(request)
    const current = await request({ op: "check_root" })
    if (current.status !== "ready") throw failure()
    await request({ op: "close" }); child.stdin.end()
    return result
  } finally {
    signal.removeEventListener("abort", abort)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed
    await linux?.close()
  }
}

export * as EventValidationNative from "./event-validation-native"
