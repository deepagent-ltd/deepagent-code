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
import { createRuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"

// C5-12 — the flag-gated legacy double-write removal on the EventV2 → GlobalBus mirror. When the V2
// admission path is ON (`isEventV2AdmissionEnabled`), the GlobalBus mirror + sync emission are SKIPPED
// (the V2 admission consumer is the single writer); when OFF the existing mirror is unchanged.

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

  test("flag ON: the GlobalBus mirror is SKIPPED (emit counter 0 — single writer)", async () => {
    const count = await Effect.runPromise(mirrorCount(admissionOn))
    expect(count).toBe(0)
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
