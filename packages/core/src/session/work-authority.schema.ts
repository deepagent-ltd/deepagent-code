export * as WorkAuthoritySchema from "./work-authority.schema"

import { Schema } from "effect"
import { WorkCommandSchema } from "./work-command.schema"
import { WorkCommandV2Schema } from "./work-command-v2.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Revision = Count.check(Schema.isGreaterThanOrEqualTo(1))
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const ErrorCode = Schema.Literals([
  "WORK_INVALID_REQUEST",
  "WORK_AUTHORITY_MISSING",
  "WORK_REQUEST_CONFLICT",
  "WORK_BINDING_CONFLICT",
  "WORK_CONTROL_CONFLICT",
  "WORK_NOT_READY",
  "WORK_REVOKED",
  "WORK_PAUSED",
  "WORK_EXPIRED",
  "WORK_BUDGET_EXHAUSTED",
  "WORK_CEILING_VIOLATION",
  "WORK_RECOVERY_REQUIRED",
  "WORK_DISPATCH_CONFLICT",
  "PROFILE_UNAVAILABLE",
  "WORK_ENDPOINT_DENIED",
])
export type ErrorCode = typeof ErrorCode.Type

export class Error extends Schema.TaggedErrorClass<Error>()("WorkAuthority.Error", {
  code: ErrorCode,
  message: Schema.String,
}) {}

export const AdmissionState = Schema.Literals(["reserved", "ready", "rejected"])
export const ControlState = Schema.Literals(["active", "paused", "revoked", "cancelled", "expired"])
export const Outcome = Schema.Literals(["pending", "succeeded", "failed", "unknown"])
export const DispatchState = Schema.Literals(["reserved", "dispatching", "settled", "released", "unknown"])
export type AdmissionState = typeof AdmissionState.Type
export type ControlState = typeof ControlState.Type
export type Outcome = typeof Outcome.Type
export type DispatchState = typeof DispatchState.Type

export const Budget = Schema.Struct({
  maxTotalTokens: Count,
  maxInputTokens: Count,
  // Completion INCLUDES reasoning. Never add reasoning to completion a second time.
  maxCompletionTokens: Count,
  maxProviderDispatches: Count,
  maxToolCalls: Count,
  maxChildren: Count,
  maxDurationMs: Count,
  hourTokensMax: Count,
  hourWindowMinutes: Revision,
})
export type Budget = typeof Budget.Type

export const Location = Schema.Struct({ directory: Text, workspaceID: Text.pipe(Schema.optional) })
export type Location = typeof Location.Type

/** References are data, not proof. The server must resolve the live record before reserve/dispatch. */
export const Source = Schema.Struct({
  kind: Schema.Literals(["server_operator", "server_rule"]),
  authorityID: Text,
  authorityRevision: Revision,
  sourceID: Text,
  requestID: Text,
  requestHash: Digest,
})

/** Supplied by the trusted route resolver, never copied from ordinary HTTP/plugin metadata. */
export const ProviderRoute = Schema.Struct({
  providerID: Text,
  modelID: Text,
  protocol: Text,
  routeID: Text,
  configurationHash: Digest,
  endpoint: Text,
  evidenceID: Text,
  evidenceHash: Digest,
  endpointPinned: Schema.Boolean,
  redirectsDenied: Schema.Boolean,
  transportRetriesDenied: Schema.Boolean,
  completion: Schema.Struct({
    parameter: Text,
    hardLimit: Schema.Boolean,
    includesReasoning: Schema.Boolean,
    maxTokens: Revision,
  }),
})
export type ProviderRoute = typeof ProviderRoute.Type

export const LegacyBinding = Schema.Struct({
  schemaVersion: Schema.Literal("work-execution.v1"),
  workID: Text,
  rootWorkID: Text,
  parentWorkID: Text.pipe(Schema.optional),
  attemptKey: Text,
  source: Source,
  envelopeHash: Digest,
  scope: Schema.Struct({ actorID: Text, workspaceID: Text, securityNamespaceID: Text, projectScopeKey: Text }),
  location: Location,
  agentID: Text,
  sessionID: Text,
  inputID: Text,
  profile: Schema.Struct({ id: Text, version: Revision, hash: Digest }),
  auditedText: Schema.Struct({ hash: Digest, utf8Bytes: Count, snapshotRef: Text }),
  contextPolicy: Schema.Literal("static_instructions_and_audited_text"),
  toolPolicy: Schema.Literal("deny_all"),
  childPolicy: Schema.Literal("deny_all"),
  provider: ProviderRoute,
  budget: Budget,
  deadline: Count,
})
export type LegacyBinding = typeof LegacyBinding.Type

const ProjectText = Text.check(Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= 512))
const ProjectPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= 2048 && !/[\u0000-\u001f\u007f]/.test(value)))
const RelativeProjectPath = ProjectPath.check(Schema.makeFilter((value: string) =>
  !value.includes("\\") && !value.includes(":") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")))
const ProjectPathRule = Schema.Struct({ kind: Schema.Literals(["file", "tree"]), path: RelativeProjectPath })
const ProjectProfile = Schema.Struct({ id: ProjectText, version: Revision, hash: Digest })
const ProjectResource = Schema.Struct({ id: ProjectText, revision: Revision, hash: Digest })
const DecimalIdentity = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/))

/** A versioned project grant is DATA, not a native path handle or a tool dispatch permit.
 * The profile/current-source verifier must separately authorize this explicit version. The
 * union never converts a v1 grant or synthesizes its project fields from current configuration. */
