import { describe, expect, test } from "bun:test"
import {
  buildDeterministicResult,
  classifyDeterministicTask,
  deterministicToolPolicy,
  isReadOnlySql,
  shouldActivateQueryControls,
} from "../../src/deepagent/deterministic-task"
import { configureRegistry, discover, score } from "../../src/deepagent/domain-pack-registry"
import type { ExtendedProblemProfile } from "../../src/deepagent/domain-pack-registry"

const profile = (over: Partial<ExtendedProblemProfile> = {}): ExtendedProblemProfile => ({
  scenario_mode: "intelligence",
  agent_strength: "high",
  task_kind: "explain",
  code_domains: ["code"],
  business_domains: [],
  platforms: [],
  languages: [],
  frameworks: [],
  data_classes: [],
  risk_markers: [],
  repo_signals: [],
  round_signals: [],
  user_overrides: [],
  ...over,
})

describe("deterministic task controls (docs/38)", () => {
  test("classifies Chinese query/count requests as deterministic and read-only", () => {
    const input = { raw: "请查一下数据库里有多少条用户记录" }
    expect(classifyDeterministicTask(input)).toBe("deterministic_query")
    expect(shouldActivateQueryControls(input)).toBe(true)
    expect(deterministicToolPolicy(input)).toMatchObject({
      task_kind: "deterministic_query",
      read_only: true,
    })
    expect(deterministicToolPolicy(input).denied_actions).toContain("update")
  })

  test("does not activate query controls for mutation requests", () => {
    const input = { raw: "请删除这些旧记录并更新数据库索引" }
    expect(classifyDeterministicTask(input)).toBe("mutation_request")
    expect(shouldActivateQueryControls(input)).toBe(false)
    expect(deterministicToolPolicy(input).read_only).toBe(false)
    expect(shouldActivateQueryControls({ ...input, activePackIds: ["code.query"] })).toBe(false)
  })

  test("SQL read-only detection separates inspection from mutation", () => {
    expect(isReadOnlySql("select count(*) from users")).toBe(true)
    expect(isReadOnlySql("EXPLAIN SELECT * FROM users")).toBe(true)
    expect(isReadOnlySql("update users set active = false")).toBe(false)
    expect(isReadOnlySql("drop table users")).toBe(false)
  })

  test("deterministic result summaries are bounded without another model call", () => {
    const result = buildDeterministicResult(
      {
        kind: "query",
        source: "tool",
        commandOrQuery: "rg TODO",
        resultSummary: "x".repeat(20),
        resultRef: "run:r1:tool:rg",
        createdAt: "2026-06-22T00:00:00.000Z",
      },
      { maxSummaryChars: 8 },
    )
    expect(result).toEqual({
      schema_version: "deepagent-code.deterministic_result.v1",
      kind: "query",
      source: "tool",
      command_or_query: "rg TODO",
      result_summary: "xxxxxxxx",
      result_ref: "run:r1:tool:rg",
      truncated: true,
      created_at: "2026-06-22T00:00:00.000Z",
    })
  })

  test("code.query built-in pack is discoverable and activates only for read-only query signals", () => {
    configureRegistry(undefined)
    const packs = discover()
    expect(packs.map((pack) => pack.id)).toContain("code.query")

    const hit = score(profile({ code_domains: ["query"], repo_signals: ["统计当前日志里有多少 ERROR"] }), packs)
    expect(hit.find((score) => score.packId === "code.query")?.score).toBeGreaterThanOrEqual(0.5)

    const miss = score(profile({ repo_signals: ["更新数据库并删除旧记录"] }), packs)
    expect(miss.find((score) => score.packId === "code.query")?.score).toBe(0)
  })
})
