import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { DeepAgentLearningLifecycleTrigger } from "@deepagent-code/core/deepagent/learning-lifecycle-trigger"
import type { SessionV1 } from "@deepagent-code/core/v1/session"
import { BackgroundJob } from "../../src/background/job"
import { InstanceRef } from "../../src/effect/instance-ref"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"

afterEach(() => DeepAgentLearningLifecycleTrigger.setRuntimeObserver(undefined))

describe("learning lifecycle production callers", () => {
  test("SessionRunState publishes the idle boundary after work settles and before idle status", async () => {
    const events: string[] = []
    DeepAgentLearningLifecycleTrigger.setRuntimeObserver({
      observe: async (input) => {
        events.push(`learning:${input.trigger}`)
        expect(input).toMatchObject({
          trigger: "idle",
          sessionID: "ses-caller",
          match: "session",
        })
        expect(input.boundaryKey).toBe("session-idle:ses-caller")
        return { state: "skipped", reason: "no_exact_settled_run" }
      },
    })
    const sessionID = SessionID.make("ses-caller")
    const result = {
      info: {
        id: "msg-caller",
        sessionID: "ses-caller",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "openai", modelID: "test" },
      },
      parts: [],
    } as unknown as SessionV1.WithParts
    const status = Layer.succeed(
      SessionStatus.Service,
      SessionStatus.Service.of({
        get: () => Effect.succeed({ type: "idle" }),
        list: () => Effect.succeed(new Map()),
        set: (_sessionID, value) => Effect.sync(() => events.push(`status:${value.type}`)),
      }),
    )
    const background = Layer.succeed(
      BackgroundJob.Service,
      BackgroundJob.Service.of({
        list: () => Effect.succeed([]),
      } as unknown as BackgroundJob.Interface),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionRunState.Service
        expect(
          yield* service.ensureRunning(
            sessionID,
            Effect.succeed(result),
            Effect.sync(() => {
              events.push("work:settled")
              return result
            }),
          ),
        ).toBe(result)
      }).pipe(
        Effect.provide(SessionRunState.layer.pipe(Layer.provide(status), Layer.provide(background))),
        Effect.provideService(InstanceRef, {
          directory: "/tmp/learning-lifecycle-caller",
          worktree: "/tmp/learning-lifecycle-caller",
          project: { id: "project-caller" },
        } as never),
        Effect.scoped,
      ),
    )

    expect(events).toEqual(["work:settled", "learning:idle", "status:idle"])
  })
})