export const ProjectBinding = Schema.Struct({
  ...LegacyBinding.fields,
  schemaVersion: Schema.Literal("work-execution.v2"),
  workID: ProjectText,
  rootWorkID: ProjectText,
  parentWorkID: Schema.optional(ProjectText),
  attemptKey: ProjectText,
  source: Schema.Struct({ ...Source.fields, authorityID: ProjectText, sourceID: ProjectText,
    requestID: ProjectText }),
  scope: Schema.Struct({ actorID: ProjectText, workspaceID: ProjectText,
    securityNamespaceID: ProjectText, projectScopeKey: ProjectText }),
  location: Schema.Struct({ directory: ProjectPath, workspaceID: Schema.optional(ProjectText) }),
  agentID: ProjectText,
  sessionID: ProjectText,
  inputID: ProjectText,
  profile: Schema.Struct({ id: Schema.Literals(["project_work_v1", "event_investigate_v1", "project_shared_root_v1", "project_deepseek_context_bound_v1", "event_deepseek_dag_v1"]), version: Schema.Literal(1), hash: Digest }),
  auditedText: Schema.Struct({ hash: Digest, utf8Bytes: Count, snapshotRef: ProjectText }),
  projectScope: Schema.Struct({
    projectID: ProjectText,
    locationKey: ProjectText,
    namespaceBindingHash: Digest,
    canonicalRoot: ProjectPath,
    helperHash: Digest,
    rootIdentity: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("posix"), device: DecimalIdentity, inode: DecimalIdentity }),
      Schema.Struct({ kind: Schema.Literal("windows"), volumeSerial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
        fileID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) }),
    ]),
  }),
  contextPolicy: Schema.Struct({
    kind: Schema.Literal("scoped_project_history_v1"),
    instructionsRevision: Revision,
    history: Schema.Literal("same_work_activity"),
    graphs: Schema.Array(Schema.Never),
    references: Schema.Array(Schema.Never),
    files: Schema.Literal("approved_tool_results_only"),
  }),
  toolPolicy: Schema.Struct({
    kind: Schema.Literal("scoped_project_tools_v1"),
    capabilities: Schema.Array(Schema.Struct({
      toolID: ProjectText,
      definitionHash: Digest,
      operations: Schema.Array(Schema.Literals(["read", "list", "search", "write", "edit", "run", "delegate", "mcp", "browser", "network"]))
        .check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    })).check(Schema.isMaxLength(128)),
    fileScope: Schema.Struct({
      read: Schema.Array(ProjectPathRule).check(Schema.isMaxLength(128)),
      write: Schema.Array(ProjectPathRule).check(Schema.isMaxLength(128)),
      deny: Schema.Array(ProjectPathRule).check(Schema.isMaxLength(128)),
      maxReadBytes: Count,
      maxPageBytes: Revision.check(Schema.isLessThanOrEqualTo(51_200)),
      maxHashBytes: Revision.check(Schema.isLessThanOrEqualTo(16_777_216)),
      maxWriteBytes: Count,
      symlinks: Schema.Literal("deny"),
    }),
    commandScope: Schema.Array(Schema.Struct({
      command: ProjectResource,
      sandbox: ProjectResource,
      environmentHash: Digest,
      networkHash: Digest,
      filesystemHash: Digest,
    })).check(Schema.isMaxLength(32)),
    commandRecipes: Schema.optional(Schema.Array(WorkCommandV2Schema.ApprovedRecipe).check(Schema.isMaxLength(32),
      Schema.makeFilter((recipes) => new Set(recipes.map((recipe) => recipe.logicalID)).size === recipes.length))),
    integrations: Schema.Array(Schema.Struct({
      kind: Schema.Literals(["mcp", "browser", "network"]),
      capability: ProjectResource,
      resources: Schema.Array(ProjectText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    })).check(Schema.isMaxLength(32)),
  }),
  childPolicy: Schema.Union([
    Schema.Literal("deny_all"),
    Schema.Struct({ kind: Schema.Literal("root_budget_inheritance_v1"),
      maxConcurrent: Revision.check(Schema.isLessThanOrEqualTo(2)),
      profiles: Schema.Array(ProjectProfile).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    }),
    Schema.Struct({ kind: Schema.Literal("shared_root_v1"),
      maxConcurrent: Revision.check(Schema.isLessThanOrEqualTo(2)),
      agents: Schema.Array(ProjectText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
      toolIDs: Schema.Array(ProjectText).check(Schema.isMaxLength(128)),
      budget: Budget,
    }),
    Schema.Struct({ kind: Schema.Literal("event_dag_v1"),
      maxConcurrent: Revision.check(Schema.isLessThanOrEqualTo(2)),
      agents: Schema.Array(ProjectText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
      toolIDs: Schema.Array(ProjectText).check(Schema.isMaxLength(128)),
      budget: Budget,
    }),
  ]),
  provider: Schema.Struct({ ...ProviderRoute.fields, providerID: ProjectText, modelID: ProjectText,
    protocol: ProjectText, routeID: ProjectText, endpoint: ProjectPath, evidenceID: ProjectText,
    completion: Schema.Struct({ ...ProviderRoute.fields.completion.fields, parameter: ProjectText }) }),
})
export type ProjectBinding = typeof ProjectBinding.Type
export const Binding = Schema.Union([LegacyBinding, ProjectBinding])
export type Binding = typeof Binding.Type

export const InputBound = Schema.Struct({
  tokens: Count,
  kind: Schema.Literals(["exact", "conservative"]),
  evidenceID: Text,
  evidenceHash: Digest,
})
export type InputBound = typeof InputBound.Type

export const Usage = Schema.Struct({
  inputTokens: Count,
  completionTokens: Count,
  reasoningTokens: Count.pipe(Schema.optional),
})
export type Usage = typeof Usage.Type

export type Validation<A> =
  | { readonly ok: true; readonly value: A; readonly authorization: "not_checked" }
  | { readonly ok: false; readonly error: Error }
