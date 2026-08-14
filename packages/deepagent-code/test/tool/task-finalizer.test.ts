import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Effect } from "effect"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import {
  runDurableStructuredFinalizer,
  runSubagentPrompt,
  type StructuredOutputReceipt,
  type SubagentPromptInput,
  type TaskPromptOps,
} from "@/tool/task"

const model = {
  modelID: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test-provider"),
}
const sessionID = SessionID.make("ses_task_finalizer")
const schema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
}

function response(
  input: SessionPrompt.PromptInput,
  options: { text?: string; structured?: unknown; error?: SessionV1.Assistant["error"] },
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      role: "assistant",
      mode: input.agent ?? "researcher",
      agent: input.agent ?? "researcher",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? model.modelID,
      providerID: input.model?.providerID ?? model.providerID,
      time: { created: Date.now() },
      finish: "stop",
      ...(options.structured === undefined ? {} : { structured: options.structured }),
      ...(options.error ? { error: options.error } : {}),
    },
    parts: options.text
      ? [
          {
            id: PartID.ascending(),
            messageID: id,
            sessionID: input.sessionID,
            type: "text",
            text: options.text,
          },
        ]
      : [],
  }
}

function input(ops: TaskPromptOps, outputSchema: Record<string, unknown> | undefined = schema): SubagentPromptInput {
  return {
    ops,
    prompt: "research the subsystem",
    sessionID,
    model,
    variant: "xhigh",
    agent: "researcher",
    agentModeOverride: undefined,
    outputSchema,
    allowTextFallback: true,
    tools: { task: false },
    worktreeInfo: undefined,
  }
}

function ops(prompt: TaskPromptOps["prompt"]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
    prompt,
  }
}

