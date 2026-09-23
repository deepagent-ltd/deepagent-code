import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ToolJsonSchema } from "../../src/tool/json-schema"

// Each tool exports its parameters schema at module scope so this test can
// import them without running the tool's Effect-based init. The JSON Schema
// snapshot captures what the LLM sees; the parse assertions pin down the
// accepts/rejects contract. `ToolJsonSchema.fromSchema` is the same helper `session/
// prompt.ts` uses to emit tool schemas to the LLM, so the snapshots stay
// provider-compatible while tools use Effect Schema internally.

import { StartParameters as ActivityStart, StatusParameters as ActivityStatus } from "../../src/tool/activity_facade"
import { Parameters as ApplyPatch } from "../../src/tool/apply_patch"
import { Parameters as ApplyPatchChunk } from "../../src/tool/apply_patch_chunk"
import { Parameters as CodeIntel } from "../../src/tool/code_intel"
import { CodeIntelV2Parameters } from "../../src/tool/code_intel_v2"
import { ContextQueryParameters } from "../../src/tool/context_query"
import { Parameters as Debug } from "../../src/tool/debug"
import { Parameters as DismissValidation } from "../../src/tool/dismiss_validation"
import { Parameters as Edit } from "../../src/tool/edit"
import { Parameters as Glob } from "../../src/tool/glob"
import { Parameters as Grep } from "../../src/tool/grep"
import { Parameters as Invalid } from "../../src/tool/invalid"
import { Parameters as Lsp } from "../../src/tool/lsp"
import { Parameters as Plan } from "../../src/tool/plan"
import { PlanWriteParameters } from "../../src/tool/plan-write"
import { Parameters as Question } from "../../src/tool/question"
import { Parameters as QueryLog } from "../../src/tool/query_log"
import { Parameters as Read } from "../../src/tool/read"
import { Parameters as Shell } from "../../src/tool/shell"
import { Parameters as Skill } from "../../src/tool/skill"
import { Parameters as Task } from "../../src/tool/task"
import { Parameters as TaskRead } from "../../src/tool/task_read"
import { Parameters as WebFetch } from "../../src/tool/webfetch"
import { Parameters as WebSearch } from "../../src/tool/websearch"
import { Parameters as Write } from "../../src/tool/write"

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const toJsonSchema = ToolJsonSchema.fromSchema

