import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Duration } from "effect"
import { EventV2Bridge } from "../src/event-v2-bridge"
import { V2OutboxWriter } from "../src/event/v2-outbox-writer"
import { GlobalBus } from "../src/bus/global"
import type { GlobalEvent } from "../src/bus/global"
import { EventV2 } from "@deepagent-code/core/event"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Location } from "@deepagent-code/core/location"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { DateTime, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventOutbox } from "@deepagent-code/core/deepagent/event-outbox"
import { EventConsumer } from "@deepagent-code/core/deepagent/event-consumer"
import { TuiEvent } from "../src/server/tui-event"
import { SessionID } from "../src/session/schema"
import { createRuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"

// Registered C5 events retain one durable writer. Unregistered UI events must
// still reach the legacy egress while admission is ON.

const MirrorEvent = EventV2.define({
  type: "test.mirror.event",
  schema: { value: Schema.String },
})

const VersionedAggregateV1 = EventV2.define({
  type: "test.versioned.aggregate",
  sync: { aggregate: "legacyID", version: 1 },
  schema: { legacyID: Schema.String },
})

EventV2.define({
  type: "test.versioned.aggregate",
  sync: { aggregate: "nativeID", version: 2 },
  schema: { nativeID: Schema.String },
})

const admissionOn = createRuntimeFeatureRegistry(undefined, {
  [EventAdmission.EVENT_V2_ADMISSION_ENV]: "true",
})
const admissionOff = createRuntimeFeatureRegistry(undefined, {
  [EventAdmission.EVENT_V2_ADMISSION_ENV]: "false",
})

/** Build the bridge (EventV2.defaultLayer provides its own Database), publish one mirrored event, and
 * return how many GlobalBus "event" emits the listener produced. */
const mirrorCount = (runtimeFeatures = admissionOff) =>
  Effect.gen(function* () {
    const ctx = yield* Layer.build(EventV2Bridge.defaultLayerWithRuntimeFeatures(runtimeFeatures))
    const bridge = Context.get(ctx, EventV2Bridge.Service)
    let emits = 0
    const listener = () => {
      emits++
    }
    GlobalBus.on("event", listener)
    try {
      yield* bridge.publish(MirrorEvent, { value: "v1" })
      yield* Effect.sleep(Duration.millis(30))
      return emits
    } finally {
      GlobalBus.off("event", listener)
    }
  }).pipe(Effect.scoped)

describe("C5-12 event-v2-bridge flag-gated GlobalBus mirror removal", () => {
  test("C5 registrations fail at graph construction when the EventV2 type has no durable sync definition", () => {
    expect(() => EventV2Bridge.assertSynchronizedOutboxRegistry(V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY)).not.toThrow()
    expect(() =>
      EventV2Bridge.layerWithRegistry(
        V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY.register({
          ...V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY.lookup("session.created")!,
          eventType: MirrorEvent.type,
        }),
      ),
    ).toThrow("C5 outbox registrations require synchronized EventV2 definitions: test.mirror.event")
  })

  test("flag OFF: the GlobalBus mirror emits the event (current runtime authoritative)", async () => {
    const count = await Effect.runPromise(mirrorCount(admissionOff))
    expect(count).toBeGreaterThan(0)
  })

  test("flag ON: an unregistered ephemeral event retains exactly one legacy egress", async () => {
    const count = await Effect.runPromise(mirrorCount(admissionOn))
    expect(count).toBe(1)
  })

  test("native session.created.2 remains V2 durable authority but exposes the legacy client shape", () => {
    const sessionID = SessionSchema.ID.make("ses_event_v2_bridge_created")
    const compatible = EventV2Bridge.compatibilityEvent({
      id: EventV2.ID.make("evt_event_v2_bridge_created"),
      type: SessionEvent.Created.type,
      version: 2,
      data: {
        sessionID,
        info: new SessionSchema.Info({
          id: sessionID,
          projectID: ProjectV2.ID.global,
          permissions: [{ action: "bash", resource: "*", effect: "deny" }],
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
          title: "Native V2",
          location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
        }),
        slug: "native-v2",
        version: "2.0.0-beta.0",
      },
    })

    expect(compatible).toMatchObject({
      type: "session.created",
      version: 2,
      data: {
        sessionID,
        info: {
          id: sessionID,
          slug: "native-v2",
          version: "2.0.0-beta.0",
          directory: "/project",
          title: "Native V2",
          permission: [{ permission: "bash", pattern: "*", action: "deny" }],
          time: { created: 1, updated: 2 },
        },
      },
    })
  })

  test("native session.deleted.2 uses the third compatibility egress pair", () => {
    const sessionID = SessionSchema.ID.make("ses_event_v2_bridge_deleted")
    const compatible = EventV2Bridge.compatibilityEvent({
      id: EventV2.ID.make("evt_event_v2_bridge_deleted"),
      type: SessionEvent.Deleted.type,
      version: 2,
      data: {
        sessionID,
        info: new SessionSchema.Info({
          id: sessionID,
          projectID: ProjectV2.ID.global,
          permissions: [],
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
          title: "Deleted V2",
          location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
        }),
        slug: "deleted-v2",
        version: "2.0.0-beta.0",
      },
    })

    expect(compatible).toMatchObject({
      type: "session.deleted",
      version: 2,
      data: { sessionID, info: { id: sessionID, slug: "deleted-v2", title: "Deleted V2" } },
    })
    expect(EventV2Bridge.compatibilityEgressDefinition(SessionEvent.Deleted.type)).toBe(
      SessionV1.Event.Deleted,
    )
  })

  test("native session.diff.2 keeps the independent diff model on the legacy egress", () => {
    const sessionID = SessionSchema.ID.make("ses_event_v2_bridge_diff")
    const compatible = EventV2Bridge.compatibilityEvent({
      id: EventV2.ID.make("evt_event_v2_bridge_diff"),
      type: SessionEvent.DiffUpdated.type,
      version: 2,
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        summary: {
          additions: 2,
          deletions: 1,
          files: 1,
          diffManifest: {
            completeness: "complete",
            truncationReasons: [],
            manifestHash: "sha256:diff",
            totalFiles: 1,
            totalFilesExact: true,
            includedFiles: 1,
            truncatedFiles: 0,
          },
        },
        diff: [{ file: "a.ts", additions: 2, deletions: 1, status: "modified" }],
      },
    })

    expect(compatible).toMatchObject({
      type: "session.diff",
      version: 2,
      data: {
        sessionID,
        diff: [{ file: "a.ts", additions: 2, deletions: 1, status: "modified" }],
        manifest: { totalFiles: 1 },
      },
    })
    expect(EventV2Bridge.compatibilityEgressDefinition(SessionEvent.DiffUpdated.type)).toBe(
      SessionV1.Event.Diff,
    )
  })

  test("native session.revert.1 egresses a complete legacy session.updated payload", () => {
    const sessionID = SessionSchema.ID.make("ses_event_v2_bridge_revert")
    const compatible = EventV2Bridge.compatibilityEvent({
      id: EventV2.ID.make("evt_event_v2_bridge_revert"),
      type: SessionEvent.RevertChanged.type,
      version: 1,
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        info: new SessionSchema.Info({
          id: sessionID,
          projectID: ProjectV2.ID.global,
          permissions: [],
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
          title: "Reverted V2",
          location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
        }),
        slug: "reverted-v2",
        version: "2.0.0-beta.0",
        mutationEpoch: 1,
        revert: { messageID: "msg_revert_target" },
        summary: { additions: 1, deletions: 0, files: 1 },
      },
    })

    expect(compatible).toMatchObject({
      type: "session.updated",
      version: 1,
      data: {
        sessionID,
        info: {
          id: sessionID,
          slug: "reverted-v2",
          title: "Reverted V2",
          revert: { messageID: "msg_revert_target" },
          summary: { additions: 1, files: 1 },
        },
      },
    })
    expect(EventV2Bridge.compatibilityEgressDefinition(SessionEvent.RevertChanged.type)).toBe(
      SessionV1.Event.Updated,
    )
  })

  test("sync mirror resolves the aggregate field from the exact event version", async () => {
    const aggregates = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(EventV2Bridge.defaultLayerWithRuntimeFeatures(admissionOff))
        const bridge = Context.get(ctx, EventV2Bridge.Service)
        const seen: string[] = []
        const listener = (event: GlobalEvent) => {
          if (event.payload.type === "sync") seen.push(event.payload.syncEvent.aggregateID)
        }
        GlobalBus.on("event", listener)
        try {
          yield* bridge.publish(VersionedAggregateV1, { legacyID: "legacy-aggregate" })
          yield* Effect.sleep(Duration.millis(30))
          return seen
        } finally {
          GlobalBus.off("event", listener)
        }
      }).pipe(Effect.scoped),
    )

    expect(aggregates).toContain("legacy-aggregate")
  })
})


