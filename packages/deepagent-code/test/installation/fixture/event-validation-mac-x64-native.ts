import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { EventValidationHost } from "../../../src/deepagent/event-validation"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { WorkCommandRuntime } from "../../../src/installation/work-command-runtime"
import { WorkFileHelper } from "../../../src/installation/work-file-helper"
import { LocalTaskAuthority } from "../../../src/im/local-task-authority"
import { ServerAuth } from "../../../src/server/auth"

const directory = process.argv[2]
if (!directory || process.platform !== "darwin" || process.arch !== "x64") throw new Error("Intel native fixture requires an isolated native macOS x64 case")
const services = Layer.mergeAll(EventValidationHost.defaultLayer, LocationIdentity.layer).pipe(
  Layer.provideMerge(Database.defaultLayer), Layer.provideMerge(ServerAuth.Config.defaultLayer), Layer.provide(FSUtil.defaultLayer),
)
const program = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const root = path.join(directory, "project")
  const installed = yield* NativeInstallation.current()
  const executable = yield* Effect.promise(() => WorkCommandRuntime.verifiedMacX64Runtime(installed))
  const inspected = yield* WorkFileHelper.inspectRoot(root)
  const placement = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
    directory: AbsolutePath.make(root), project: { kind: "registered_root", observedProjectId: "intel-validation-project" } })
  const namespace = yield* db.get<{ binding_hash: string }>(sql`SELECT binding_hash FROM context_security_namespace WHERE id=${placement.securityNamespaceId}`)
  if (!namespace) throw new Error("Original registered namespace missing")
  const config = yield* ServerAuth.Config
  if (Option.isNone(config.password)) throw new Error("Private operator credential missing")
  const password = config.password.value
  yield* LocalTaskAuthority.ensurePrivateInstallation()
  const identity = yield* LocalTaskAuthority.configured(config)
  const configuration = Schema.decodeUnknownSync(EventValidationSchema.Configuration, { onExcessProperty: "error" })({
    profile: "project_validation_v1", kind: "test", helperHash: inspected.helperHash,
    scope: { instanceID: identity.runtime.instanceID, workspaceID: null, securityNamespaceID: placement.securityNamespaceId,
      namespaceBindingHash: namespace.binding_hash, locationKey: placement.locationKey, projectScopeKey: placement.projectScopeKey,
      projectID: "intel-validation-project", canonicalRoot: root, rootIdentity: inspected.rootIdentity },
    recipe: { schemaVersion: "work-command-recipe.mac-x64.v1", logicalID: "intel-test", revision: 1,
      executable: executable.executable, argv: ["test", "guard.test.ts", "--timeout", "5000"].map((value) => ({ kind: "literal", value })),
      parameters: [], cwd: null, inputs: ["guard.test.ts"], outputs: ["result.txt"], environment: [{ name: "CI", value: "1" }],
      workspace: "private_explicit_files.v1", sandbox: { id: "darwin-single-process-workspace-v1", revision: 1,
        network: "deny", processes: 1, openFiles: 64, maxInputFiles: 256, maxInputFileBytes: 16_777_216,
        maxInputBytes: 67_108_864, maxDepth: 16, maxOutputFiles: 32, maxOutputFileBytes: 1_048_576, maxOutputBytes: 33_554_432 },
      timeoutMs: 15_000, stdoutBytes: 1_048_576, stderrBytes: 1_048_576 },
    parameters: [], watch: ["guard.test.ts"], recipient: "local_status", maxRuns: 1,
    expiresAt: Date.now() + 120_000, investigation: "disabled", autoFix: false,
  })
  const provider = { providerID: "unused-validation", modelID: "unused", protocol: "openai-responses", routeID: "unused",
    configurationHash: "a".repeat(64), endpoint: "https://example.invalid/v1/responses", evidenceID: "unused", evidenceHash: "b".repeat(64),
    endpointPinned: true, redirectsDenied: true, transportRetriesDenied: true,
    completion: { parameter: "max_output_tokens", hardLimit: true, includesReasoning: true, maxTokens: 4096 } }
  yield* LocalOperator.enroll(db, { operationID: "enroll-intel", operatorID: "intel-validation-operator", username: config.username,
    credentialVerifier: yield* Effect.promise(() => Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 })),
    policy: { version: 2, targets: [{ id: "intel-project", locationKey: placement.locationKey, namespaceBindingHash: namespace.binding_hash,
      target: { version: 2, scope: { actorID: "intel-validation-operator", workspaceID: root,
        securityNamespaceID: placement.securityNamespaceId, projectScopeKey: placement.projectScopeKey }, location: { directory: root },
        agentID: "auto", profile: { id: "project_work_v1", version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
        projectScope: { projectID: "intel-validation-project", locationKey: placement.locationKey, namespaceBindingHash: namespace.binding_hash,
          canonicalRoot: root, helperHash: inspected.helperHash, rootIdentity: inspected.rootIdentity },
        contextPolicy: { kind: "scoped_project_history_v1", instructionsRevision: 1, history: "same_work_activity", graphs: [], references: [], files: "approved_tool_results_only" },
        toolPolicy: { kind: "scoped_project_tools_v1", capabilities: [{ toolID: "managed_command", definitionHash: "e".repeat(64), operations: ["run"] }],
          fileScope: { read: [{ kind: "file", path: "guard.test.ts" }], write: [], deny: [], maxReadBytes: 67_108_864,
            maxPageBytes: 51_200, maxHashBytes: 16_777_216, maxWriteBytes: 0, symlinks: "deny" },
          commandScope: [], commandRecipes: [configuration.recipe], integrations: [] }, childPolicy: "deny_all",
        provider, budget: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, durationMs: 60_000 } }] },
  }).pipe(Effect.provideService(LocalOperator.Runtime, identity.runtime))
  const witness = yield* LocalTaskAuthority.authenticatePassword(db, identity.runtime, config.username, password)
  const auth = { runtime: identity.runtime, witness }
  const host = yield* EventValidationHost.Service
  yield* LocalTaskAuthority.provide(auth, host.configure({ ruleID: "intel-rule", requestID: "create", expectedRevision: 0, configuration }))
  yield* LocalTaskAuthority.provide(auth, host.control({ ruleID: "intel-rule", requestID: "enable", expectedRevision: 1, action: "enable" }))
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const runs = (yield* host.history("intel-rule"))
    const completed = runs.find((run) => run.resultCurrent && run.releasedAt !== null)
    if (completed) {
      yield* LocalTaskAuthority.provide(auth, host.control({ ruleID: "intel-rule", requestID: "pause", expectedRevision: 2, action: "pause" }))
      const counts = yield* db.get<{ inputs: number; providers: number; runCount: number }>(sql`SELECT
        (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers,
        (SELECT count(*) FROM event_validation_run) runCount`)
      return { target: (yield* NativeInstallation.describe(installed)).target, recipeTag: configuration.recipe.schemaVersion,
        outcome: completed.outcome, state: completed.state, result: completed.result,
        known: completed.terminalAt !== null, cleanup: completed.releasedAt !== null, retainedBytes: completed.retainedBytes,
        contentHash: completed.contentHash, recipeHash: completed.recipeHash, processID: completed.processID,
        ruleState: (yield* EventValidation.getRule(db, "intel-rule"))?.state, counts }
    }
    yield* Effect.sleep(50)
  }
  throw new Error("Intel validation did not reach the original durable known/cleanup boundary")
}).pipe(Effect.provide(services), Effect.provide(Global.layer), Effect.scoped)
const exit = await Effect.runPromiseExit(program)
process.stdout.write(`${JSON.stringify(Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, error: Cause.pretty(exit.cause) })}\n`)
process.exitCode = Exit.isSuccess(exit) ? 0 : 1
