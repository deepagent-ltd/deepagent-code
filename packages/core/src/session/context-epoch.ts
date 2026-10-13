export * as SessionContextEpoch from "./context-epoch"

import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { AgentV2 } from "../agent"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { Location } from "../location"
import { SystemContext } from "../system-context/index"
import { ContextSnapshotDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessageID } from "./message-id"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionTable } from "./sql"

type DatabaseService = Database.Interface["db"]

class RevisionMismatch extends Error {}
class LocationMismatch extends Error {}
export class AgentMismatch extends SessionInput.SelectionMismatch {}
export class AgentSelectionUnstable extends Schema.TaggedErrorClass<AgentSelectionUnstable>()(
  "SessionContextEpoch.AgentSelectionUnstable",
  { sessionID: SessionSchema.ID, attempts: Schema.Int },
) {}

/** The runner supplies the same actual Location roster used to prepare the turn. */
export interface Selection {
  readonly select: AgentV2.Interface["select"]
  readonly snapshot?: SessionInput.SelectionSnapshot
}

const selectedAgentMatches = (raw: string | null, agent: AgentV2.ID, selection?: Selection) =>
  selection
    ? selection.select(raw ?? undefined).pipe(Effect.map((current) => current.id === agent))
    : Effect.succeed(raw === null || raw === agent)

export class AgentReplacementBlocked extends Schema.TaggedErrorClass<AgentReplacementBlocked>()(
  "SessionContextEpoch.AgentReplacementBlocked",
  { sessionID: SessionSchema.ID, previous: AgentV2.ID, current: AgentV2.ID },
) {}

const fenceRevision = <A, E>(attempt: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  attempt().pipe(
    Effect.catchDefect((defect) =>
      defect instanceof RevisionMismatch ? Effect.die(new AgentMismatch()) : Effect.die(defect),
    ),
  )

interface Prepared {
  readonly baseline: string
  readonly baselineSeq: number
  readonly revision: number
  readonly snapshot: SystemContext.Snapshot
  readonly replacementSeq: number | null
  readonly selection?: SessionInput.SelectionSnapshot
}

export function initialize(
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
  selection?: Selection,
): Effect.Effect<Prepared | undefined, SystemContext.InitializationBlocked> {
  return fenceRevision(() => initializeOnce(db, context, sessionID, location, agent, selection)).pipe(
    Effect.withSpan("SessionContextEpoch.initialize"),
  )
}

export function prepare(
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
  selection?: Selection,
): Effect.Effect<Prepared, SystemContext.InitializationBlocked | ContextSnapshotDecodeError | AgentReplacementBlocked> {
  return fenceRevision(() => prepareOnce(db, events, context, sessionID, location, agent, selection)).pipe(
    Effect.withSpan("SessionContextEpoch.prepare"),
  )
}

const prepareOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
  selection?: Selection,
) {
  const [value, stored] = yield* Effect.all([context, find(db, sessionID)], { concurrency: 2 })
  if (!stored) {
    const generation = yield* SystemContext.initialize(value)
    const baselineSeq = yield* insert(db, sessionID, location, agent, generation, selection)
    return {
      baseline: generation.baseline,
      baselineSeq,
      revision: 0,
      snapshot: generation.snapshot,
      replacementSeq: null,
      selection: selection?.snapshot,
    }
  }

  const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const replacingAgent = stored.agent !== agent
  const result =
    stored.replacement_seq === null && !replacingAgent
      ? yield* SystemContext.reconcile(value, snapshot)
      : yield* SystemContext.replace(value, snapshot)
  if (result._tag === "ReplacementBlocked" && replacingAgent) {
    yield* fence(db, sessionID, agent, stored.revision, selection)
    return yield* new AgentReplacementBlocked({ sessionID, previous: stored.agent, current: agent })
  }
  if (result._tag === "Unchanged" || result._tag === "ReplacementBlocked") {
    yield* fence(db, sessionID, agent, stored.revision, selection)
    return {
      baseline: stored.baseline,
      baselineSeq: stored.baseline_seq,
      revision: stored.revision,
      snapshot,
      replacementSeq: stored.replacement_seq,
      selection: selection?.snapshot,
    }
  }
  if (result._tag === "ReplacementReady") {
    const replacementSeq = stored.replacement_seq ?? (yield* SessionInput.latestSeq(db, sessionID))
    yield* replace(db, sessionID, agent, stored.revision, replacementSeq, result.generation, selection)
    return {
      baseline: result.generation.baseline,
      baselineSeq: replacementSeq,
      revision: stored.revision + 1,
      snapshot: result.generation.snapshot,
      replacementSeq: null,
      selection: selection?.snapshot,
    }
  }

  const updated = yield* events.publish(
    SessionEvent.ContextUpdated,
    { sessionID, messageID: SessionMessageID.ID.create(), timestamp: yield* DateTime.now, text: result.text },
    {
      commit: () =>
        requireAgentSelection(db, sessionID, agent, selection).pipe(
          Effect.andThen(advance(db, sessionID, stored.revision, result.snapshot)),
          Effect.orDie,
        ),
    },
  )
  const successor = selection?.snapshot
    ? yield* SessionInput.afterContextUpdate(db, selection.snapshot, updated)
    : undefined
  return {
    baseline: stored.baseline,
    baselineSeq: stored.baseline_seq,
    revision: stored.revision + 1,
    snapshot: result.snapshot,
    replacementSeq: null,
    selection: successor,
  }
})

const initializeOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
  selection?: Selection,
) {
  if (yield* exists(db, sessionID)) return
  const generation = yield* context.pipe(Effect.flatMap(SystemContext.initialize))
  const baselineSeq = yield* insert(db, sessionID, location, agent, generation, selection)
  return {
    baseline: generation.baseline,
    baselineSeq,
    revision: 0,
    snapshot: generation.snapshot,
    replacementSeq: null,
    selection: selection?.snapshot,
  }
})

const exists = Effect.fn("SessionContextEpoch.exists")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (
    (yield* db
      .select({ sessionID: SessionContextEpochTable.session_id })
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

const find = Effect.fn("SessionContextEpoch.find")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

const requireAgentSelection = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  selection?: Selection,
) {
  const selected = yield* db
    .select({ agent: SessionTable.agent })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!selected) return yield* Effect.die(new AgentMismatch())
  if (selection?.snapshot) {
    if (selection.snapshot.sessionID !== sessionID) return yield* Effect.die(new AgentMismatch())
    yield* SessionInput.requireSelection(db, selection.snapshot)
  }
  if (
    !(yield* selectedAgentMatches(
      selection?.snapshot ? (selection.snapshot.agent ?? null) : selected.agent,
      agent,
      selection,
    ))
  )
    return yield* Effect.die(new AgentMismatch())
})

// A prospective Context has already been fully observed and fenced. Promotion requests a
// replacement for every explicit selector; acknowledge ONLY those requests from this exact
// batch in its final event transaction. Historical/external replacement requests remain live.
export const promotePrepared = Effect.fn("SessionContextEpoch.promotePrepared")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  prepared: Prepared,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  select: AgentV2.Interface["select"],
) {
  if (!prepared.selection || prepared.selection.sessionID !== sessionID) return yield* Effect.die(new AgentMismatch())
  const result = { prepared }
  const promoted = yield* SessionInput.promoteSelection(db, events, prepared.selection, (promotion) =>
    Effect.gen(function* () {
      const stored = yield* find(db, sessionID)
      const revision = prepared.revision + promotion.selectionChanges
      if (
        !stored ||
        stored.revision !== revision ||
        stored.agent !== agent ||
        stored.baseline !== prepared.baseline ||
        stored.baseline_seq !== prepared.baselineSeq ||
        JSON.stringify(stored.snapshot) !== JSON.stringify(prepared.snapshot) ||
        stored.replacement_seq !== (promotion.replacementSeq ?? prepared.replacementSeq)
      )
        return yield* Effect.die(new AgentMismatch())
      yield* requireAgentSelection(db, sessionID, agent, { select })
      if (promotion.selectionChanges === 0 || prepared.replacementSeq !== null) {
        result.prepared = { ...prepared, revision }
        return
      }
      const updated = yield* db
        .update(SessionContextEpochTable)
        .set({ replacement_seq: null, revision: revision + 1 })
        .where(
          and(
            eq(SessionContextEpochTable.session_id, sessionID),
            eq(SessionContextEpochTable.revision, revision),
            eq(SessionContextEpochTable.replacement_seq, promotion.replacementSeq!),
          ),
        )
        .returning({ revision: SessionContextEpochTable.revision })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* Effect.die(new AgentMismatch())
      result.prepared = { ...prepared, revision: updated.revision, replacementSeq: null }
    }),
  )
  return { promoted, prepared: result.prepared }
})

