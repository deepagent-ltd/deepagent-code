import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { retrieve } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"

const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }

const withSeededKnowledge = (fn: () => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), "deepagent-retrieval-isolation-"))
  try {
    knowledgeSource.configure(dir)
    seedCoreKnowledge(openUserGlobalStore(dir))
    fn()
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

const selectedRefs = (userRequest: string) => {
  const result = retrieve({ mode: "max", task: task(userRequest), tools, round: 1, previousFailures: 0 })
  return [...(result?.strategyRefs ?? []), ...(result?.methodologyRefs ?? [])]
}

const expectDomainSelection = (
  userRequest: string,
  expected: readonly string[],
  excluded: readonly string[] = ["gpu"],
) => {
  const refs = selectedRefs(userRequest)
  for (const token of expected) expect(refs.some((ref) => ref.includes(token))).toBe(true)
  for (const token of excluded) expect(refs.some((ref) => ref.includes(token))).toBe(false)
}

describe("domain pack retrieval isolation", () => {
  test("gpu prompts select gpu refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection("optimize the sgemm cuda kernel for shared memory", ["gpu"], [])
    })
  })

  test("web UI prompts select frontend/web refs and exclude gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection("fix CSS responsive text overlap and browser console errors in the web UI", [
        "frontend-web",
      ])
    })
  })

  test("backend API prompts select backend/api refs and exclude gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection("change REST endpoint request validation and OpenAPI response error shape", ["backend-api"])
    })
  })

  test("database prompts select database/sql refs and exclude gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection(
        "add database migration with unique constraint backfill transaction rollback and explain plan",
        ["database"],
      )
    })
  })

  test("security prompts select risk/security refs and exclude gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection("fix authorization bypass and SQL injection risk at server trust boundary", ["security"])
    })
  })

  test("privacy prompts select risk/privacy refs and exclude gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection("redact PII from logs and enforce data minimization for user export", ["privacy"])
    })
  })

  test("production prompts select risk/production refs and exclude gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection(
        "prepare production deployment rollback plan for irreversible migration and traffic shift",
        ["production"],
      )
    })
  })

  test("TypeScript and JavaScript prompts select language/runtime refs instead of gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection("fix TypeScript typecheck module resolution generic inference and exported types", [
        "typescript",
      ])
      expectDomainSelection("fix JavaScript ESM CJS package scripts Node browser runtime issue", ["javascript"])
    })
  })

  test("Vue prompts select Vue/frontend refs and exclude gpu-only refs", () => {
    withSeededKnowledge(() => {
      expectDomainSelection("fix Vue Composition API ref computed template binding hydration issue", ["frontend_vue"])
    })
  })
})
