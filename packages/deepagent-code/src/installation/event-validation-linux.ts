export * as EventValidationLinux from "./event-validation-linux"

import fs from "node:fs/promises"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { Context, Effect } from "effect"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { NativeWorkProcessSupervisor } from "./work-process-supervisor"
import { WorkCommandRuntime } from "./work-command-runtime"
import type { WorkFileHelper } from "./work-file-helper"

type Asset = Effect.Success<ReturnType<typeof WorkFileHelper.validationAsset>>
type Workspace = Awaited<ReturnType<typeof WorkCommandRuntime.createWorkspace>>
const failure = () => new EventValidationSchema.Error({ code: "VALIDATION_UNAVAILABLE", message: "Installed Linux validation is unavailable or changed" })

export const current = Effect.fn("EventValidationLinux.current")(function* (asset: Asset, configuration: EventValidationSchema.Configuration) {
  if (configuration.recipe.schemaVersion !== "work-command-recipe.v2" || process.platform !== "linux") return yield* failure()
  yield* NativeWorkProcessSupervisor.requireProvisioning.pipe(Effect.mapError(failure))
  const runtime = yield* NativeWorkProcessSupervisor.inspectRuntime(asset.installation).pipe(Effect.mapError(failure))
  if (EventValidation.hash(runtime.executable) !== EventValidation.hash(configuration.recipe.executable)) return yield* failure()
  yield* asset.current.pipe(Effect.mapError(failure))
  return runtime
})

/** A copied file has its own inode. Source identities cannot authorize the
 * supervisor's read-only mounts, even when the original content hash matches. */
export async function copiedInputs(workspace: Workspace, configuration: EventValidationSchema.Configuration,
  content: EventValidationSchema.Content) {
  const inputs = [] as NativeWorkProcessSupervisor.Request["inputs"][number][]
  for (const relative of configuration.recipe.inputs) {
    const original = content.files.find((file) => file.relative === relative && !file.missing)
    if (!original || original.bytes > 16777216) throw failure()
    const copied = (await WorkCommandRuntime.readOutput(workspace, relative, 16777216)).description
    if (copied.bytes !== original.bytes || copied.sha256 !== original.sha256 ||
      inputs.reduce((total, file) => total + file.bytes, copied.bytes) > 67108864) throw failure()
    inputs.push(copied)
  }
  return inputs
}

