import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { tolerantInt, tolerantNumber } from "../src/schema"
import { ContextFederationContract } from "../src/context-federation/contract"
import { ApplyPatchChunkTool } from "../src/tool/apply-patch-chunk"
import { BashTool } from "../src/tool/bash"
import { GlobTool } from "../src/tool/glob"
import { GrepTool } from "../src/tool/grep"
import { ReadTool } from "../src/tool/read"
import { TaskReadTool } from "../src/tool/task-read"
import { WebFetchTool } from "../src/tool/webfetch"
import { WebSearchTool } from "../src/tool/websearch"

// Ablation F-1 family regression (GLM-class omission providers serialize JSON numbers as
// strings and null as "null"): every model-facing strict number field below once REJECTED a
// value-equivalent stringified number at the decode boundary, and a tolerant-but-unchecked
// string arm would have decoded "null"/malformed strings to NaN (the plan-write F-7 poison).
// The tolerantInt/tolerantNumber arms decode value-equivalent strings through the SAME checks
// as the numeric arm; everything else still rejects with a field-precise message.

const accepts = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))
const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

describe("tolerant number helpers", () => {
  test("tolerantInt coerces value-equivalent strings and rejects poison", () => {
    const field = Schema.Struct({ n: Schema.optional(tolerantInt(Schema.isGreaterThan(0))) })
    expect(decode(field, { n: "120" })).toEqual({ n: 120 })
    expect(decode(field, { n: 120 })).toEqual({ n: 120 })
    expect(decode(field, {})).toEqual({})
    for (const bad of ["null", "abc", "", "1.5", 1.5, 0, -3, "0"]) expect(accepts(field, { n: bad })).toBe(false)
  })

  test("tolerantNumber keeps decimal parity and rejects non-finite poison on both arms", () => {
    const field = Schema.Struct({ n: Schema.optional(tolerantNumber()) })
    expect(decode(field, { n: "2.5" })).toEqual({ n: 2.5 })
    expect(decode(field, { n: 2.5 })).toEqual({ n: 2.5 })
    // "null"/malformed strings would decode to NaN through a bare NumberFromString arm.
    for (const bad of ["null", "abc", "", 1e999, Number.NaN]) expect(accepts(field, { n: bad })).toBe(false)
  })

  test("the advertised wire shape keeps the constrained integer arm next to the string arm", () => {
    const document = Schema.toJsonSchemaDocument(
      Schema.Struct({ n: Schema.optional(tolerantInt(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10))) }),
    )
    const property = (document.schema.properties as Record<string, { anyOf: unknown[] }>)["n"]
    expect(JSON.stringify(property.anyOf)).toContain('"type":"integer"')
    expect(JSON.stringify(property.anyOf)).toContain('"type":"string"')
    expect(JSON.stringify(property.anyOf)).toContain('"maximum":10')
  })
})

describe("F-1 stringified-number tolerance in V2 builtin tool inputs", () => {
  test("bash timeout", () => {
    expect(decode(BashTool.Input, { command: "ls", timeout: "120000" }).timeout).toBe(120000)
    expect(decode(BashTool.Input, { command: "ls", timeout: "600000" }).timeout).toBe(BashTool.MAX_TIMEOUT_MS)
    for (const bad of ["null", "abc", "1.5", 0, "600001", 600001])
      expect(accepts(BashTool.Input, { command: "ls", timeout: bad })).toBe(false)
  })

  test("webfetch timeout keeps decimal-second parity", () => {
    expect(decode(WebFetchTool.Input, { url: "https://example.com", timeout: "30" }).timeout).toBe(30)
    expect(decode(WebFetchTool.Input, { url: "https://example.com", timeout: "1.5" }).timeout).toBe(1.5)
    for (const bad of ["null", "abc", "0", String(WebFetchTool.MAX_TIMEOUT_SECONDS + 1)])
      expect(accepts(WebFetchTool.Input, { url: "https://example.com", timeout: bad })).toBe(false)
  })

  test("websearch numResults and contextMaxCharacters", () => {
    const parsed = decode(WebSearchTool.Input, { query: "q", numResults: "8", contextMaxCharacters: "50000" })
    expect(parsed.numResults).toBe(8)
    expect(parsed.contextMaxCharacters).toBe(50000)
    for (const bad of ["null", "abc", "0", "21"])
      expect(accepts(WebSearchTool.Input, { query: "q", numResults: bad })).toBe(false)
    expect(accepts(WebSearchTool.Input, { query: "q", contextMaxCharacters: "50001" })).toBe(false)
  })

  test("read offset and limit", () => {
    const parsed = decode(ReadTool.Input, { path: "f.ts", offset: "10", limit: "2000" })
    expect(parsed.offset).toBe(10)
    expect(parsed.limit).toBe(2000)
    for (const bad of ["null", "abc", "0", "-1", "1.5"])
      expect(accepts(ReadTool.Input, { path: "f.ts", offset: bad })).toBe(false)
    expect(accepts(ReadTool.Input, { path: "f.ts", limit: "2001" })).toBe(false)
  })

  test("glob and grep share the tolerant result limit", () => {
    expect(decode(GlobTool.Input, { pattern: "*.ts", limit: "12" }).limit).toBe(12)
    expect(decode(GrepTool.Input, { pattern: "x", limit: "50" }).limit).toBe(50)
    for (const bad of ["null", "abc", "0", "101"]) {
      expect(accepts(GlobTool.Input, { pattern: "*.ts", limit: bad })).toBe(false)
      expect(accepts(GrepTool.Input, { pattern: "x", limit: bad })).toBe(false)
    }
  })

  test("task_read limit keeps plain-number parity without NaN poison", () => {
    expect(decode(TaskReadTool.Input, { task_id: "ses_x", limit: "50" }).limit).toBe(50)
    expect(decode(TaskReadTool.Input, { task_id: "ses_x", limit: "2.5" }).limit).toBe(2.5)
    for (const bad of ["null", "abc", ""])
      expect(accepts(TaskReadTool.Input, { task_id: "ses_x", limit: bad })).toBe(false)
  })

  test("apply_patch_chunk offset (copied back from nextOffset)", () => {
    expect(decode(ApplyPatchChunkTool.Input, { action: "begin", offset: "0", patchText: "x" }).offset).toBe(0)
    expect(decode(ApplyPatchChunkTool.Input, { action: "append", offset: "12000" }).offset).toBe(12000)
    for (const bad of ["null", "abc", "-1", "1.5"])
      expect(accepts(ApplyPatchChunkTool.Input, { action: "append", offset: bad })).toBe(false)
  })

  test("context-federation contract depth/limit (code_intel + context_query)", () => {
    const intel = decode(ContextFederationContract.CodeIntelInput, { intent: "search", depth: "3", limit: "100" })
    expect(intel.depth).toBe(3)
    expect(intel.limit).toBe(100)
    expect(decode(ContextFederationContract.ContextQueryInput, { intent: "search", limit: "7" }).limit).toBe(7)
    for (const bad of ["null", "abc", "0", "101"]) {
      expect(accepts(ContextFederationContract.CodeIntelInput, { intent: "search", limit: bad })).toBe(false)
      expect(accepts(ContextFederationContract.ContextQueryInput, { intent: "search", limit: bad })).toBe(false)
    }
    expect(accepts(ContextFederationContract.CodeIntelInput, { intent: "search", depth: "4" })).toBe(false)
  })
})
