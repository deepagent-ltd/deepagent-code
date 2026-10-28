import { expect, test } from "bun:test"
import path from "node:path"
import { rename, writeFile } from "node:fs/promises"
import { and, count, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { DurableKnowledgeStore } from "../src/deepagent/durable-knowledge-store"
import { EventV2 } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionEvent } from "../src/session/event"
import { fromRow } from "../src/session/info"
import { SessionTable } from "../src/session/sql"
import { SessionToolQuota } from "../src/session/tool-quota.schema"
import { DomainPackLoadTool } from "../src/system-context/domain-pack-load-tool"
import { KnowledgeProposeTool } from "../src/tool/knowledge-propose"
import { Tool } from "../src/tool/tool"
import { quotaLayer, seedQuotaSession } from "./fixture/tool-quota"
import { tmpRoot } from "./fixture/tmpdir"

const sessionID = SessionSchema.ID.make("ses_actual_tool_quota")
const context = (toolCallID: string, turn = "one"): Tool.Context => ({
  sessionID,
  toolCallID,
  assistantMessageID: SessionMessage.ID.make(`msg_quota_${turn}`),
  agent: AgentV2.ID.make("build"),
})
const seed = (store: DurableKnowledgeStore, key: string) =>
  store.seedActive({
    type: "strategy",
    idSlug: key,
    description: key,
    body: `body ${key}`,
    scope: "user-global",
    packId: "quota",
    domain: "quota",
    tags: ["pack:quota", "provenance:domain_pack:quota"],
    sensitivity: "public",
    risk: "low",
    confidence: { evidence_strength: "strong", support_count: 1 },
    provenance: { source: "human", run_ref: null },
  })
const load = (tool: Tool.AnyTool, ref: string, id: string, turn = "one") =>
  Tool.settle(tool, { type: "tool-call", id, name: DomainPackLoadTool.name, input: { ref } }, context(id, turn))
const propose = (tool: Tool.AnyTool, id: string) =>
  Tool.settle(
    tool,
    {
      type: "tool-call",
      id,
      name: KnowledgeProposeTool.name,
      input: {
        type: "memory",
        description: "Human review required",
        body: "Original session keeps its budget",
        scope: "global",
      },
    },
    context(id),
  )

test("domain quota survives concurrent admission, reset, cold reopen and real projection compaction", async () => {
  const directory = tmpRoot()
  const filename = path.join(directory, "quota.sqlite")
  const store = new DurableKnowledgeStore(path.join(directory, "knowledge"))
  const docs = ["a", "b", "c", "d"].map((key) => seed(store, key))
  const tool = DomainPackLoadTool.makeDomainPackLoadTool({ store: () => store })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedQuotaSession(sessionID, directory)
      const outcomes = yield* Effect.forEach(
        docs.slice(0, 3),
        (doc, index) => load(tool, doc.id, `load_${index}`).pipe(Effect.result),
        { concurrency: 3 },
      )
      expect(outcomes.filter((item) => item._tag === "Success")).toHaveLength(2)
      expect(outcomes.filter((item) => item._tag === "Failure")).toHaveLength(1)
      const db = (yield* Database.Service).db
      expect(
        (yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.type, "session.domain_pack.loaded.1"))
          .get()
          .pipe(Effect.orDie))?.value,
      ).toBe(2)
      yield* db
        .update(SessionTable)
        .set({ metadata: {} })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      DomainPackLoadTool.resetDomainPackLoadState()
      const failures = yield* load(tool, docs[3]!.id, "full_turn").pipe(Effect.result)
      expect(failures._tag).toBe("Failure")
      const events = yield* EventV2.Service
      const seq = (yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie))!.seq
      yield* events.checkpoint({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(seq),
        expectedLatest: EventV2.Cursor.make(seq),
        codec: "session-projection",
        schemaVersion: 1,
      })
      const compacted = yield* events.compact({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(seq),
        limit: 100,
      })
      expect(compacted.complete).toBe(true)
      expect(compacted.deleted).toBe(0)
    }).pipe(Effect.provide(quotaLayer(filename)), Effect.scoped),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const loaded = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.domain_pack.loaded.1"))
        .get()
        .pipe(Effect.orDie)
      const same = yield* load(tool, String(loaded!.data.ref), "reload", "two")
      expect(same.structured).toMatchObject({ state: "already_loaded" })
      expect((yield* load(tool, docs[3]!.id, "cold_same_turn").pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* load(tool, docs[3]!.id, "new_turn", "two")).structured).toMatchObject({ state: "loaded" })
      const row = (yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie))!
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Deleted, {
        sessionID,
        info: fromRow(row),
        slug: row.slug,
        version: row.version,
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      yield* events.remove(sessionID)
      expect(
        (yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie))?.value,
      ).toBe(0)
    }).pipe(Effect.provide(quotaLayer(filename)), Effect.scoped),
  )
})

