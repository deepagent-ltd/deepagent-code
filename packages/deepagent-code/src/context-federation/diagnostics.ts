export * as ContextFederationDiagnostics from "./diagnostics"

import {
  ContextArtifactTable,
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { GraphKind } from "@deepagent-code/core/context-federation/contract"
import { GraphQueryStatus } from "@deepagent-code/core/context-federation/federation"
import { Sensitivity } from "@deepagent-code/core/context-federation/authorization"
import { SessionProviderAttempt } from "@deepagent-code/core/context-federation/provider-attempt"
import { Database } from "@deepagent-code/core/database/database"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionToolRequestResolutionTable } from "@deepagent-code/core/session/sql"
import { SessionToolRequestReceiptTable } from "../session/tool-request-receipt.sql"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Session } from "../session/session"
import { SessionFederatedContext } from "./session-context-runtime"
import { ContextFederationObservability } from "./observability"

const StoredSelectedRef = Schema.Struct({
  ref: Schema.Struct({ graph: GraphKind, revision: Schema.String }),
  token: Schema.String,
  provenanceTokens: Schema.Array(Schema.String),
  relations: Schema.Array(
    Schema.Struct({
      relation: Schema.String,
      token: Schema.String,
      freshness: Schema.Literals(["exact", "rebound", "broken"]),
    }),
  ),
  freshness: Schema.Literals(["current", "historical", "expired", "superseded", "conflict", "unknown"]),
  sensitivity: Sensitivity,
  score: Schema.Finite,
  reason: Schema.String,
})

export type ResolutionDecision = "abandoned" | "settled" | "replayed"

export class DiagnosticsError extends Schema.TaggedErrorClass<DiagnosticsError>()(
  "ContextFederationDiagnostics.DiagnosticsError",
  { reason: Schema.String },
) {}

export interface Interface {
  readonly get: (
    sessionId: SessionSchema.ID,
    now?: number,
  ) => Effect.Effect<ReturnType<typeof dashboard>, DiagnosticsError>
  readonly resolveAttempt: (input: {
    readonly session: Session.Info
    readonly attemptId: string
    readonly decision: ResolutionDecision
    readonly reason: string
    readonly riskAcknowledged: boolean
    readonly actorId: string
    readonly now?: number
  }) => Effect.Effect<ReturnType<typeof attemptView>, DiagnosticsError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextFederationDiagnostics") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const attempts = yield* SessionProviderAttempt.Service
    const federation = yield* SessionFederatedContext.Service

    const get: Interface["get"] = (sessionId, now = Date.now()) =>
      Effect.gen(function* () {
        const selectionRows = yield* database.db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.session_id, sessionId))
          .orderBy(desc(SessionContextSelectionTable.created_at), desc(SessionContextSelectionTable.revision))
          .limit(50)
          .all()
          .pipe(Effect.orDie)
        const activityRows =
          selectionRows.length === 0
            ? []
            : yield* database.db
                .select()
                .from(SessionActivityTable)
                .where(
                  inArray(SessionActivityTable.activity_id, [...new Set(selectionRows.map((row) => row.activity_id))]),
                )
                .all()
                .pipe(Effect.orDie)
        const artifactRows =
          selectionRows.length === 0
            ? []
            : yield* database.db
                .select()
                .from(ContextArtifactTable)
                .where(
                  inArray(
                    ContextArtifactTable.selection_id,
                    selectionRows.map((row) => row.selection_id),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
        const attemptRows = yield* database.db
          .select()
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.session_id, sessionId))
          .orderBy(desc(SessionProviderAttemptTable.provider_turn_seq))
          .limit(50)
          .all()
          .pipe(Effect.orDie)
        const resolutionRows =
          attemptRows.length === 0
            ? []
            : yield* database.db
                .select()
                .from(SessionProviderAttemptResolutionTable)
                .where(
                  inArray(
                    SessionProviderAttemptResolutionTable.attempt_id,
                    attemptRows.map((row) => row.attempt_id),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
        const messages = attemptRows.some((row) => row.state === "indeterminate_after_crash")
          ? yield* sessions.messages({ sessionID: SessionSchema.ID.make(sessionId) }).pipe(Effect.orDie)
          : []
        return dashboard({
          sessionId,
          selections: selectionRows.map((row) =>
            selectionView({
              row,
              activity: activityRows.find((activity) => activity.activity_id === row.activity_id),
              artifact: artifactRows.find((artifact) => artifact.selection_id === row.selection_id),
              now,
            }),
          ),
          attempts: attemptRows.map((row) =>
            attemptView(
              row,
              resolutionRows.find((resolution) => resolution.attempt_id === row.attempt_id),
              hasTerminalMessage(messages, row.attempt_id),
              now,
            ),
          ),
        })
      }).pipe(Effect.mapError(diagnosticsError))

