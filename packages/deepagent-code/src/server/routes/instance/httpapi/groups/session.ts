import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Permission } from "@/permission"
import { SessionV1 } from "@deepagent-code/core/v1/session"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import {
  ApiNotFoundError,
  ConflictError,
  InvalidRequestError,
  PermissionNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
} from "../errors"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { GraphKind } from "@deepagent-code/core/context-federation/contract"
import { GraphQueryStatus } from "@deepagent-code/core/context-federation/federation"
import { Sensitivity } from "@deepagent-code/core/context-federation/authorization"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { File as DiffArtifactFile, Limits as DiffArtifactLimits, Manifest as DiffArtifactManifest } from "@/session/diff-artifact-schema"

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Struct.omit(SessionSummary.DiffInput.fields, ["sessionID"]),
})
export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MessageV2.ClientMessageLimits.page),
    ),
  ),
  before: Schema.optional(Schema.String),
})
export const DiffArtifactMaintenancePayload = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(DiffArtifactLimits.batch),
    ),
  ),
})
export const DiffArtifactManifestQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  messageID: MessageID,
  artifactID: Schema.String,
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(DiffArtifactLimits.manifestFiles),
    ),
  ),
})
export const DiffArtifactFileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  messageID: MessageID,
  artifactID: Schema.String,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  maxBytes: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(DiffArtifactLimits.patchBytes),
    ),
  ),
})
export const StatusMap = Schema.Record(Schema.String, SessionStatus.Info)
export const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Session.Metadata),
  permission: Schema.optional(PermissionV1.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Schema.NullOr(Session.ArchivedTimestamp)),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const LegacyForkPayload = Schema.Struct({
  ...Struct.omit(Session.ForkInput.fields, ["sessionID", "intentID"]),
  intentID: Schema.optional(Schema.NonEmptyString),
})
export const InitPayload = Schema.Struct({
  modelID: ModelV2.ID,
  providerID: ProviderV2.ID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const PromptAsyncAccepted = Schema.Struct({
  messageID: MessageID,
  delivery: Schema.Literals(["turn", "steer", "queue", "goal_steer"]),
})
export const PromptPreparePayload = Schema.Struct({
  // Legacy-compat: "wish" is the pre-rename wire literal for "intelligence". The server accepts BOTH
  // so an older client sending "wish" still works while new clients send "intelligence"; the handler
  // normalizes internally. Do NOT drop "wish" from this union.
  mode: Schema.Literals(["wish", "intelligence"]),
  output_language: Schema.optional(Schema.Literals(["chinese", "english"])),
  intent_id: Schema.optional(Schema.String),
  intent_source: Schema.optional(Schema.Literals(["composer", "intelligence", "followup", "rewrite"])),
  parts: SessionPrompt.PromptInput.fields.parts,
})
export const PromptPrepareResult = Schema.Struct({
  prompt_draft_id: Schema.String,
  context_plan_id: Schema.String,
  state: Schema.String,
  // The result echoes the canonical post-rename literal; older clients tolerate the string.
  mode: Schema.Literal("intelligence"),
  route: Schema.Union([Schema.Literal("code"), Schema.Literal("general")]),
  goal: Schema.String,
  preview: Schema.String,
  intent_id: Schema.optional(Schema.String),
})
// A3 macro-round: the latest persisted next-round suggestion for human approval. `null` body when
// no suggestion exists yet.
export const PromptSuggestionResult = Schema.Struct({
  status: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
})
const PlanSnapshotStep = Schema.Struct({
  step_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  acceptance: Schema.NullOr(Schema.String),
  assigned_agent: Schema.NullOr(Schema.String),
  evidence: Schema.Array(Schema.String),
  note: Schema.NullOr(Schema.String),
})
const PlanSnapshot = Schema.Struct({
  plan_id: Schema.String,
  session_id: Schema.String,
  goal: Schema.String,
  assumptions: Schema.Array(Schema.String),
  steps: Schema.Array(PlanSnapshotStep),
  active_step_id: Schema.NullOr(Schema.String),
  replan_reason: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
})
export const PlanSnapshotResult = Schema.Struct({
  plan: Schema.NullOr(PlanSnapshot),
  doc_id: Schema.NullOr(Schema.String),
  plan_version: Schema.NullOr(Schema.Number),
})
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: PermissionV1.Reply,
})
export const ContextEvidenceResult = Schema.Struct({
  token: Schema.String,
  graph: GraphKind,
  revision: Schema.String,
  sensitivity: Sensitivity,
  freshness: Schema.Literals(["current", "historical", "expired", "superseded", "conflict", "unknown"]),
  score: Schema.Finite,
  reason: Schema.String,
  provenance: Schema.Array(Schema.String),
  relations: Schema.Array(
    Schema.Struct({
      relation: Schema.String,
      token: Schema.String,
      freshness: Schema.Literals(["exact", "rebound", "broken"]),
    }),
  ),
})
export const ContextArtifactResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), ref: Schema.String }),
  Schema.Struct({
    status: Schema.Literals(["degraded_unavailable", "expired", "unavailable"]),
    reasonCode: Schema.String,
  }),
])
export const ContextSelectionResult = Schema.Struct({
  selectionId: Schema.String,
  activityId: Schema.String,
  activityState: Schema.Literals(["active", "settled", "failed", "interrupted"]),
  revision: Schema.Int,
  summary: Schema.Literals(["complete", "partial", "empty"]),
  statuses: Schema.Array(GraphQueryStatus),
  evidence: Schema.Array(ContextEvidenceResult),
  tokenCount: Schema.Int,
  stale: Schema.Boolean,
  nextRevalidationAt: Schema.Int,
  artifact: ContextArtifactResult,
  createdAt: Schema.Int,
})
export const ContextAttemptResult = Schema.Struct({
  attemptId: Schema.String,
  activityId: Schema.String,
  providerTurnSeq: Schema.Int,
  selectionId: Schema.String,
  providerId: Schema.String,
  parentAttemptId: Schema.optional(Schema.String),
  state: Schema.Literals([
    "prepared",
    "dispatching",
    "streaming",
    "settled",
    "failed",
    "indeterminate_after_crash",
    "resolved_abandoned",
    "resolved_settled",
    "resolved_replayed",
  ]),
  createdAt: Schema.Int,
  firstEventAt: Schema.optional(Schema.Int),
  settledAt: Schema.optional(Schema.Int),
  errorCode: Schema.optional(Schema.String),
  ageMs: Schema.Int,
  canAbandon: Schema.Boolean,
  canSettle: Schema.Boolean,
  canReplay: Schema.Boolean,
  resolution: Schema.optional(
    Schema.Struct({
      decision: Schema.Literals(["abandoned", "settled", "replayed"]),
      actorType: Schema.Literals(["user", "administrator", "system"]),
      actorId: Schema.String,
      riskAcknowledged: Schema.Boolean,
      reason: Schema.String,
      createdAt: Schema.Int,
    }),
  ),
})
export const ContextGraphMetricResult = Schema.Struct({
  graph: GraphKind,
  queries: Schema.Int,
  candidates: Schema.Int,
  selected: Schema.Int,
  rejected: Schema.Int,
  redacted: Schema.Int,
  averageLatencyMs: Schema.Finite,
  maxLatencyMs: Schema.Finite,
  lastLatencyMs: Schema.Finite,
  lastObservedAt: Schema.optional(Schema.Int),
  status: Schema.optional(GraphQueryStatus),
})
export const ContextDiagnosticsResult = Schema.Struct({
  sessionId: SessionID,
  selections: Schema.Array(ContextSelectionResult),
  attempts: Schema.Array(ContextAttemptResult),
  metrics: Schema.Struct({
    selections: Schema.Int,
    tokens: Schema.Int,
    shadow: Schema.Struct({
      comparisons: Schema.Int,
      legacyKnowledgeRefs: Schema.Int,
      legacyMemoryRefs: Schema.Int,
      federated: Schema.Struct({
        code: Schema.Int,
        knowledge: Schema.Int,
        memory: Schema.Int,
        documents: Schema.Int,
      }),
      knowledgeMemoryDelta: Schema.Int,
    }),
    graphs: Schema.Array(ContextGraphMetricResult),
    alerts: Schema.Array(
      Schema.Struct({
        graph: GraphKind,
        state: Schema.Literals([
          "ready",
          "cold",
          "indexing",
          "stale",
          "degraded",
          "unavailable",
          "denied",
          "not_queried",
        ]),
        reasonCode: Schema.String,
      }),
    ),
  }),
})
export const ContextAttemptResolvePayload = Schema.Struct({
  decision: Schema.Literals(["abandoned", "settled", "replayed"]),
  reason: Schema.String,
  riskAcknowledged: Schema.optional(Schema.Boolean),
})
// FEAT-005: cohort-level durable aggregation query/result. The window is [sinceMs, untilMs]; untilMs
// defaults to now when omitted. Result buckets selections by readiness (see diagnostics.cohort).
export const ContextCohortQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sinceMs: Schema.NumberFromString,
  untilMs: Schema.optional(Schema.NumberFromString),
})
const ContextCohortGraphStat = Schema.Struct({
  statuses: Schema.Int,
  ready: Schema.Int,
  notReady: Schema.Int,
})
export const ContextCohortResult = Schema.Struct({
  window: Schema.Struct({ sinceMs: Schema.Int, untilMs: Schema.Int }),
  selections: Schema.Int,
  sessions: Schema.Int,
  tokens: Schema.Int,
  readiness: Schema.Struct({
    ready: Schema.Int,
    building: Schema.Int,
    degraded: Schema.Int,
    blocked: Schema.Int,
  }),
  graphs: Schema.Struct({
    code: ContextCohortGraphStat,
    knowledge: ContextCohortGraphStat,
    memory: ContextCohortGraphStat,
    documents: ContextCohortGraphStat,
  }),
})
export const ProviderResolutionPayload = Schema.Struct(
  Struct.omit(SessionLegacyProviderResolution.ResolveInput.fields, ["sessionID"]),
)