test("knowledge concurrency preserves the ten reservations and missing Sessions cannot stage", async () => {
  const directory = tmpRoot()
  const store = new DurableKnowledgeStore(path.join(directory, "knowledge"))
  const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => store })
  await Effect.runPromise(
    Effect.gen(function* () {
      expect((yield* propose(tool, "missing_session").pipe(Effect.result))._tag).toBe("Failure")
      expect(store.listByStatus("candidate")).toHaveLength(0)
      yield* seedQuotaSession(sessionID, directory)
      const results = yield* Effect.forEach(
        Array.from({ length: 11 }, (_, index) => `knowledge_${index}`),
        (id) => propose(tool, id).pipe(Effect.result),
        { concurrency: 11 },
      )
      expect(results.filter((item) => item._tag === "Success")).toHaveLength(10)
      expect(results.filter((item) => item._tag === "Failure")).toHaveLength(1)
      const db = (yield* Database.Service).db
      expect(
        (yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.type, "session.knowledge_propose.reserved.1"))
          .get()
          .pipe(Effect.orDie))?.value,
      ).toBe(10)
    }).pipe(Effect.provide(quotaLayer(path.join(directory, "quota.sqlite"))), Effect.scoped),
  )
})

test("domain Session capacity and UTF-8 reference bounds fail before a new quota fact", async () => {
  const started = performance.now()
  const trace = (phase: string) => console.error(JSON.stringify({
    test: "quota-capacity", phase, elapsedMs: Math.round(performance.now() - started),
  }))
  trace("start")
  const directory = tmpRoot()
  const store = new DurableKnowledgeStore(path.join(directory, "knowledge"))
  const tool = DomainPackLoadTool.makeDomainPackLoadTool({ store: () => store })
  const doc = seed(store, "capacity")
  const fresh = seed(store, "new")
  trace("layer-open-start")
  await Effect.runPromise(
    Effect.gen(function* () {
      trace("layer-ready")
      yield* seedQuotaSession(sessionID, directory)
      yield* load(tool, doc.id, "first")
      trace("first-load-complete")
      const db = (yield* Database.Service).db
      // Existing ledger facts are fixture input committed by the original event publisher, including
      // its synchronization index. No synthetic loaded body or successful tool result is created.
      const events = yield* EventV2.Service
      const definition = EventV2.definitions().find((item) => item.type === "session.domain_pack.loaded")!
      trace("capacity-seed-start")
      // Commit fixture history once; every fact still runs the original publisher and sync index.
      yield* db.transaction(
        () => Effect.forEach(
          Array.from({ length: 4095 }, (_, index) => index),
          (index) =>
            events.publish(definition, {
              sessionID,
              assistantMessageID: `msg_retained_${index}`,
              toolCallID: `held_${index}`,
              ref: `doc:retained_${index}`,
            }),
          { discard: true },
        ),
        { behavior: "immediate" },
      ).pipe(Effect.orDie)
      trace("capacity-seed-complete")
      const full = yield* load(tool, fresh.id, "full", "next").pipe(Effect.result)
      expect(full._tag).toBe("Failure")
      if (full._tag === "Failure") expect(full.failure.message).toContain("capacity exhausted")
      expect((yield* load(tool, doc.id, "known", "next")).structured).toMatchObject({ state: "already_loaded" })
      expect((yield* load(tool, "doc:" + "界".repeat(341), "utf8").pipe(Effect.result))._tag).toBe("Failure")
      expect(
        (yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.type, "session.domain_pack.loaded.1"))
          .get()
          .pipe(Effect.orDie))?.value,
      ).toBe(4096)
      trace("body-done")
    }).pipe(Effect.provide(quotaLayer(path.join(directory, "quota.sqlite"))), Effect.scoped),
  )
  trace("scope-closed")
}, 20_000)

test("knowledge staging failure retains its reservation across restart and exact retry cannot repeat the effect", async () => {
  const directory = tmpRoot()
  const filename = path.join(directory, "quota.sqlite")
  const storePath = path.join(directory, "knowledge")
  const store = new DurableKnowledgeStore(storePath)
  const tool = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => store })
  await rename(storePath, `${storePath}-retained`)
  await writeFile(storePath, "owned fixture prevents the actual store write")
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedQuotaSession(sessionID, directory)
      expect((yield* propose(tool, "unknown_staging").pipe(Effect.result))._tag).toBe("Failure")
      const db = (yield* Database.Service).db
      expect(
        (yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.type, "session.knowledge_propose.reserved.1"))
          .get()
          .pipe(Effect.orDie))?.value,
      ).toBe(1)
    }).pipe(Effect.provide(quotaLayer(filename)), Effect.scoped),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      KnowledgeProposeTool.resetKnowledgeProposeState()
      const retry = yield* propose(tool, "unknown_staging").pipe(Effect.result)
      expect(retry._tag).toBe("Failure")
      if (retry._tag === "Failure") expect(retry.failure.message).toContain("original tool result")
      const db = (yield* Database.Service).db
      expect(
        (yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(
            and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, "session.knowledge_propose.reserved.1")),
          )
          .get()
          .pipe(Effect.orDie))?.value,
      ).toBe(1)
    }).pipe(Effect.provide(quotaLayer(filename)), Effect.scoped),
  )
})

