import { afterEach, describe, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { Database } from "@deepagent-code/core/database/database"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { Global } from "@deepagent-code/core/global"
import { WikiService, WikiGraph, EXECUTION_ARCHIVE_TYPES } from "../../src/wiki/wiki-service"
import * as WikiEvents from "../../src/wiki/wiki-events"
import { archiveSessionOnCompletion } from "../../src/wiki/session-archive"
import { EventDrivenArchiver } from "../../src/wiki/event-driven-archiver"
import { testEffect } from "../lib/effect"
import { freshStore, knowledgeInput } from "./helpers"

// FEAT-006 — wiki/knowledge change eventing (LMNEvents.WIKI_PAGE_CHANGED):
//   1. editKnowledge publishes after the governed write commits (type/payload/idempotency key);
//   2. the same write redelivered (same docId+version) never double-publishes (bus dedup on key);
//   3. the archive path (archiveSessionOnCompletion) publishes with the `archive` marker in the key;
//   4. SELF-LOOP isolation: wiki.page.changed is not an archive trigger, and the archiver ignores it;
//   5. the bus port is injectable (constructor) AND resolvable from the Effect environment (the
//      production seam — the unmodified wikiEdit handler's runtime provides the bus layer).

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

// Seed a session's run-scoped context store (the SAME root archiveSessionOnCompletion persists
// into) with one trajectory doc, so archival produces a REAL persisted archive page to emit for.
const seedSessionStore = (sessionID: string) => {
  const root = path.join(Global.Path.agent.data, "state", "context", sessionID)
  const store = new DocumentStore(root)
  store.create({
    type: "plan",
    scope: `run:${sessionID}`,
    body: "goal: ship it",
    description: "plan",
    provenance: { source: "runner", run_ref: `run:${sessionID}` },
  })
  roots.push(root)
}

let clock = 0
const now = () => clock
const database = Database.layerFromPath(":memory:")
const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
// runLoop:false → no background subscription; handle() is driven directly for the self-loop test.
const archiverLayer = EventDrivenArchiver.layerWith({ runLoop: false }).pipe(Layer.provideMerge(busLayer))
const it = testEffect(archiverLayer)

// Every wiki.page.changed event currently on the bus (durable replay — deterministic).
const replayWikiEvents = Effect.gen(function* () {
  const bus = yield* DeepAgentEventBus.Service
  const chunk = yield* Stream.runCollect(bus.replay({ from: 0, type: LMNEvents.WIKI_PAGE_CHANGED }))
  return Array.from(chunk)
})

const WORKSPACE = "/tmp/feat-006-ws"

describe("FEAT-006 editKnowledge → wiki.page.changed", () => {
  it.effect("publishes AFTER a committed edit: type/payload/idempotency key (injected bus port)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const { store, root } = freshStore()
      roots.push(root)
      const k = store.create(knowledgeInput({ body: "v1" }))
      // explicit port injection (the constructor seam) — workspacePath labels the payload.
      const service = new WikiService(new WikiGraph([store]), undefined, { bus, workspacePath: WORKSPACE })
      const page = yield* service.editKnowledge({ docId: k.id, body: "v2 edited", editor: { id: "alice" } })
      expect(page.version).toBe(2)

      const events = yield* replayWikiEvents
      expect(events).toHaveLength(1)
      const ev = events[0]!
      expect(ev.type).toBe(LMNEvents.WIKI_PAGE_CHANGED)
      expect(ev.idempotencyKey).toBe(WikiEvents.wikiPageChangedIdempotencyKey({ docId: k.id, version: 2 }))
      expect(ev.idempotencyKey).toBe(`wiki.page.changed:${k.id}:2`) // docId+version, no archive marker
      const payload = ev.payload as Record<string, unknown>
      expect(payload.workspacePath).toBe(WORKSPACE)
      expect(payload.docId).toBe(k.id)
      expect(payload.type).toBe("knowledge")
      expect(payload.version).toBe(2)
      expect(payload.editor).toBe("alice")
      expect(payload.archive).toBeUndefined() // a human edit is NOT an archive write
    }),
  )

  it.effect("environment seam: no injected port → the bus is resolved from the Effect runtime", () =>
    Effect.gen(function* () {
      // The production construction point (handlers/deepagent.ts) passes NO bus — the route runtime
      // provides DeepAgentEventBus.defaultLayer, and editKnowledge falls back to the environment's
      // service. This test reproduces that seam exactly: ports carry only workspacePath.
      const { store, root } = freshStore()
      roots.push(root)
      const k = store.create(knowledgeInput({ body: "v1" }))
      const service = new WikiService(new WikiGraph([store]), undefined, { workspacePath: WORKSPACE })
      yield* service.editKnowledge({ docId: k.id, body: "v2", editor: { id: "bob" } })
      const events = yield* replayWikiEvents
      expect(events).toHaveLength(1)
      expect((events[0]!.payload as Record<string, unknown>).editor).toBe("bob")
    }),
  )

  it.effect("a bus-less edit never fails and never emits (graceful degradation without any bus)", () =>
    Effect.gen(function* () {
      // No injected port AND no bus in the environment: run the edit through a bare runtime
      // (Effect.runPromise in a plain Effect below — no bus layer provided), so resolveBus's
      // serviceOption sees None. The edit must still commit: publishing is best-effort, never a
      // dependency of the write itself.
      const { store, root } = freshStore()
      roots.push(root)
      const k = store.create(knowledgeInput({ body: "v1" }))
      const service = new WikiService(new WikiGraph([store]))
      const page = yield* Effect.promise(() =>
        Effect.runPromise(service.editKnowledge({ docId: k.id, body: "v2", editor: { id: "carol" } })),
      )
      expect(page.version).toBe(2)
      expect(store.get(k.id)!.version).toBe(2)
      // no bus anywhere → nothing was published anywhere this test can see; the write is intact.
    }),
  )

  it.effect("idempotency: same docId+version published twice → ONE event (no duplicate)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const { store, root } = freshStore()
      roots.push(root)
      const k = store.create(knowledgeInput({ body: "v1" }))
      const service = new WikiService(new WikiGraph([store]), undefined, { bus, workspacePath: WORKSPACE })
      yield* service.editKnowledge({ docId: k.id, body: "v2", editor: { id: "alice" } })
      // Simulate a redelivery of the SAME committed write (docId+version identical): the publisher
      // re-emits with the same idempotency key → the bus dedupes, no second event row.
      yield* WikiEvents.publishWikiPageChanged(bus, {
        workspacePath: WORKSPACE,
        docId: k.id,
        type: "knowledge",
        version: 2,
        editor: "alice",
      })
      const events = yield* replayWikiEvents
      expect(events).toHaveLength(1) // deduped on wiki.page.changed:<docId>:2
      // a GENUINELY new edit bumps the version → a NEW key → a second event (not swallowed).
      yield* service.editKnowledge({ docId: k.id, body: "v3", editor: { id: "alice" } })
      expect((yield* replayWikiEvents)).toHaveLength(2)
    }),
  )
})

