import { tool, jsonSchema, type Tool as AITool } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Hash } from "@deepagent-code/core/util/hash"
import { MessageV2 } from "./message-v2"
import { ToolInternal } from "@/tool/internal"

// v2w-l2 prompt monolith teardown: the structured-output prompt helpers moved here VERBATIM from
// session/prompt.ts (the deleted V1 monolith). These are pure prompt/tail builders plus the
// synthetic AI-SDK tool factory; the V2 admission carries json_schema formats through
// interactiveV2Prompt (prompt-v2.ts) and the core runner consumes them from the projected user
// message. Consumers: the structured-output test suites.

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

// P1: Build a schema-aware system prompt that injects the required field names so the model
// knows the exact schema even during extended-thinking (xhigh) reasoning, without relying
// solely on the tool definition which may not be visible during the thinking phase.
export function buildStructuredOutputSystemPrompt(schema: Record<string, any>): string {
  const fields = extractSchemaTopLevelFields(schema)
  const fieldHint =
    fields.length > 0
      ? `\nThe StructuredOutput tool requires these top-level fields: ${fields.join(", ")}. Use ONLY these exact field names.`
      : ""
  return `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.${fieldHint}`
}

export function buildStructuredOutputRuntimeTail(
  format: SessionV1.OutputFormat,
  finalizerMode: boolean,
  finalizerAllowsText = false,
  wireFormat = false,
): string {
  if (finalizerAllowsText) {
    return "This is a bounded finalizer turn. Read the supplied research result and return exactly one JSON value. No research, Markdown, explanatory prose, or tool use is permitted."
  }
  if (format.type !== "json_schema") return ""
  // UPD-002: wire mode — the provider enforces the schema via text.format, so
  // the tail must NOT reference the (absent) StructuredOutput tool.
  if (wireFormat) {
    return "IMPORTANT: The user has requested structured output. Your final response text is schema-constrained by the provider. Reply with ONLY a single JSON value matching the required schema - no Markdown fences, prose, or wrapping."
  }
  return [
    buildStructuredOutputSystemPrompt(format.schema),
    finalizerMode
      ? "This is a bounded finalizer turn. Read the supplied research result and call StructuredOutput once. No research or other work is permitted."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function extractSchemaTopLevelFields(schema: Record<string, any>): string[] {
  if (!schema || typeof schema !== "object") return []
  const props = schema.properties
  if (!props || typeof props !== "object") return []
  return Object.keys(props)
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return "null"
  if (["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === "function" || typeof value === "symbol") return "null"
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`
  if (typeof value !== "object") return JSON.stringify(String(value))
  if (seen.has(value)) return JSON.stringify("[circular]")
  seen.add(value)
  const result = `{${Object.entries(value)
    .filter((entry) => typeof entry[1] !== "function")
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item, seen)}`)
    .join(",")}}`
  seen.delete(value)
  return result
}

/** @internal Exported for deterministic receipt verification. */
export function providerResponseFingerprint(response: SessionV1.WithParts) {
  return Hash.sha256(
    stableJson({
      ...response,
      info: MessageV2.stripActivityProgress(response.info),
    }),
  )
}

export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  const result = tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
  ToolInternal.set(result)
  return result
}

export * as SessionStructuredOutput from "./structured-output-prompt"
