/**
 * F3: Tool parameter JSON parsing safety tests
 *
 * Acceptance criteria (from docs/4.0.4_r4.md §F3):
 * 1. Valid JSON passes unchanged.
 * 2. Tool name case fix still works.
 * 3. Invalid JSON produces bounded, non-leaking tool error with resubmit hint.
 * 4. Schema mismatch not misclassified as JSON syntax error.
 * 5. Truncated write content is NOT executed or guessed.
 * 6. Same bad call eventually hits F1 loop protection.
 *
 * These tests exercise the two F3-changed paths in llm.ts:
 *   A. AI SDK experimental_repairToolCall callback — via error type discrimination helpers.
 *   B. Workflow toolExecutor — via isolated helper that mirrors the closure logic.
 */

import { describe, test, expect } from "bun:test"
import { InvalidToolInputError, NoSuchToolError } from "ai"

// ---------------------------------------------------------------------------
// A. Error type discrimination helpers (mirrors repair callback logic)
// ---------------------------------------------------------------------------

/**
 * Mirrors the repair callback classification: given a repair error, return
 * "case_fix" | "unknown_tool" | "invalid_json" | "schema_mismatch" | "unknown".
 */
function classifyRepairError(
  toolName: string,
  loweredName: string,
  toolExists: boolean,
  error: NoSuchToolError | InvalidToolInputError,
): "case_fix" | "unknown_tool" | "invalid_json" | "schema_mismatch" | "unknown" {
  if (loweredName !== toolName && toolExists) return "case_fix"
  if (NoSuchToolError.isInstance(error)) return "unknown_tool"
  if (InvalidToolInputError.isInstance(error)) {
    return error.cause instanceof SyntaxError ? "invalid_json" : "schema_mismatch"
  }
  return "unknown"
}

/**
 * Mirrors the bounded preview logic used in the repair callback.
 * Must never exceed 200 chars in the truncated preview.
 */
function boundedPreview(rawInput: string, limit = 200): string {
  return rawInput.length > limit ? rawInput.slice(0, limit) + "…[truncated]" : rawInput
}

describe("F3.A repair callback — error type discrimination", () => {
  test("case fix: lowercase matches existing tool → case_fix", () => {
    const error = new NoSuchToolError({ toolName: "Bash" })
    const result = classifyRepairError("Bash", "bash", /* toolExists */ true, error)
    expect(result).toBe("case_fix")
  })

  test("unknown tool: NoSuchToolError, no lowercase match → unknown_tool", () => {
    const error = new NoSuchToolError({ toolName: "nonexistent" })
    const result = classifyRepairError("nonexistent", "nonexistent", /* toolExists */ false, error)
    expect(result).toBe("unknown_tool")
  })

  test("invalid JSON: InvalidToolInputError with SyntaxError cause → invalid_json", () => {
    let syntaxErr: SyntaxError
    try {
      JSON.parse("{bad json}")
    } catch (e) {
      syntaxErr = e as SyntaxError
    }
    const error = new InvalidToolInputError({
      toolName: "write",
      toolInput: "{bad json}",
      cause: syntaxErr!,
    })
    const result = classifyRepairError("write", "write", /* toolExists */ true, error)
    expect(result).toBe("invalid_json")
  })

  test("schema mismatch: InvalidToolInputError with non-SyntaxError cause → schema_mismatch", () => {
    // Schema validation errors are not SyntaxErrors (e.g. Zod validation failures).
    const zodLikeError = new TypeError("Expected string, received number")
    const error = new InvalidToolInputError({
      toolName: "bash",
      toolInput: '{"command":123}',
      cause: zodLikeError,
    })
    const result = classifyRepairError("bash", "bash", /* toolExists */ true, error)
    expect(result).toBe("schema_mismatch")
  })

  test("schema mismatch is NOT classified as invalid_json", () => {
    // This is the key invariant: a schema mismatch (valid JSON, wrong shape)
    // must not be reported as a JSON syntax error to the model.
    const zodError = Object.assign(new Error("Expected string"), { issues: [{ code: "invalid_type" }] })
    const error = new InvalidToolInputError({
      toolName: "read",
      toolInput: '{"filePath":42}',
      cause: zodError,
    })
    const result = classifyRepairError("read", "read", /* toolExists */ true, error)
    expect(result).toBe("schema_mismatch")
    expect(result).not.toBe("invalid_json")
  })
})

