import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// M2 (S1-v3.4) acceptance (f): the source-classification path must not guess
// provenance from the tool name string anymore, and the gateway's 5 hard-matched
// `mcp_or_namespaced_tool` tokens must remain untouched (token unchanged; only the
// value now comes from trusted explicit provenance).

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..") // packages/deepagent-code
const coreRoot = path.resolve(root, "../core")

const read = (p: string) => readFileSync(p, "utf8")

describe("M2 provenance — no string-guess residue", () => {
  test("request.ts source classification does not reverse-engineer from tool name", () => {
    const src = read(path.join(root, "src/session/llm/request.ts"))
    // The two old guesses must be gone from the classification path.
    expect(src).not.toContain('name.includes(":") ? "mcp_or_namespaced_tool"')
    expect(src).not.toContain('name.includes(":") ? ("mcp" as const)')
    // No name-splitting heuristic for server grouping.
    expect(src).not.toContain("ref.name.split(sep)")
    // It must read explicit provenance instead.
    expect(src).toContain("ToolProvenance.get")
  })

  test("gateway keeps all 5 mcp_or_namespaced_tool hard-matches intact", () => {
    const src = read(path.join(coreRoot, "src/agent-gateway.ts"))
    const occurrences = src.split('"mcp_or_namespaced_tool"').length - 1
    // 1125 (count), 2245 (capability index), 2255 (filter), 2264 + 2455 (hasMcpTools).
    expect(occurrences).toBeGreaterThanOrEqual(5)
  })
})