export const requestReplacement = Effect.fn("SessionContextEpoch.requestReplacement")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  seq: number,
) {
  return yield* db
    .update(SessionContextEpochTable)
    .set({ replacement_seq: seq, revision: sql`${SessionContextEpochTable.revision} + 1` })
    .where(
      and(
        eq(SessionContextEpochTable.session_id, sessionID),
        lt(SessionContextEpochTable.baseline_seq, seq),
        or(isNull(SessionContextEpochTable.replacement_seq), lt(SessionContextEpochTable.replacement_seq, seq)),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export const reset = Effect.fn("SessionContextEpoch.reset")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .delete(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

const insert = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
  generation: SystemContext.Generation,
  selection?: Selection,
) {
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const placed = yield* db
            .select({ agent: SessionTable.agent })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, sessionID),
                eq(SessionTable.directory, location.directory),
                location.workspaceID === undefined
                  ? isNull(SessionTable.workspace_id)
                  : eq(SessionTable.workspace_id, location.workspaceID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!placed) return yield* Effect.die(new LocationMismatch())
          if (selection?.snapshot) {
            if (selection.snapshot.sessionID !== sessionID) return yield* Effect.die(new AgentMismatch())
            yield* SessionInput.requireSelection(db, selection.snapshot)
            if (!(yield* selectedAgentMatches(selection.snapshot.agent ?? null, agent, selection)))
              return yield* Effect.die(new AgentMismatch())
          } else if (!(yield* selectedAgentMatches(placed.agent, agent, selection)))
            return yield* Effect.die(new AgentMismatch())
          const baselineSeq = yield* SessionInput.latestSeq(db, sessionID)
          yield* db
            .insert(SessionContextEpochTable)
            .values({
              session_id: sessionID,
              baseline: generation.baseline,
              agent,
              snapshot: generation.snapshot,
              baseline_seq: baselineSeq,
              revision: 0,
            })
            .onConflictDoNothing()
            .returning({ sessionID: SessionContextEpochTable.session_id })
            .get()
            .pipe(
              Effect.orDie,
              Effect.flatMap((inserted) => (inserted ? Effect.void : Effect.die(new RevisionMismatch()))),
            )
          return baselineSeq
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const replace = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  expectedRevision: number,
  baselineSeq: number,
  generation: SystemContext.Generation,
  selection?: Selection,
) {
  yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          yield* requireAgentSelection(db, sessionID, agent, selection)
          const updated = yield* db
            .update(SessionContextEpochTable)
            .set({
              baseline: generation.baseline,
              agent,
              snapshot: generation.snapshot,
              baseline_seq: baselineSeq,
              replacement_seq: null,
              revision: expectedRevision + 1,
            })
            .where(
              and(
                eq(SessionContextEpochTable.session_id, sessionID),
                eq(SessionContextEpochTable.revision, expectedRevision),
              ),
            )
            .returning({ revision: SessionContextEpochTable.revision })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* Effect.die(new RevisionMismatch())
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const fence = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  expectedRevision: number,
  selection?: Selection,
) {
  const current = yield* db
    .select({ selected: SessionTable.agent, revision: SessionContextEpochTable.revision })
    .from(SessionContextEpochTable)
    .innerJoin(SessionTable, eq(SessionTable.id, SessionContextEpochTable.session_id))
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!current) return yield* Effect.die(new AgentMismatch())
  yield* requireAgentSelection(db, sessionID, agent, selection)
  if (current.revision !== expectedRevision) return yield* Effect.die(new RevisionMismatch())
})

export const current = Effect.fn("SessionContextEpoch.current")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  revision: number,
  selection?: Selection,
) {
  const value = yield* db
    .select({
      agent: SessionContextEpochTable.agent,
      selected: SessionTable.agent,
      revision: SessionContextEpochTable.revision,
    })
    .from(SessionContextEpochTable)
    .innerJoin(SessionTable, eq(SessionTable.id, SessionContextEpochTable.session_id))
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return (
    value !== undefined &&
    value.agent === agent &&
    (yield* selectedAgentMatches(value.selected, agent, selection)) &&
    value.revision === revision
  )
})

const advance = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  expectedRevision: number,
  snapshot: SystemContext.Snapshot,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({ snapshot, revision: expectedRevision + 1 })
    .where(
      and(
        eq(SessionContextEpochTable.session_id, sessionID),
        eq(SessionContextEpochTable.revision, expectedRevision),
        isNull(SessionContextEpochTable.replacement_seq),
      ),
    )
    .returning({ revision: SessionContextEpochTable.revision })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new RevisionMismatch())
})