describe("task structured finalizer", () => {
  test("durable production finalizer uses the frozen run contract and returns its exact receipt", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const result = await Effect.runPromise(
      runDurableStructuredFinalizer({
        ops: ops((prompt) =>
          Effect.sync(() => {
            calls.push(prompt)
            return response(prompt, { structured: { result: "frozen" } })
          }),
        ),
        run: {
          runID: "run_durable_finalizer",
          childSessionID: sessionID,
          executionSpec: {
            prompt: { text: "frozen research prompt" },
            agent: "reviewer",
            model: { providerID: "frozen-provider", modelID: "frozen-model", variant: "precise" },
            tools: { read: true, edit: false },
            structuredOutput: {
              schema,
              allowTextFallback: true,
              receiptVersion: 1,
              maxAttempts: 2,
            },
          },
        },
        research: response(
          {
            sessionID,
            agent: "researcher",
            model,
            parts: [],
          },
          { text: "durable research" },
        ),
        contract: {
          schema,
          allowTextFallback: true,
          receiptVersion: 1,
          maxAttempts: 2,
        },
        onFinalizing: () => Effect.void,
      }),
    )

    expect(result).toMatchObject({
      output: '{"result":"frozen"}',
      structuredResultMessageID: expect.any(String),
      receipt: { attempt: 1, transport: "structured" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionID,
      agent: "reviewer",
      model: { providerID: "frozen-provider", modelID: "frozen-model" },
      variant: "precise",
      format: { type: "json_schema", schema },
    })
    expect(calls[0]?.metadata?.deepagent?.structured_finalizer).toMatchObject({
      attempt: 1,
      source_message_id: expect.any(String),
    })
  })

  test("direct structured output records a first-attempt structured receipt", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    let receipt: StructuredOutputReceipt | undefined
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, { structured: { result: "ok" } })
        }),
      ),
    )
    request.directStructuredOutput = true
    request.finalizerInstructions = ["Preserve the assigned identity."]
    request.onFinalized = (_messageID, settled) =>
      Effect.sync(() => {
        receipt = settled
      })

    const result = await Effect.runPromise(runSubagentPrompt(request))

    expect(result).toBe('{"result":"ok"}')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.format?.type).toBe("json_schema")
    expect(calls[0]?.tools).toEqual({ task: false })
    expect(calls[0]?.metadata?.deepagent).toEqual({ structured_direct: { attempt: 1, allow_text: false } })
    expect(calls[0]?.parts.at(-1)).toMatchObject({ type: "text", text: "Preserve the assigned identity." })
    expect(receipt).toEqual({ attempt: 1, transport: "structured" })
  })

  test("direct structured output retries once after invalid structured output", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, { structured: calls.length === 1 ? { wrong: "field" } : { result: "recovered" } })
        }),
      ),
    )
    request.directStructuredOutput = true
    request.allowTextFallback = false

    const result = await Effect.runPromise(runSubagentPrompt(request))

    expect(result).toBe('{"result":"recovered"}')
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.metadata?.deepagent?.structured_direct?.attempt)).toEqual([1, 2])
    expect(calls.every((call) => call.format?.type === "json_schema")).toBe(true)
  })

  test("direct structured output stops after two invalid attempts", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, { structured: { wrong: "field" } })
        }),
      ),
    )
    request.directStructuredOutput = true
    request.allowTextFallback = false

    const error = await Effect.runPromise(runSubagentPrompt(request)).then(
      () => undefined,
      (cause) => cause,
    )

    expect(String(error)).toContain("[structured_output_invalid]")
    expect(String(error)).toContain("Attempts: 2")
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.metadata?.deepagent?.structured_direct?.attempt)).toEqual([1, 2])
  })

  test("direct structured output accepts schema-valid JSON text on the bounded second attempt", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    let receipt: StructuredOutputReceipt | undefined
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, { text: '{"result":"fallback"}' })
        }),
      ),
    )
    request.directStructuredOutput = true
    request.onFinalized = (_messageID, settled) =>
      Effect.sync(() => {
        receipt = settled
      })

    const result = await Effect.runPromise(runSubagentPrompt(request))

    expect(result).toBe('{"result":"fallback"}')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.format?.type).toBe("json_schema")
    expect(calls[1]?.format).toBeUndefined()
    expect(calls[1]?.metadata?.deepagent?.structured_direct).toEqual({ attempt: 2, allow_text: true })
    expect(calls[1]?.parts.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining('<output_schema>{"type":"object"'),
    })
    expect(receipt).toEqual({ attempt: 2, transport: "text_fallback" })
  })

  test("direct structured output rejects invalid JSON text without a third attempt", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, { text: calls.length === 1 ? "not json" : '{"wrong":"field"}' })
        }),
      ),
    )
    request.directStructuredOutput = true

    await expect(Effect.runPromise(runSubagentPrompt(request))).rejects.toThrow("[structured_output_invalid]")
    expect(calls).toHaveLength(2)
  })

  test("schema-less tasks preserve the last-text compatibility path", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          const output = response(prompt, { text: "first" })
          output.parts.push({
            id: PartID.ascending(),
            messageID: output.info.id,
            sessionID: prompt.sessionID,
            type: "text",
            text: "last",
          })
          return output
        }),
      ),
    )
    request.outputSchema = undefined
    const result = await Effect.runPromise(runSubagentPrompt(request))

    expect(result).toBe("last")
    expect(calls).toHaveLength(1)
  })

  test("research and finalization are separate durable prompts", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const result = await Effect.runPromise(
      runSubagentPrompt(
        input(
          ops((request) =>
            Effect.sync(() => {
              calls.push(request)
              return calls.length === 1
                ? response(request, { text: "persisted research" })
                : response(request, { structured: { result: "ok" } })
            }),
          ),
        ),
      ),
    )

    expect(result).toBe('{"result":"ok"}')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.format).toBeUndefined()
    expect(calls[0]?.tools).toEqual({ task: false })
    expect(calls[0]?.metadata?.deepagent?.task_activity).toMatchObject({
      interactive: false,
      budget: { max_steps: 64, max_wall_ms: 1_800_000, max_no_progress: 6 },
    })
    expect(calls[0]?.metadata?.deepagent?.task_activity?.budget).not.toHaveProperty("max_tokens")
    expect(calls[0]?.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("You are a leaf subagent"),
    })
    expect(calls[1]?.format?.type).toBe("json_schema")
    expect(calls[1]?.tools).toBeUndefined()
    expect(calls[1]?.metadata?.deepagent).toMatchObject({ structured_finalizer: { attempt: 1 } })
    expect(calls[1]?.parts[0]?.type === "text" ? calls[1].parts[0].text : "").toContain(
      "Preserve exact evidence identifiers, literals, paths, and values",
    )
  })

  test("plain-text finalizer exhaustion returns the bounded research result as degraded text", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    let receipt: Parameters<NonNullable<SubagentPromptInput["onFinalized"]>>[1] | undefined
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, { text: calls.length === 1 ? "persisted research" : "plain text" })
        }),
      ),
    )
    request.onFinalized = (_messageID, settled) =>
      Effect.sync(() => {
        receipt = settled
      })
    const effect = runSubagentPrompt(request)

    expect(JSON.parse(await Effect.runPromise(effect))).toEqual({
      _degraded: true,
      _reason: "structured_output_missing",
      _attempts: 2,
      _raw: "persisted research",
    })
    expect(calls).toHaveLength(3)
    expect(calls.slice(1).map((call) => call.metadata?.deepagent?.structured_finalizer?.attempt)).toEqual([1, 2])
    expect(calls[1]?.format?.type).toBe("json_schema")
    expect(calls[1]?.metadata?.deepagent?.structured_finalizer?.allow_text).toBe(false)
    expect(calls[2]?.format).toBeUndefined()
    expect(calls[2]?.metadata?.deepagent?.structured_finalizer?.allow_text).toBe(true)
    expect(receipt).toEqual({ attempt: 2, transport: "degraded_text", reason: "structured_output_missing" })
  })

  test("ignores JSON text from the forced-tool attempt and accepts it only on the text fallback", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const result = await Effect.runPromise(
      runSubagentPrompt(
        input(
          ops((request) =>
            Effect.sync(() => {
              calls.push(request)
              if (calls.length === 1) return response(request, { text: "persisted research" })
              if (calls.length === 2)
                return response(request, {
                  text: 'The result is:\n```json\n{"result":"ignored"}\n```',
                  error: new SessionV1.StructuredOutputError({
                    message: "Finalizer did not produce valid structured output",
                    retries: 1,
                  }).toObject(),
                })
              return response(request, { text: '{"result":"recovered"}' })
            }),
          ),
        ),
      ),
    )

    expect(result).toBe('{"result":"recovered"}')
    expect(calls).toHaveLength(3)
    expect(calls[1]?.format?.type).toBe("json_schema")
    expect(calls[2]?.format).toBeUndefined()
  })

  test("uses a text-only finalizer for the bounded second attempt", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const result = await Effect.runPromise(
      runSubagentPrompt(
        input(
          ops((request) =>
            Effect.sync(() => {
              calls.push(request)
              if (calls.length === 1) return response(request, { text: "persisted research" })
              if (calls.length === 2) return response(request, { text: "not json" })
              return response(request, { text: '{"result":"text fallback"}' })
            }),
          ),
        ),
      ),
    )

    expect(result).toBe('{"result":"text fallback"}')
    expect(calls).toHaveLength(3)
    expect(calls[2]?.format).toBeUndefined()
    expect(calls[2]?.metadata?.deepagent?.structured_finalizer).toMatchObject({ attempt: 2, allow_text: true })
    expect(calls[2]?.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('<output_schema>{"type":"object"'),
    })
  })

  test("callers that disable JSON text fallback still receive the Level-2 research receipt", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, { text: calls.length === 1 ? "persisted research" : '{"result":"text"}' })
        }),
      ),
    )
    request.allowTextFallback = false

    expect(JSON.parse(await Effect.runPromise(runSubagentPrompt(request)))).toEqual({
      _degraded: true,
      _reason: "structured_output_missing",
      _attempts: 2,
      _raw: "persisted research",
    })
    expect(calls).toHaveLength(3)
    expect(calls[2]?.format?.type).toBe("json_schema")
    expect(calls[2]?.metadata?.deepagent?.structured_finalizer?.allow_text).toBe(false)
  })

  test("assistant errors are propagated before any output fallback", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const effect = runSubagentPrompt(
      input(
        ops((request) =>
          Effect.sync(() => {
            calls.push(request)
            return response(request, {
              text: "must not become success",
              error: new SessionV1.DoomLoopError({
                message: "repeated shell command",
                tool: "bash",
                period: 1,
                count: 3,
              }).toObject(),
            })
          }),
        ),
      ),
    )

    await expect(Effect.runPromise(effect)).rejects.toThrow("[doom_loop]")
    expect(calls).toHaveLength(1)
  })

  test("schema-invalid finalizer exhaustion degrades without accepting the invalid value", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const effect = runSubagentPrompt(
      input(
        ops((request) =>
          Effect.sync(() => {
            calls.push(request)
            if (calls.length === 1) return response(request, { text: "persisted research" })
            if (calls.length === 2) return response(request, { structured: { wrong: "field" } })
            return response(request, { text: '{"wrong":"field"}' })
          }),
        ),
      ),
    )

    expect(JSON.parse(await Effect.runPromise(effect))).toEqual({
      _degraded: true,
      _reason: "structured_output_invalid",
      _attempts: 2,
      _raw: "persisted research",
    })
    expect(calls).toHaveLength(3)
  })

  test("Level-2 research output is bounded to 80,000 Unicode characters", async () => {
    const raw = `${"a".repeat(79_999)}😀tail`
    const result = await Effect.runPromise(
      runSubagentPrompt(
        input(
          ops((request) =>
            Effect.succeed(
              response(request, {
                text: request.metadata?.deepagent?.task_activity ? raw : "not json",
              }),
            ),
          ),
        ),
      ),
    )
    const degraded = JSON.parse(result) as { _raw: string }

    expect(Array.from(degraded._raw)).toHaveLength(80_000)
    expect(degraded._raw.endsWith("😀")).toBe(true)
  })

  test("provider transport errors are outside schema retries and fail after one physical call", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const request = input(
      ops((prompt) =>
        Effect.sync(() => {
          calls.push(prompt)
          return response(prompt, {
            error: {
              name: "APIError",
              data: { message: "upstream unavailable", isRetryable: true },
            },
          })
        }),
      ),
    )
    request.directStructuredOutput = true

    await expect(Effect.runPromise(runSubagentPrompt(request))).rejects.toThrow("[provider_error]")
    expect(calls).toHaveLength(1)
  })

  test("standard finalizer transport failure does not trigger another finalizer call", async () => {
    const calls: SessionPrompt.PromptInput[] = []
    const effect = runSubagentPrompt(
      input(
        ops((prompt) =>
          Effect.sync(() => {
            calls.push(prompt)
            if (calls.length === 1) return response(prompt, { text: "persisted research" })
            return response(prompt, {
              error: {
                name: "APIError",
                data: { message: "upstream unavailable", isRetryable: true },
              },
            })
          }),
        ),
      ),
    )

    await expect(Effect.runPromise(effect)).rejects.toThrow("[provider_error]")
    expect(calls).toHaveLength(2)
  })

  test("research wall-time exhaustion returns a recoverable typed task error", async () => {
    const request = input(ops(() => Effect.never))
    request.budget = { maxSteps: 2, maxWallMs: 5, maxNoProgress: 2 }

    await expect(Effect.runPromise(runSubagentPrompt(request))).rejects.toThrow("[budget_exhausted]")
    await expect(Effect.runPromise(runSubagentPrompt(request))).rejects.toThrow(
      `task_read({ task_id: "${sessionID}" })`,
    )
  })

  test("assistant budget errors are propagated before text fallback", async () => {
    const effect = runSubagentPrompt(
      input(
        ops((request) =>
          Effect.succeed(
            response(request, {
              text: "must not become success",
              error: new SessionV1.TaskBudgetExceededError({
                message: "token budget exhausted",
                budget: "tokens",
                limit: 10,
                used: 11,
              }).toObject(),
            }),
          ),
        ),
      ),
    )

    await expect(Effect.runPromise(effect)).rejects.toThrow("[budget_exhausted]")
  })
})
