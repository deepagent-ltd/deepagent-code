import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { LLM } from "@deepagent-code/llm"
import { OpenAIResponses } from "@deepagent-code/llm/protocols/openai-responses"
import { OpenAIChat } from "@deepagent-code/llm/protocols/openai-chat"
import { RemoteCompaction } from "../src/session/remote-compaction"
import { RemoteCompactionBinding } from "../src/session/remote-compaction-binding"
import { SessionMessage } from "../src/session/message"
import { toLLMMessages } from "../src/session/runner/to-llm-message"
import { Hash } from "../src/util/hash"
import { CanonicalJson } from "../src/util/canonical-json"

const model = OpenAIResponses.route.model({ id: "gpt-5.4" })
const window = {
  ...RemoteCompactionBinding.identity(model),
  output: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
    { type: "compaction", id: "cmp-1", encrypted_content: "opaque-not-summary" },
  ],
}
const checkpoint = () =>
  new SessionMessage.Compaction({
    id: SessionMessage.ID.create(),
    type: "compaction",
    reason: "auto",
    summary: "provider context",
    recent: "",
    remote: window,
    time: { created: DateTime.nowUnsafe() },
  })

describe("native remote compaction checkpoint", () => {
  test("only declared canonical endpoint adapters attempt a paid remote call", () => {
    expect(RemoteCompaction.supported(LLM.request({ model, prompt: "x" }))).toBe(true)
    expect(
      RemoteCompaction.supported(
        LLM.request({
          model: OpenAIResponses.route.with({ endpoint: { baseURL: "https://proxy.test/v1" } }).model({ id: model.id }),
          prompt: "x",
        }),
      ),
    ).toBe(false)
    for (const baseURL of [
      "https://api.openai.com/custom",
      "https://api.openai.com/v1/nested",
      "https://api.openai.com:8443/v1",
      "https://api.openai.com/v1?region=other",
      "https://api.openai.com/v1#custom",
    ])
      expect(
        RemoteCompaction.supported(
          LLM.request({
            model: OpenAIResponses.route.with({ endpoint: { baseURL } }).model({ id: model.id }),
            prompt: "x",
          }),
        ),
      ).toBe(false)
    expect(
      RemoteCompaction.supported(LLM.request({ model: OpenAIChat.route.model({ id: "gpt-5.4" }), prompt: "x" })),
    ).toBe(false)
  })

  test("durable checkpoint schema preserves full returned item fields", () => {
    const restored = Schema.decodeUnknownSync(Schema.fromJsonString(SessionMessage.Compaction))(
      Schema.encodeSync(Schema.fromJsonString(SessionMessage.Compaction))(checkpoint()),
    )
    expect(restored.remote).toEqual(window)
    const messages = toLLMMessages([restored], model)
    expect(messages).toHaveLength(1)
    expect(messages[0].metadata?.responsesCompactedWindow).toEqual(window.output)
    expect(messages[0].content).toEqual([])
  })

  test("provider/model/route/endpoint changes fail closed rather than replay opaque state", () => {
    for (const target of [
      OpenAIResponses.route.model({ id: "other-model" }),
      OpenAIResponses.route.with({ provider: "proxy" }).model({ id: model.id }),
      OpenAIResponses.route.with({ endpoint: { baseURL: "https://proxy.test/v1" } }).model({ id: model.id }),
      OpenAIChat.route.model({ id: model.id }),
    ])
      expect(() => toLLMMessages([checkpoint()], target)).toThrow("Remote compacted context belongs")
  })

  test("settled receipt recovers the whole window without a second provider dispatch", () => {
    const artifact = [{ kind: "remote_window" as const, window }]
    const receipt = {
      state: "settled",
      outcome_hash: Hash.sha256(CanonicalJson.stringify(artifact)),
      outcome_artifact: artifact,
    }
    expect(RemoteCompaction.replay(receipt)).toEqual(artifact[0])
    expect(RemoteCompaction.replay({ ...receipt, outcome_hash: "corrupt" }).kind).toBe("recovery_required")
    for (const state of ["preparing", "dispatching", "streaming", "indeterminate_after_crash", "failed"])
      expect(RemoteCompaction.replay({ ...receipt, state }).kind).toBe("recovery_required")
  })
})
