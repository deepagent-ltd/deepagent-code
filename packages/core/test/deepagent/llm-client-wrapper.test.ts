import { describe, expect } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Schema, Stream } from "effect"
import { LLM, Model } from "@deepagent-code/llm"
import { AgentGateway } from "../../src/agent-gateway"
import { Endpoint, LLMClient, Protocol, Route, type FramingDef } from "@deepagent-code/llm/route"
import { testEffect } from "../lib/effect"
import { dynamicResponse } from "../lib/llm-http"

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
  Effect.succeed(respond(JSON.stringify([{ type: "text", text: `echo:${text}` }, { type: "finish", reason: "stop" }]))),
)

const it = testEffect(echoLayer)

describe("DeepAgent LLMClient wrapper", () => {
  it.effect("wraps all provider requests through the global runtime", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "deepagent-client-")))
      try {
        AgentGateway.configure({ enabled: true, runsDir: dir })
        const llm = yield* LLMClient.Service
        const request = LLM.request({
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
        })

        const events = Array.from(yield* llm.stream(request).pipe(Stream.runCollect))
        expect(events.map((event) => event.type)).toEqual(["text-delta", "finish"])
        const runs = yield* Effect.promise(() => readdir(dir))
        expect(runs).toHaveLength(1)
      } finally {
        AgentGateway.configure({ enabled: false, runsDir: undefined })
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }))
      }
    }),
  )
})
