import { expect, spyOn } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { ModelV2 } from "../src/model"
import { Location } from "../src/location"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionContextEpoch } from "../src/session/context-epoch"
import { SessionExecution } from "../src/session/execution"
import { SessionEvent } from "../src/session/event"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionProjector } from "../src/session/projector"
import { SessionStore } from "../src/session/store"
import { SessionContextEpochTable, SessionInputTable, SessionTable } from "../src/session/sql"
import { SystemContext } from "../src/system-context"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(
    database,
    events,
    store,
    sessions,
    AgentV2.layer,
    SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/selection-fixture") })
const context = Effect.succeed(
  SystemContext.make({
    key: SystemContext.Key.make("test/selection"),
    codec: Schema.toCodecJson(Schema.String),
    load: Effect.succeed("Selected agent context"),
    baseline: String,
    update: (_old, value) => value,
  }),
)

it.effect("legacy build selector uses the actual roster identity without rewriting the Session", () =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.update((editor) =>
      editor.update(AgentV2.defaultID, (agent) => {
        agent.mode = "primary"
      }),
    )
    const session = yield* (yield* SessionV2.Service).create({ location, agent: AgentV2.ID.make("build") })
    const selected = yield* agents.select(session.agent)
    expect(selected.id).toBe(AgentV2.ID.make("auto"))
    const prepared = yield* SessionContextEpoch.initialize(
      (yield* Database.Service).db,
      context,
      session.id,
      location,
      selected.id,
      { select: agents.select },
    )
    expect(prepared?.baseline).toBe("Selected agent context")
    expect((yield* (yield* SessionV2.Service).get(session.id)).agent).toBe(AgentV2.ID.make("build"))
  }),
)

it.effect("first pending prompt can select B before its durable promotion", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ location, agent: AgentV2.ID.make("A") })
    yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "First", agent: "B" }), resume: false })
    const selected = yield* SessionInput.peekActiveSelection(db, session.id, "steer")
    expect(selected?.agent).toBe(AgentV2.ID.make("B"))
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    const agents = yield* AgentV2.Service
    yield* agents.update((editor) =>
      editor.update(AgentV2.ID.make("B"), (agent) => {
        agent.mode = "primary"
      }),
    )
    const prepared = yield* SessionContextEpoch.initialize(db, context, session.id, location, AgentV2.ID.make("B"), {
      select: agents.select,
      snapshot,
    })
    expect(prepared?.baseline).toBe("Selected agent context")
  }),
)

it.effect("mixed pending agent and model follow independent last-wins projection", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ location, agent: AgentV2.ID.make("A") })
    yield* sessions.prompt({
      sessionID: session.id,
      prompt: new Prompt({ text: "Choose B", agent: "B" }),
      resume: false,
    })
    yield* sessions.prompt({
      sessionID: session.id,
      prompt: new Prompt({ text: "Choose M", model: { providerID: "p", id: "m" } }),
      resume: false,
    })
    expect(yield* SessionInput.peekActiveSelection(db, session.id, "steer")).toEqual({
      agent: "B",
      model: { providerID: "p", id: "m" },
    })
  }),
)

it.effect("queue snapshot promotes one FIFO queue then steers, with independent selections", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ location, agent: AgentV2.ID.make("A") })
    const admit = (text: string, delivery: SessionInput.Delivery, agent?: string, model?: Prompt["model"]) =>
      SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: session.id,
        delivery,
        prompt: new Prompt({ text, agent, model }),
      })
    const first = yield* admit("First queued", "queue", "Q", { providerID: "p", id: "first" })
    const second = yield* admit("Second queued", "queue", "later")
    const steer = yield* admit("Steer agent", "steer", "B")
    const model = yield* admit("Steer model", "steer", undefined, { providerID: "p", id: "last" })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "queue")
    expect(snapshot.agent).toBe(AgentV2.ID.make("B"))
    expect(snapshot.model).toEqual({ providerID: "p", id: "last" })
    expect(yield* SessionInput.promoteSelection(db, events, snapshot)).toEqual([first.id, steer.id, model.id])
    expect((yield* SessionInput.find(db, second.id))?.promotedSeq).toBeUndefined()
    expect((yield* sessions.get(session.id)).agent).toBe(AgentV2.ID.make("B"))
    expect((yield* sessions.get(session.id)).model?.id).toBe(ModelV2.ID.make("last"))
  }),
)

