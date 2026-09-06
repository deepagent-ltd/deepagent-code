import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Effect, Layer, Duration } from "effect"
import { EventV2Bridge } from "../src/event-v2-bridge"
import { GlobalBus } from "../src/bus/global"
import type { GlobalEvent } from "../src/bus/global"
import { EventV2 } from "@deepagent-code/core/event"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { Location } from "@deepagent-code/core/location"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { DateTime, Schema } from "effect"

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

const saved = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]

/** Build the bridge (EventV2.defaultLayer provides its own Database), publish one mirrored event, and
 * return how many GlobalBus "event" emits the listener produced. */
const mirrorCount = () =>
  Effect.gen(function* () {
    const ctx = yield* Layer.build(EventV2Bridge.defaultLayer)
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
  beforeAll(() => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "false"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
    else process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = saved
  })

  test("flag OFF: the GlobalBus mirror emits the event (current runtime authoritative)", async () => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "false"
    const count = await Effect.runPromise(mirrorCount())
    expect(count).toBeGreaterThan(0)
  })

  test("flag ON: the GlobalBus mirror is SKIPPED (emit counter 0 — single writer)", async () => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
    const count = await Effect.runPromise(mirrorCount())
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

  test("sync mirror resolves the aggregate field from the exact event version", async () => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "false"
    const aggregates = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(EventV2Bridge.defaultLayer)
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
