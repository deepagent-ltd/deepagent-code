export * as EventValidationSchema from "./event-validation.schema"

import { Schema } from "effect"
import { WorkCommandSchema } from "../session/work-command.schema"
import { WorkCommandMacX64Schema } from "../session/work-command-mac-x64.schema"
import { WorkCommandV2Schema } from "../session/work-command-v2.schema"
import { WorkProcessSupervisorSchema } from "../session/work-process-supervisor.schema"
import { EventInvestigationAuthoritySchema } from "./event-investigation-authority.schema"

const bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max),
  Schema.makeFilter((value: string) => Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value)))
export const ID = bounded(512)
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const Positive = Count.check(Schema.isGreaterThanOrEqualTo(1))
const Time = Schema.NullOr(Positive)
const Relative = bounded(2048).check(Schema.makeFilter((value: string) => !value.includes("\\") && !value.includes(":") &&
  value.split("/").length <= 16 && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")))
export const DEBOUNCE_MS = 750
export const MAX_MERGE_MS = 5000
export const MAX_RULE_BYTES = 65_536
export const MAX_RUN_BYTES = 262_144
export const MAX_COMMAND_BYTES = 8192
export const MAX_RULES = 256
export const MAX_RUNS = 10_000
export const MAX_COMMANDS = 10_000
export const MAX_CUSTODY = 8
export const RESERVATION_BYTES = WorkCommandSchema.RESERVATION_BYTES
export const Scope = Schema.Struct({
  instanceID: ID, workspaceID: Schema.NullOr(ID), securityNamespaceID: ID, namespaceBindingHash: Digest,
  locationKey: ID, projectScopeKey: ID, projectID: ID, canonicalRoot: bounded(2048),
  rootIdentity: WorkCommandSchema.Identity,
})
export type Scope = typeof Scope.Type

export const MacRecipe = Schema.Union([WorkCommandSchema.Recipe, WorkCommandMacX64Schema.Recipe])
export type MacRecipe = typeof MacRecipe.Type
export const MacRecipeRequest = Schema.Union([WorkCommandSchema.RecipeRequest, WorkCommandMacX64Schema.RecipeRequest])
export type MacRecipeRequest = typeof MacRecipeRequest.Type
const LinuxTarget = Schema.Literals(["linux-x64", "linux-arm64"])
export const LinuxRecipe = Schema.Struct({ ...WorkCommandV2Schema.Recipe.fields,
  executable: Schema.Struct({ ...WorkCommandV2Schema.Recipe.fields.executable.fields,
    platform: LinuxTarget, identity: WorkCommandSchema.Identity }),
  sandbox: WorkProcessSupervisorSchema.LinuxIsolation,
}).check(Schema.makeFilter(Schema.is(WorkCommandV2Schema.Recipe)))
export const LinuxRecipeRequest = Schema.Struct({ ...WorkCommandV2Schema.RecipeRequest.fields,
  target: LinuxTarget, sandbox: WorkProcessSupervisorSchema.LinuxIsolation,
}).check(Schema.makeFilter(Schema.is(WorkCommandV2Schema.RecipeRequest)))
export const Recipe = Schema.Union([MacRecipe, LinuxRecipe])
export type Recipe = typeof Recipe.Type
export const RecipeRequest = Schema.Union([MacRecipeRequest, LinuxRecipeRequest])
export type RecipeRequest = typeof RecipeRequest.Type

/** This is explicit operator configuration, never an instruction discovered in a file,
 * watcher payload, model result, or chat. The host captures the installed recipe. */
export const Configuration = Schema.Struct({
  profile: Schema.Literal("project_validation_v1"), scope: Scope,
  kind: Schema.Literals(["test", "build"]), recipe: Recipe,
  parameters: WorkCommandSchema.Input.fields.parameters,
  helperHash: Digest,
  watch: Schema.Array(Relative).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  recipient: Schema.Literal("local_status"),
  maxRuns: Positive.check(Schema.isLessThanOrEqualTo(MAX_RUNS)), expiresAt: Positive,
  investigation: Schema.Literal("disabled"), autoFix: Schema.Literal(false),
}).check(Schema.makeFilter((value) => new Set(value.watch).size === value.watch.length &&
  value.recipe.inputs.every((relative) => value.watch.includes(relative)) &&
  value.parameters.length === value.recipe.parameters.length && new Set(value.parameters.map((item) => item.key)).size === value.parameters.length &&
  value.parameters.every((item) => value.recipe.parameters.some((allowed) => allowed.key === item.key && allowed.choices.includes(item.value))) &&
  value.watch.reduce((sum, item) => sum + Buffer.byteLength(item), 0) <= 8192))
export type Configuration = typeof Configuration.Type

export const RuleState = Schema.Literals(["disabled", "enabled", "paused", "revoked"])
export const Reason = Schema.Literals(["disabled", "paused", "revoked", "debouncing", "unchanged", "ready", "running",
  "superseded", "cancelled", "expired", "budget_exhausted", "authority_changed", "native_unavailable", "unknown", "completed"])
export const RuleRecord = Schema.Struct({
  version: Schema.Literal(1), ruleID: ID, instanceID: ID, projectKey: Digest, revision: Positive, state: RuleState,
  operatorID: ID, operatorRevision: Positive, configuration: Configuration, configHash: Digest,
  approval: Schema.NullOr(Schema.Struct({ ruleRevision: Positive, operatorRevision: Positive, configHash: Digest })),
  contentRevision: Count, contentHash: Schema.NullOr(Digest), runCount: Count,
  pendingFirstAt: Time, pendingLastAt: Time, dueAt: Time,
  currentRunID: Schema.NullOr(ID), lastReason: Reason, createdAt: Positive, updatedAt: Positive,
  investigationAuthority: Schema.optional(EventInvestigationAuthoritySchema.Authority),
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_RULE_BYTES))
export type RuleRecord = typeof RuleRecord.Type

export const File = Schema.Struct({ relative: Relative, identity: Schema.NullOr(WorkCommandSchema.Identity),
  sha256: Schema.NullOr(Digest), bytes: Count.check(Schema.isLessThanOrEqualTo(16_777_216)), missing: Schema.Boolean })
export const Content = Schema.Struct({ files: Schema.Array(File).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  contentHash: Digest, observedAt: Positive,
}).check(Schema.makeFilter((value) => new Set(value.files.map((item) => item.relative)).size === value.files.length &&
  value.files.reduce((sum, item) => sum + item.bytes, 0) <= 67_108_864 &&
  value.files.every((item) => item.missing ? item.identity === null && item.sha256 === null && item.bytes === 0 : item.identity !== null && item.sha256 !== null)))
export type Content = typeof Content.Type
export const Stream = Schema.Struct({ sha256: Digest, bytes: Count,
  capturedBytes: Count.check(Schema.isLessThanOrEqualTo(1_048_576)), truncated: Schema.Boolean, complete: Schema.Boolean,
  excerptTruncated: Schema.Boolean,
  excerpt: Schema.String.check(Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 65_536)),
})
export const RunState = Schema.Literals(["queued", "preparing", "dispatching", "settled", "cancelled", "superseded", "unknown"])
export const Result = Schema.Struct({ outcome: Schema.Literals(["passed", "failed", "cancelled", "refused"]),
  exitCode: Schema.NullOr(Schema.Int), signal: Schema.NullOr(ID), stdout: Stream, stderr: Stream,
  stopConfirmed: Schema.Boolean, endedAt: Positive,
})
export type Result = typeof Result.Type
export const PreparationRelease = Schema.Struct({ version: Schema.Literal(1), preparationID: ID,
  kind: Schema.Literals(["no_workspace_created", "partial_workspace_cleaned"]),
  workspaceIdentity: Schema.NullOr(WorkCommandSchema.Identity), observedAt: Positive,
}).check(Schema.makeFilter((value) => value.kind === "no_workspace_created" ? value.workspaceIdentity === null : value.workspaceIdentity !== null))
export const RunRecord = Schema.Struct({
  version: Schema.Literal(1), runID: ID, ruleID: ID, instanceID: ID, projectKey: Digest,
  ruleRevision: Positive, contentRevision: Positive, contentHash: Digest, recipeHash: Digest, configHash: Digest,
  state: RunState, outcome: Schema.NullOr(Result.fields.outcome), ownerToken: ID, revision: Positive,
  cancelRequested: Schema.Boolean, content: Content,
  testRunID: Schema.NullOr(ID), previewBuildID: Schema.NullOr(ID),
  snapshotHash: Schema.NullOr(Digest), processIncarnation: Schema.NullOr(ID), processID: Schema.NullOr(Positive),
  workspaceBasename: Schema.String.check(Schema.isPattern(/^cmd_[a-f0-9]{32}$/)),
  workspaceIdentity: Schema.NullOr(WorkCommandSchema.Identity), retainedBytes: Count, releasedAt: Time,
  result: Schema.NullOr(Result), resultCurrent: Schema.Boolean,
  createdAt: Positive, startedAt: Time, terminalAt: Time, deadline: Positive,
  preparationRelease: Schema.optional(PreparationRelease),
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_RUN_BYTES &&
  (!value.preparationRelease || ((value.state === "cancelled" || value.state === "superseded") &&
    (value.outcome === "cancelled" || value.outcome === "refused") && value.result === null && !value.resultCurrent &&
    value.processID === null && value.startedAt === null && value.terminalAt !== null && value.releasedAt !== null && value.retainedBytes === 0 &&
    value.preparationRelease.observedAt >= value.createdAt && value.preparationRelease.observedAt <= value.releasedAt))))
export type RunRecord = typeof RunRecord.Type
export const RunView = Schema.Struct({ record: RunRecord, current: Schema.Boolean,
  observation: Schema.Literals(["owned", "known_terminal", "recovery_required"]) })

export const Action = Schema.Literals(["create", "update", "enable", "pause", "revoke", "verify", "cancel"])
export const CommandReceipt = Schema.Struct({ version: Schema.Literal(1), instanceID: ID, requestID: ID,
  ruleID: ID, action: Action, ruleRevision: Positive, runID: Schema.NullOr(ID), createdAt: Positive,
  investigation: Schema.optional(Schema.Struct({ version: Schema.Literal(1),
    operation: Schema.Literals(["enable", "disable"]), epoch: Positive })),
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_COMMAND_BYTES))
export type CommandReceipt = typeof CommandReceipt.Type
export const Configure = Schema.Struct({ ruleID: ID, requestID: ID, expectedRevision: Count, configuration: Configuration })
export const CandidatesRequest = Schema.Struct({ sessionID: ID })
export const Candidates = Schema.Struct({ targets: Schema.Array(Schema.Struct({ targetID: ID,
  recipes: Schema.Array(RecipeRequest).check(Schema.isMaxLength(32)) })).check(Schema.isMaxLength(32)) })
export const Capture = Schema.Struct({ sessionID: ID, targetID: ID, recipeID: ID,
  parameters: Configuration.fields.parameters, watch: Configuration.fields.watch,
  maxRuns: Configuration.fields.maxRuns, expiresAt: Positive })
export const Captured = Schema.Struct({ captureID: ID, expiresAt: Positive,
  preview: Schema.Struct({ kind: Configuration.fields.kind, recipe: RecipeRequest,
    parameters: Configuration.fields.parameters, watch: Configuration.fields.watch,
    maxRuns: Configuration.fields.maxRuns, ruleExpiresAt: Positive }) })
export const ConfigureCaptured = Schema.Struct({ captureID: ID, ruleID: ID, requestID: ID, expectedRevision: Count })
export const Control = Schema.Struct({ ruleID: ID, requestID: ID, expectedRevision: Positive,
  action: Schema.Literals(["enable", "pause", "revoke", "verify", "cancel"]) })
export class Error extends Schema.TaggedErrorClass<Error>()("EventValidation.Error", {
  code: Schema.Literals(["VALIDATION_INVALID", "VALIDATION_NOT_FOUND", "VALIDATION_CONFLICT", "VALIDATION_AUTH_REQUIRED",
    "VALIDATION_SCOPE_CHANGED", "VALIDATION_UNAVAILABLE", "VALIDATION_CAPACITY", "VALIDATION_RECOVERY_REQUIRED", "VALIDATION_CAPTURE_EXPIRED"]),
  message: Schema.String,
}) {}
