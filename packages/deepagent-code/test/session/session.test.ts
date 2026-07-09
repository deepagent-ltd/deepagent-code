import { describe, expect } from "bun:test"
import path from "path"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import * as Log from "@deepagent-code/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { Worktree } from "@/worktree"
import { Git } from "../../src/git"
import { DeepAgentContext, DeepAgentDocumentStore } from "@deepagent-code/core/deepagent/index"
import { contextStoreRoot, loadForkOrigin, forwardLedgerOnFork } from "@/session/context-ledger"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork, stamping fork lineage", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      // The fork inherits the source metadata (deep-cloned, not the same reference) …
      expect(fork.metadata).toMatchObject(meta)
      expect(fork.metadata).not.toBe(meta)
      // … and additionally records its lineage so the UI can render "derived from" + nest the fork.
      expect((fork.metadata as { forkedFrom?: { parentSessionID?: string } }).forkedFrom?.parentSessionID).toBe(
        created.id,
      )
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )

  // Archival is a soft flag on session.time_archived (nullable column). Unarchive sends
  // `time: { archived: null }` which must flow through patch → Updated event → projector,
  // where drizzle writes NULL (undefined would be skipped, leaving the column stale).
  it.instance("setArchived({ time }) sets the column, and setArchived({ time: null }) clears it to NULL", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "archive-roundtrip" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      // session.get reads the projected SessionTable row; fromRow maps a NULL
      // time_archived column to `undefined`, so `time.archived` reflects the
      // column state after the patch → Updated event → projector round-trip.

      // Fresh session is not archived.
      expect((yield* session.get(created.id)).time.archived).toBeUndefined()

      // Archive: a numeric timestamp lands in the column.
      yield* session.setArchived({ sessionID: created.id, time: 1700000000000 })
      expect((yield* session.get(created.id)).time.archived).toBe(1700000000000)

      // Unarchive: null must clear the column back to NULL. If null were dropped to
      // undefined anywhere in the chain, drizzle would skip the key and the column
      // would keep 1700000000000 — this assertion would then fail.
      yield* session.setArchived({ sessionID: created.id, time: null })
      expect((yield* session.get(created.id)).time.archived).toBeUndefined()
    }),
  )

  // listGlobal({ archived: true }) must return ONLY archived sessions — the archived-sessions drawer
  // relies on this. Regression guard for the bug where dropping the isNull filter leaked active
  // sessions into the archived list.
  it.instance("listGlobal({ archived: true }) returns only archived sessions", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const active = yield* Effect.acquireRelease(session.create({ title: "active-session" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const archived = yield* Effect.acquireRelease(session.create({ title: "archived-session" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      yield* session.setArchived({ sessionID: archived.id, time: Date.now() })

      const archivedList = yield* session.listGlobal({ limit: 200, archived: true })
      const archivedIds = archivedList.map((s) => s.id)

      expect(archivedIds).toContain(archived.id)
      expect(archivedIds).not.toContain(active.id)

      const defaultList = yield* session.listGlobal({ limit: 200 })
      const defaultIds = defaultList.map((s) => s.id)

      expect(defaultIds).toContain(active.id)
      expect(defaultIds).not.toContain(archived.id)
    }),
  )

  // preview mirrors Codex's threads.preview: a snapshot of the FIRST user message, set once so an
  // archived-session list can render a content snippet. It must survive the create→event→projector
  // round-trip (it lives on the SessionV1.SessionInfo event schema) and never be overwritten.
  it.instance("preview is empty on create, set once, and never overwritten by a later message", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "preview-writeonce" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      // Fresh session has no preview.
      expect(created.preview).toBeUndefined()
      expect((yield* session.get(created.id)).preview).toBeUndefined()

      // First user message populates it (round-trips through the event + projector into the column).
      yield* session.setPreview({ sessionID: created.id, preview: "first user message" })
      expect((yield* session.get(created.id)).preview).toBe("first user message")

      // A second (later) message must NOT change it — write-once.
      yield* session.setPreview({ sessionID: created.id, preview: "second user message" })
      expect((yield* session.get(created.id)).preview).toBe("first user message")
    }),
  )

  it.instance("setPreview ignores empty / whitespace-only text (no preview written)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "preview-empty" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      yield* session.setPreview({ sessionID: created.id, preview: "   \n  " })
      expect((yield* session.get(created.id)).preview).toBeUndefined()

      // A subsequent real message still lands, since the empty one was a no-op.
      yield* session.setPreview({ sessionID: created.id, preview: "real content" })
      expect((yield* session.get(created.id)).preview).toBe("real content")
    }),
  )

  // 附-D 阶段3: fork without a directory keeps today's behavior — the fork inherits the source
  // session's (instance) directory and worktree-relative path. This is the backward-compat guard.
  it.instance("fork without a directory inherits the source directory (backward compat)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "fork-default-dir" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(fork.directory).toBe(created.directory)
      expect(fork.path).toBe(created.path)
    }),
  )

  // Fork depth is capped at MAX_FORK_DEPTH levels (root → fork → fork-of-fork). A further fork off a
  // depth-2 session is rejected so lineage can't grow without bound.
  it.instance("rejects a fork beyond the max depth (root → fork → fork, no 4th level)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const root = yield* Effect.acquireRelease(session.create({ title: "depth-root" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const fork1 = yield* Effect.acquireRelease(session.fork({ sessionID: root.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const fork2 = yield* Effect.acquireRelease(session.fork({ sessionID: fork1.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      // root=depth0, fork1=depth1, fork2=depth2 — all allowed. A fork off fork2 would be depth3 → reject.
      const tooDeep = yield* session.fork({ sessionID: fork2.id }).pipe(Effect.exit)
      expect(Exit.isFailure(tooDeep)).toBe(true)
    }),
  )

  // 附-D 阶段3: an explicit directory forks into that directory, and the stored session `path` is
  // re-derived relative to the instance worktree root (not the raw absolute directory).
  it.instance(
    "fork with an explicit directory forks into that directory and re-derives path",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const ctx = yield* InstanceState.context
        const target = path.join(ctx.directory, "packages", "sub")
        const created = yield* Effect.acquireRelease(session.create({ title: "fork-explicit-dir" }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )
        const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id, directory: target }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        expect(fork.directory).toBe(target)
        // path is worktree-relative and never an absolute escape out of the worktree root.
        expect(fork.path).toBe(path.relative(path.resolve(ctx.worktree), target).replaceAll("\\", "/"))
        expect(path.isAbsolute(fork.path ?? "")).toBe(false)
      }),
    { git: true },
  )

  // 附-D 阶段3 (boundary guard): unlike create(), fork's `directory` is reachable from the public
  // HTTP ForkPayload, so an untrusted client could aim the fork's cwd anywhere. A directory that
  // escapes the instance boundary (ctx.directory / worktree root) must be rejected fail-closed
  // rather than silently becoming the session's working directory.
  it.instance(
    "fork rejects a directory that escapes the project boundary",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* Effect.acquireRelease(session.create({ title: "fork-escape" }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )
        // An absolute path well outside the instance directory / worktree root.
        const escape = path.resolve(path.sep, "definitely", "outside", "the", "boundary")
        const exit = yield* session.fork({ sessionID: created.id, directory: escape }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { git: true },
  )
})