export const ImportSnapshotPayload = Schema.Struct({
  bundle: Schema.String,
})
export const ImportSnapshotResult = Schema.Struct({
  sessionID: Schema.String,
  messages: Schema.Number,
  parts: Schema.Number,
})

export const SessionPaths = {
  list: root,
  status: `${root}/status`,
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  todo: `${root}/:sessionID/todo`,
  plan: `${root}/:sessionID/plan`,
  diff: `${root}/:sessionID/diff`,
  diffArtifactMaintenance: `${root}/:sessionID/diff-artifact/maintenance`,
  diffArtifactManifest: `${root}/:sessionID/diff-artifact/manifest`,
  diffArtifactFile: `${root}/:sessionID/diff-artifact/file`,
  messages: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
  summarize: `${root}/:sessionID/summarize`,
  prompt: `${root}/:sessionID/message`,
  promptPrepare: `${root}/:sessionID/prompt_prepare`,
  promptPrepareStream: `${root}/:sessionID/prompt_prepare_stream`,
  promptSuggestion: `${root}/:sessionID/prompt_suggestion`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  command: `${root}/:sessionID/command`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permissions: `${root}/:sessionID/permissions/:permissionID`,
  deleteMessage: `${root}/:sessionID/message/:messageID`,
  deletePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  updatePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  contextDiagnostics: `${root}/:sessionID/context`,
  contextAttemptResolve: `${root}/:sessionID/context/attempt/:attemptID/resolve`,
  contextCohort: `${root}/context/cohort`,
  providerResolution: `${root}/:sessionID/provider-resolution`,
  exportSnapshot: `${root}/:sessionID/export`,
  importSnapshot: `${root}/import-snapshot`,
} as const

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Session.Info), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.list",
            summary: "List sessions",
            description: "Get a list of all DeepAgent Code sessions, sorted by most recently updated.",
          }),
        ),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusMap, "Get session status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.status",
            summary: "Get session status",
            description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Get session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Get session",
            description: "Retrieve detailed information about a specific DeepAgent Code session.",
          }),
        ),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Session.Info), "List of children"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.children",
            summary: "Get session children",
            description: "Retrieve all child sessions that were forked from the specified parent session.",
          }),
        ),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Info), "Todo list"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.todo",
            summary: "Get session todos",
            description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
          }),
        ),
        HttpApiEndpoint.get("plan", SessionPaths.plan, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(PlanSnapshotResult, "Current durable session plan"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.plan",
            summary: "Get session plan",
            description: "Retrieve the versioned durable plan snapshot for a session.",
          }),
        ),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: { sessionID: SessionID },
          query: DiffQuery,
          success: described(Schema.Array(Snapshot.FileDiff), "Successfully retrieved diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diff",
            summary: "Get message diff",
            description: "Get the file changes (diff) that resulted from a specific user message in the session.",
          }),
        ),
        HttpApiEndpoint.post("diffArtifactMaintenance", SessionPaths.diffArtifactMaintenance, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: DiffArtifactMaintenancePayload,
          success: described(
            Schema.Struct({
              processed: Schema.Number,
              committed: Schema.Number,
              failed: Schema.Number,
            }),
            "Legacy Session diff migration batch result",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diffArtifactMaintenance",
            summary: "Migrate one bounded legacy Session diff batch",
            description:
              "Build authorized per-file artifact indexes, verify PromptEpoch history hashes, and CAS-rewrite user messages without publishing giant events.",
            exclude: true,
          }),
        ),
        HttpApiEndpoint.get("diffArtifactManifest", SessionPaths.diffArtifactManifest, {
          params: { sessionID: SessionID },
          query: DiffArtifactManifestQuery,
          success: described(DiffArtifactManifest, "Bounded Session diff artifact manifest page"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diffArtifactManifest",
            summary: "Get a Session diff artifact manifest page",
            description: "Read only metadata for an artifact committed to the addressed Session message.",
          }),
        ),
        HttpApiEndpoint.get("diffArtifactFile", SessionPaths.diffArtifactFile, {
          params: { sessionID: SessionID },
          query: DiffArtifactFileQuery,
          success: described(DiffArtifactFile, "Bounded Session diff artifact file patch"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diffArtifactFile",
            summary: "Get one bounded Session diff artifact file patch",
            description:
              "Verify content-addressed chunks and return at most the requested UTF-8 byte budget for one authorized path.",
          }),
        ),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: { sessionID: SessionID },
          query: MessagesQuery,
          success: described(Schema.Array(SessionV1.WithParts), "List of messages"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.messages",
            summary: "Get session messages",
            description: "Retrieve all messages in a session, including user prompts and AI responses.",
          }),
        ),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(SessionV1.WithParts, "Message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Session.CreateInput],
          success: described(Session.Info, "Successfully created session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Create session",
            description:
              "Create a new DeepAgent Code session for interacting with AI assistants and managing conversations.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.delete",
            summary: "Delete session",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
          }),
        ),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Session.Info, "Successfully updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Update session",
            description: "Update properties of an existing session, such as title or other metadata.",
          }),
        ),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ForkPayload,
          success: described(Session.Info, "200"),
          error: [HttpApiError.BadRequest, ConflictError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description:
              "Create a new session by forking an existing session at a specific message point. intentID is required so response-loss retries adopt the same child. Older bodyless HTTP clients remain supported by a compatibility parser.",
          }),
        ),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Aborted session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.abort",
            summary: "Abort session",
            description: "Abort an active session and stop any ongoing AI processing or command execution.",
          }),
        ),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: InitPayload,
          success: described(Schema.Boolean, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.init",
            summary: "Initialize session",
            description:
              "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
          }),
        ),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully shared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share",
            summary: "Share session",
            description: "Create a shareable link for a session, allowing others to view the conversation.",
          }),
        ),
        HttpApiEndpoint.delete("unshare", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully unshared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare",
            summary: "Unshare session",
            description: "Remove the shareable link for a session, making it private again.",
          }),
        ),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SummarizePayload,
          success: described(Schema.Boolean, "Summarized session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.summarize",
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
          }),
        ),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ConflictError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Create and send a new message to a session, streaming the AI response.",
          }),
        ),
        HttpApiEndpoint.post("promptPrepare", SessionPaths.promptPrepare, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPreparePayload,
          success: described(PromptPrepareResult, "Prepared prompt draft"),
          error: [HttpApiError.BadRequest, ConflictError, InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_prepare",
            summary: "Prepare prompt draft",
            description: "Create a DeepAgent intelligence prompt draft for user confirmation before task submission.",
          }),
        ),
        HttpApiEndpoint.post("promptPrepareStream", SessionPaths.promptPrepareStream, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPreparePayload,
          success: Schema.String,
          error: [HttpApiError.BadRequest, ConflictError, InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_prepare_stream",
            summary: "Stream prompt draft preparation",
            description:
              "Create a DeepAgent intelligence prompt draft and stream progressive preview updates as server-sent events.",
          }),
        ),
        HttpApiEndpoint.get("promptSuggestion", SessionPaths.promptSuggestion, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(PromptSuggestionResult, "Latest next-round suggestion"),
          error: [ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_suggestion",
            summary: "Get latest next-round suggestion",
            description:
              "Read the latest DeepAgent macro-round suggestion ({status, body}) persisted for human approval (high/max).",
          }),
        ),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(PromptAsyncAccepted, "Prompt durably admitted"),
          error: [HttpApiError.BadRequest, ConflictError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_async",
            summary: "Send async message",
            description:
              "Durably admit a new message or steer, start session execution if needed, and return without waiting for model completion.",
          }),
        ),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Send command",
            description: "Send a new command to a session for execution by the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ShellPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description: "Execute a shell command within the session context and return the AI's response.",
          }),
        ),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: RevertPayload,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert",
            summary: "Revert message",
            description:
              "Revert a specific message in a session, undoing its effects and restoring the previous state.",
          }),
        ),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert",
            summary: "Restore reverted messages",
            description: "Restore all previously reverted messages in a session.",
          }),
        ),
        HttpApiEndpoint.post("permissionRespond", SessionPaths.permissions, {
          params: { sessionID: SessionID, permissionID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: PermissionResponsePayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.respond",
            summary: "Respond to permission",
            description: "Approve or deny a permission request from the AI assistant.",
            deprecated: true,
          }),
        ),
        HttpApiEndpoint.delete("deleteMessage", SessionPaths.deleteMessage, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.deleteMessage",
            summary: "Delete message",
            description:
              "Permanently delete a specific message and all of its parts from a session without reverting file changes.",
          }),
        ),
        HttpApiEndpoint.delete("deletePart", SessionPaths.deletePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.delete",
            description: "Delete a part from a message.",
          }),
        ),
        HttpApiEndpoint.patch("updatePart", SessionPaths.updatePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          payload: SessionV1.Part,
          success: described(SessionV1.Part, "Successfully updated part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.update",
            description: "Update a part in a message.",
          }),
        ),
        HttpApiEndpoint.get("contextDiagnostics", SessionPaths.contextDiagnostics, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ContextDiagnosticsResult, "Session context diagnostics"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.contextDiagnostics",
            summary: "Get session context diagnostics",
            description: "Inspect four-graph status, opaque evidence, audit availability, and provider attempts.",
          }),
        ),
        HttpApiEndpoint.post("contextAttemptResolve", SessionPaths.contextAttemptResolve, {
          params: { sessionID: SessionID, attemptID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ContextAttemptResolvePayload,
          success: described(ContextAttemptResult, "Resolved provider attempt"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.contextAttemptResolve",
            summary: "Resolve an indeterminate provider attempt",
            description: "Apply an audited abandon, verified-settle, or risk-acknowledged replay decision.",
          }),
        ),
        HttpApiEndpoint.get("contextCohort", SessionPaths.contextCohort, {
          query: ContextCohortQuery,
          success: described(ContextCohortResult, "Cohort-level federated context aggregation"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.contextCohort",
            summary: "Aggregate federated context selections across sessions",
            description:
              "FEAT-005: durable cohort aggregation over [sinceMs, untilMs], bucketed by readiness " +
              "(ready/building/degraded/blocked) so rollout decisions are not skewed by cold-start noise.",
          }),
        ),
        HttpApiEndpoint.get("providerResolutionList", SessionPaths.providerResolution, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Array(SessionLegacyProviderResolution.Descriptor),
            "Pending provider recovery decisions",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.providerResolutionList",
            summary: "List provider recovery decisions",
            description: "List unresolved legacy provider outcomes that require explicit recovery.",
          }),
        ),
        HttpApiEndpoint.post("providerResolutionResolve", SessionPaths.providerResolution, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ProviderResolutionPayload,
          success: described(SessionLegacyProviderResolution.Resolution, "Resolved provider outcome"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.providerResolutionResolve",
            summary: "Resolve a provider outcome",
            description: "Append an audited abandoned resolution and activate a safe successor history epoch.",
          }),
        ),
        HttpApiEndpoint.get("exportSnapshot", SessionPaths.exportSnapshot, {
          params: { sessionID: SessionID },
          success: described(Schema.String, "Session snapshot bundle as a JSON string"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.exportSnapshot",
            summary: "Export a session snapshot",
            description:
              "Export the session's conversation (session + messages + parts) as a self-describing " +
              "snapshot bundle (JSON). The bundle re-imports on another device as a fresh, continuable session.",
          }),
        ),
        HttpApiEndpoint.post("importSnapshot", SessionPaths.importSnapshot, {
          payload: ImportSnapshotPayload,
          success: described(ImportSnapshotResult, "Imported session summary"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.importSnapshot",
            summary: "Import a session snapshot",
            description:
              "Import a previously exported session bundle into the current instance as a fresh, " +
              "continuable session (new IDs, re-rooted to the current project/directory).",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session",
          description: "Experimental HttpApi session routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "deepagent-code experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
