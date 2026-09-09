import { describe, expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// C4-07 — dead-code removal proof for the legacy context-admission loader. The three
// functions (loadOnDemand / admitIndexRefs / formatPackIndexSection) had zero production
// callers (the "comment-useful, production-no-caller" gap); they were removed and the
// deepagent re-export + now-obsolete S6 tests were dropped. This proves the removal is
// complete (grep-based) so the gap can never silently return.

const coreRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src")
const src = (rel: string): string => readFileSync(path.join(coreRoot, rel), "utf8")
const exists = (rel: string): boolean => existsSync(path.join(coreRoot, rel))

describe("C4-07 dead-code removal proof (legacy context-admission loader)", () => {
  test("the context-admission module file no longer exists", () => {
    expect(exists("deepagent/context-admission.ts")).toBe(false)
  })

  test("the deepagent index no longer re-exports context-admission", () => {
    expect(src("deepagent/index.ts")).not.toContain("context-admission")
    expect(src("deepagent/index.ts")).not.toContain("DeepAgentContextAdmission")
  })

  test("no src file references the removed loader symbols", () => {
    expect(src("deepagent/index.ts")).not.toMatch(
      /loadOnDemand|admitIndexRefs|formatPackIndexSection|ContextAdmissionGate/i,
    )
  })

  test("the inactive domain_pack_load prototype cannot be advertised by the production layer", () => {
    const prototype = src("deepagent/domain-pack-load.ts")
    const production = src("system-context/capability-load-tool.ts")
    const builtins = src("tool/builtins.ts")
    expect(prototype).toContain("loadDomainPack")
    expect(prototype).toContain("DEFAULT_MAX_ACTIVE_PACK_REFS")
    expect(production.slice(production.indexOf("export const layer"))).not.toContain("[domainPackLoadName]")
    expect(builtins).not.toContain("CapabilityLoadTool.domainPackLoadName")
  })
})