describe("tool parameters", () => {
  describe("JSON Schema (wire shape)", () => {
    test("apply_patch", () => expect(toJsonSchema(ApplyPatch)).toMatchSnapshot())
    test("bash", () => expect(toJsonSchema(Shell)).toMatchSnapshot())
    test("edit", () => expect(toJsonSchema(Edit)).toMatchSnapshot())
    test("glob", () => expect(toJsonSchema(Glob)).toMatchSnapshot())
    test("grep", () => expect(toJsonSchema(Grep)).toMatchSnapshot())
    test("invalid", () => expect(toJsonSchema(Invalid)).toMatchSnapshot())
    test("lsp", () => expect(toJsonSchema(Lsp)).toMatchSnapshot())
    test("plan", () => expect(toJsonSchema(Plan)).toMatchSnapshot())
    test("question", () => expect(toJsonSchema(Question)).toMatchSnapshot())
    test("read", () => expect(toJsonSchema(Read)).toMatchSnapshot())
    test("skill", () => expect(toJsonSchema(Skill)).toMatchSnapshot())
    test("task", () => expect(toJsonSchema(Task)).toMatchSnapshot())
    test("webfetch", () => expect(toJsonSchema(WebFetch)).toMatchSnapshot())
    test("websearch", () => expect(toJsonSchema(WebSearch)).toMatchSnapshot())
    test("write", () => expect(toJsonSchema(Write)).toMatchSnapshot())

    test("inlines named child schemas for provider compatibility", () => {
      const schema = toJsonSchema(Question)
      expect(schema).not.toHaveProperty("$defs")
      expect(schema).toMatchObject({
        properties: {
          questions: { items: { properties: { options: { items: { properties: { label: { type: "string" } } } } } } },
        },
      })
    })

    test("preserves required nullable fields", () => {
      expect(toJsonSchema(Schema.Struct({ value: Schema.NullOr(Schema.String) }))).toMatchObject({
        properties: { value: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
      })
    })

    test("keeps repeated allOf constraints instead of dropping duplicates", () => {
      expect(
        toJsonSchema(
          Schema.Struct({ value: Schema.String.check(Schema.isPattern(/^a/)).check(Schema.isPattern(/z$/)) }),
        ),
      ).toMatchObject({ properties: { value: { allOf: [{ pattern: "^a" }, { pattern: "z$" }] } } })
    })

    test("bounds bare integer fields to safe integer range", () => {
      expect(toJsonSchema(Schema.Struct({ value: Schema.Int }))).toMatchObject({
        properties: { value: { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } },
      })
    })

    test("does not expose defaulted optional keys as nullable", () => {
      expect(toJsonSchema(WebFetch)).toMatchObject({
        properties: { format: { type: "string", enum: ["text", "markdown", "html"], default: "markdown" } },
      })
      expect(toJsonSchema(WebFetch).properties?.format).not.toHaveProperty("anyOf")
    })
  })

  describe("apply_patch", () => {
    test("accepts patchText", () => {
      expect(parse(ApplyPatch, { patchText: "*** Begin Patch\n*** End Patch" })).toEqual({
        patchText: "*** Begin Patch\n*** End Patch",
      })
    })
    test("rejects missing patchText", () => {
      expect(accepts(ApplyPatch, {})).toBe(false)
    })
    test("rejects non-string patchText", () => {
      expect(accepts(ApplyPatch, { patchText: 123 })).toBe(false)
    })
  })

  describe("plan-write protocol admission", () => {
    // F-10/F-11 contract update: omission-tolerant providers (GLM) legally send goal+steps with no
    // operation/expected_* — those ADMIT at the schema boundary and get inferred/normalized in
    // execute. The historical garbage-title defense is now carried by semantic validation plus the
    // two-attempt protocol budget, not by required fields (a required-field rejection had no
    // correction payload and burned the whole budget in the field).
    test("admits omission-shaped payloads (F-10) and still rejects malformed shapes", () => {
      const historical = [
        ["ayContext", "active"],
        ["Context", "pending"],
        ["Context", "active"],
        ["Context", "active"],
        ["", ""],
        ["Context", "active"],
        ["", "active"],
        ["Context", "pending"],
        ["", "active"],
        ["Context", "active"],
        ["Context", "active"],
      ] as const
      expect(
        accepts(PlanWriteParameters, { goal: "现场计划目标", steps: [{ title: "Context", status: "active" }] }),
      ).toBe(true)
      expect(accepts(PlanWriteParameters, { goal: "x", steps: "not-an-array" })).toBe(false)
      expect(accepts(PlanWriteParameters, { operation: "bogus", goal: "x", steps: [] })).toBe(false)
    })

    test("accepts the forward-compatible envelope so semantic validation remains the failing boundary", () => {
      expect(
        accepts(PlanWriteParameters, {
          operation: "replan",
          expected_plan_id: "plan_fixture",
          expected_version: 1,
          replan_reason: "provider returned malformed steps",
          goal: "ship the change",
          steps: [{ step_id: "s1", title: "", status: "pending" }],
          active_step_id: null,
        }),
      ).toBe(true)
    })

    test("accepts a status-only advance patch without step titles", () => {
      expect(
        accepts(PlanWriteParameters, {
          operation: "advance",
          expected_plan_id: "plan_fixture",
          expected_version: 2,
          steps: [{ step_id: "s1", status: "done" }],
        }),
      ).toBe(true)
    })

    test("accepts create/replan without active_step_id so the server can derive it", () => {
      expect(
        accepts(PlanWriteParameters, {
          operation: "create",
          expected_plan_id: null,
          expected_version: null,
          goal: "ship the change",
          steps: [{ title: "implement", status: "active" }],
        }),
      ).toBe(true)
      expect(
        accepts(PlanWriteParameters, {
          operation: "replan",
          expected_plan_id: "plan_fixture",
          expected_version: 2,
          replan_reason: "the implementation boundary changed",
          goal: "ship the change",
          steps: [{ title: "implement the new boundary", status: "active" }],
        }),
      ).toBe(true)
    })
  })

  describe("shell", () => {
    test("accepts minimum: command + description", () => {
      expect(parse(Shell, { command: "ls", description: "list" })).toEqual({ command: "ls", description: "list" })
    })
    test("accepts optional timeout + workdir", () => {
      const parsed = parse(Shell, { command: "ls", description: "list", timeout: 5000, workdir: "/tmp" })
      expect(parsed.timeout).toBe(5000)
      expect(parsed.workdir).toBe("/tmp")
    })
    test("rejects missing description", () => {
      expect(accepts(Shell, { command: "ls" })).toBe(false)
    })
    test("rejects missing command", () => {
      expect(accepts(Shell, { description: "list" })).toBe(false)
    })
  })

  describe("edit", () => {
    test("accepts all four fields", () => {
      expect(parse(Edit, { filePath: "/a", oldString: "x", newString: "y", replaceAll: true })).toEqual({
        filePath: "/a",
        oldString: "x",
        newString: "y",
        replaceAll: true,
      })
    })
    test("replaceAll is optional", () => {
      const parsed = parse(Edit, { filePath: "/a", oldString: "x", newString: "y" })
      expect(parsed.replaceAll).toBeUndefined()
    })
    test("rejects missing filePath", () => {
      expect(accepts(Edit, { oldString: "x", newString: "y" })).toBe(false)
    })
  })

  describe("glob", () => {
    test("accepts pattern-only", () => {
      expect(parse(Glob, { pattern: "**/*.ts" })).toEqual({ pattern: "**/*.ts" })
    })
    test("accepts optional path", () => {
      expect(parse(Glob, { pattern: "**/*.ts", path: "/tmp" }).path).toBe("/tmp")
    })
    test("rejects missing pattern", () => {
      expect(accepts(Glob, {})).toBe(false)
    })
  })

  describe("grep", () => {
    test("accepts pattern-only", () => {
      expect(parse(Grep, { pattern: "TODO" })).toEqual({ pattern: "TODO" })
    })
    test("accepts optional path + include", () => {
      const parsed = parse(Grep, { pattern: "TODO", path: "/tmp", include: "*.ts" })
      expect(parsed.path).toBe("/tmp")
      expect(parsed.include).toBe("*.ts")
    })
    test("rejects missing pattern", () => {
      expect(accepts(Grep, {})).toBe(false)
    })
  })

  describe("invalid", () => {
    test("accepts tool + error", () => {
      expect(parse(Invalid, { tool: "foo", error: "bar" })).toEqual({ tool: "foo", error: "bar" })
    })
    test("rejects missing fields", () => {
      expect(accepts(Invalid, { tool: "foo" })).toBe(false)
      expect(accepts(Invalid, { error: "bar" })).toBe(false)
    })
  })

  describe("lsp", () => {
    test("accepts all fields", () => {
      const parsed = parse(Lsp, { operation: "hover", filePath: "/a.ts", line: 1, character: 1 })
      expect(parsed.operation).toBe("hover")
    })
    test("rejects line < 1", () => {
      expect(accepts(Lsp, { operation: "hover", filePath: "/a.ts", line: 0, character: 1 })).toBe(false)
    })
    test("rejects character < 1", () => {
      expect(accepts(Lsp, { operation: "hover", filePath: "/a.ts", line: 1, character: 0 })).toBe(false)
    })
    test("rejects unknown operation", () => {
      expect(accepts(Lsp, { operation: "bogus", filePath: "/a.ts", line: 1, character: 1 })).toBe(false)
    })
  })

  describe("plan", () => {
    test("accepts empty object", () => {
      expect(parse(Plan, {})).toEqual({})
    })
  })

  describe("question", () => {
    test("accepts questions array", () => {
      const parsed = parse(Question, {
        questions: [
          {
            question: "pick one",
            header: "Header",
            custom: false,
            options: [{ label: "a", description: "desc" }],
          },
        ],
      })
      expect(parsed.questions.length).toBe(1)
    })
    test("rejects missing questions", () => {
      expect(accepts(Question, {})).toBe(false)
    })
  })

  describe("read", () => {
    test("accepts filePath-only", () => {
      expect(parse(Read, { filePath: "/a" }).filePath).toBe("/a")
    })
    test("accepts optional offset + limit", () => {
      const parsed = parse(Read, { filePath: "/a", offset: 10, limit: 100 })
      expect(parsed.offset).toBe(10)
      expect(parsed.limit).toBe(100)
    })
  })

  describe("skill", () => {
    test("accepts name", () => {
      expect(parse(Skill, { name: "foo" }).name).toBe("foo")
    })
    test("rejects missing name", () => {
      expect(accepts(Skill, {})).toBe(false)
    })
  })

  describe("task", () => {
    test("accepts description + prompt + subagent_type", () => {
      const parsed = parse(Task, { description: "d", prompt: "p", subagent_type: "general" })
      expect(parsed.subagent_type).toBe("general")
    })
    test("accepts optional background flag", () => {
      const parsed = parse(Task, { description: "d", prompt: "p", subagent_type: "general", background: true })
      expect(parsed.background).toBe(true)
    })
    test("rejects missing prompt", () => {
      expect(accepts(Task, { description: "d", subagent_type: "general" })).toBe(false)
    })
  })

  describe("webfetch", () => {
    test("defaults omitted format to markdown", () => {
      expect(parse(WebFetch, { url: "https://example.com" })).toEqual({
        url: "https://example.com",
        format: "markdown",
      })
      expect(parse(WebFetch, { url: "https://example.com", format: undefined })).toEqual({
        url: "https://example.com",
        format: "markdown",
      })
    })
  })

  describe("websearch", () => {
    test("accepts query", () => {
      expect(parse(WebSearch, { query: "deepagent-code" }).query).toBe("deepagent-code")
    })
  })

  describe("write", () => {
    test("accepts content + filePath", () => {
      expect(parse(Write, { content: "hi", filePath: "/a" })).toEqual({ content: "hi", filePath: "/a" })
    })
    test("rejects missing filePath", () => {
      expect(accepts(Write, { content: "hi" })).toBe(false)
    })
  })

  // Ablation F-1 family: GLM-class omission providers serialize JSON numbers as strings. Every
  // model-facing number field below once REJECTED a value-equivalent stringified number at the
  // decode boundary; the tolerant arms decode them through the same checks as the numeric arm,
  // while malformed or "null" strings still reject instead of decoding to NaN (the F-7 poison).
  describe("stringified-number tolerance (F-1 family)", () => {
    test("read offset/limit", () => {
      expect(parse(Read, { filePath: "/a", offset: "10", limit: "100" })).toEqual({
        filePath: "/a",
        offset: 10,
        limit: 100,
      })
      for (const bad of ["null", "abc", "", "1.5", "-1"])
        expect(accepts(Read, { filePath: "/a", offset: bad })).toBe(false)
    })

    test("lsp line/character", () => {
      const parsed = parse(Lsp, { operation: "hover", filePath: "/a.ts", line: "3", character: "5" })
      expect(parsed.line).toBe(3)
      expect(parsed.character).toBe(5)
      for (const bad of ["null", "abc", "0", "1.5"])
        expect(accepts(Lsp, { operation: "hover", filePath: "/a.ts", line: bad, character: 1 })).toBe(false)
    })

    test("shell timeout", () => {
      expect(parse(Shell, { command: "ls", description: "list", timeout: "5000" }).timeout).toBe(5000)
      for (const bad of ["null", "abc", "0", "1.5", "-1"])
        expect(accepts(Shell, { command: "ls", description: "list", timeout: bad })).toBe(false)
    })

    test("webfetch timeout keeps decimal parity", () => {
      expect(parse(WebFetch, { url: "https://example.com", timeout: "30" }).timeout).toBe(30)
      expect(parse(WebFetch, { url: "https://example.com", timeout: "1.5" }).timeout).toBe(1.5)
      for (const bad of ["null", "abc", ""])
        expect(accepts(WebFetch, { url: "https://example.com", timeout: bad })).toBe(false)
    })

    test("websearch numResults/contextMaxCharacters", () => {
      const parsed = parse(WebSearch, { query: "q", numResults: "5", contextMaxCharacters: "1000" })
      expect(parsed.numResults).toBe(5)
      expect(parsed.contextMaxCharacters).toBe(1000)
      for (const bad of ["null", "abc"])
        expect(accepts(WebSearch, { query: "q", numResults: bad })).toBe(false)
    })

    test("code_intel position/limit/depth", () => {
      const parsed = parse(CodeIntel, {
        intent: "references",
        symbol: "resolveTools",
        position: { file: "/a.ts", line: "2", character: "3" },
        limit: "10",
        depth: "2",
      })
      expect(parsed.position).toEqual({ file: "/a.ts", line: 2, character: 3 })
      expect(parsed.limit).toBe(10)
      expect(parsed.depth).toBe(2)
      for (const bad of ["null", "abc", "0"])
        expect(accepts(CodeIntel, { intent: "references", limit: bad })).toBe(false)
    })

    test("query_log since/until/limit", () => {
      const parsed = parse(QueryLog, { since: "1000", until: "2000", limit: "50" })
      expect(parsed.since).toBe(1000)
      expect(parsed.until).toBe(2000)
      expect(parsed.limit).toBe(50)
      for (const bad of ["null", "abc"]) expect(accepts(QueryLog, { since: bad })).toBe(false)
    })

    test("debug frame", () => {
      expect(parse(Debug, { intent: "inspect", frame: "1" }).frame).toBe(1)
      for (const bad of ["null", "abc", "-1"]) expect(accepts(Debug, { intent: "inspect", frame: bad })).toBe(false)
    })

    test("apply_patch_chunk offset", () => {
      expect(parse(ApplyPatchChunk, { action: "append", transactionID: "tx", offset: "12000" }).offset).toBe(12000)
      for (const bad of ["null", "abc", "-1", "1.5"])
        expect(accepts(ApplyPatchChunk, { action: "append", offset: bad })).toBe(false)
    })

    test("dismiss_validation exit_code", () => {
      expect(parse(DismissValidation, { command: "bun test", exit_code: "1", reason: "safe" }).exit_code).toBe(1)
      for (const bad of ["null", "abc"])
        expect(accepts(DismissValidation, { command: "bun test", exit_code: bad, reason: "safe" })).toBe(false)
    })

    test("task_read limit", () => {
      expect(parse(TaskRead, { task_id: "ses_x", limit: "50" }).limit).toBe(50)
      for (const bad of ["null", "abc", ""]) expect(accepts(TaskRead, { task_id: "ses_x", limit: bad })).toBe(false)
    })

    test("activity_start budget fields", () => {
      const parsed = parse(ActivityStart, {
        subkind: "task",
        objective: "ship it",
        budget: { maxTicks: "10", maxTokens: "1000", maxWallclockMs: "60000" },
      })
      expect(parsed.budget).toEqual({ maxTicks: 10, maxTokens: 1000, maxWallclockMs: 60000 })
      for (const bad of ["null", "abc", "0", "1.5"])
        expect(accepts(ActivityStart, { subkind: "task", objective: "x", budget: { maxTicks: bad } })).toBe(false)
    })

    test("activity_status limit", () => {
      expect(parse(ActivityStatus, { limit: "5" }).limit).toBe(5)
      for (const bad of ["null", "0", "21"]) expect(accepts(ActivityStatus, { limit: bad })).toBe(false)
    })

    test("context_query limit (core contract)", () => {
      expect(parse(ContextQueryParameters, { intent: "search", limit: "7" }).limit).toBe(7)
      for (const bad of ["null", "abc", "0", "101"])
        expect(accepts(ContextQueryParameters, { intent: "search", limit: bad })).toBe(false)
    })

    test("code_intel_v2 depth/limit (core contract)", () => {
      const parsed = parse(CodeIntelV2Parameters, { intent: "search", depth: "2", limit: "100" })
      expect(parsed.depth).toBe(2)
      expect(parsed.limit).toBe(100)
      expect(accepts(CodeIntelV2Parameters, { intent: "search", depth: "4" })).toBe(false)
    })
  })
})