test("original snapshot export/import preserves quota facts and conflicting or tampered imports roll back", async () => {
  const started = performance.now()
  const trace = (phase: string) => console.error(JSON.stringify({
    test: "quota-snapshot", phase, elapsedMs: Math.round(performance.now() - started),
  }))
  trace("start")
  const directory = tmpRoot()
  const store = new DurableKnowledgeStore(path.join(directory, "knowledge"))
  const docs = ["a", "b", "c"].map((key) => seed(store, key))
  const domain = DomainPackLoadTool.makeDomainPackLoadTool({ store: () => store })
  const knowledge = KnowledgeProposeTool.makeKnowledgeProposeTool({ globalStore: () => store })
  trace("source-layer-open-start")
  const bundle = await Effect.runPromise(
    Effect.gen(function* () {
      trace("source-layer-ready")
      yield* seedQuotaSession(sessionID, directory)
      yield* load(domain, docs[0]!.id, "load_a")
      yield* load(domain, docs[1]!.id, "load_b")
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, index) => `stage_${index}`),
        (id) => propose(knowledge, id),
        { discard: true },
      )
      trace("source-quota-facts-complete")
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const seq = (yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie))!.seq
      const snapshot = yield* events.checkpoint({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(seq),
        expectedLatest: EventV2.Cursor.make(seq),
        codec: "session-projection",
        schemaVersion: 1,
      })
      expect(Schema.decodeUnknownSync(EventV2.SnapshotManifest)(snapshot.body).tables.quota_event).toBe(12)
      trace("source-export-start")
      const exported = yield* events.exportSnapshotBundle!({ snapshotID: snapshot.snapshotID })
      trace("source-body-done")
      return exported
    }).pipe(Effect.provide(quotaLayer(path.join(directory, "source.sqlite"))), Effect.scoped),
  )
  trace("source-scope-closed")
  const proposed = store.listByStatus("candidate").map((ref) => store.documentStore.get(ref.id))
  trace("import-layer-open-start")
  await Effect.runPromise(
    Effect.gen(function* () {
      trace("import-layer-ready")
      yield* seedQuotaSession(sessionID, directory)
      const events = yield* EventV2.Service
      const malformed = JSON.parse(bundle)
      malformed.snapshot.aggregateID = "ses_foreign_quota"
      expect((yield* events.importSnapshotBundle!(JSON.stringify(malformed)).pipe(Effect.exit))._tag).toBe("Failure")
      trace("import-malformed-refused")
      yield* events.importSnapshotBundle!(bundle)
      trace("import-bundle-complete")
      const db = (yield* Database.Service).db
      expect(
        (yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie))?.value,
      ).toBe(12)
      expect((yield* load(domain, docs[0]!.id, "import_already")).structured).toMatchObject({ state: "already_loaded" })
      expect((yield* load(domain, docs[2]!.id, "import_full").pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* propose(knowledge, "import_full").pipe(Effect.result))._tag).toBe("Failure")
      expect(store.listByStatus("candidate").map((ref) => store.documentStore.get(ref.id))).toEqual(proposed)
      trace("import-body-done")
    }).pipe(Effect.provide(quotaLayer(path.join(directory, "import.sqlite"))), Effect.scoped),
  )
  trace("import-scope-closed")
  trace("conflict-layer-open-start")
  await Effect.runPromise(
    Effect.gen(function* () {
      trace("conflict-layer-ready")
      yield* seedQuotaSession(sessionID, directory)
      const parsed = JSON.parse(bundle) as EventV2.SnapshotBundle
      const row = parsed.rows.find((item) => item.tableName === "quota_event")!
      const fact = JSON.parse(
        Buffer.concat(parsed.chunks[row.rowHash]!.map((chunk) => Buffer.from(chunk, "base64"))).toString(),
      ) as SessionToolQuota.SnapshotFact
      const events = yield* EventV2.Service
      if (fact.type === SessionToolQuota.types[0])
        yield* events.publish(
          SessionToolQuota.Loaded,
          Schema.decodeUnknownSync(SessionToolQuota.Loaded.data)({ ...fact.data, ref: "doc:local-conflict" }),
          { id: fact.id },
        )
      if (fact.type === SessionToolQuota.types[1])
        yield* events.publish(
          SessionToolQuota.Reserved,
          Schema.decodeUnknownSync(SessionToolQuota.Reserved.data)({ ...fact.data, inputHash: "a".repeat(64) }),
          { id: fact.id },
        )
      const db = (yield* Database.Service).db
      yield* db
        .update(SessionTable)
        .set({ title: "untouched original" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const before = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect((yield* events.importSnapshotBundle!(bundle).pipe(Effect.exit))._tag).toBe("Failure")
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
      ).toEqual(before)
      expect(
        (yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie))?.title,
      ).toBe("untouched original")
      trace("conflict-body-done")
    }).pipe(Effect.provide(quotaLayer(path.join(directory, "conflict.sqlite"))), Effect.scoped),
  )
  trace("conflict-scope-closed")
})
