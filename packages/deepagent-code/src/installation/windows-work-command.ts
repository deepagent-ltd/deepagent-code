import { randomBytes, randomUUID } from "node:crypto"
import { Context, Effect, Exit, Option, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { WorkCommand } from "@deepagent-code/core/session/work-command"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { WorkCommandWindowsSchema } from "@deepagent-code/core/session/work-command-windows.schema"
import { WorkCommandV2Schema } from "@deepagent-code/core/session/work-command-v2.schema"
import { WorkStorageCleanupWindowsSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows.schema"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { NativeInstallation } from "./native-installation"
import { NativeWorkProcessSupervisor } from "./work-process-supervisor"
import { NativeWindowsWorkFactory } from "./windows-work-factory"
import { WindowsWorkCommandRuntime } from "./windows-work-command-runtime"

type Input = Parameters<NonNullable<WorkFileCapability.Interface["command"]>>[1]
type File = { relative: string; identity: WorkCommandWindowsSchema.Identity; sha256: string; bytes: number }
export type Root = Readonly<{
  binding: typeof WorkAuthoritySchema.ProjectBinding.Type; bindingHash: string; controlRevision: number
  installation: NativeInstallation.VerifiedInstalledComponents; helperHash: string
  current: Effect.Effect<void, WorkFileCapability.Error>
  currentBinding: Effect.Effect<void, WorkFileCapability.Error>
  readInput: (relative: string, limit: number, deadline: number, permission: Input["checkPermission"]) => Effect.Effect<File, WorkFileCapability.Error>
  snapshot: (workspace: WindowsWorkCommandRuntime.Workspace, files: readonly File[], outputs: readonly string[],
    deadline: number, permission: Input["checkPermission"]) => Effect.Effect<{ manifestHash: string; files: number; bytes: number;
      outputFiles: number; identity: WorkCommandWindowsSchema.Identity }, WorkFileCapability.Error>
}>
declare const originalPreparation: unique symbol
export interface Preparation { readonly [originalPreparation]: true }

/** The original Windows retirement factory supplies this service. A decoded
 * Security object, POSIX manifest or historical SQL row cannot implement it.
 * Without it, admission fails before any durable command reservation. */
export class Custody extends Context.Service<Custody, {
  readonly current: Effect.Effect<void, WorkFileCapability.Error>
  readonly prepare: Effect.Effect<Preparation, WorkFileCapability.Error, Scope.Scope>
  readonly instanceID: (preparation: Preparation) => string | undefined
  readonly capture: (record: WorkCommandWindowsSchema.Record, workspace: WindowsWorkCommandRuntime.Workspace,
    currentBinding: Effect.Effect<void, WorkFileCapability.Error>, preparation: Preparation) =>
    Effect.Effect<{ manifest: WorkStorageCleanupWindowsSchema.Manifest }, WorkFileCapability.Error>
  readonly stopped: (workspace: WindowsWorkCommandRuntime.Workspace, proof: NativeWorkProcessSupervisor.StopProof) =>
    Effect.Effect<{ security: typeof WorkStorageCleanupWindowsSchema.Security.Type; aclRestoreHash: string;
      jobRetired: true; appContainerRetired: true; aclRestored: true }, WorkFileCapability.Error>
  readonly cleanup: (record: WorkCommandWindowsSchema.Record, workspace: WindowsWorkCommandRuntime.Workspace,
    files: readonly { relative: string; bytes: number; sha256: string }[]) => Effect.Effect<void, WorkFileCapability.Error>
}>()("@deepagent-code/WindowsWorkCommand.Custody") {}

const failure = (code: WorkFileCapability.Error["code"] = "WORK_FILE_UNAVAILABLE") =>
  new WorkFileCapability.Error({ code, message: "Original Windows command authority or custody is unavailable" })
type Owned = { root: WorkFileCapability.Root; workspace: WindowsWorkCommandRuntime.Workspace;
  record: WorkCommandWindowsSchema.Record; inputs: File[]; published: Set<string>; cleanupStarted: boolean }

/** Windows owns an independent v2 custody map. The POSIX FileHandle/record path
 * and the single Session runner are unchanged. This layer never retries work. */
export const make = Effect.fn("WindowsWorkCommand.make")(function* (lookup: (root: WorkFileCapability.Root) => Root | undefined) {
  const database = yield* Database.Service
  const runtime = yield* Effect.serviceOption(WindowsWorkCommandRuntime.Service)
  const factory = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  const custody = yield* Effect.serviceOption(Custody)
  const owned = new Map<string, Owned>()
  const receipts = new WeakMap<WorkFileCapability.CommandObservation, { root: WorkFileCapability.Root; description: WorkFileCapability.CommandDescription }>()
  const lifetime = { active: true }
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false }))
  // Only the captured original factory's lifetime is consumed in SQL. Its
  // installation/native IO is completed before the current source fence.
  const nativeReference = { current: Effect.suspend(() => Option.isSome(factory) && factory.value.isCurrent()
    ? Effect.succeed(factory.value.description.target) : Effect.fail(new WorkCommandSchema.Error({
      code: "WORK_COMMAND_UNAVAILABLE", message: "Original Windows command factory is unavailable" }))) }
  const native = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(WorkCommand.NativeWindows, nativeReference))
  const available = Effect.gen(function* () {
    if (process.platform !== "win32" || !lifetime.active || Option.isNone(runtime) || Option.isNone(factory) || Option.isNone(custody))
      return yield* failure()
    yield* factory.value.current.pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
    yield* custody.value.current
    return { runtime: runtime.value, factory: factory.value, custody: custody.value }
  })
  const cleanup = (entry: Owned) => Effect.gen(function* () {
    const ports = yield* available
    if (entry.cleanupStarted || entry.record.state !== "settled" || entry.record.releasedAt !== null) return yield* failure()
    const actual = yield* WorkCommand.get(database.db, entry.record.admissionID)
    if (!actual || actual.version !== 2 || CanonicalJson.stringify(actual) !== CanonicalJson.stringify(entry.record)) return yield* failure()
    entry.cleanupStarted = true
    yield* ports.custody.cleanup(actual, entry.workspace, [...entry.inputs, ...actual.outputs])
    // Original cleanup proves the private namespace/security retirement. A
    // successful SQL terminal alone cannot release the retained reservation.
    entry.record = yield* native(WorkCommand.released(database.db, actual))
    yield* ports.runtime.closeWorkspace(entry.workspace).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
    owned.delete(entry.record.admissionID)
  })
  return {
    command: (root: WorkFileCapability.Root, input: Input) => Effect.scoped(Effect.gen(function* () {
      const ports = yield* available
      const current = lookup(root)
      if (!current || current.binding.projectScope.rootIdentity.kind !== "windows" || owned.size >= WorkCommandSchema.MAX_CUSTODY)
        return yield* failure()
      const decoded = Schema.decodeUnknownOption(WorkCommandSchema.Input, { onExcessProperty: "error" })(input.input)
      const recipe = current.binding.toolPolicy.commandRecipes?.find((entry) => entry.logicalID === input.input.commandID)
      if (Option.isNone(decoded) || !recipe || recipe.schemaVersion !== "work-command-recipe.v2" ||
        recipe.executable.platform !== ports.factory.description.target || recipe.executable.identity.kind !== "windows" ||
        recipe.sandbox.id !== "win32-job-appcontainer-single-payload-v1" ||
        ![...recipe.inputs, ...recipe.outputs, ...(recipe.cwd === null ? [] : [recipe.cwd])].every(Schema.is(WorkWindowsPathSchema.Relative)) ||
        !WorkWindowsPathSchema.nonOverlapping([...recipe.inputs, ...recipe.outputs]) ||
        decoded.value.parameters.length !== recipe.parameters.length ||
        new Set(decoded.value.parameters.map((entry) => entry.key)).size !== decoded.value.parameters.length ||
        decoded.value.parameters.some((entry) => !recipe.parameters.find((parameter) => parameter.key === entry.key)?.choices.includes(entry.value)))
        return yield* failure()
      yield* current.current
      yield* input.checkPermission
      const actualRuntime = yield* NativeWorkProcessSupervisor.inspectRuntime(current.installation).pipe(Effect.mapError(() => failure()))
      if (CanonicalJson.stringify(actualRuntime.executable) !== CanonicalJson.stringify(recipe.executable)) return yield* failure("WORK_FILE_CHANGED")
      const preparation = yield* ports.custody.prepare
      const instanceID = ports.custody.instanceID(preparation)
      if (!instanceID) return yield* failure()
      yield* current.currentBinding
      const reservation = yield* native(WorkCommand.reserveWindows(database.db, { commandID: randomUUID(), admissionID: input.admissionID,
        instanceID, workID: current.binding.workID, rootWorkID: current.binding.rootWorkID,
        sessionID: current.binding.sessionID, inputID: current.binding.inputID, activityID: input.activityID,
        providerReceiptID: input.providerReceiptID, providerAttemptID: input.providerAttemptID, toolCallID: input.toolCallID,
        ownerToken: input.ownerToken, sessionClaimToken: input.sessionClaimToken, bindingHash: current.bindingHash,
        controlRevision: current.controlRevision, recipeID: recipe.logicalID, recipeRevision: recipe.revision,
        recipeHash: Hash.sha256(CanonicalJson.stringify(recipe)), requestHash: Hash.sha256(CanonicalJson.stringify(input.input)),
        helperHash: current.helperHash, runtimeHash: recipe.executable.sha256, workspaceBasename: `cmd_${randomBytes(16).toString("hex")}`,
        deadline: Math.min(current.binding.deadline, Date.now() + recipe.timeoutMs),
      }))
      if (reservation.replayed) return yield* failure("WORK_FILE_UNKNOWN")
      const workspace = yield* ports.runtime.createWorkspace(reservation.record.workspaceBasename, current.binding.projectScope.canonicalRoot)
        .pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      const state: Owned = { root, workspace, record: reservation.record, inputs: [], published: new Set(), cleanupStarted: false }
      owned.set(input.admissionID, state)
      for (const relative of recipe.inputs) {
        const matches = (rule: { kind: "file" | "tree"; path: string }) => relative === rule.path ||
          (rule.kind === "tree" && relative.startsWith(`${rule.path}/`))
        if (current.binding.toolPolicy.fileScope.deny.some(matches) || !current.binding.toolPolicy.fileScope.read.some(matches)) return yield* failure()
        const observed = yield* current.readInput(relative, Math.min(16_777_216, current.binding.toolPolicy.fileScope.maxHashBytes,
          current.binding.toolPolicy.fileScope.maxReadBytes), state.record.deadline, input.checkPermission)
        if (observed.bytes > 16_777_216 || state.inputs.reduce((bytes, entry) => bytes + entry.bytes, observed.bytes) > 67_108_864)
          return yield* failure("WORK_FILE_CAPACITY")
        state.inputs.push(observed)
      }
      const snapshot = yield* current.snapshot(workspace, state.inputs, recipe.outputs, state.record.deadline, input.checkPermission)
      if (CanonicalJson.stringify(snapshot.identity) !== CanonicalJson.stringify(workspace.identity) ||
        snapshot.files !== state.inputs.length || snapshot.bytes !== state.inputs.reduce((bytes, entry) => bytes + entry.bytes, 0) ||
        snapshot.outputFiles !== recipe.outputs.length) return yield* failure("WORK_FILE_UNKNOWN")
      yield* current.currentBinding
      state.record = yield* native(WorkCommand.prepared(database.db, state.record, { workspaceIdentity: workspace.identity,
        snapshotHash: snapshot.manifestHash, observedRetainedBytes: snapshot.bytes }))
      const inputs = yield* Effect.forEach(state.inputs, (entry) => ports.runtime.readOutput(workspace, entry.relative, 16_777_216).pipe(
        Effect.map((output) => output.description), Effect.mapError(() => failure("WORK_FILE_UNKNOWN"))))
      if (inputs.some((copied, index) => copied.bytes !== state.inputs[index]!.bytes || copied.sha256 !== state.inputs[index]!.sha256))
        return yield* failure("WORK_FILE_UNKNOWN")
      const manifest: { value?: WorkStorageCleanupWindowsSchema.Manifest } = {}
      const capture = Effect.gen(function* () {
        if (manifest.value) return yield* failure("WORK_FILE_UNKNOWN")
        const captured = (yield* ports.custody.capture(state.record, workspace, current.currentBinding, preparation)).manifest
        if (!Schema.is(WorkStorageCleanupWindowsSchema.Manifest)(captured) ||
        !Schema.is(WorkStorageCleanupWindowsSchema.NativeSecurity)(captured.security) || captured.version !== 2 || captured.target !== state.record.target ||
        captured.admissionID !== state.record.admissionID || captured.custodyID !== state.record.commandID ||
        (["instanceID", "workID", "rootWorkID", "sessionID", "inputID", "activityID", "providerReceiptID", "providerAttemptID",
          "toolCallID", "ownerToken", "sessionClaimToken", "bindingHash", "controlRevision", "helperHash"] as const)
          .some((key) => captured[key] !== state.record[key]) ||
        captured.sourceRequestHash !== state.record.requestHash || captured.basename !== state.record.workspaceBasename ||
        captured.project !== current.binding.projectScope.canonicalRoot ||
        CanonicalJson.stringify(captured.projectIdentity) !== CanonicalJson.stringify(current.binding.projectScope.rootIdentity) ||
        captured.snapshotHash !== state.record.snapshotHash ||
        captured.files.length !== inputs.length + recipe.outputs.length ||
        CanonicalJson.stringify(captured.containerIdentity) !== CanonicalJson.stringify(workspace.identity) ||
        inputs.some((entry) => !captured.files.some((file) => file.relative === entry.relative &&
          file.bytes === entry.bytes && file.sha256 === entry.sha256 && CanonicalJson.stringify(file.identity) === CanonicalJson.stringify(entry.identity))) ||
        recipe.outputs.some((relative) => !captured.files.some((file) => file.relative === relative &&
          file.bytes === 0 && file.sha256 === Hash.sha256(Buffer.alloc(0))))) return yield* failure("WORK_FILE_UNKNOWN")
        manifest.value = captured
      })
      yield* current.current
      yield* input.checkPermission
      yield* ports.runtime.currentWorkspace(workspace).pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const authority = { authorize: (ready: NativeWorkProcessSupervisor.Ready, request: NativeWorkProcessSupervisor.Request) =>
          Effect.gen(function* () {
            const original = NativeWorkProcessSupervisor.describeReady(ready)
            if (!original || original.workID !== state.record.workID || original.commandID !== state.record.commandID ||
              original.recipeHash !== state.record.recipeHash || original.controlRevision !== state.record.controlRevision ||
              original.containment !== "win32-job-appcontainer-single-payload-v1" || request.workspace !== workspace.directory ||
              CanonicalJson.stringify(request.configuration.isolation) !== CanonicalJson.stringify(recipe.sandbox)) return yield* failure()
            yield* readyStep("current", current.current)
            yield* readyStep("permission", input.checkPermission)
            // Native AppContainer/profile/ACL facts first exist at Ready. The
            // exact v2 manifest is durable before dispatch SQL or Continue.
            yield* readyStep("custody", capture)
            yield* readyStep("source-fence", current.currentBinding)
            state.record = yield* readyStep("dispatch-sql", native(database.db.transaction((tx) => WorkCommand.dispatchReadyInTransaction(tx, state.record,
              original.nonce, original.rootPID), { behavior: "immediate" })))
          }).pipe(Effect.mapError(() => new NativeWorkProcessSupervisor.Error({ code: "SUPERVISOR_AUTH_REQUIRED",
            message: "Original Windows command current authority differs" }))) }
        const supervisor = yield* NativeWorkProcessSupervisor.make(current.installation, workspace).pipe(
          Effect.provideService(NativeWorkProcessSupervisor.Authority, authority), Effect.mapError(() => failure()))
        const executable = yield* supervisor.executable().pipe(Effect.mapError(() => failure()))
        const completion: { value?: NativeWorkProcessSupervisor.Completion } = {}
        const exit = yield* restore(supervisor.execute({ binding: { workID: state.record.workID, commandID: state.record.commandID,
          recipeHash: state.record.recipeHash, controlRevision: state.record.controlRevision },
          configuration: { target: recipe.executable.platform, isolation: recipe.sandbox }, workspace: workspace.directory,
          workspaceIdentity: workspace.identity, executable,
          inputs: inputs.map((entry) => ({ ...entry, identity: { kind: "windows" as const,
            volume_serial: entry.identity.volumeSerial, file_id: entry.identity.fileID } })), outputs: recipe.outputs,
          argv: recipe.argv.map((entry) => entry.kind === "literal" ? entry.value :
            input.input.parameters.find((parameter) => parameter.key === entry.parameter)!.value),
          ...(recipe.cwd === null ? {} : { cwd: recipe.cwd }), env: Object.fromEntries(recipe.environment.map((entry) => [entry.name, entry.value])),
          timeoutMs: Math.min(recipe.timeoutMs, state.record.deadline - Date.now()), stdoutBytes: recipe.stdoutBytes, stderrBytes: recipe.stderrBytes,
        }, (value) => { completion.value = value })).pipe(Effect.exit)
        const completed = Exit.isSuccess(exit) ? exit.value : completion.value
        if (!completed) {
          if (state.record.state === "dispatching") state.record = yield* native(WorkCommand.unknown(database.db, state.record))
          return yield* failure("WORK_FILE_UNKNOWN")
        }
        const observed = supervisor.describeStop(completed.proof)
        if (!observed || observed.supervision.nonce !== state.record.processIncarnation || observed.supervision.rootPID !== state.record.processID)
          return yield* failure("WORK_FILE_UNKNOWN")
        const security = yield* ports.custody.stopped(workspace, completed.proof)
        if (!manifest.value || !security.jobRetired || !security.appContainerRetired || !security.aclRestored ||
          CanonicalJson.stringify(security.security) !== CanonicalJson.stringify(manifest.value.security) ||
          !Schema.is(WorkAuthoritySchema.Digest)(security.aclRestoreHash)) return yield* failure("WORK_FILE_UNKNOWN")
        const outputs = yield* Effect.forEach(recipe.outputs, (relative) => ports.runtime.readOutput(workspace, relative).pipe(
          Effect.map((output) => output.description), Effect.mapError(() => failure("WORK_FILE_UNKNOWN"))))
        const summary = (stream: typeof observed.result.stdout) => ({ sha256: stream.sha256, bytes: stream.bytes,
          capturedBytes: stream.captured_bytes, truncated: stream.bytes !== stream.captured_bytes, complete: stream.eof })
        state.record = yield* native(WorkCommand.settled(database.db, state.record, { outcome: observed.result.cancelled ? "cancelled" : "exited",
          exitCode: observed.result.exit_code, signal: observed.result.signal == null ? null : `signal:${observed.result.signal}`, stopConfirmed: true,
          stdout: summary(observed.result.stdout), stderr: summary(observed.result.stderr), outputs,
          observedRetainedBytes: snapshot.bytes + outputs.reduce((bytes, entry) => bytes + entry.bytes, 0) +
            observed.result.stdout.captured_bytes + observed.result.stderr.captured_bytes }))
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
        const handle = Object.freeze({}) as WorkFileCapability.CommandObservation
        receipts.set(handle, { root, description: { record: state.record, observedAt: Date.now(), supervision: observed.supervision } })
        return { observation: handle, output: { outcome: state.record.outcome!, exitCode: state.record.exitCode, signal: state.record.signal,
          stdout: { ...summary(observed.result.stdout), text: completed.stdout.toString("utf8") },
          stderr: { ...summary(observed.result.stderr), text: completed.stderr.toString("utf8") }, stopConfirmed: true,
          manifestHash: state.record.snapshotHash!, outputs: outputs.map((entry) => ({ kind: "command_output" as const,
            admissionID: state.record.admissionID, relative: entry.relative, sha256: entry.sha256, bytes: entry.bytes })) } }
      }))
    })).pipe(preserve),
    describeCommand: (root: WorkFileCapability.Root, observation: WorkFileCapability.CommandObservation) =>
      lifetime.active && lookup(root) && receipts.get(observation)?.root === root ? receipts.get(observation)!.description : undefined,
    commandOutput: (root: WorkFileCapability.Root, input: { admissionID: string; relative: string; sha256: string }) => Effect.gen(function* () {
      const ports = yield* available
      const current = lookup(root)
      const entry = owned.get(input.admissionID)
      if (!current || !entry || entry.root !== root || entry.record.state !== "settled" || entry.record.releasedAt !== null)
        return yield* failure()
      yield* current.current
      const expected = entry.record.outputs.find((output) => output.relative === input.relative && output.sha256 === input.sha256)
      if (!expected || expected.bytes > 51_200) return yield* failure("WORK_FILE_CAPACITY")
      const actual = yield* ports.runtime.readOutput(entry.workspace, input.relative, 51_200).pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
      if (CanonicalJson.stringify(actual.description) !== CanonicalJson.stringify(expected)) return yield* failure("WORK_FILE_CHANGED")
      yield* current.current
      return yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(actual.bytes), catch: () => failure() })
    }).pipe(preserve),
    cleanupCommand: (root: WorkFileCapability.Root, admissionID: string, published?: WorkCommandSchema.OutputReference) => Effect.gen(function* () {
      const current = lookup(root)
      const entry = owned.get(admissionID)
      if (!current || !entry || entry.root !== root || entry.record.workID !== current.binding.workID || entry.record.bindingHash !== current.bindingHash)
        return yield* failure()
      yield* current.current
      if (published) {
        if (published.admissionID !== admissionID || !entry.record.outputs.some((output) => output.relative === published.relative &&
          output.sha256 === published.sha256 && output.bytes === published.bytes)) return yield* failure()
        entry.published.add(published.relative)
      }
      if (entry.record.outputs.some((output) => !entry.published.has(output.relative))) return
      yield* cleanup(entry)
    }).pipe(preserve),
    cleanupCompletedWork: (input: { workID: string; bindingHash: string }) => Effect.gen(function* () {
      const work = yield* WorkAuthority.get(database.db, input.workID)
      if (!lifetime.active || !work || work.binding_hash !== input.bindingHash || !["succeeded", "failed"].includes(work.outcome)) return yield* failure()
      for (const entry of owned.values()) {
        if (entry.record.workID !== input.workID || entry.record.bindingHash !== input.bindingHash ||
          entry.record.state !== "settled" || entry.record.releasedAt !== null || entry.cleanupStarted) continue
        const [effect] = yield* database.db.all<{ known: number }>(sql`SELECT 1 known FROM session_v2_tool_effect
          WHERE receipt_id=${entry.record.providerReceiptID} AND provider_attempt_id=${entry.record.providerAttemptID}
            AND session_id=${entry.record.sessionID} AND tool_call_id=${entry.record.toolCallID} AND owner_token=${entry.record.ownerToken}
            AND tool_name='managed_command' AND effect_kind='mutating' AND state='settled' AND error_code IS NULL
            AND typeof(known_command_proof)='text' AND length(CAST(known_command_proof AS BLOB)) BETWEEN 1 AND 16384
            AND known_read_proof IS NULL AND known_write_proof IS NULL`)
        if (!effect) continue
        yield* cleanup(entry).pipe(Effect.catchTag("WorkFileCapability.Error", (error) => Effect.logWarning(
          `Windows command custody cleanup remains unresolved code=${error.code}`)))
      }
    }).pipe(preserve),
  }
})

function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN")))
}

function readyStep<A, E, R>(stage: "current" | "permission" | "custody" | "source-fence" | "dispatch-sql", effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.tapError((error) => Effect.logWarning(
    `Windows command Ready refused stage=${stage} code=${error instanceof WorkCommandSchema.Error ||
      error instanceof WorkFileCapability.Error || error instanceof NativeWorkProcessSupervisor.Error ? error.code : "UNCLASSIFIED"}`,
  )))
}

export * as WindowsWorkCommand from "./windows-work-command"
