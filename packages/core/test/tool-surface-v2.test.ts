import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { builtinToolNames } from "@deepagent-code/core/tool/builtins"
import { DeepAgentCodeToolInventory } from "@deepagent-code/core/system-context/capability-manifest"

// RI-113 (design §1.2): the Core V2 tool surface has exactly one machine-readable
// authority — `DeepAgentCodeToolInventory`, pinned to `builtinToolNames` by the
// exact gate. This file is the anti-drift guard for the V1→V2 tool matrix: renamed
// tools keep only their V2 names, V1-only capabilities stay absent until an explicit
// migration lands, and removed dead declarations cannot silently return.

const coreRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")
const exists = (rel: string): boolean => existsSync(path.join(coreRoot, rel))

const allSources = (): ReadonlyArray<string> => {
  const walk = (dir: string): string[] =>
    readdirSync(path.join(coreRoot, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : [],
    )
  return walk(".").map((file) => readFileSync(path.join(coreRoot, file), "utf8"))
}

describe("RI-113 dead declaration removal proof", () => {
  test("the unwired V2 config schema modules no longer exist", () => {
    expect(exists("config/mcp.ts")).toBe(false)
    expect(exists("config/lsp.ts")).toBe(false)
  })

  test("the removed todowrite tool module no longer exists", () => {
    expect(exists("tool/todowrite.ts")).toBe(false)
  })

  test("no src file references the removed modules or their namespaces", () => {
    const sources = allSources()
    expect(sources.some((text) => /ConfigMCP\b|ConfigLSP\b/.test(text))).toBe(false)
    expect(sources.some((text) => /TodoWriteTool\b/.test(text))).toBe(false)
  })
})

describe("RI-113 V1→V2 tool surface guard", () => {
  test("V1 renamed tools exist only under their V2 names", () => {
    const renamed: ReadonlyArray<readonly [string, string]> = [
      ["shell", "bash"],
      ["fetch", "webfetch"],
      ["search", "websearch"],
      ["patch", "apply_patch"],
      ["planwrite", "plan"],
    ]
    for (const [v1, v2] of renamed) {
      expect(builtinToolNames.has(v1)).toBe(false)
      expect(DeepAgentCodeToolInventory.toolNames.has(v1)).toBe(false)
      expect(builtinToolNames.has(v2)).toBe(true)
      expect(DeepAgentCodeToolInventory.toolNames.has(v2)).toBe(true)
    }
  })

  test("RI-26 W2 explicit migrations are present on the V2 surface", () => {
    // The delegation tool (549a1a218), the read-only git leaf, and the chunked-patch transaction
    // tool (129f45b80) are explicitly migrated; their V1 modules remain for legacy profiles.
    for (const name of ["task", "git_read", "apply_patch_chunk"]) {
      expect(builtinToolNames.has(name)).toBe(true)
      expect(DeepAgentCodeToolInventory.toolNames.has(name)).toBe(true)
    }
  })

  test("V1-only capabilities stay absent from the V2 surface until an explicit migration", () => {
    const deferred = [
      // V1 durable task-run management family (V2 task is one-shot/resume keyed by session id;
      // the durable task_runs store + recovery surface has no V2 counterpart yet)
      "task_status",
      "task_read",
      "task_close",
      "task_recovery",
      // V1 workflow helpers with no V2 consumer
      "pr_finalize",
      "dismiss_validation",
      "spectool",
      // V1 flag-gated diagnostics (default OFF in V1, no V2 surface)
      "profile",
      "debug",
      "query_log",
      // V1 experimental LSP tool (config field `lsp` is fail-closed in V2)
      "lsp",
      // V1 activity facade (default OFF in V1)
      "activity_start",
      "activity_status",
      "activity_result",
      "activity_control",
      // removed LLM-facing todo writer (superseded by `plan`)
      "todowrite",
      // V1 error placeholder, never a real tool
      "invalid",
    ]
    for (const name of deferred) {
      expect(builtinToolNames.has(name)).toBe(false)
      expect(DeepAgentCodeToolInventory.toolNames.has(name)).toBe(false)
    }
  })

  test("the V2-only capability tools and the conditional graph pair are present", () => {
    // code_intel/context_query are additionally gated at runtime by the
    // context_query_tools_v2 flag plus ContextToolRuntime availability.
    for (const name of ["capability_search", "capability_load", "code_intel", "context_query"]) {
      expect(builtinToolNames.has(name)).toBe(true)
      expect(DeepAgentCodeToolInventory.toolNames.has(name)).toBe(true)
    }
  })
})