it.effect("late inputs invalidate the captured cutoff without consuming either batch", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ location })
    yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "First", agent: "A" }), resume: false })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "Late", agent: "B" }), resume: false })
    expect(
      yield* SessionInput.promoteSelection(db, events, snapshot).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionInput.SelectionMismatch)
    expect((yield* db.select().from(SessionInputTable)).every((row) => row.promoted_seq === null)).toBeTrue()
    expect((yield* SessionInput.captureSelection(db, session.id, "steer")).agent).toBe(AgentV2.ID.make("B"))
  }),
)

it.effect("a real A to B to A switch during Context invalidates the initial snapshot", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const agents = yield* AgentV2.Service
    yield* agents.update((editor) =>
      editor.update(AgentV2.ID.make("A"), (agent) => {
        agent.mode = "primary"
      }),
    )
    const session = yield* sessions.create({ location, agent: AgentV2.ID.make("A") })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    const raced = Effect.gen(function* () {
      yield* sessions.switchAgent({ sessionID: session.id, agent: "B" })
      yield* sessions.switchAgent({ sessionID: session.id, agent: "A" })
      return yield* context
    }).pipe(Effect.orDie)
    expect(
      yield* SessionContextEpoch.initialize(db, raced, session.id, location, AgentV2.ID.make("A"), {
        select: agents.select,
        snapshot,
      }).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionInput.SelectionMismatch)
    expect(yield* db.select().from(SessionContextEpochTable)).toHaveLength(0)
  }),
)

it.effect("the promotion transaction rolls back a changed selector and its input projection", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ location, agent: AgentV2.ID.make("A") })
    yield* sessions.prompt({
      sessionID: session.id,
      prompt: new Prompt({ text: "Choose B", agent: "B" }),
      resume: false,
    })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    // Real in-transaction projection interference; the commit hook must roll back both writes.
    yield* events.project(SessionEvent.PromptLifecycle.Promoted, () =>
      db
        .update(SessionTable)
        .set({ agent: "C" })
        .where(eq(SessionTable.id, session.id))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    expect(
      yield* SessionInput.promoteSelection(db, events, snapshot).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionInput.SelectionMismatch)
    expect((yield* sessions.get(session.id)).agent).toBe(AgentV2.ID.make("A"))
    expect((yield* db.select().from(SessionInputTable))[0].promoted_seq).toBeNull()
    expect(yield* SessionInput.latestSeq(db, session.id)).toBe(snapshot.cutoff)
  }),
)

it.effect("caller-created or edited snapshots cannot substitute a different batch", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ location })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    expect(Object.isFrozen(snapshot)).toBeTrue()
    expect(
      yield* SessionInput.requireSelection(db, { ...snapshot }).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionInput.SelectionMismatch)
  }),
)

it.effect("historical independent build epoch is replaced when the actual roster now resolves auto", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const agents = yield* AgentV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    yield* agents.update((editor) => {
      editor.update(AgentV2.defaultID, (agent) => {
        agent.mode = "primary"
      })
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.mode = "primary"
      })
    })
    const session = yield* sessions.create({ location, agent: AgentV2.ID.make("build") })
    expect((yield* agents.select(session.agent)).id).toBe(AgentV2.ID.make("build"))
    yield* SessionContextEpoch.initialize(db, context, session.id, location, AgentV2.ID.make("build"), {
      select: agents.select,
    })
    yield* agents.update((editor) => editor.remove(AgentV2.ID.make("build")))
    expect((yield* agents.select(session.agent)).id).toBe(AgentV2.ID.make("auto"))
    expect(
      yield* SessionContextEpoch.current(db, session.id, AgentV2.defaultID, 0, { select: agents.select }),
    ).toBeFalse()
    const prepared = yield* SessionContextEpoch.prepare(db, events, context, session.id, location, AgentV2.defaultID, {
      select: agents.select,
    })
    expect(prepared.revision).toBe(1)
    expect((yield* db.select().from(SessionContextEpochTable))[0].agent).toBe(AgentV2.ID.make("auto"))
    expect((yield* sessions.get(session.id)).agent).toBe(AgentV2.ID.make("build"))
  }),
)

