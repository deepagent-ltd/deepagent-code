// BUG-407-008 §7.3 — Provider protocol non-regression tests (items 30–34).
//
// The BUG-407-008 fix is scoped to App/progress projection; it must not touch
// provider-side reasoning handling. These tests pin the deterministic
// input → lowered-provider-request (and response → canonical event) shapes for
// every reasoning replay mode listed in the spec:
//
//   #30 Kimi active continuation: reasoning/tool chain survives lowering verbatim
//   #31 signed reasoning provider: signature/redacted block order unchanged
//   #32 encrypted reasoning provider: encrypted content never removed by UI metadata
//   #33 settled plain reasoning is not re-injected across the terminal boundary
//   #34 raw reasoning + tool results stay fully parseable for DB/export persistence
//
// All assertions are deterministic snapshots: identical inputs must always lower
// to identical wire shapes, before and after the projection fix.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as AnthropicMessages from "../../src/protocols/anthropic-messages"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

// Kimi-style interleaved reasoning provider: OpenAI-compatible chat route.
// `reasoningReplayCapability` maps it to `active-continuation`, i.e. plain
// reasoning is replayed via `reasoning_content` for the active sub-turn.
const kimiModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.moonshot.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "kimi-k2" })

// Signed reasoning provider (Anthropic family): thinking blocks carry a
// signature; redacted blocks round-trip their opaque blob as the signature.
const signedModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

// Encrypted reasoning provider (OpenAI Responses family): stateless turns
// (store: false) replay reasoning via `encrypted_content`.
const encryptedModel = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5.2" })

// The incident's distinguishing shape: revision 8 and revision 9 emitted
// verbatim-identical reasoning followed by different tool calls. Replay of the
// identical text in BOTH sub-turns is legitimate provider history and must not
// be deduplicated or dropped by lowering.
const SHARED_REASONING = [
  "用户在等 w70_stress.py 的四个用户全部打出 FINAL @~950K。",
  "上一轮已确认 user0 / user1 / user3 三个 FINAL，user2 还没出现。",
  "需要再次检查 stress log 尾部并确认 w70_stress 进程仍在运行，",
  "然后再等待 user2 的 FINAL 输出。",
].join("\n")

const REVISION_8_TOOL_OUTPUT = "user1 FINAL @~950K\nuser0 FINAL @~950K\nuser3 FINAL @~950K\n===PROC===\npython -u /data1/fyl/w70_stress.py"
const REVISION_9_TOOL_OUTPUT = "user1 FINAL @~950K\nuser0 FINAL @~950K\nuser3 FINAL @~950K"

const bashTool = ToolDefinition.make({
  name: "bash",
  description: "Run a shell command.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
})

