import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { retrieve } from "../../src/deepagent/knowledge-retriever"
import type { ActivateOptions } from "../../src/deepagent/domain-pack"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"
import type { Selection } from "../../src/deepagent/released-snapshot"
import { releasedUserGlobalSelection } from "./released-selection-fixture"

const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }

const withSeededKnowledge = (fn: (releasedSelection: Selection) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), "deepagent-retrieval-isolation-"))
  try {
    knowledgeSource.configure(dir)
    seedCoreKnowledge(openUserGlobalStore(dir))
    fn(releasedUserGlobalSelection(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const task = (userRequest: string): TaskContext => ({
  userRequest,
  taskType: "code_modification",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
})

const selectedRefs = (userRequest: string, releasedSelection: Selection, domainOptions?: ActivateOptions) => {
  const result = retrieve({
    mode: "max",
    task: task(userRequest),
    tools,
    round: 1,
    previousFailures: 0,
    releasedSelection,
    ...(domainOptions ? { domainOptions } : {}),
  })
  return [...(result?.strategyRefs ?? []), ...(result?.methodologyRefs ?? [])]
}

const expectDomainSelection = (
  userRequest: string,
  expected: readonly string[],
  releasedSelection: Selection,
  excluded: readonly string[] = ["gpu"],
) => {
  const refs = selectedRefs(userRequest, releasedSelection)
  for (const token of expected) expect(refs.some((ref) => ref.includes(token))).toBe(true)
  for (const token of excluded) expect(refs.some((ref) => ref.includes(token))).toBe(false)
}

describe("domain pack retrieval isolation", () => {
  test("gpu prompts select gpu refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection("optimize the sgemm cuda kernel for shared memory", ["gpu"], releasedSelection, [])
    })
  })

  test("web UI prompts select frontend/web refs and exclude gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "fix CSS responsive text overlap and browser console errors in the web UI",
        ["frontend-web"],
        releasedSelection,
      )
    })
  })

  test("backend API prompts select backend/api refs and exclude gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "change REST endpoint request validation and OpenAPI response error shape",
        ["backend-api"],
        releasedSelection,
      )
    })
  })

  test("database prompts select database/sql refs and exclude gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "add database migration with unique constraint backfill transaction rollback and explain plan",
        ["database"],
        releasedSelection,
      )
    })
  })

  test("security prompts select risk/security refs and exclude gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "fix authorization bypass and SQL injection risk at server trust boundary",
        ["security"],
        releasedSelection,
      )
    })
  })

  test("privacy prompts select risk/privacy refs and exclude gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "redact PII from logs and enforce data minimization for user export",
        ["privacy"],
        releasedSelection,
      )
    })
  })

  test("production prompts select risk/production refs and exclude gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "prepare production deployment rollback plan for irreversible migration and traffic shift",
        ["production"],
        releasedSelection,
      )
    })
  })

  test("TypeScript and JavaScript prompts select language/runtime refs instead of gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "fix TypeScript typecheck module resolution generic inference and exported types",
        ["typescript"],
        releasedSelection,
      )
      expectDomainSelection(
        "fix JavaScript ESM CJS package scripts Node browser runtime issue",
        ["javascript"],
        releasedSelection,
      )
    })
  })

  test("Vue prompts select Vue/frontend refs and exclude gpu-only refs", () => {
    withSeededKnowledge((releasedSelection) => {
      expectDomainSelection(
        "fix Vue Composition API ref computed template binding hydration issue",
        ["frontend_vue"],
        releasedSelection,
      )
    })
  })

  // FEAT-001: pinned packs (user overrides) must force their refs into the selection even when
  // the task text activates the pack nowhere.
  describe("pinned packs (domainOptions overrides)", () => {
    const genericTask = "rename a local helper function in the user service module"

    test("unpinned generic task does not select gpu refs", () => {
      withSeededKnowledge((releasedSelection) => {
        expectDomainSelection(genericTask, [], releasedSelection, ["gpu"])
      })
    })

    test("legacy single-value override still force-selects the pinned pack refs", () => {
      withSeededKnowledge((releasedSelection) => {
        const refs = selectedRefs(genericTask, releasedSelection, { override: "code.gpu-kernel" })
        expect(refs.some((ref) => ref.includes("gpu"))).toBe(true)
      })
    })

    test("multi-pin overrides force-select every pinned pack's refs", () => {
      withSeededKnowledge((releasedSelection) => {
        const refs = selectedRefs(genericTask, releasedSelection, { overrides: ["code.gpu-kernel"] })
        expect(refs.some((ref) => ref.includes("gpu"))).toBe(true)
      })
    })

    test("override and overrides merge without duplicates", () => {
      withSeededKnowledge((releasedSelection) => {
        const refs = selectedRefs(genericTask, releasedSelection, {
          override: "code.gpu-kernel",
          overrides: ["code.gpu-kernel"],
        })
        expect(refs.some((ref) => ref.includes("gpu"))).toBe(true)
      })
    })
  })
})