it.effect("Context defects and cancellation retain pending input and do not become selection retries", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ location })
    yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "Pending" }), resume: false })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    const agents = yield* AgentV2.Service
    const error = new Error("specific Context source failure")
    expect(
      yield* SessionContextEpoch.initialize(db, Effect.die(error), session.id, location, AgentV2.defaultID, {
        select: agents.select,
        snapshot,
      }).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBe(error)
    const canceled = yield* SessionContextEpoch.initialize(
      db,
      Effect.interrupt,
      session.id,
      location,
      AgentV2.defaultID,
      { select: agents.select, snapshot },
    ).pipe(Effect.exit)
    expect(Exit.isFailure(canceled) && Cause.hasInterrupts(canceled.cause)).toBeTrue()
    expect(yield* db.select().from(SessionContextEpochTable)).toHaveLength(0)
    expect((yield* db.select().from(SessionInputTable))[0].promoted_seq).toBeNull()
  }),
)

it.effect("a multi-page backlog bounds reads per page and retains every later FIFO queue member", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ location })
    for (const index of Array.from({ length: 385 }, (_, index) => index)) {
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: session.id,
        delivery: "steer",
        prompt: new Prompt({
          text: `Steer ${index}`,
          ...(index === 384 ? { agent: "B" } : {}),
          ...(index === 257 ? { model: { providerID: "p", id: "last" } } : {}),
        }),
      })
      if (index >= 128) continue
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: session.id,
        delivery: "queue",
        prompt: new Prompt({ text: `Queue ${index}`, agent: "Q" }),
      })
    }
    // The real 513-row inbox needs four bounded steer pages, one FIFO queue read and
    // original admission proofs; reads grow per page rather than per pending prompt.
    const reads = spyOn(db, "select")
    yield* Effect.gen(function* () {
      const snapshot = yield* SessionInput.captureSelection(db, session.id, "queue")
      expect(reads).toHaveBeenCalledTimes(11)
      expect(snapshot.agent).toBe("B")
      expect(snapshot.model).toEqual({ providerID: "p", id: "last" })
      reads.mockClear()
      yield* SessionInput.requireSelection(db, snapshot)
      expect(reads).toHaveBeenCalledTimes(11)
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("B"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const prepared = yield* SessionContextEpoch.prepare(
        db,
        events,
        context,
        session.id,
        location,
        AgentV2.ID.make("B"),
        { select: agents.select, snapshot },
      )
      const admitted = yield* SessionContextEpoch.promotePrepared(
        db,
        events,
        prepared,
        session.id,
        AgentV2.ID.make("B"),
        agents.select,
      )
      expect(admitted.promoted).toHaveLength(386)
      expect(admitted.prepared.baseline).toBe("Selected agent context")
      expect(yield* SessionInput.pendingQueueInputs(db, session.id)).toHaveLength(127)
      expect((yield* sessions.get(session.id)).agent).toBe(AgentV2.ID.make("B"))
      expect((yield* sessions.get(session.id)).model?.id).toBe(ModelV2.ID.make("last"))
      expect(
        yield* SessionInput.requireSelection(db, snapshot).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBeInstanceOf(SessionInput.SelectionMismatch)
    }).pipe(Effect.ensuring(Effect.sync(() => reads.mockRestore())))
  }),
)