describe("FEAT-006 archive path → wiki.page.changed (archive marker)", () => {
  it.effect("archiveSessionOnCompletion publishes with archive:true + `archive:` idempotency key", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const sessionID = "sess-feat006-archive"
      seedSessionStore(sessionID)
      const archive = yield* archiveSessionOnCompletion({ workspacePath: WORKSPACE, sessionID, bus })
      expect(archive).not.toBeNull()

      const events = yield* replayWikiEvents
      expect(events).toHaveLength(1)
      const ev = events[0]!
      expect(ev.type).toBe(LMNEvents.WIKI_PAGE_CHANGED)
      const payload = ev.payload as Record<string, unknown>
      expect(payload.archive).toBe(true) // the archive marker
      expect(payload.sessionID).toBe(sessionID)
      expect(payload.workspacePath).toBe(WORKSPACE)
      expect(payload.editor).toBe("system:archiver")
      expect(payload.type).toBe("context_snapshot") // the persisted archive page's doc type
      expect(ev.idempotencyKey!.startsWith("wiki.page.changed:archive:")).toBe(true)
      expect(ev.idempotencyKey).toBe(
        WikiEvents.wikiPageChangedIdempotencyKey({
          docId: payload.docId as string,
          version: payload.version as number,
          archive: { sessionID },
        }),
      )
    }),
  )

  it.effect("redelivered archive trigger → SAME docId+version → no duplicate event (idempotent)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const sessionID = "sess-feat006-redeliver"
      seedSessionStore(sessionID)
      yield* archiveSessionOnCompletion({ workspacePath: WORKSPACE, sessionID, bus })
      // A redelivered session.completed re-runs the archive: the trajectory is unchanged, so
      // DocumentStore.upsert is a fingerprint no-op (same doc at the same version) → the event's
      // idempotency key is identical → the bus dedupes.
      yield* archiveSessionOnCompletion({ workspacePath: WORKSPACE, sessionID, bus })
      yield* archiveSessionOnCompletion({ workspacePath: WORKSPACE, sessionID, bus })
      const events = yield* replayWikiEvents
      expect(events).toHaveLength(1) // three runs, ONE event
    }),
  )
})

