import { describe, expect } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer, Schema, Stream } from "effect"
import { LLM, Model } from "@deepagent-code/llm"
import { AgentGateway } from "../../src/agent-gateway"
import { Endpoint, LLMClient, Protocol, Route, type FramingDef } from "@deepagent-code/llm/route"
import { testEffect } from "../lib/effect"
import { dynamicResponse } from "../lib/llm-http"
import { tmpRootAsync, tmpRootSharedAsync } from "../fixture/tmpdir"

type FakeBody = {
  readonly body: string
}

const FakeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("finish"), reason: Schema.Literal("stop") }),
])
type FakeEvent = Schema.Schema.Type<typeof FakeEvent>
const decodeFakeEvents = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(FakeEvent)))

const fakeFraming: FramingDef<FakeEvent> = {
  id: "fake-json-array",
  frame: (bytes) =>
    Stream.fromEffect(
      bytes.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, event) => text + event,
        ),
        Effect.flatMap(decodeFakeEvents),
        Effect.orDie,
      ),
    ).pipe(Stream.flatMap(Stream.fromIterable)),
}

const fakeProtocol = Protocol.make<FakeBody, FakeEvent, FakeEvent, void>({
  id: "fake-deepagent",
  body: {
    schema: Schema.Struct({ body: Schema.String }),
    from: (request) =>
      Effect.succeed({
        body: request.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      }),
  },
  stream: {
    event: FakeEvent,
    initial: () => undefined,
    step: (state, event) =>
      Effect.succeed([
        state,
        event.type === "finish"
          ? [{ type: "finish", reason: event.reason }]
          : [{ type: "text-delta", id: "text-0", text: event.text }],
      ] as const),
  },
})

const fakeRoute = Route.make({
  id: "fake-deepagent",
  protocol: fakeProtocol,
  endpoint: Endpoint.path("/chat", { baseURL: "https://fake.local" }),
  framing: fakeFraming,
})

const echoLayer = dynamicResponse(({ text, respond }) =>
  Effect.succeed(
    respond(
      JSON.stringify([
        { type: "text", text: `echo:${text}` },
        { type: "finish", reason: "stop" },
      ]),
    ),
  ),
)

const it = testEffect(echoLayer)

describe("DeepAgent LLMClient wrapper", () => {
  it.effect("wraps all provider requests through the global runtime", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpRootSharedAsync())
      try {
        // The process-global registry is gone: client wrapping now requires the explicit
        // middleware service. AgentGateway.layer is the legacy compatibility layer that keeps
        // following the mutable configure() state (unlike the immutable V2 runtimeLayer).
        const events = yield* Effect.gen(function* () {
          const llm = yield* LLMClient.Service
          return Array.from(
            yield* llm
              .stream(
                LLM.request({
                  id: "req_deepagent",
                  model: Model.make({ id: "gpt-test", provider: "openai", route: fakeRoute }),
                  prompt: "hello",
                  metadata: {
                    "deepagent-code": {
                      callKind: "session_turn",
                      feature: "session_chat",
                      sessionID: "ses_deepagent",
                      messageID: "msg_deepagent",
                    },
                  },
                }),
              )
              .pipe(Stream.runCollect),
          )
        }).pipe(
          Effect.provide(
            Layer.fresh(LLMClient.managedLayer).pipe(
              Layer.provide(AgentGateway.layer({ enabled: true, runsDir: dir })),
            ),
          ),
        )
        expect(events.map((event) => event.type)).toEqual(["text-delta", "finish"])
        const runs = yield* Effect.promise(() => readdir(dir))
        expect(runs).toHaveLength(1)
      } finally {
        AgentGateway.configure({ enabled: false, runsDir: undefined })
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.effect("keeps durable-learning authority inside each V2 runtime", () =>
    Effect.gen(function* () {
      const left = yield* Effect.promise(() => tmpRootSharedAsync())
      const right = yield* Effect.promise(() => tmpRootSharedAsync())
      const recorded: string[] = []
      const releasePoison = AgentGateway.setLearningAuthority({
        record: async () => {
          throw new Error("process-global learning authority must not receive a V2 run")
        },
        enqueue: async () => {
          throw new Error("process-global learning authority must not receive a V2 run")
        },
      })
      try {
        const run = (label: string, baseDir: string) =>
          Effect.gen(function* () {
            const llm = yield* LLMClient.Service
            yield* llm
              .stream(
                LLM.request({
                  id: `req_${label}`,
                  model: Model.make({ id: "gpt-test", provider: "openai", route: fakeRoute }),
                  prompt: "hello",
                  metadata: {
                    "deepagent-code": {
                      callKind: "session_turn",
                      feature: "session_chat",
                      sessionID: `ses_${label}`,
                      messageID: `msg_${label}`,
                    },
                  },
                }),
              )
              .pipe(Stream.runDrain)
          }).pipe(
            Effect.provide(
              Layer.fresh(LLMClient.managedLayer).pipe(
                Layer.provide(
                  AgentGateway.runtimeLayer(
                    { enabled: true, agentMode: "high", baseDir, runsDir: path.join(baseDir, "runs") },
                    {
                      learningAuthority: {
                        record: async (admission) => {
                          recorded.push(`${label}:${admission.input.sessionID}`)
                        },
                        enqueue: async () => undefined,
                      },
                    },
                  ),
                ),
              ),
            ),
          )

        yield* Effect.all([run("left", left), run("right", right)], { concurrency: "unbounded" })
        expect(recorded.toSorted()).toEqual(["left:ses_left", "right:ses_right"])
      } finally {
        releasePoison()
        yield* Effect.promise(() => Promise.all([left, right].map((dir) => rm(dir, { recursive: true, force: true }))))
      }
    }),
  )
})