for (const mutation of ["changed", "missing", "promoted"] as const) {
  it.effect(`a ${mutation} later page refuses before publishing its member and retains the committed prefix`, () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const session = yield* sessions.create({ location })
      const rows: SessionInput.Admitted[] = []
      for (const index of Array.from({ length: 129 }, (_, index) => index)) {
        rows.push(
          yield* SessionInput.admit(db, events, {
            id: SessionMessage.ID.create(),
            sessionID: session.id,
            delivery: "steer",
            prompt: new Prompt({ text: `Steer ${index}` }),
          }),
        )
      }
      const last = rows.at(-1)!
      const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
      const seen: string[] = []
      yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== SessionEvent.PromptLifecycle.Promoted.type) return
          seen.push(event.id)
          if (seen.length !== 128) return
          if (mutation === "missing") {
            yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, last.id)).run().pipe(Effect.orDie)
            return
          }
          if (mutation === "promoted") {
            yield* db
              .update(SessionInputTable)
              .set({ promoted_seq: snapshot.cutoff })
              .where(eq(SessionInputTable.id, last.id))
              .run()
              .pipe(Effect.orDie)
            return
          }
          yield* db
            .update(SessionInputTable)
            .set({ prompt: { text: "Changed after the first page" } })
            .where(eq(SessionInputTable.id, last.id))
            .run()
            .pipe(Effect.orDie)
        }),
      )
      expect(
        yield* SessionInput.promoteSelection(db, events, snapshot).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBeInstanceOf(SessionInput.SelectionMismatch)
      expect(seen).toHaveLength(128)
      expect(
        (yield* db.select().from(EventTable)).filter(
          (event) => event.type === EventV2.durableType(SessionEvent.PromptLifecycle.Promoted),
        ),
      ).toHaveLength(128)
      if (mutation !== "promoted") expect((yield* SessionInput.find(db, last.id))?.promotedSeq).toBeUndefined()
      expect(
        yield* SessionInput.requireSelection(db, snapshot).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBeInstanceOf(SessionInput.SelectionMismatch)
      // Owned corruption is repaired from this test's original admission, never by rewriting
      // any production Work. A new witness promotes the exact remaining original member once.
      if (mutation === "missing") {
        yield* SessionInput.projectAdmitted(db, {
          id: last.id,
          sessionID: session.id,
          admittedSeq: last.admittedSeq,
          prompt: last.prompt,
          delivery: last.delivery,
          timeCreated: last.timeCreated,
        })
      }
      if (mutation === "changed") {
        yield* db
          .update(SessionInputTable)
          .set({ prompt: { text: last.prompt.text } })
          .where(eq(SessionInputTable.id, last.id))
          .run()
          .pipe(Effect.orDie)
      }
      if (mutation === "promoted") {
        yield* db
          .update(SessionInputTable)
          .set({ promoted_seq: null })
          .where(eq(SessionInputTable.id, last.id))
          .run()
          .pipe(Effect.orDie)
      }
      const remaining = yield* SessionInput.captureSelection(db, session.id, "steer")
      expect(yield* SessionInput.promoteSelection(db, events, remaining)).toEqual([last.id])
      expect(seen).toHaveLength(129)
      const empty = yield* SessionInput.captureSelection(db, session.id, "steer")
      expect(yield* SessionInput.promoteSelection(db, events, empty)).toEqual([])
    }),
  )
}

it.effect("a later-page transaction rolls back its conflicting projection before consuming that member", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ location })
    const rows: SessionInput.Admitted[] = []
    for (const index of Array.from({ length: 129 }, (_, index) => index)) {
      rows.push(
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID: session.id,
          delivery: "steer",
          prompt: new Prompt({ text: `Steer ${index}` }),
        }),
      )
    }
    const last = rows.at(-1)!
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    const seen: string[] = []
    const refused = { precedingSequence: undefined as number | undefined }
    yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type === SessionEvent.PromptLifecycle.Promoted.type) seen.push(event.id)
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Promoted, (event) => {
      if (event.data.messageID !== last.id) return Effect.void
      refused.precedingSequence = event.seq! - 1
      return db
        .update(SessionInputTable)
        .set({ prompt: { text: "Conflicting in-transaction projection" } })
        .where(eq(SessionInputTable.id, last.id))
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    })
    expect(
      yield* SessionInput.promoteSelection(db, events, snapshot).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionInput.SelectionMismatch)
    expect(seen).toHaveLength(128)
    expect((yield* SessionInput.find(db, last.id))?.prompt.text).toBe(last.prompt.text)
    expect((yield* SessionInput.find(db, last.id))?.promotedSeq).toBeUndefined()
    expect(refused.precedingSequence).toBeDefined()
    expect(yield* SessionInput.latestSeq(db, session.id)).toBe(refused.precedingSequence!)
  }),
)

