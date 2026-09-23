import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionV2 } from "@deepagent-code/core/session"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { createLLMEventPublisher } from "@deepagent-code/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const capture = () => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.sync ? EventV2.versionedType(definition.type, definition.sync.version) : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    aggregateEvents: () => Stream.empty,
    sync: () => Effect.succeed(Effect.void),
    listen: () => Effect.succeed(Effect.void),
    beforeCommit: () => Effect.void,
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    snapshot: () => Effect.succeed(undefined),
    checkpoint: () => Effect.die("unused"),
    importSnapshot: () => Effect.die("unused"),
    compact: () => Effect.die("unused"),
    canonicalizeLegacyArtifacts: () => Effect.succeed({ processed: 0 }),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
      },
    }),
  }
}

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "media", mediaType: "image/png", data: base64, filename: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", source: { type: "data", data: base64 }, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", source: { type: "data", data: base64 }, mime: "image/png" },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("a settlement failureCode classifies the durable tool failure error", async () => {
  const wording =
    "The user rejected permission to use this specific tool call with the following feedback: use write instead"
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ id: "call-refused", name: "edit", input: {} })))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: "call-refused",
        name: "edit",
        result: { type: "error", value: wording, metadata: { failureCode: "user_corrected_permission" } },
      }),
    ),
  )

  const failed = published.find((event) => event.type === "session.next.tool.failed.1")
  expect(failed?.data).toMatchObject({
    error: { type: "permission_corrected", message: wording },
    result: { type: "error", value: wording, metadata: { failureCode: "user_corrected_permission" } },
  })
})

test("each refusal failureCode maps to its durable error type", async () => {
  const cases = [
    ["user_rejected_permission", "permission_rejected"],
    ["user_corrected_permission", "permission_corrected"],
    ["permission_denied_rule", "permission_denied"],
  ] as const
  for (const [failureCode, type] of cases) {
    const { published, publisher } = capture()
    await Effect.runPromise(
      publisher.publish(LLMEvent.toolCall({ id: `call-${failureCode}`, name: "bash", input: {} })),
    )
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.toolResult({
          id: `call-${failureCode}`,
          name: "bash",
          result: { type: "error", value: "refused", metadata: { failureCode } },
        }),
      ),
    )
    const failed = published.find((event) => event.type === "session.next.tool.failed.1")
    expect(failed?.data).toMatchObject({ error: { type, message: "refused" } })
  }
})

test("an unclassified settlement failure keeps the unknown error type", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ id: "call-plain", name: "read", input: {} })))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: "call-plain",
        name: "read",
        result: { type: "error", value: "plain failure", metadata: { unrelated: true } },
      }),
    ),
  )
  const failed = published.find((event) => event.type === "session.next.tool.failed.1")
  expect(failed?.data).toMatchObject({ error: { type: "unknown", message: "plain failure" } })
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", source: { type: "data", data: base64 }, mime: "image/png" }],
    result: { type: "content", value: [{ type: "media", mediaType: "image/png", data: base64 }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})