describe("FEAT-006 self-loop protection (archiver ⇏ wiki.page.changed ⇏ archiver)", () => {
  it.effect("isolation proof: wiki.page.changed is NOT an archive trigger; archiver ignores it", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const archiver = yield* EventDrivenArchiver.Service
      // 1. Type-level isolation: the consumer-type filter is the guard (see LMNEvents comment —
      //    DLQ_ALERT guards at the producer instead; here the archiver simply never matches).
      expect(LMNEvents.isArchiveTrigger(LMNEvents.WIKI_PAGE_CHANGED)).toBe(false)
      // 2. Content-level isolation: the persisted archive page is a context_snapshot — outside
      //    EXECUTION_ARCHIVE_TYPES — so it could never be folded into a later archive either.
      expect(EXECUTION_ARCHIVE_TYPES.includes("context_snapshot")).toBe(false)
      // 3. Behavioral proof: feed a REAL published wiki.page.changed to the archiver's handler —
      //    it acks it as "not our concern" and produces NO archive.
      const ev = yield* bus.publish({
        type: LMNEvents.WIKI_PAGE_CHANGED,
        source: "system",
        workspaceID: WORKSPACE,
        idempotencyKey: "self-loop-1",
        payload: { workspacePath: WORKSPACE, docId: "doc:knowledge:x", type: "knowledge", version: 2, editor: "alice" },
      })
      expect(yield* archiver.handle(ev)).toBe(false) // not an archive trigger → skipped, no write
    }),
  )

  it.effect("archiver-driven archive emits wiki.page.changed without re-triggering itself", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const archiver = yield* EventDrivenArchiver.Service
      const sessionID = "sess-feat006-selfloop"
      seedSessionStore(sessionID)
      // Drive the archiver end-to-end: session.completed → archive persist → wiki.page.changed.
      const trigger = yield* bus.publish({
        type: LMNEvents.SESSION_COMPLETED,
        source: "system",
        workspaceID: WORKSPACE,
        idempotencyKey: "sc-selfloop",
        payload: { sessionID, workspacePath: WORKSPACE },
      })
      expect(yield* archiver.handle(trigger)).toBe(true) // archive produced (bus injected by layer)
      const wikiEvents = yield* replayWikiEvents
      expect(wikiEvents).toHaveLength(1)
      // The emitted event is inert for the archiver: handle() on it produces nothing.
      expect(yield* archiver.handle(wikiEvents[0]!)).toBe(false)
      // …and no SECOND archive-derived event appeared (no cascade, no duplicate).
      expect((yield* replayWikiEvents)).toHaveLength(1)
    }),
  )
})