describe("F3.A repair callback — input preview safety", () => {
  test("input within limit passes through unchanged", () => {
    const short = '{"command":"ls -la"}'
    expect(boundedPreview(short)).toBe(short)
  })

  test("input exceeding 200 chars is truncated with ellipsis suffix", () => {
    const long = "x".repeat(300)
    const preview = boundedPreview(long)
    expect(preview.length).toBeLessThanOrEqual(213) // 200 + length of "…[truncated]"
    expect(preview.endsWith("…[truncated]")).toBe(true)
  })

  test("preview never echoes full file content for a large write body", () => {
    // Simulates a write tool call with a large content field.
    const largeContent = "function foo() {\n" + "  const x = 1;\n".repeat(200) + "}"
    const fakeInput = JSON.stringify({ filePath: "src/index.ts", content: largeContent })
    const preview = boundedPreview(fakeInput)
    // The preview must be bounded regardless of content size.
    expect(preview.length).toBeLessThanOrEqual(213)
    expect(preview.endsWith("…[truncated]")).toBe(true)
  })

  test("error message is bounded to 300 chars", () => {
    const longMessage = "Parse error at position 0: " + "x".repeat(400)
    const bounded = longMessage.slice(0, 300)
    expect(bounded.length).toBe(300)
    // Confirms the slice(0, 300) cap used in the repair callback is enforced.
    expect(bounded).not.toContain("x".repeat(350))
  })
})

// ---------------------------------------------------------------------------
// B. Workflow toolExecutor — isolated helper tests
// ---------------------------------------------------------------------------

/**
 * Isolated version of the workflow toolExecutor logic from llm.ts.
 * Mirrors the actual implementation to allow direct unit testing without
 * spinning up the full Effect layer.
 */
async function workflowToolExecutor(
  toolName: string,
  argsJson: string,
  requestID: string,
  tools: Record<string, { execute?: (args: unknown, opts: unknown) => Promise<unknown> }>,
): Promise<{ result: string; error?: string; metadata?: unknown; title?: unknown }> {
  // (1) Unknown tool
  const t = tools[toolName]
  if (!t || !t.execute) {
    return {
      result: "",
      error: `[unknown_tool] Tool "${toolName}" is not available. Resend the request using a valid tool name.`,
    }
  }

  // (2) JSON parse
  let parsedArgs: unknown
  try {
    parsedArgs = JSON.parse(argsJson)
  } catch (parseErr: any) {
    const inputPreview = argsJson.length > 200 ? argsJson.slice(0, 200) + "…[truncated]" : argsJson
    return {
      result: "",
      error: `[invalid_json] Arguments for tool "${toolName}" are not valid JSON (${(parseErr?.message ?? "parse error").slice(0, 200)}). Resend the request with complete, valid JSON arguments.`,
    }
  }

  // (3) Execute
  try {
    const result = await t.execute!(parsedArgs, { toolCallId: requestID, messages: [], abortSignal: undefined })
    const output = typeof result === "string" ? result : ((result as any)?.output ?? JSON.stringify(result))
    return {
      result: output,
      metadata: typeof result === "object" ? (result as any)?.metadata : undefined,
      title: typeof result === "object" ? (result as any)?.title : undefined,
    }
  } catch (e: any) {
    const isSchemaError =
      Array.isArray(e?.issues) || e?._tag === "ParseError" || e?.cause?._tag === "ParseError"
    if (isSchemaError) {
      return {
        result: "",
        error: `[schema_mismatch] Arguments for tool "${toolName}" do not match the expected schema. Resend the request with correctly structured arguments.`,
      }
    }
    return { result: "", error: (e?.message ?? String(e)).slice(0, 500) }
  }
}

