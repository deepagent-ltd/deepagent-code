import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DeepAgentCodeHome } from "../../src/deepagent/workspace"
import { openUserGlobalStore, projectIdForWorkspace } from "../../src/deepagent/durable-knowledge-store"
import { EnvironmentFactAdoption } from "../../src/deepagent/environment-fact-adoption"
import { matchStaleFacts } from "../../src/deepagent/environment-fact"

let root: string
let home: DeepAgentCodeHome
const WORKSPACE = "/work/milvus"
const NOW = "2026-07-09T00:00:00Z"

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "envfact-adopt-"))
  home = new DeepAgentCodeHome(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const seedProvisional = (description: string, body: object) =>
  openUserGlobalStore(root).stageProvisionalEnvironmentFact({
    description,
    body: JSON.stringify(body),
    provenance: { source: "human" },
  })

const adoptionFor = (workspacePath = WORKSPACE) => {
  const paths = home.ensureProject(projectIdForWorkspace(workspacePath), workspacePath)
  return new EnvironmentFactAdoption(root, paths, workspacePath)
}

describe("V3.8.1 §G.5 use-gate resolve/adopt/reject", () => {
  test("a provisional fact starts as pending (ask), not adopted", () => {
    seedProvisional("milvus test server", { host: "10.0.0.4", port: 19530, last_confirmed_at: NOW })
    const a = adoptionFor()
    const { adopted, pending } = a.resolve()
    expect(adopted.length).toBe(0)
    expect(pending.length).toBe(1)
    expect(pending[0]!.body?.host).toBe("10.0.0.4")
  })

  test("adopt moves the fact to silently-used and never asks again", () => {
    const fact = seedProvisional("milvus test server", { host: "10.0.0.4", port: 19530, last_confirmed_at: NOW })
    const a = adoptionFor()
    a.adopt(fact.id, NOW)
    const { adopted, pending } = a.resolve()
    expect(pending.length).toBe(0)
    expect(adopted.map((f) => f.fact_id)).toEqual([fact.id])
  })

  test("reject omits the fact and is isolated to this project", () => {
    const fact = seedProvisional("milvus test server", { host: "10.0.0.4", last_confirmed_at: NOW })
    adoptionFor("/work/projA").reject(fact.id, NOW)
    // project A: skipped entirely
    const a = adoptionFor("/work/projA").resolve()
    expect(a.adopted.length + a.pending.length).toBe(0)
    // project B: still pending (isolation — other projects unaffected)
    const b = adoptionFor("/work/projB").resolve()
    expect(b.pending.map((f) => f.fact_id)).toEqual([fact.id])
  })
})

describe("V3.8.1 §G.5 modify", () => {
  test("global correction updates the user-global doc and adopts it", () => {
    const fact = seedProvisional("milvus test server", { host: "10.0.0.4", port: 19530, last_confirmed_at: NOW })
    const a = adoptionFor()
    const { updatedId } = a.modify({
      factId: fact.id,
      description: "milvus test server",
      body: { host: "10.0.0.5", port: 19530, last_confirmed_at: "2026-07-09T12:00:00Z" },
      mode: "global",
      now: NOW,
    })
    // the correction is visible to a DIFFERENT project's use-gate (global scope)
    const other = adoptionFor("/work/other").resolve()
    const seen = other.pending.find((f) => f.fact_id === updatedId)
    expect(seen?.body?.host).toBe("10.0.0.5")
  })

  test("project override writes a local fact, leaving global untouched for others", () => {
    const fact = seedProvisional("milvus test server", { host: "10.0.0.4", last_confirmed_at: NOW })
    const a = adoptionFor()
    const { updatedId } = a.modify({
      factId: fact.id,
      description: "milvus test server (local)",
      body: { host: "127.0.0.1", last_confirmed_at: NOW },
      mode: "project",
      now: NOW,
    })
    expect(updatedId).not.toBe(fact.id)
    // this project uses the override host
    const mine = adoptionFor().resolve()
    expect(mine.adopted.find((f) => f.fact_id === updatedId)?.body?.host).toBe("127.0.0.1")
    // another project still sees the ORIGINAL global fact as pending
    const other = adoptionFor("/work/other").resolve()
    expect(other.pending.find((f) => f.fact_id === fact.id)?.body?.host).toBe("10.0.0.4")
  })
})

describe("V3.8.1 §G.6 connection-failure staleness", () => {
  test("matchStaleFacts flags an adopted endpoint named in a connection error", () => {
    const adopted = [{ fact_id: "f1", host: "10.0.0.4", port: 19530 }]
    const hit = matchStaleFacts("dial tcp 10.0.0.4:19530: connect: connection refused", adopted)
    expect(hit).toEqual(["f1"])
  })

  test("non-connection errors do not flag anything", () => {
    const adopted = [{ fact_id: "f1", host: "10.0.0.4", port: 19530 }]
    expect(matchStaleFacts("TypeError: undefined is not a function", adopted)).toEqual([])
  })

  test("a different host in the error does not flag the fact", () => {
    const adopted = [{ fact_id: "f1", host: "10.0.0.4", port: 19530 }]
    expect(matchStaleFacts("ECONNREFUSED 10.9.9.9:6379", adopted)).toEqual([])
  })

  test("marking stale drops the fact from the pending set and flags degraded", () => {
    const fact = seedProvisional("flaky milvus", { host: "10.0.0.4", port: 19530, last_confirmed_at: NOW })
    const a = adoptionFor()
    a.adopt(fact.id, NOW)
    // simulate the runtime hook: mark stale via the store
    expect(openUserGlobalStore(root).markEnvironmentFactStale(fact.id)).toBe(true)
    const resolved = adoptionFor().resolve()
    const shown = [...resolved.adopted, ...resolved.pending].find((f) => f.fact_id === fact.id)
    expect(shown?.degraded).toBe(true)
  })
})
