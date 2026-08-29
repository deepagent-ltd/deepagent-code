import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Effect, Layer, Duration } from "effect"
import { EventV2Bridge } from "../src/event-v2-bridge"
import { GlobalBus } from "../src/bus/global"
import { EventV2 } from "@deepagent-code/core/event"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { Schema } from "effect"

// C5-12 — the flag-gated legacy double-write removal on the EventV2 → GlobalBus mirror. When the V2
// admission path is ON (`isEventV2AdmissionEnabled`), the GlobalBus mirror + sync emission are SKIPPED
// (the V2 admission consumer is the single writer); when OFF the existing mirror is unchanged.

const MirrorEvent = EventV2.define({
  type: "test.mirror.event",
  schema: { value: Schema.String },
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
})