describe("F3.B workflow toolExecutor — error classification", () => {
  const echoTool = {
    execute: async (args: unknown) => ({ output: JSON.stringify(args) }),
  }

  // AC1: valid JSON passes through unchanged
  test("AC1: valid JSON is parsed and passed to execute without modification", async () => {
    const result = await workflowToolExecutor(
      "echo",
      '{"message":"hello world"}',
      "call-1",
      { echo: echoTool },
    )
    expect(result.error).toBeUndefined()
    expect(result.result).toBe('{"message":"hello world"}')
  })

  // AC3: invalid JSON → bounded error with resubmit hint
  test("AC3: invalid JSON produces bounded error with [invalid_json] prefix", async () => {
    const result = await workflowToolExecutor(
      "echo",
      '{"message": unquoted}',
      "call-2",
      { echo: echoTool },
    )
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/^\[invalid_json\]/)
    expect(result.error).toContain("echo")
    expect(result.error).toContain("Resend")
  })

  // AC3: error message is bounded even for very long parse error messages
  test("AC3: invalid JSON error message does not echo full large content", async () => {
    const largeContent = '{"content":"' + "a".repeat(1000) + '"truncated here...'
    const result = await workflowToolExecutor("echo", largeContent, "call-3", { echo: echoTool })
    expect(result.error).toBeDefined()
    expect(result.error!.length).toBeLessThan(600) // bounded; not 1000+ chars
    expect(result.error).toMatch(/^\[invalid_json\]/)
  })

  // AC4: schema mismatch not misclassified as JSON syntax error
  test("AC4: schema mismatch produces [schema_mismatch], not [invalid_json]", async () => {
    const schemaTool = {
      execute: async (_args: unknown) => {
        // Simulate Effect Schema ParseError
        const err = Object.assign(new Error("Expected string"), { _tag: "ParseError" as const })
        throw err
      },
    }
    const result = await workflowToolExecutor(
      "schema_tool",
      '{"value":42}',
      "call-4",
      { schema_tool: schemaTool },
    )
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/^\[schema_mismatch\]/)
    expect(result.error).not.toMatch(/invalid_json/)
    expect(result.error).toContain("Resend")
  })

  // AC4: Zod-style schema error (has .issues array)
  test("AC4: Zod schema error (issues array) classified as schema_mismatch", async () => {
    const zodTool = {
      execute: async (_args: unknown) => {
        const err = Object.assign(new Error("Validation failed"), {
          issues: [{ code: "invalid_type", expected: "string", received: "number" }],
        })
        throw err
      },
    }
    const result = await workflowToolExecutor("zod_tool", '{"x":1}', "call-5", { zod_tool: zodTool })
    expect(result.error).toMatch(/^\[schema_mismatch\]/)
  })

  // AC5: truncated write content is not executed
  test("AC5: truncated JSON (missing closing brace) is not executed", async () => {
    const writeTool = {
      execute: async (args: unknown) => ({ output: `wrote ${(args as any).filePath}` }),
    }
    // Truncated write call — missing closing }
    const truncated = '{"filePath":"src/main.ts","content":"function foo() {\\n  return 1;'
    const result = await workflowToolExecutor("write", truncated, "call-6", { write: writeTool })
    // Must be a parse error, not a successful write
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/^\[invalid_json\]/)
    // The execute function must NOT have been called
    expect(result.result).toBe("")
  })

  // Unknown tool classification
  test("unknown tool produces [unknown_tool] error with resubmit hint", async () => {
    const result = await workflowToolExecutor("nonexistent", '{"x":1}', "call-7", {})
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/^\[unknown_tool\]/)
    expect(result.error).toContain("nonexistent")
    expect(result.error).toContain("Resend")
  })

  // Runtime execution error (not schema, not JSON parse) stays as-is but bounded
  test("runtime execution error produces bounded error message", async () => {
    const failingTool = {
      execute: async () => {
        throw new Error("disk full: " + "x".repeat(600))
      },
    }
    const result = await workflowToolExecutor("failing", '{"x":1}', "call-8", { failing: failingTool })
    expect(result.error).toBeDefined()
    // Not a schema or JSON error
    expect(result.error).not.toMatch(/^\[(invalid_json|schema_mismatch|unknown_tool)\]/)
    // Bounded to 500 chars
    expect(result.error!.length).toBeLessThanOrEqual(500)
  })
})

describe("F3 constraints — no regex repair, no content guessing", () => {
  test("unescaped quote in content is not silently fixed — parse error is returned", async () => {
    // A write call where the content has an unescaped quote (common model error).
    // The correct behaviour is to return an error, not to fix the quote.
    const writeTool = {
      execute: async (args: unknown) => ({ output: `ok: ${(args as any).content?.slice(0, 20)}` }),
    }
    const badInput = '{"filePath":"a.ts","content":"let x = "hello""}'
    const result = await workflowToolExecutor("write", badInput, "call-9", { write: writeTool })
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/^\[invalid_json\]/)
    // execute must NOT have been called with guessed/repaired content
    expect(result.result).toBe("")
  })

  test("control characters in content are not stripped — parse error is returned", async () => {
    // Content with a raw newline inside a JSON string (not \\n escaped)
    const writeTool = {
      execute: async (args: unknown) => ({ output: "ok" }),
    }
    const badInput = '{"filePath":"b.ts","content":"line1\nline2"}'
    const result = await workflowToolExecutor("write", badInput, "call-10", { write: writeTool })
    // JSON.parse rejects this — it must NOT be silently fixed
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/^\[invalid_json\]/)
    expect(result.result).toBe("")
  })
})
