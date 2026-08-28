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
import { ContextStagedAdaptersV2 } from "@deepagent-code/core/context-federation/staged-adapters-v2"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
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

/** Build a v2-scoped resolver QueryEnvelope for a session readiness probe. */
function buildReadinessEnvelope(session: Session.Info): QueryEnvelope {
  const locationKey = ContextReference.LocationKey.make(session.directory)
  const graphs = [...SessionContextResolverV2.GraphOrder]
  return {
    membership: { sessionId: session.id, activityId: "", inputIds: [] },
    location: {
      locationKey,
      ...(session.workspaceID ? { workspaceId: session.workspaceID } : {}),
    },
    principal: {
      securityNamespaceId: V2Namespace,
      principalId: session.id,
      authorizationEpoch: 0,
      locationKeys: [locationKey],
      projectScopeKeys: [V2Scope],
      sessionIds: [session.id],
      subjectIds: [],
      allowBuiltin: false,
    },
    workspace: { workspaceId: session.workspaceID ?? "" },
    securityNamespace: { securityNamespaceId: V2Namespace },
    projectScope: { projectScopeKey: V2Scope },
    egress: { policyId: "v2:history-context", epoch: 0, graphs, sensitivities: [] },
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

export const contextHandlers = HttpApiBuilder.group(InstanceHttpApi, "context", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const database = yield* Database.Service

    const readiness = Effect.fn("ContextHttpApi.readiness")(function* (ctx: {
      query: { session_id: string }
    }) {
      const sessionId = SessionID.make(ctx.query.session_id)
      const info = yield* session.get(sessionId).pipe(
        Effect.mapError(() => makeApiError("resource_not_found", { resource: ctx.query.session_id })),
      )
      const envelope = buildReadinessEnvelope(info)
      const resolved = yield* SessionContextResolverV2.resolveGraphs(
        envelope,
        ContextStagedAdaptersV2.stagedV2Adapters(),
        5_000,
      )
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
