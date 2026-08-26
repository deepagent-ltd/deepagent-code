import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  DEFAULT_OUTPUT_SCHEMA_BY_AGENT,
  Orchestration,
  OrchestrationSchemas,
  ResearchResult,
  ReviewFinding,
  ReviewResult,
} from "@/agent/schema/orchestration"
import { resolveOutputSchema } from "@/tool/task"

// L3 (v3.8.0 §L3): structured result contract round-trips through Effect Schema decode/encode.
describe("L3 orchestration schemas", () => {
  test("ReviewFinding decode/encode round-trip", () => {
    const finding = {
      severity: "critical" as const,
      category: "correctness" as const,
      file: "src/foo.ts",
      line: 42,
      summary: "off-by-one in loop bound",
      failureScenario: "input list of length N drops the last element",
      confidence: 0.9,
      suggestion: "use <= instead of <",
    }
    const decoded = Schema.decodeUnknownSync(ReviewFinding)(finding)
    expect(decoded.severity).toBe("critical")
    expect(decoded.line).toBe(42)
    const encoded = Schema.encodeSync(ReviewFinding)(decoded)
    expect(encoded).toEqual(finding)
  })

  test("ReviewFinding: line and suggestion are optional", () => {
    const decoded = Schema.decodeUnknownSync(ReviewFinding)({
      severity: "low",
      category: "convention",
      file: "src/bar.ts",
      summary: "naming",
      failureScenario: "n/a",
      confidence: 0.3,
    })
    expect(decoded.line).toBeUndefined()
    expect(decoded.suggestion).toBeUndefined()
  })

  test("ReviewResult round-trips with a verdict and findings", () => {
    const value = {
      findings: [
        {
          severity: "high" as const,
          category: "security" as const,
          file: "src/auth.ts",
          summary: "missing authz check",
          failureScenario: "unauthenticated request reaches admin route",
          confidence: 0.8,
        },
      ],
      verdict: "block" as const,
    }
    const decoded = Schema.decodeUnknownSync(ReviewResult)(value)
    expect(decoded.verdict).toBe("block")
    expect(decoded.findings).toHaveLength(1)
    expect(Schema.encodeSync(ReviewResult)(decoded)).toEqual(value)
  })

  test("ResearchResult round-trips", () => {
    const value = {
      module: "auth",
      mechanism: "session tokens verified per request",
      keyFiles: [{ path: "src/auth.ts", role: "token verification" }],
      interfaces: ["verifyToken(req)"],
      risks: ["token replay"],
      openQuestions: ["rotation policy?"],
    }
    const decoded = Schema.decodeUnknownSync(ResearchResult)(value)
    expect(decoded.module).toBe("auth")
    expect(decoded.keyFiles[0]!.role).toBe("token verification")
    expect(Schema.encodeSync(ResearchResult)(decoded)).toEqual(value)
  })

  test("invalid input fails decode (schema is enforced, not best-effort)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ReviewFinding)({
        severity: "not-a-severity",
        category: "correctness",
        file: "x",
        summary: "y",
        failureScenario: "z",
        confidence: 0.5,
      }),
    ).toThrow()
  })

  test("DEFAULT_OUTPUT_SCHEMA_BY_AGENT wires reviewer→ReviewResult, researcher→ResearchResult", () => {
    expect(DEFAULT_OUTPUT_SCHEMA_BY_AGENT.reviewer).toBe("ReviewResult")
    expect(DEFAULT_OUTPUT_SCHEMA_BY_AGENT.researcher).toBe("ResearchResult")
  })

  test("OrchestrationSchemas exposes the named schemas and the namespace re-export", () => {
    expect(OrchestrationSchemas.ReviewResult).toBe(ReviewResult)
    expect(OrchestrationSchemas.ResearchResult).toBe(ResearchResult)
    expect(Orchestration.ReviewFinding).toBe(ReviewFinding)
  })
})

// L3: the task tool's output_schema resolver maps names/aliases/raw schemas to a JSON Schema object,
// and returns undefined (⇒ unchanged free-text path) when nothing is requested.
describe("L3 resolveOutputSchema (task tool param)", () => {
  test("undefined ⇒ free-text for an agent with NO registered default", () => {
    // general has no DEFAULT_OUTPUT_SCHEMA_BY_AGENT entry ⇒ unchanged free-text path.
    expect(resolveOutputSchema(undefined, "general")).toBeUndefined()
  })

  // Task 6 (§5 auto-mount): native researcher/reviewer default to their structured schema even when
  // the model omits output_schema, so they always go through the deterministic structured path.
  test("undefined ⇒ auto-mounts the reviewer's default schema (ReviewResult)", () => {
    const schema = resolveOutputSchema(undefined, "reviewer")
    expect(schema).toBeDefined()
    expect(schema?.type).toBe("object")
    expect((schema?.properties as Record<string, unknown>).verdict).toBeDefined()
  })

  test("undefined ⇒ auto-mounts the researcher's default schema (ResearchResult)", () => {
    const schema = resolveOutputSchema(undefined, "researcher")
    expect(schema).toBeDefined()
    expect((schema?.properties as Record<string, unknown>).mechanism).toBeDefined()
  })

  test("explicit schema wins over the auto-mounted default (explicit > auto)", () => {
    // A reviewer explicitly asked to return a ResearchResult must get ResearchResult, not the
    // reviewer default. Auto-mount only fills the gap when nothing was requested.
    const schema = resolveOutputSchema("ResearchResult", "reviewer")
    expect((schema?.properties as Record<string, unknown>).mechanism).toBeDefined()
    expect((schema?.properties as Record<string, unknown>).verdict).toBeUndefined()
    // and a raw object still passes through verbatim for reviewer too
    const raw = { type: "object", properties: { z: { type: "string" } } }
    expect(resolveOutputSchema(raw, "reviewer")).toEqual(raw)
  })

  test("named schema resolves to a JSON Schema object", () => {
    const schema = resolveOutputSchema("ReviewResult", "reviewer")
    expect(schema).toBeDefined()
    expect(schema?.type).toBe("object")
    expect((schema?.properties as Record<string, unknown>).verdict).toBeDefined()
  })

  test('"default"/"auto" resolves to the subagent\'s natural schema', () => {
    const reviewer = resolveOutputSchema("default", "reviewer")
    expect((reviewer?.properties as Record<string, unknown>).verdict).toBeDefined()
    const researcher = resolveOutputSchema("auto", "researcher")
    expect((researcher?.properties as Record<string, unknown>).mechanism).toBeDefined()
  })

  test("a raw JSON Schema object is passed through verbatim", () => {
    const raw = { type: "object", properties: { x: { type: "number" } } }
    expect(resolveOutputSchema(raw, "reviewer")).toEqual(raw)
  })

  test("an unknown name for an agent with no default ⇒ undefined", () => {
    expect(resolveOutputSchema("default", "general")).toBeUndefined()
    expect(resolveOutputSchema("NopeSchema", "reviewer")).toBeUndefined()
  })
})