test("actual TUI ephemeral events egress once with zero outbox; registered sync remains single durable delivery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-bridge-egress-"))
  const Registered = EventV2.define({ type: "test.bridge.registered", sync: { version: 1, aggregate: "sessionID" }, schema: { sessionID: Schema.String } })
  const registry = V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY.register({ ...V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY.lookup("session.created")!, eventType: Registered.type })
  const seen: GlobalEvent[] = []
  const listen = (event: GlobalEvent) => { seen.push(event) }
  GlobalBus.on("event", listen)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const context = yield* Layer.build(EventV2Bridge.layerWithRegistry(registry, admissionOn).pipe(
        Layer.provideMerge(EventV2.layer), Layer.provideMerge(Database.layerFromPath(path.join(directory, "events.db")))))
      const bridge = Context.get(context, EventV2Bridge.Service)
      const db = Context.get(context, Database.Service).db
      yield* bridge.publish(TuiEvent.PromptAppend, { text: "safe UI text" })
      yield* bridge.publish(TuiEvent.CommandExecute, { command: "session.plan" })
      yield* bridge.publish(TuiEvent.ToastShow, { message: "safe toast", variant: "info", duration: 1000 })
      yield* bridge.publish(TuiEvent.SessionSelect, { sessionID: SessionID.make("ses_ui_egress") })
      yield* Effect.sleep(Duration.millis(20))
      expect(seen.map((item) => item.payload.type).filter((type) => type.startsWith("tui."))).toEqual([
        "tui.prompt.append", "tui.command.execute", "tui.toast.show", "tui.session.select"])
      expect(yield* db.all(sql`SELECT outbox_id FROM deepagent_event_outbox`)).toHaveLength(0)
      yield* bridge.publish(VersionedAggregateV1, { legacyID: "unregistered-sync" })
      yield* Effect.sleep(Duration.millis(20))
      expect(seen.filter((item) => item.payload.type === VersionedAggregateV1.type)).toHaveLength(1)
      expect(seen.filter((item) => item.payload.type === "sync" && item.payload.syncEvent.aggregateID === "unregistered-sync")).toHaveLength(1)
      expect(yield* db.all(sql`SELECT outbox_id FROM deepagent_event_outbox`)).toHaveLength(0)
      const now = Date.now()
      yield* EventConsumer.register(db, { consumerKey: "bridge-observer", deliveryContractVersion: "1", now })
      const event = yield* bridge.publish(Registered, { sessionID: "ses_registered_egress" })
      yield* Effect.sleep(Duration.millis(20))
      expect(seen.filter((item) => item.payload.type === Registered.type)).toHaveLength(0)
      expect(seen.filter((item) => item.payload.type === "sync" && item.payload.syncEvent.aggregateID === "ses_registered_egress")).toHaveLength(0)
      const row = yield* V2OutboxWriter.forEvent(db, event.id)
      expect(row).toBeDefined()
      if (!row) throw new Error("Missing durable outbox")
      let dispatched = 0
      const publish = () => EventOutbox.publish(db, { now: Date.now(), claimantId: "bridge-publisher", leaseMs: 10000, batchSize: 10, maxAttempts: 1,
        dispatch: () => Effect.sync(() => { dispatched++ }) })
      yield* publish()
      yield* publish()
      expect(dispatched).toBe(1)
      yield* EventConsumer.schedule(db, { outboxId: row.outboxId, consumerKey: "bridge-observer", now: Date.now() })
      const claim = { consumerKey: "bridge-observer", claimantId: "actual-consumer", now: Date.now(), leaseMs: 10000, limit: 10 }
      const delivery = yield* EventConsumer.claimDue(db, claim)
      expect(delivery.deliveries).toHaveLength(1)
      expect(yield* EventConsumer.commitResult(db, { outboxId: row.outboxId, consumerKey: claim.consumerKey, claimToken: delivery.claimToken, now: Date.now() })).toBe(true)
      expect((yield* EventConsumer.claimDue(db, claim)).deliveries).toHaveLength(0)
      expect(yield* db.all(sql`SELECT outbox_id FROM deepagent_event_outbox`)).toHaveLength(1)
    }).pipe(Effect.scoped))
  } finally { GlobalBus.off("event", listen); await fs.rm(directory, { recursive: true, force: true }) }
})