describe("BUG-407-008 §7.3 provider protocol non-regression", () => {
  it.effect("#30 Kimi active continuation keeps the reasoning/tool chain intact in the lowered request", () =>
    Effect.gen(function* () {
      // Deterministic incident-shaped history: two consecutive reasoning-only
      // sub-turns (revision 8 / 9) with verbatim-identical reasoning and
      // different tool calls, followed by their tool results.
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          id: "req_bug407008_kimi_active_continuation",
          model: kimiModel,
          system: "You are a careful operations assistant.",
          messages: [
            Message.user("请你再查询确认一下，是不是四个用户每个用户都有950K的上下文空间。"),
            Message.assistant([
              { type: "reasoning", text: SHARED_REASONING },
              ToolCallPart.make({
                id: "tool_sd47zQa3WQeOSa1BKPhv6mF1",
                name: "bash",
                input: { command: "tail -n 4 stress.log; ps aux | grep w70_stress" },
              }),
            ]),
            Message.tool({
              id: "tool_sd47zQa3WQeOSa1BKPhv6mF1",
              name: "bash",
              result: REVISION_8_TOOL_OUTPUT,
              resultType: "text",
            }),
            Message.assistant([
              { type: "reasoning", text: SHARED_REASONING },
              ToolCallPart.make({
                id: "tool_ZSTCdihDT0jY74tJVeAZLZ45",
                name: "bash",
                input: { command: "tail -n 4 stress.log" },
              }),
            ]),
            Message.tool({
              id: "tool_ZSTCdihDT0jY74tJVeAZLZ45",
              name: "bash",
              result: REVISION_9_TOOL_OUTPUT,
              resultType: "text",
            }),
          ],
          tools: [bashTool],
          cache: "none",
        }),
      )

      // Snapshot of the required reasoning/tool chain: every reasoning payload
      // verbatim, every tool call paired with its result, order preserved.
      expect(prepared.body.messages).toEqual([
        { role: "system", content: "You are a careful operations assistant." },
        { role: "user", content: "请你再查询确认一下，是不是四个用户每个用户都有950K的上下文空间。" },
        {
          role: "assistant",
          content: null,
          reasoning_content: SHARED_REASONING,
          tool_calls: [
            {
              id: "tool_sd47zQa3WQeOSa1BKPhv6mF1",
              type: "function",
              function: {
                name: "bash",
                arguments: '{"command":"tail -n 4 stress.log; ps aux | grep w70_stress"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "tool_sd47zQa3WQeOSa1BKPhv6mF1", content: REVISION_8_TOOL_OUTPUT },
        {
          role: "assistant",
          content: null,
          reasoning_content: SHARED_REASONING,
          tool_calls: [
            {
              id: "tool_ZSTCdihDT0jY74tJVeAZLZ45",
              type: "function",
              function: { name: "bash", arguments: '{"command":"tail -n 4 stress.log"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "tool_ZSTCdihDT0jY74tJVeAZLZ45", content: REVISION_9_TOOL_OUTPUT },
      ])

      // The identical reasoning text must be replayed twice — once per
      // sub-turn. Lowering must never deduplicate cross-turn reasoning.
      const reasoningPayloads = prepared.body.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoning_content)
      expect(reasoningPayloads).toEqual([SHARED_REASONING, SHARED_REASONING])
    }),
  )

  it.effect("#31 signed reasoning provider preserves signature/redacted block order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          id: "req_bug407008_signed_reasoning_order",
          model: signedModel,
          messages: [
            Message.user("Confirm all four users reached 950K."),
            Message.assistant([
              {
                type: "reasoning",
                text: "rev8: check the stress log tail and the w70_stress process",
                providerMetadata: { anthropic: { signature: "sig_rev8" } },
              },
              ToolCallPart.make({
                id: "tool_rev8",
                name: "bash",
                input: { command: "tail -n 4 stress.log" },
              }),
              // Redacted block: opaque provider blob round-trips as the
              // thinking signature with no visible text.
              { type: "reasoning", text: "", encrypted: "redacted_blob_rev8" },
              {
                type: "reasoning",
                text: "rev9: poll the stress log again for user2 FINAL",
                providerMetadata: { anthropic: { signature: "sig_rev9" } },
              },
            ]),
          ],
          cache: "none",
        }),
      )

      // Block order is part of the signed-reasoning contract: lowering must
      // keep signature and redacted blocks exactly where the parts were.
      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Confirm all four users reached 950K." }] },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "rev8: check the stress log tail and the w70_stress process",
              signature: "sig_rev8",
            },
            { type: "tool_use", id: "tool_rev8", name: "bash", input: { command: "tail -n 4 stress.log" } },
            { type: "thinking", thinking: "", signature: "redacted_blob_rev8" },
            { type: "thinking", thinking: "rev9: poll the stress log again for user2 FINAL", signature: "sig_rev9" },
          ],
        },
      ])
    }),
  )

  it.effect("#32 encrypted reasoning content is never removed by App projection metadata", () =>
    Effect.gen(function* () {
      // The same provider chain, once without and once with the App-side
      // computed progress marker attached to the reasoning part. The marker is
      // a UI/API view only — the lowered provider request must be identical.
      const chain = (withAppProjection: boolean) => [
        Message.user("Continue the stress check."),
        Message.assistant([
          {
            type: "reasoning",
            text: "checking stress log tail",
            ...(withAppProjection
              ? {
                  metadata: {
                    deepagent_activity_progress: {
                      activity_id: "a6d06b2a82ef234ab9dc71e3fd940292a21b34f4732f28aa19ba8416c4c5e5a9",
                      revision: 8,
                      state: "progress",
                    },
                  },
                }
              : {}),
            providerMetadata: {
              openai: { itemId: "rs_rev8", reasoningEncryptedContent: "encrypted-rev8" },
            },
          },
          ToolCallPart.make({
            id: "call_rev8",
            name: "bash",
            input: { command: "tail -n 4 stress.log" },
          }),
        ]),
        Message.tool({ id: "call_rev8", name: "bash", result: REVISION_8_TOOL_OUTPUT, resultType: "text" }),
      ]
      const build = (withAppProjection: boolean) =>
        LLM.request({
          id: withAppProjection
            ? "req_bug407008_encrypted_with_projection"
            : "req_bug407008_encrypted_without_projection",
          model: encryptedModel,
          messages: chain(withAppProjection),
          tools: [bashTool],
          cache: "none",
          providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
        })

      const withoutProjection = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(build(false))
      const withProjection = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(build(true))

      // App projection metadata must not change the wire request at all.
      expect(withProjection.body.input).toEqual(withoutProjection.body.input)

      // The encrypted reasoning item survives lowering verbatim, ahead of the
      // tool chain it belongs to.
      expect(withProjection.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Continue the stress check." }] },
        {
          type: "reasoning",
          id: "rs_rev8",
          summary: [{ type: "summary_text", text: "checking stress log tail" }],
          encrypted_content: "encrypted-rev8",
        },
        {
          type: "function_call",
          call_id: "call_rev8",
          name: "bash",
          arguments: '{"command":"tail -n 4 stress.log"}',
        },
        { type: "function_call_output", call_id: "call_rev8", output: REVISION_8_TOOL_OUTPUT },
      ])
    }),
  )

  it.effect("#33 settled plain reasoning is not re-injected across the store:false terminal boundary", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_bug407008_terminal_boundary",
          model: encryptedModel,
          messages: [
            Message.assistant([
              // Audit-only reasoning without any provider state is never
              // replayed into a new provider request.
              { type: "reasoning", text: "audit-only reasoning without provider state" },
              // Settled reasoning item whose encrypted state was not captured:
              // the terminal boundary filter must not re-inject it.
              {
                type: "reasoning",
                text: "settled plain reasoning from revision 8",
                providerMetadata: { openai: { itemId: "rs_rev8_plain" } },
              },
              // Active reasoning item with encrypted state: replay is allowed.
              {
                type: "reasoning",
                text: "active encrypted reasoning from revision 9",
                providerMetadata: {
                  openai: { itemId: "rs_rev9", reasoningEncryptedContent: "encrypted-rev9" },
                },
              },
              ToolCallPart.make({
                id: "call_rev9",
                name: "bash",
                input: { command: "tail -n 4 stress.log" },
              }),
            ]),
            Message.tool({ id: "call_rev9", name: "bash", result: REVISION_9_TOOL_OUTPUT, resultType: "text" }),
          ],
          tools: [bashTool],
          cache: "none",
          providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
        }),
      )

      // The boundary keeps exactly the encrypted reasoning item plus the intact
      // tool chain; nothing plain or stateless sneaks back into the request.
      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          id: "rs_rev9",
          summary: [{ type: "summary_text", text: "active encrypted reasoning from revision 9" }],
          encrypted_content: "encrypted-rev9",
        },
        {
          type: "function_call",
          call_id: "call_rev9",
          name: "bash",
          arguments: '{"command":"tail -n 4 stress.log"}',
        },
        { type: "function_call_output", call_id: "call_rev9", output: REVISION_9_TOOL_OUTPUT },
      ])

      const reasoningItems = prepared.body.input.filter(
        (item) => "type" in item && item.type === "reasoning",
      )
      expect(reasoningItems).toHaveLength(1)
      expect(prepared.body.input.some((item) => "id" in item && item.id === "rs_rev8_plain")).toBe(false)
    }),
  )

  it.effect("#34 parser keeps full raw reasoning text and tool results for DB/export persistence", () =>
    Effect.gen(function* () {
      // One deterministic stream per provider sub-turn (revision 8 / 9), both
      // carrying the verbatim-identical reasoning and their own tool call.
      // This is the llm-side half of the invariant: every raw provider token
      // must reach canonical events untouched so persistence/export can store
      // it. (Actual DB/export reads live in packages/deepagent-code.)
      const revisionStream = (input: { itemID: string; callID: string; command: string }) => {
        const args = JSON.stringify({ command: input.command })
        return sseEvents(
          { type: "response.output_item.added", item: { type: "reasoning", id: input.itemID, encrypted_content: null } },
          { type: "response.reasoning_summary_part.added", item_id: input.itemID, summary_index: 0 },
          { type: "response.reasoning_summary_text.delta", item_id: input.itemID, summary_index: 0, delta: SHARED_REASONING },
          { type: "response.reasoning_summary_part.done", item_id: input.itemID, summary_index: 0 },
          {
            type: "response.output_item.done",
            item: { type: "reasoning", id: input.itemID, encrypted_content: `enc_${input.itemID}` },
          },
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: `fc_${input.callID}`, call_id: input.callID, name: "bash", arguments: "" },
          },
          { type: "response.function_call_arguments.delta", item_id: `fc_${input.callID}`, delta: args },
          { type: "response.function_call_arguments.done", item_id: `fc_${input.callID}`, arguments: args },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: `fc_${input.callID}`,
              call_id: input.callID,
              name: "bash",
              arguments: args,
            },
          },
          {
            type: "response.completed",
            response: { id: `resp_${input.itemID}`, usage: { input_tokens: 10, output_tokens: 5 } },
          },
        )
      }
      const turnRequest = (id: string) =>
        LLM.request({
          id,
          model: encryptedModel,
          prompt: "Continue the stress check.",
          tools: [bashTool],
          providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
        })

      const revision8 = yield* LLMClient.generate(turnRequest("req_bug407008_raw_rev8")).pipe(
        Effect.provide(
          fixedResponse(revisionStream({ itemID: "rs_rev8", callID: "call_rev8", command: "tail stress.log; ps aux" })),
        ),
      )
      const revision9 = yield* LLMClient.generate(turnRequest("req_bug407008_raw_rev9")).pipe(
        Effect.provide(
          fixedResponse(revisionStream({ itemID: "rs_rev9", callID: "call_rev9", command: "tail stress.log" })),
        ),
      )

      // Full raw reasoning text survives parsing in BOTH revisions — identical
      // content is not merged, truncated, or dropped on the parse side.
      expect(revision8.reasoning).toBe(SHARED_REASONING)
      expect(revision9.reasoning).toBe(SHARED_REASONING)

      // Replay state (encrypted content + item id) needed for later turns is
      // attached to the reasoning events of each revision.
      expect(revision8.events).toContainEqual(
        expect.objectContaining({
          type: "reasoning-end",
          id: "rs_rev8:0",
          providerMetadata: { openai: { itemId: "rs_rev8", reasoningEncryptedContent: "enc_rs_rev8" } },
        }),
      )
      expect(revision9.events).toContainEqual(
        expect.objectContaining({
          type: "reasoning-end",
          id: "rs_rev9:0",
          providerMetadata: { openai: { itemId: "rs_rev9", reasoningEncryptedContent: "enc_rs_rev9" } },
        }),
      )

      // Raw tool inputs stay complete and distinct per revision.
      const toolCall8 = revision8.events.find((event) => event.type === "tool-call")
      const toolCall9 = revision9.events.find((event) => event.type === "tool-call")
      expect(toolCall8).toMatchObject({
        type: "tool-call",
        id: "call_rev8",
        name: "bash",
        input: { command: "tail stress.log; ps aux" },
      })
      expect(toolCall9).toMatchObject({
        type: "tool-call",
        id: "call_rev9",
        name: "bash",
        input: { command: "tail stress.log" },
      })
    }),
  )
})