// 附-D 阶段4: worktree isolation. Uses a layer that DOES provide Worktree.Service so fork can
// allocate a dedicated checkout. In a git project the fork lands in a distinct worktree directory;
// in a non-git project the WorktreeNotGitError degrades gracefully to a same-directory fork.
describe("Session fork worktree isolation (附-D 阶段4)", () => {
  const itWt = testEffect(
    Layer.mergeAll(
      SessionNs.layer.pipe(
        Layer.provide(Storage.defaultLayer),
        Layer.provide(Database.defaultLayer),
        Layer.provideMerge(EventV2Bridge.defaultLayer),
        Layer.provide(SessionProjector.defaultLayer),
        Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
        Layer.provide(BackgroundJob.defaultLayer),
      ),
      Worktree.defaultLayer,
      FSUtil.defaultLayer,
      Git.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      testInstanceStoreLayer,
    ),
  )
  const gitOnly = process.platform !== "win32" ? itWt.instance : itWt.instance.skip

  gitOnly(
    "fork with isolate:worktree creates a distinct worktree directory",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const ctx = yield* InstanceState.context
        const created = yield* Effect.acquireRelease(session.create({ title: "fork-isolate" }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )
        const fork = yield* Effect.acquireRelease(
          session.fork({ sessionID: created.id, isolate: "worktree" }),
          (info) => session.remove(info.id).pipe(Effect.ignore),
        )

        // Dedicated worktree => a directory distinct from the instance directory. Git worktrees are
        // allocated by Worktree.Service as siblings of the main checkout, so the worktree-relative
        // `path` may legitimately be "../<name>"; the boundary here is owned by Worktree.Service, not
        // by sessionPath. What matters: the fork got its OWN directory and a derived (relative) path.
        expect(fork.directory).not.toBe(ctx.directory)
        expect(fork.directory.length).toBeGreaterThan(0)
        expect(path.isAbsolute(fork.path ?? "")).toBe(false)

        // clean up the created worktree
        const worktree = yield* Worktree.Service
        yield* worktree.remove({ directory: fork.directory }).pipe(Effect.ignore)
      }),
    { git: true },
  )

  itWt.instance("fork with isolate:worktree degrades to same-directory in a non-git project", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const ctx = yield* InstanceState.context
      const created = yield* Effect.acquireRelease(session.create({ title: "fork-isolate-nongit" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const fork = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, isolate: "worktree" }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      // WorktreeNotGitError tolerated => falls back to the instance directory.
      expect(fork.directory).toBe(ctx.directory)
    }),
  )
})

