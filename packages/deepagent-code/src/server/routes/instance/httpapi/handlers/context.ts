import { Effect } from "effect"
import { and, asc, eq, gt } from "drizzle-orm"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import { EventSequenceTable, EventTable } from "@deepagent-code/core/event/sql"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import {
  SessionContextResolverV2,
  type QueryEnvelope,
} from "@deepagent-code/core/context-federation/resolver-v2"
import {
  ProductionV2Sources,
  productionAdaptersEnabled,
  productionV2Adapters,
  type ProductionV2AdapterInput,
  type ProductionV2LocationIdentity,
} from "@deepagent-code/core/context-federation/production-adapters"
import { ContextStagedAdaptersV2 } from "@deepagent-code/core/context-federation/staged-adapters-v2"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { currentIdentity } from "@/context-federation/production-sources"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "../api"
import { ContextApi } from "../groups/context"
import { makeApiError } from "../typed-error"

// C6-03 (design §11.1 + §11.2): context readiness + snapshot-at-watermark cursor.
// The durable event store (`event_sequence` + `event`) is the SINGLE authority
// for the cursor contract: a cursor below the retained floor is a typed 410
// (`cursor_gap_exceeded`), never a silent volatile/live fallback.

export const ContextEventPageLimit = 500

/** Maximum number of events in one drain page (over-limit is a typed 400). */
export const maxEventLimit = () => ContextEventPageLimit

/** Bounded page-size validation: returns undefined when the limit is acceptable. */
export function validateEventLimit(limit: number | undefined): string | undefined {
  if (limit === undefined) return undefined
  if (limit <= 0) return "limit must be a positive integer"
  if (limit > ContextEventPageLimit) return `limit exceeds the max page (${ContextEventPageLimit})`
  return undefined
}

/** Whether `after` has fallen behind the durable retention floor (bounded resync). */
export function isCursorBehindFloor(after: number, floor: number | null | undefined): boolean {
  return floor !== null && floor !== undefined && after < floor
}

/** Deduplicate a page of cursor events (absorb duplicates) preserving order. */
export function dedupeEvents<T extends { seq: number }>(events: readonly T[]): T[] {
  const seen = new Set<number>()
  const out: T[] = []
  for (const event of events) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    out.push(event)
  }
  return out
}

const V2Namespace = ContextReference.SecurityNamespaceID.make("v2:local")
const V2Scope = ContextReference.ProjectScopeKey.make("v2:local")

/**
 * Build a v2-scoped resolver QueryEnvelope for a session readiness probe. W3.8.1: when the
 * production sources seam carries the real location identity, the probe answers with THAT frame
 * (identity namespace/location/scope + the released-knowledge legacy project id — the same frame
 * the V2 runner's `buildV2Envelope` uses, so the probe cannot diverge from real turns); absent an
 * identity the envelope keeps the v2:local degradation pin exactly as before.
 */
export function buildReadinessEnvelope(
  session: Session.Info,
  identity?: ProductionV2LocationIdentity,
): QueryEnvelope {
  const frameLocationKey = identity?.locationKey ?? ContextReference.LocationKey.make(session.directory)
  const frameNamespace = identity?.securityNamespaceId ?? V2Namespace
  const frameScope = identity?.projectScopeKey ?? V2Scope
  // The contract `projectId` is the released-knowledge legacy project id: the real frame carries
  // the host derivation (the adapter `legacyProjectId`), the v2:local fallback carries "v2:local".
  const frameLegacyProjectId = identity?.legacyProjectId ?? V2Scope
  const graphs = [...SessionContextResolverV2.GraphOrder]
  return {
    membership: { sessionId: session.id, activityId: "", inputIds: [] },
    location: {
      locationKey: frameLocationKey,
      ...(session.workspaceID ? { workspaceId: session.workspaceID } : {}),
    },
    principal: {
      securityNamespaceId: frameNamespace,
      principalId: session.id,
      authorizationEpoch: 0,
      locationKeys: [frameLocationKey],
      projectScopeKeys: [frameScope],
      sessionIds: [session.id],
      subjectIds: [],
      allowBuiltin: false,
    },
    workspace: { workspaceId: session.workspaceID ?? "" },
    securityNamespace: { securityNamespaceId: frameNamespace },
    projectScope: { projectScopeKey: frameScope, projectId: frameLegacyProjectId },
    // W3.8.1 — the probe must let the LIVE sources actually answer: the LiveCodeQuery gate and the
    // document/durable-knowledge candidate authorization check the egress sensitivity list, and an
    // empty list would make every real-frame probe answer `source_error` (the exact defect being
    // closed). The grant mirrors the deepagent-code live-query facade default (`envelopeFor`): the
    // sensitivity set a real context query may read.
    egress: { policyId: "v2:history-context", epoch: 0, graphs, sensitivities: ["public", "source_code", "secret_adjacent"] },
    agentPolicy: { agentId: session.agent ?? "default", autonomyCeiling: "medium", permitDegraded: true },
    modelCapability: { modelId: "", providerId: "", protocol: "openai.responses", contextWindow: 0, structuredOutput: false },
    releasedKnowledge: { snapshotId: "", binding: "unavailable" },
    queryIntent: "search",
    query: "session context",
    observedLocationMutationEpoch: 0,
    now: Date.now(),
  }
}

const decodeEventRow = (row: { id: string; seq: number; type: string; data: Record<string, unknown> }) => ({
  id: row.id,
  seq: row.seq,
  type: row.type,
  data: row.data,
})