export const execute = Effect.fn("EventValidationLinux.execute")(function* (input: {
  asset: Asset; configuration: EventValidationSchema.Configuration; workspace: Workspace; deadline: number;
  preparation: EventValidation.PreparationInput; inputs: NativeWorkProcessSupervisor.Request["inputs"];
}, hooks: Parameters<EventValidation.Native["Service"]["execute"]>[1],
  completed: (value: EventValidationSchema.Result) => void) {
  const recipe = input.configuration.recipe
  const binding = input.preparation.supervisorBinding
  if (recipe.schemaVersion !== "work-command-recipe.v2" || !binding || binding.instanceID !== input.configuration.scope.instanceID ||
    !Number.isSafeInteger(binding.ruleRevision) || binding.ruleRevision < 1) return yield* failure()
  yield* current(input.asset, input.configuration)
  yield* Effect.tryPromise({ try: () => WorkCommandRuntime.currentWorkspace(input.workspace), catch: failure })
  const identity = { workID: `ev_${EventValidation.hash(["dac.ev.validation.supervisor-work.v1", binding.instanceID, binding.ruleID, input.preparation.runID])}`,
    commandID: input.preparation.runID, recipeHash: EventValidation.hash(recipe), controlRevision: binding.ruleRevision }
  const ready = { nonce: "", rootPID: 0 }
  const authority: NonNullable<Context.Service.Shape<typeof NativeWorkProcessSupervisor.Authority>> = {
    authorize: (handle, request) => Effect.gen(function* () {
      const observed = NativeWorkProcessSupervisor.describeReady(handle)
      if (!observed || observed.workID !== identity.workID || observed.commandID !== identity.commandID ||
        observed.recipeHash !== identity.recipeHash || observed.controlRevision !== identity.controlRevision ||
        EventValidation.hash(request.binding) !== EventValidation.hash(identity) || request.workspace !== input.workspace.directory ||
        EventValidation.hash(request.workspaceIdentity) !== EventValidation.hash(input.workspace.identity) ||
        EventValidation.hash(request.configuration.isolation) !== EventValidation.hash(recipe.sandbox) ||
        EventValidation.hash(request.inputs) !== EventValidation.hash(input.inputs))
        return yield* new NativeWorkProcessSupervisor.Error({ code: "SUPERVISOR_AUTH_REQUIRED", message: "Original validation Ready differs" })
      yield* current(input.asset, input.configuration).pipe(Effect.mapError(() => new NativeWorkProcessSupervisor.Error({ code: "SUPERVISOR_AUTH_REQUIRED", message: "Current validation assets changed" })))
      yield* hooks.started(observed.rootPID).pipe(Effect.mapError(() => new NativeWorkProcessSupervisor.Error({ code: "SUPERVISOR_AUTH_REQUIRED", message: "Current validation authority changed" })))
      ready.nonce = observed.nonce
      ready.rootPID = observed.rootPID
    }),
  }
  const supervisor = yield* NativeWorkProcessSupervisor.make(input.asset.installation).pipe(
    Effect.provideService(NativeWorkProcessSupervisor.Authority, authority), Effect.mapError(failure))
  const executable = yield* supervisor.executable().pipe(Effect.mapError(failure))
  // A launch without a complete Ready/stop protocol must already be durable
  // dispatching, so cold observation retains its original project barrier.
  yield* hooks.beforeDispatch
  return yield* supervisor.execute({ binding: identity, configuration: { target: recipe.executable.platform, isolation: recipe.sandbox },
    executable, workspace: input.workspace.directory, workspaceIdentity: input.workspace.identity, inputs: input.inputs,
    outputs: recipe.outputs, argv: recipe.argv.map((argument) => argument.kind === "literal" ? argument.value :
      input.configuration.parameters.find((parameter) => parameter.key === argument.parameter)!.value),
    ...(recipe.cwd === null ? {} : { cwd: recipe.cwd }), env: Object.fromEntries(recipe.environment.map((entry) => [entry.name, entry.value])),
    timeoutMs: Math.min(recipe.timeoutMs, input.deadline - Date.now()), stdoutBytes: recipe.stdoutBytes, stderrBytes: recipe.stderrBytes,
  }, (value) => {
    const stop = supervisor.describeStop(value.proof)
    if (!stop || stop.supervision.nonce !== ready.nonce || stop.supervision.rootPID !== ready.rootPID) throw failure()
    const stream = (output: typeof stop.result.stdout, bytes: Buffer) => {
      const text = bytes.toString("utf8")
      const encoded = Buffer.from(text)
      const end = { value: Math.min(65536, encoded.length) }
      while (end.value < encoded.length && (encoded[end.value]! & 0xc0) === 0x80) end.value--
      return { sha256: output.sha256, bytes: output.bytes, capturedBytes: output.captured_bytes,
        truncated: output.bytes !== output.captured_bytes, complete: output.eof,
        excerpt: encoded.subarray(0, end.value).toString("utf8"), excerptTruncated: end.value < encoded.length || output.bytes !== output.captured_bytes }
    }
    completed({ outcome: stop.result.cancelled ? "cancelled" : stop.result.exit_code === 0 ? "passed" : "failed",
      exitCode: stop.result.exit_code, signal: stop.result.signal == null ? null : `signal:${stop.result.signal}`,
      stdout: stream(stop.result.stdout, value.stdout), stderr: stream(stop.result.stderr, value.stderr), stopConfirmed: true, endedAt: Date.now() })
  }).pipe(Effect.asVoid, Effect.mapError(failure))
}, Effect.scoped)

/** Only the fixed signed file helper is started here. No payload/argv/env is
 * accepted; Linux payload execution always belongs to the supervisor above. */
export async function openHelper(filename: string, expectedHash: string) {
  if (process.platform !== "linux" || await fs.realpath(filename) !== filename) throw failure()
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 16777216n || (before.mode & 0o022n) !== 0n) throw failure()
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65536)
    const count = { bytes: 0 }
    while (true) {
      const part = await file.read(buffer, 0, buffer.length, null)
      if (!part.bytesRead) break
      count.bytes += part.bytesRead
      if (count.bytes > 16777216) throw failure()
      hash.update(buffer.subarray(0, part.bytesRead))
    }
    const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(":")
    const current = async () => {
      if (stamp(await file.stat({ bigint: true })) !== stamp(before) || stamp(await fs.lstat(filename, { bigint: true })) !== stamp(before) ||
        await fs.realpath(filename) !== filename) throw failure()
    }
    if (count.bytes !== Number(before.size) || hash.digest("hex") !== expectedHash) throw failure()
    await current()
    return { executable: `/proc/${process.pid}/fd/${file.fd}`, current, close: () => file.close() }
  } catch (error) { await file.close(); throw error }
}