it.effect("original snapshot compaction retains pending admission facts for selection pages", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ location })
    const pending = yield* SessionInput.admit(db, events, {
      id: SessionMessage.ID.create(),
      sessionID: session.id,
      delivery: "steer",
      prompt: new Prompt({ text: "Still pending after compaction", agent: "B" }),
    })
    const frontier = EventV2.Cursor.make(yield* SessionInput.latestSeq(db, session.id))
    yield* events.checkpoint({
      aggregateID: session.id,
      throughSeq: frontier,
      expectedLatest: frontier,
      codec: "session-projection",
      schemaVersion: 1,
    })
    const compaction = { complete: false, deleted: 0 }
    while (!compaction.complete) {
      const page = yield* events.compact({ aggregateID: session.id, throughSeq: frontier, limit: 1 })
      compaction.complete = page.complete
      compaction.deleted += page.deleted
    }
    expect(compaction.deleted).toBeGreaterThan(0)
    expect(yield* db.select().from(EventTable).where(eq(EventTable.seq, pending.admittedSeq))).toHaveLength(1)
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    expect(snapshot.agent).toBe("B")
    expect(yield* SessionInput.promoteSelection(db, events, snapshot)).toEqual([pending.id])
  }),
)

it.effect("a failed ContextUpdated CAS rolls back the event and does not notify before commit", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const agents = yield* AgentV2.Service
    yield* agents.update((editor) =>
      editor.update(AgentV2.defaultID, (agent) => {
        agent.mode = "primary"
      }),
    )
    const session = yield* sessions.create({ location })
    yield* SessionContextEpoch.initialize(db, context, session.id, location, AgentV2.defaultID, {
      select: agents.select,
    })
    yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "Still pending" }), resume: false })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    const observed: string[] = []
    yield* events.listen((event) =>
      Effect.sync(() => {
        observed.push(event.type)
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, () =>
      db
        .update(SessionContextEpochTable)
        .set({ revision: sql`${SessionContextEpochTable.revision} + 1` })
        .where(eq(SessionContextEpochTable.session_id, session.id))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    const changed = Effect.succeed(
      SystemContext.make({
        key: SystemContext.Key.make("test/selection"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed("Changed context"),
        baseline: String,
        update: (_old, value) => value,
      }),
    )
    expect(
      yield* SessionContextEpoch.prepare(db, events, changed, session.id, location, AgentV2.defaultID, {
        select: agents.select,
        snapshot,
      }).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionContextEpoch.AgentMismatch)
    expect(observed).toEqual([])
    expect(yield* SessionInput.latestSeq(db, session.id)).toBe(snapshot.cutoff)
    expect((yield* db.select().from(SessionContextEpochTable))[0].revision).toBe(0)
    expect((yield* db.select().from(SessionInputTable))[0].promoted_seq).toBeNull()
  }),
)

it.effect("a switch between promotion members retains only the already committed prefix", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ location, agent: AgentV2.ID.make("A") })
    yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "First" }), resume: false })
    yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "Second" }), resume: false })
    const snapshot = yield* SessionInput.captureSelection(db, session.id, "steer")
    const seen: string[] = []
    yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== SessionEvent.PromptLifecycle.Promoted.type) return
        seen.push(event.id)
        if (seen.length === 1) {
          yield* sessions.switchAgent({ sessionID: session.id, agent: "B" }).pipe(Effect.orDie)
          yield* sessions.switchAgent({ sessionID: session.id, agent: "A" }).pipe(Effect.orDie)
        }
      }),
    )
    expect(
      yield* SessionInput.promoteSelection(db, events, snapshot).pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionInput.SelectionMismatch)
    const rows = yield* db.select().from(SessionInputTable)
    expect(rows.filter((row) => row.promoted_seq !== null)).toHaveLength(1)
    expect(rows.filter((row) => row.promoted_seq === null)).toHaveLength(1)
    expect(seen).toHaveLength(1)
  }),
)