    const resolveAttempt: Interface["resolveAttempt"] = (input) =>
      Effect.gen(function* () {
        const attempt = yield* attempts.get(input.attemptId)
        if (!attempt || attempt.sessionId !== input.session.id) {
          return yield* new DiagnosticsError({ reason: "provider_attempt_not_found" })
        }
        const legacyReceipt = yield* database.db
          .select({ receiptID: SessionToolRequestReceiptTable.receipt_id })
          .from(SessionToolRequestReceiptTable)
          .leftJoin(
            SessionToolRequestResolutionTable,
            eq(SessionToolRequestResolutionTable.receipt_id, SessionToolRequestReceiptTable.receipt_id),
          )
          .where(
            and(
              eq(SessionToolRequestReceiptTable.session_id, input.session.id),
              eq(SessionToolRequestReceiptTable.provider_attempt_id, input.attemptId),
              eq(SessionToolRequestReceiptTable.provider_state, "indeterminate_after_crash"),
              isNull(SessionToolRequestResolutionTable.resolution_id),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (legacyReceipt)
          return yield* new DiagnosticsError({
            reason: "legacy_provider_recovery_required",
          })
        if (input.decision === "replayed") {
          const resolved = yield* federation.replayIndeterminate({
            session: input.session,
            attemptId: input.attemptId,
            actorId: input.actorId,
            reason: input.reason,
            riskAcknowledged: input.riskAcknowledged,
            now: input.now,
          })
          return attemptView(resolved.replay, undefined, false, input.now ?? Date.now())
        }
        const terminal =
          input.decision === "settled"
            ? (yield* sessions.messages({ sessionID: input.session.id }).pipe(Effect.orDie)).find((message) =>
                hasTerminalMessage([message], input.attemptId),
              )
            : undefined
        if (input.decision === "settled" && !terminal) {
          return yield* new DiagnosticsError({ reason: "persisted_terminal_event_required" })
        }
        const resolved = yield* attempts.resolve({
          attemptId: input.attemptId,
          actor: {
            type: "user",
            id: input.actorId,
            canResolve: true,
            canAcknowledgeReplayRisk: false,
          },
          decision: input.decision,
          ...(terminal
            ? {
                providerEvidence: {
                  kind: "persisted_terminal_event" as const,
                  requestHash: attempt.requestHash,
                  eventId: terminal.info.id,
                  observedAt: terminal.info.role === "assistant" ? terminal.info.time.completed! : Date.now(),
                },
              }
            : {}),
          riskAcknowledged: false,
          reason: input.reason,
          now: input.now,
        })
        return attemptView(resolved.attempt, undefined, false, input.now ?? Date.now())
      }).pipe(Effect.mapError(diagnosticsError))

    return Service.of({ get, resolveAttempt })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionProviderAttempt.layer.pipe(Layer.provide(Database.defaultLayer))),
  Layer.provide(SessionFederatedContext.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

function dashboard(input: {
  readonly sessionId: SessionSchema.ID
  readonly selections: readonly ReturnType<typeof selectionView>[]
  readonly attempts: readonly ReturnType<typeof attemptView>[]
}) {
  const metrics = ContextFederationObservability.snapshot()
  const latestStatuses = input.selections[0]?.statuses ?? []
  const graphs = GraphKind.literals.map((graph) => {
    const metric = metrics.graphs[graph]
    return {
      graph,
      queries: metric.queries,
      candidates: metric.candidates,
      selected: metric.selected,
      rejected: metric.rejected,
      redacted: metric.redacted,
      averageLatencyMs: metric.averageLatencyMs,
      maxLatencyMs: metric.maxLatencyMs,
      lastLatencyMs: metric.lastLatencyMs,
      lastObservedAt: metric.lastObservedAt,
      status: metric.lastStatus ?? latestStatuses.find((status) => status.graph === graph),
    }
  })
  return {
    sessionId: input.sessionId,
    selections: input.selections,
    attempts: input.attempts,
    metrics: {
      selections: metrics.selections,
      tokens: metrics.tokens,
      shadow: metrics.shadow,
      graphs,
      alerts: graphs.flatMap((metric) =>
        metric.status && !(metric.status.kind === "complete" && metric.status.state === "ready")
          ? [{ graph: metric.graph, state: metric.status.state, reasonCode: metric.status.reasonCode }]
          : [],
      ),
    },
  }
}

function selectionView(input: {
  readonly row: typeof SessionContextSelectionTable.$inferSelect
  readonly activity?: typeof SessionActivityTable.$inferSelect
  readonly artifact?: typeof ContextArtifactTable.$inferSelect
  readonly now: number
}) {
  const statuses = parse(Schema.Array(GraphQueryStatus), input.row.graph_statuses, "graph_statuses")
  const selected = parse(Schema.Array(StoredSelectedRef), input.row.selected_refs, "selected_refs")
  return {
    selectionId: input.row.selection_id,
    activityId: input.row.activity_id,
    activityState: input.activity?.state ?? "failed",
    revision: input.row.revision,
    summary: statuses.some((status) => status.kind !== "complete")
      ? ("partial" as const)
      : statuses.some((status) => status.outcome === "matched")
        ? ("complete" as const)
        : ("empty" as const),
    statuses,
    evidence: selected.map((item) => ({
      token: item.token,
      graph: item.ref.graph,
      revision: item.ref.revision,
      sensitivity: item.sensitivity,
      freshness: item.freshness,
      score: item.score,
      reason: item.reason,
      provenance: item.provenanceTokens,
      relations: item.relations,
    })),
    tokenCount: input.row.token_count,
    stale: input.row.next_revalidation_at <= input.now,
    nextRevalidationAt: input.row.next_revalidation_at,
    artifact: artifactView(input.row, input.artifact, input.now),
    createdAt: input.row.created_at,
  }
}

function artifactView(
  selection: typeof SessionContextSelectionTable.$inferSelect,
  artifact: typeof ContextArtifactTable.$inferSelect | undefined,
  now: number,
) {
  if (selection.artifact_write_status === "degraded_unavailable") {
    const audit = selection.inline_audit ? parseInlineAudit(selection.inline_audit) : undefined
    return { status: "degraded_unavailable" as const, reasonCode: audit?.reasonCode ?? "audit_storage_unavailable" }
  }
  if (!artifact) return { status: "unavailable" as const, reasonCode: "artifact_missing" }
  if (artifact.deleted_at !== null || artifact.expires_at <= now) {
    return { status: "expired" as const, reasonCode: artifact.delete_reason ?? "retention_expired" }
  }
  return { status: "available" as const, ref: selection.artifact_ref! }
}

function attemptView(
  attempt: SessionProviderAttempt.Attempt | typeof SessionProviderAttemptTable.$inferSelect,
  resolution?: typeof SessionProviderAttemptResolutionTable.$inferSelect,
  terminalEvidence = false,
  now = Date.now(),
) {
  const value =
    "attemptId" in attempt
      ? attempt
      : {
          attemptId: attempt.attempt_id,
          activityId: attempt.activity_id,
          providerTurnSeq: attempt.provider_turn_seq,
          selectionId: attempt.selection_id,
          providerId: attempt.provider_id,
          parentAttemptId: attempt.parent_attempt_id ?? undefined,
          state: attempt.state,
          createdAt: attempt.created_at,
          firstEventAt: attempt.first_event_at ?? undefined,
          settledAt: attempt.settled_at ?? undefined,
          errorCode: attempt.error_code ?? undefined,
        }
  return {
    attemptId: value.attemptId,
    activityId: value.activityId,
    providerTurnSeq: value.providerTurnSeq,
    selectionId: value.selectionId,
    providerId: value.providerId,
    parentAttemptId: value.parentAttemptId,
    state: value.state,
    createdAt: value.createdAt,
    firstEventAt: value.firstEventAt,
    settledAt: value.settledAt,
    errorCode: value.errorCode,
    ageMs: Math.max(0, now - value.createdAt),
    canAbandon: value.state === "indeterminate_after_crash",
    canSettle: value.state === "indeterminate_after_crash" && terminalEvidence,
    canReplay: value.state === "indeterminate_after_crash",
    resolution: resolution
      ? {
          decision: resolution.decision,
          actorType: resolution.actor_type,
          actorId: resolution.actor_id,
          riskAcknowledged: resolution.risk_acknowledged,
          reason: resolution.reason,
          createdAt: resolution.created_at,
        }
      : undefined,
  }
}

function hasTerminalMessage(messages: readonly SessionV1.WithParts[], attemptId: string) {
  return messages.some((message) => {
    const info = message.info
    return Boolean(
      info &&
        typeof info === "object" &&
        "role" in info &&
        info.role === "assistant" &&
        "providerAttemptID" in info &&
        info.providerAttemptID === attemptId &&
        "time" in info &&
        info.time &&
        typeof info.time === "object" &&
        "completed" in info.time &&
        typeof info.time.completed === "number" &&
        !("error" in info && info.error),
    )
  })
}

function parse<A>(schema: Schema.Decoder<A>, value: string, field: string) {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(JSON.parse(value))
  } catch {
    throw new DiagnosticsError({ reason: `stored_${field}_invalid` })
  }
}

function parseInlineAudit(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || !("reasonCode" in parsed) || typeof parsed.reasonCode !== "string") {
      return undefined
    }
    return { reasonCode: parsed.reasonCode }
  } catch {
    return undefined
  }
}

function diagnosticsError(error: unknown) {
  if (error instanceof DiagnosticsError) return error
  const reason = error && typeof error === "object" && "_tag" in error ? String(error._tag) : "diagnostics_failed"
  return new DiagnosticsError({ reason })
}