// 附-D fork memory completeness: fork now carries the parent's "memory" — its Session Ledger
// (App-A §C2) plus a persisted OBJECT cutoff marker (ForkOrigin) — not just messages/parts/metadata.
describe("Session fork memory completeness (附-D)", () => {
  const { SessionLedger } = DeepAgentContext
  const { DocumentStore } = DeepAgentDocumentStore

  // Seed a parent session's ledger the same way the compaction path does: construct the run-scoped
  // store at contextStoreRoot(sessionID) and persist entries. Keyed only by sessionID (independent of
  // the session's directory / worktree).
  const seedLedger = (
    sessionID: SessionID,
    texts: { kind: DeepAgentContext.SessionLedger.LedgerEntryKind; text: string }[],
  ) => {
    const store = new DocumentStore(contextStoreRoot(sessionID))
    const ledger = SessionLedger.applyUpdate(SessionLedger.emptyLedger(sessionID), { append: texts })
    SessionLedger.persistLedger(store, ledger)
  }

  it.instance("forwards the parent's Session Ledger into the fork's own ledger store", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "fork-ledger-src" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      seedLedger(created.id, [
        { kind: "goal", text: "ship the feature" },
        { kind: "constraint", text: "keep it backward compatible" },
        { kind: "decision", text: "reuse the DocumentStore" },
      ])

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // The fork opens with the parent's structured facts, re-keyed to its own sessionID and stored
      // under its OWN context store root.
      const forkStore = new DocumentStore(contextStoreRoot(fork.id))
      const forwarded = SessionLedger.loadLedger(forkStore, fork.id)
      expect(forwarded.sessionId).toBe(fork.id)
      expect(forwarded.entries.map((e) => e.text).sort()).toEqual([
        "keep it backward compatible",
        "reuse the DocumentStore",
        "ship the feature",
      ])
      // Parent and fork ledgers are independent stores (fork got its own copy).
      expect(fork.id).not.toBe(created.id)
    }),
  )

  it.instance("persists a readable ForkOrigin cutoff marker recording parent + cutoff message", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "fork-cutoff-src" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // Add two messages so a cutoff at the second carries only the first into the fork.
      const m1 = MessageID.ascending()
      yield* session.updateMessage({
        id: m1,
        sessionID: created.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      const m2 = MessageID.ascending()
      yield* session.updateMessage({
        id: m2,
        sessionID: created.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)

      const fork = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: m2 }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      const origin = loadForkOrigin(fork.id)
      expect(origin).toBeDefined()
      expect(origin?.parentSessionID).toBe(created.id)
      expect(origin?.cutoffMessageID).toBe(m2)
      expect(typeof origin?.forkedAt).toBe("number")
    }),
  )

  it.instance("ForkOrigin marker omits cutoffMessageID for a full fork", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "fork-full" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const origin = loadForkOrigin(fork.id)
      expect(origin?.parentSessionID).toBe(created.id)
      expect(origin?.cutoffMessageID).toBeUndefined()
    }),
  )

  it.instance("fork still succeeds when the parent has no ledger (default-safe, no forwarded memory)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "fork-no-ledger" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      // No ledger seeded for the parent.
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(fork.id).not.toBe(created.id)
      const forkStore = new DocumentStore(contextStoreRoot(fork.id))
      expect(SessionLedger.loadLedger(forkStore, fork.id).entries).toEqual([])
      // The cutoff marker is still written even with no ledger to forward.
      expect(loadForkOrigin(fork.id)?.parentSessionID).toBe(created.id)
    }),
  )

  it.live("forwardLedgerOnFork is default-safe: a copy failure degrades to 0, never throws", () =>
    Effect.gen(function* () {
      // A structurally invalid sessionID that yields a bogus store path still returns 0 rather than
      // failing the effect — proving the matchCauseEffect cause-recovery (DocumentStore construction
      // throws synchronously; catch would miss it).
      const copied = yield* forwardLedgerOnFork({
        parentSessionID: "\0/nonexistent" as unknown as SessionID,
        forkSessionID: "\0/also-bad" as unknown as SessionID,
      })
      expect(copied).toBe(0)
    }),
  )
})
