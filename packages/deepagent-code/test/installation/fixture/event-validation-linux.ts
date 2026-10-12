import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { EventValidationHost } from "../../../src/deepagent/event-validation"
import { EventValidationNative } from "../../../src/installation/event-validation-native"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { NativeWorkProcessSupervisor } from "../../../src/installation/work-process-supervisor"
import { WorkFileHelper } from "../../../src/installation/work-file-helper"
import { LocalTaskAuthority } from "../../../src/im/local-task-authority"
import { ServerAuth } from "../../../src/server/auth"

// Original Rule/operator and Consumer lifecycle, with an installed signed factory.
// No Work, Session execution, source overlay, provider or stop-proof fixture exists.
const directory = process.argv[2]!
const mode = process.argv[3]!
const program = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const host = yield* EventValidationHost.Service
  if (mode === "preflight") {
    const installed = yield* NativeInstallation.current()
    yield* NativeWorkProcessSupervisor.requireProvisioning
    const runtime = yield* NativeWorkProcessSupervisor.inspectRuntime(installed)
    const observed = yield* WorkFileHelper.inspectRoot(path.join(directory, "project"))
    return { preflight: true, provisioning: true, target: runtime.executable.platform,
      helperHash: observed.helperHash, runtimeHash: runtime.executable.sha256, supervisorHash: runtime.supervisorHash }
  }
  const counts = () => db.get<{ inputs: number; providers: number; works: number; runs: number; retained: number }>(sql`
    SELECT (SELECT count(*) FROM session_input) inputs,
      (SELECT count(*) FROM session_v2_provider_turn_receipt) providers,
      (SELECT count(*) FROM work_execution) works,
      (SELECT count(*) FROM event_validation_run) runs,
      (SELECT coalesce(sum(retained_bytes),0) FROM event_validation_run) retained`)
  if (mode === "cold") {
    const before = yield* db.all("SELECT * FROM event_validation_run ORDER BY run_id")
    const history = yield* host.history("actual-rule")
    const after = yield* db.all("SELECT * FROM event_validation_run ORDER BY run_id")
    if (EventValidation.hash(before) !== EventValidation.hash(after)) throw new Error("Cold history mutated execution")
    return { cold: true, unchanged: true, counts: yield* counts(),
      runs: history.map((run) => ({ state: run.state, outcome: run.outcome, stop: run.result?.stopConfirmed,
        retained: run.retainedBytes, released: run.releasedAt !== null, resultCurrent: run.resultCurrent })) }
  }
  const root = path.join(directory, "project")
  const installed = yield* NativeInstallation.current()
  const runtime = yield* NativeWorkProcessSupervisor.inspectRuntime(installed)
  const observed = yield* WorkFileHelper.inspectRoot(root)
  const recipe = Schema.decodeUnknownSync(EventValidationSchema.LinuxRecipe)({
    schemaVersion: "work-command-recipe.v2", logicalID: "test", revision: 1, executable: runtime.executable,
    argv: ["test", "guard.test.ts", "--timeout", "45000"].map((value) => ({ kind: "literal", value })),
    parameters: [], cwd: null, inputs: ["guard.test.ts", "empty.dat", "binary.dat"], outputs: ["result.txt"],
    environment: [{ name: "CI", value: "1" }], workspace: "private_explicit_files.v1",
    sandbox: { id: "linux-cgroup2-single-payload-v1", revision: 1, network: "deny", filesystem: "explicit_snapshot_closure",
      payloadProcesses: 1, payloadThreadsMax: 64, supervisorProcessesMax: 2, openFiles: 64,
      stopProof: "root_exit_stream_eof_tree_empty", threadsEnforcement: "cgroup_pids", tasksMax: 66,
      cpu: { quotaMicros: 100000, periodMicros: 100000, totalWatchdogMicros: 60000000, pollMs: 20 },
      memory: { maxBytes: 268435456, swapMaxBytes: 0 } },
    timeoutMs: 60000, stdoutBytes: 1048576, stderrBytes: 1048576,
  })
  const placement = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
    directory: AbsolutePath.make(root), project: { kind: "registered_root", observedProjectId: "linux-ev-project" } })
  const namespace = yield* db.get<{ binding_hash: string }>(sql`SELECT binding_hash FROM context_security_namespace WHERE id=${placement.securityNamespaceId}`)
  if (!namespace) throw new Error("Missing original namespace")
  const authConfig = yield* ServerAuth.Config
  if (Option.isNone(authConfig.password)) throw new Error("Missing private operator password")
  const password = authConfig.password.value
  yield* LocalTaskAuthority.ensurePrivateInstallation()
  const identity = yield* LocalTaskAuthority.configured(authConfig)
  yield* LocalOperator.enroll(db, { operationID: "enroll", operatorID: "linux-ev-operator", username: authConfig.username,
    credentialVerifier: yield* Effect.promise(() => Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 })),
    policy: { version: 2, targets: [{ id: "project", locationKey: placement.locationKey, namespaceBindingHash: namespace.binding_hash,
      target: { version: 2, scope: { actorID: "linux-ev-operator", workspaceID: placement.canonicalRoot,
        securityNamespaceID: placement.securityNamespaceId, projectScopeKey: placement.projectScopeKey },
        location: { directory: placement.canonicalRoot }, agentID: "auto",
        profile: { id: "project_work_v1", version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
        projectScope: { projectID: "linux-ev-project", locationKey: placement.locationKey, namespaceBindingHash: namespace.binding_hash,
          canonicalRoot: placement.canonicalRoot, helperHash: observed.helperHash, rootIdentity: observed.rootIdentity },
        contextPolicy: { kind: "scoped_project_history_v1", instructionsRevision: 1, history: "same_work_activity",
          graphs: [], references: [], files: "approved_tool_results_only" },
        toolPolicy: { kind: "scoped_project_tools_v1", capabilities: [{ toolID: "managed_command", definitionHash: "e".repeat(64), operations: ["run"] }],
          fileScope: { read: recipe.inputs.map((path) => ({ kind: "file", path })), write: [], deny: [], maxReadBytes: 67108864,
            maxPageBytes: 51200, maxHashBytes: 16777216, maxWriteBytes: 0, symlinks: "deny" }, commandScope: [],
          commandRecipes: [recipe], integrations: [] }, childPolicy: "deny_all",
        provider: { providerID: "unused", modelID: "unused", protocol: "openai-responses", routeID: "unused", configurationHash: "a".repeat(64),
          endpoint: "https://example.invalid/v1/responses", evidenceID: "unused", evidenceHash: "b".repeat(64), endpointPinned: true,
          redirectsDenied: true, transportRetriesDenied: true,
          completion: { parameter: "max_output_tokens", hardLimit: true, includesReasoning: true, maxTokens: 4096 } },
        budget: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, durationMs: 60000 } }] },
  }).pipe(Effect.provideService(LocalOperator.Runtime, identity.runtime))
  const witness = yield* LocalTaskAuthority.authenticatePassword(db, identity.runtime, authConfig.username, password)
  const auth = { runtime: identity.runtime, witness }
  const configuration = Schema.decodeUnknownSync(EventValidationSchema.Configuration)({ profile: "project_validation_v1", kind: "test", recipe,
    scope: { instanceID: identity.runtime.instanceID, workspaceID: null, securityNamespaceID: placement.securityNamespaceId,
      namespaceBindingHash: namespace.binding_hash, locationKey: placement.locationKey, projectScopeKey: placement.projectScopeKey,
      projectID: "linux-ev-project", canonicalRoot: root, rootIdentity: observed.rootIdentity }, helperHash: observed.helperHash,
    parameters: [], watch: recipe.inputs, recipient: "local_status", maxRuns: 2, expiresAt: Date.now() + 180000,
    investigation: "disabled", autoFix: false })
  yield* LocalTaskAuthority.provide(auth, host.configure({ ruleID: "actual-rule", requestID: "create", expectedRevision: 0, configuration }))
  // Core enable creates no advisory hint. The original Host manual action is the
  // sole Consumer trigger, so this bounded cohort starts exactly one validation.
  yield* LocalTaskAuthority.provide(auth, EventValidation.control(db, { ruleID: "actual-rule", requestID: "enable", expectedRevision: 1, action: "enable" }))
  const verified = yield* LocalTaskAuthority.provide(auth, host.control({ ruleID: "actual-rule", requestID: "verify", expectedRevision: 2, action: "verify" }))
  const wait = (predicate: (run: EventValidationSchema.RunRecord) => boolean) => Effect.gen(function* () {
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const runs = yield* EventValidation.history(db, "actual-rule")
      if (runs.length > 1) throw new Error("Unexpected extra validation execution")
      const run = runs[0]
      if (run && predicate(run)) return run
      yield* Effect.sleep(25)
    }
    throw new Error("Original Linux EV did not reach its expected boundary")
  })
  if (mode === "cancel") {
    const active = yield* wait((run) => run.state === "dispatching" && run.processID !== null)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !(yield* Effect.promise(() => fs.readFile(path.join(directory, "data/work-command-stage", active.workspaceBasename, "result.txt"), "utf8").then((value) => value === "started", () => false)))) {
      yield* Effect.sleep(25)
    }
    if (!(yield* Effect.promise(() => fs.readFile(path.join(directory, "data/work-command-stage", active.workspaceBasename, "result.txt"), "utf8").then((value) => value === "started", () => false)))) throw new Error("Actual payload marker missing")
    yield* LocalTaskAuthority.provide(auth, host.control({ ruleID: "actual-rule", requestID: "cancel", expectedRevision: verified.receipt.ruleRevision, action: "cancel" }))
  }
  const result = yield* wait((run) => run.terminalAt !== null && run.releasedAt !== null)
  const before = yield* counts()
  const currentRule = yield* EventValidation.getRule(db, "actual-rule")
  if (!currentRule) throw new Error("Original current rule disappeared")
  const history = yield* EventValidation.history(db, "actual-rule")
  yield* Effect.promise(() => fs.writeFile(path.join(directory, "boundary-before-pause-safe.json"), JSON.stringify({
    counts: before, state: result.state, outcome: result.outcome, actualPID: result.processID !== null, stop: result.result?.stopConfirmed,
    stdoutEOF: result.result?.stdout.complete, stderrEOF: result.result?.stderr.complete, retained: result.retainedBytes, released: result.releasedAt !== null,
    ruleRevision: currentRule.revision, historyCount: history.length, historyHash: EventValidation.hash(history),
  }), { mode: 0o600 }))
  yield* LocalTaskAuthority.provide(auth, host.control({ ruleID: "actual-rule", requestID: "pause", expectedRevision: currentRule.revision, action: "pause" }))
  yield* Effect.sleep(800)
  const after = yield* counts()
  if (EventValidation.hash(before) !== EventValidation.hash(after)) throw new Error("Terminal pause added an execution")
  return { mode, counts: after, run: { state: result.state, outcome: result.outcome, current: result.resultCurrent,
    actualPID: result.processID !== null, stopConfirmed: result.result?.stopConfirmed, stdoutEOF: result.result?.stdout.complete,
    stderrEOF: result.result?.stderr.complete, retainedBytes: result.retainedBytes, released: result.releasedAt !== null,
    stdoutBytes: result.result?.stdout.bytes, stderrBytes: result.result?.stderr.bytes },
    workspaceAbsent: yield* Effect.promise(() => fs.stat(path.join(directory, "data/work-command-stage", result.workspaceBasename)).then(() => false, () => true)) }
})
const layers = Layer.mergeAll(EventValidationHost.layer, LocationIdentity.layer).pipe(Layer.provideMerge(EventValidationNative.layer),
  Layer.provideMerge(Database.defaultLayer), Layer.provideMerge(ServerAuth.Config.defaultLayer), Layer.provide(FSUtil.defaultLayer), Layer.provideMerge(Global.layer))
const result = await Effect.runPromiseExit(program.pipe(Effect.provide(layers), Effect.scoped))
process.stdout.write(JSON.stringify(Exit.isSuccess(result) ? { ok: true, value: result.value } : { ok: false, error: Cause.pretty(result.cause) }) + "\n")
process.exitCode = Exit.isSuccess(result) ? 0 : 1