/**
 * W3.7 L5 — the adapter set the C6 readiness probe uses: IDENTICAL to the V2 runner's selection
 * (production sources under the W0.1 flag, staged `source_disabled` only under an explicit
 * `=false`). Before this, readiness probed staged adapters while the runner served the production
 * sources, so a ready turn could be reported degraded (and vice versa) once the real seams were
 * mounted.
 */
export function readinessAdapters(sources: ProductionV2AdapterInput) {
  return productionAdaptersEnabled()
    ? productionV2Adapters(sources)
    : ContextStagedAdaptersV2.stagedV2Adapters()
}

export const contextHandlers = HttpApiBuilder.group(InstanceHttpApi, "context", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const database = yield* Database.Service

    const getLocalSession = Effect.fn("ContextHttpApi.getLocalSession")(function* (sessionId: string) {
      const info = yield* session.get(SessionID.make(sessionId)).pipe(
        Effect.mapError(() => makeApiError("resource_not_found", { resource: sessionId })),
      )
      if (info.directory !== (yield* InstanceState.context).directory)
        return yield* Effect.fail(makeApiError("resource_not_found", { resource: sessionId }))
      return info
    })

    const readiness = Effect.fn("ContextHttpApi.readiness")(function* (ctx: {
      query: { session_id: string }
    }) {
      const info = yield* getLocalSession(ctx.query.session_id)
      // W3.8.1 + W3.9 + W3.10: the probe frame mirrors the runner. W3.9 made the seam identity
      // lazy — resolved HERE on demand (`runtime.current()` at probe time, per-request `InstanceRef`
      // from the instance-context middleware) because the production-sources layer built at app
      // start has neither `InstanceRef` nor an eager index attach (zero layer-build side effects).
      // W3.10 closes the runner side with a host hook at the per-location runner tree (the augmented
      // `LocationServiceMap` in `session/v2-runner-frame.ts`): the runner resolves the same
      // `currentIdentity` derivation at tree build with the instance context of the ref directory,
      // so probe and runner frames are the SAME derivation — a real frame when an instance index is
      // attached, the v2:local degradation otherwise (never a fake).
      const sources = yield* ProductionV2Sources
      const identity = yield* currentIdentity(yield* LocationIndexRuntime.Service)
      const envelope = buildReadinessEnvelope(info, identity)
      // W3.7 L5: readiness reflects what the V2 runner actually does — same flag-gated adapter
      // selection (production sources default, staged `source_disabled` only under `=false`).
      const adapters = readinessAdapters(sources)
      const resolved = yield* SessionContextResolverV2.resolveGraphs(envelope, adapters, 5_000)
      const graphs = resolved.results.map((entry) => entry.status)
      const ready = Object.values(resolved.graphStatuses).every((status) => status.status === "ready")
      const statuses = Object.fromEntries(
        SessionContextResolverV2.GraphOrder.map((graph) => [graph, resolved.graphStatuses[graph]]),
      ) as Record<string, (typeof graphs)[number]>
      return { session_id: ctx.query.session_id, ready, graphs, statuses }
    })

    const eventsCursor = Effect.fn("ContextHttpApi.eventsCursor")(function* (ctx: {
      query: { session_id: string }
    }) {
      const sessionId = ctx.query.session_id
      // G7i security F3 — the cursor read is instance-local: the requested session must exist
      // here (typed 404 otherwise), so a foreign/cross-instance id is never silently served.
      yield* getLocalSession(sessionId)
      const authority = yield* database.db
        .select({
          seq: EventSequenceTable.seq,
          floor: EventSequenceTable.retention_floor_seq,
        })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionId))
        .get()
        .pipe(Effect.orDie)
      const watermark = authority?.seq ?? 0
      const floor = authority?.floor ?? 0
      return { watermark, cursor: watermark, floor }
    })

    const events = Effect.fn("ContextHttpApi.events")(function* (ctx: {
      query: { session_id: string; after?: number; limit?: number }
    }) {
      const sessionId = ctx.query.session_id
      // G7i security F3 — same instance-local existence gate as eventsCursor.
      yield* getLocalSession(sessionId)
      const after = ctx.query.after ?? 0
      const limit = ctx.query.limit ?? ContextEventPageLimit

      const limitError = validateEventLimit(limit)
      if (limitError) {
        return yield* Effect.fail(
          makeApiError("validation_failed", {
            resource: sessionId,
            expected: `limit in [1, ${ContextEventPageLimit}]`,
            actual: String(limit),
            message: limitError,
          }),
        )
      }

      const authority = yield* database.db
        .select({ floor: EventSequenceTable.retention_floor_seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionId))
        .get()
        .pipe(Effect.orDie)
      const floor = authority?.floor ?? 0

      if (isCursorBehindFloor(after, floor)) {
        return yield* Effect.fail(
          makeApiError("cursor_gap_exceeded", {
            resource: sessionId,
            expected: `after >= ${floor}`,
            actual: String(after),
          }),
        )
      }

      // Durable store is the ONLY authority: read a bounded page after the cursor.
      const rows = yield* database.db
        .select({
          id: EventTable.id,
          seq: EventTable.seq,
          type: EventTable.type,
          data: EventTable.data,
        })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionId), gt(EventTable.seq, after)))
        .orderBy(asc(EventTable.seq))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)

      const page = rows.slice(0, limit).map(decodeEventRow)
      const eventsOut = dedupeEvents(page)
      const nextCursor = eventsOut.length > 0 ? eventsOut[eventsOut.length - 1].seq : undefined
      return { events: eventsOut, nextCursor, floor }
    })

    return handlers
      .handle("readiness", readiness)
      .handle("eventsCursor", eventsCursor)
      .handle("events", events)
  }),
)
