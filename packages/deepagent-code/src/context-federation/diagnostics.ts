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
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Database } from "@deepagent-code/core/database/database"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionToolRequestResolutionTable } from "@deepagent-code/core/session/sql"
import { SessionToolRequestReceiptTable } from "../session/tool-request-receipt.sql"
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Ref, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { Session } from "../session/session"
import { SessionFederatedContext } from "./session-context-runtime"
import { ContextFederationObservability } from "./observability"
import { ContextFederationProviderOwnerRuntime } from "./provider-owner-runtime"

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

// FEAT-005: cohort-level readiness buckets. A selection's per-graph status states fold into one of
// four buckets so a rollout dashboard can tell cold-start (building) apart from genuine degradation
// or an authorization block — the in-memory observability snapshot can't (process-scoped, no window).
export type ReadinessBucket = "ready" | "building" | "degraded" | "blocked"

export type CohortSummary = {
  readonly window: { readonly sinceMs: number; readonly untilMs: number }
  readonly selections: number
  readonly sessions: number
  readonly tokens: number
  readonly readiness: Readonly<Record<ReadinessBucket, number>>
  readonly graphs: Readonly<
    Record<GraphKind, { readonly statuses: number; readonly ready: number; readonly notReady: number }>
  >
}

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
  /**
   * FEAT-005: cohort-level durable aggregation. Aggregates federated context selections across all
   * sessions within [sinceMs, untilMs] from the durable selection table (NOT the in-memory
   * observability snapshot), bucketed by readiness so rollout decisions aren't skewed by cold-start
   * indexing noise.
   */
  readonly cohort: (input: { readonly sinceMs: number; readonly untilMs?: number }) => Effect.Effect<CohortSummary, DiagnosticsError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextFederationDiagnostics") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const attempts = yield* SessionProviderAttempt.Service
    const federation = yield* SessionFederatedContext.Service
    const owners = yield* SessionProviderOwner.Service
    // BUG-407-012 root cause A: same rotation contract as the prompt owner — a fenced lease
    // rotates to a successor generation; consumers read the current token at use time.
    const recoveryOwnerBase = `${process.pid}:diagnostics:${randomUUID()}`
    const recoveryOwnerInitialToken = ContextFederationProviderOwnerRuntime.nextOwnerToken({
      ownerBase: recoveryOwnerBase,
      generation: 0,
    })
    yield* owners
      .register({ ownerToken: recoveryOwnerInitialToken, leaseMs: SessionProviderOwner.LeaseMs })
      .pipe(Effect.orDie)
    const recoveryOwnerState = yield* Ref.make<ContextFederationProviderOwnerRuntime.OwnerGeneration>({
      ownerToken: recoveryOwnerInitialToken,
      generation: 0,
    })
    const ownerHealthy = yield* Ref.make(true)
    yield* Effect.addFinalizer(() =>
      Ref.get(recoveryOwnerState).pipe(
        Effect.flatMap((state) => owners.release({ ownerToken: state.ownerToken })),
        Effect.ignore,
      ),
    )
    yield* Effect.gen(function* () {
      while (yield* Ref.get(ownerHealthy)) {
        const continued = yield* ContextFederationProviderOwnerRuntime.tick({
          owners,
          owner: recoveryOwnerState,
          ownerBase: recoveryOwnerBase,
          leaseMs: SessionProviderOwner.LeaseMs,
          healthy: ownerHealthy,
          label: "provider diagnostics",
        })
        if (!continued) return
        yield* Effect.sleep(10_000)
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError(`provider diagnostics heartbeat failed: ${Cause.pretty(cause)}`)),
      Effect.forkScoped,
    )

    const get: Interface["get"] = (sessionId, now = Date.now()) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(ownerHealthy)))
          return yield* new DiagnosticsError({ reason: "provider_owner_runtime_unhealthy" })
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
        if (!(yield* Ref.get(ownerHealthy)))
          return yield* new DiagnosticsError({ reason: "provider_owner_runtime_unhealthy" })
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
          const recoveryOwnerCurrent = yield* Ref.get(recoveryOwnerState)
          const resolved = yield* federation.replayIndeterminate({
            session: input.session,
            attemptId: input.attemptId,
            actorId: input.actorId,
            reason: input.reason,
            riskAcknowledged: input.riskAcknowledged,
            recoveryOwnerToken: recoveryOwnerCurrent.ownerToken,
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
        const recoveryOwnerCurrent = yield* Ref.get(recoveryOwnerState)
        const resolved = yield* attempts.resolve({
          attemptId: input.attemptId,
          recoveryOwnerToken: recoveryOwnerCurrent.ownerToken,
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
                  requestHash: attempt.wireRequestHash ?? attempt.requestHash,
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

    const cohort: Interface["cohort"] = (input) =>
      Effect.gen(function* () {
        const untilMs = input.untilMs ?? Date.now()
        const rows = yield* database.db
          .select({
            sessionId: SessionContextSelectionTable.session_id,
            graphStatuses: SessionContextSelectionTable.graph_statuses,
            tokenCount: SessionContextSelectionTable.token_count,
          })
          .from(SessionContextSelectionTable)
          .where(and(gte(SessionContextSelectionTable.created_at, input.sinceMs), lte(SessionContextSelectionTable.created_at, untilMs)))
          .all()
          .pipe(Effect.orDie)
        const readiness: Record<ReadinessBucket, number> = { ready: 0, building: 0, degraded: 0, blocked: 0 }
        const graphs = Object.fromEntries(
          GraphKind.literals.map((graph) => [graph, { statuses: 0, ready: 0, notReady: 0 }]),
        ) as Record<GraphKind, { statuses: number; ready: number; notReady: number }>
        const sessions = new Set<string>()
        let tokens = 0
        for (const row of rows) {
          sessions.add(row.sessionId)
          tokens += row.tokenCount
          const statuses = parse(Schema.Array(GraphQueryStatus), row.graphStatuses, "graph_statuses")
          // Selection-level bucket = the WORST graph state (blocked > degraded > building > ready),
          // so a single cold/blocked graph keeps the whole selection out of the "ready" cohort.
          let worst: ReadinessBucket = "ready"
          for (const status of statuses) {
            const bucket = readinessBucket(status)
            graphs[status.graph].statuses += 1
            if (bucket === "ready") graphs[status.graph].ready += 1
            else graphs[status.graph].notReady += 1
            if (bucketRank(bucket) > bucketRank(worst)) worst = bucket
          }
          readiness[worst] += 1
        }
        return {
          window: { sinceMs: input.sinceMs, untilMs },
          selections: rows.length,
          sessions: sessions.size,
          tokens,
          readiness,
          graphs,
        } satisfies CohortSummary
      }).pipe(Effect.mapError(diagnosticsError))

    return Service.of({ get, resolveAttempt, cohort })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(Database.defaultLayer))),
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

// FEAT-005: fold a per-graph query status into a rollout-readiness bucket. complete→ready; a
// partial with a degraded source is genuine degradation, cold/indexing/stale are cold-start
// "building" (expected to self-resolve); a blocked graph is an authorization/source block (denied)
// or an unavailable source (degraded); not_queried (source disabled) counts as not-ready building.
function readinessBucket(status: GraphQueryStatus): ReadinessBucket {
  if (status.kind === "complete") return "ready"
  if (status.kind === "blocked") return status.state === "denied" ? "blocked" : "degraded"
  if (status.kind === "not_queried") return "building"
  return status.state === "degraded" ? "degraded" : "building" // partial: cold | indexing | stale
}

function bucketRank(bucket: ReadinessBucket): number {
  switch (bucket) {
    case "ready":
      return 0
    case "building":
      return 1
    case "degraded":
      return 2
    case "blocked":
      return 3
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
