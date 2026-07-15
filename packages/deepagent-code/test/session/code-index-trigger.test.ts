import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DeepAgentGraphQuery } from "@deepagent-code/core/deepagent/index"
import { CodeIndexTrigger } from "../../src/session/code-index-trigger"

// V3.8 Phase 3 (v3.8.1 §B.3): proves the code-indexer TRIGGER end-to-end — a lightweight index pass
// over a real workspace writes code_symbol nodes into the SAME per-project store GraphQuery unions,
// so the nodes are immediately query-hittable (before this, indexFiles had zero prod callers and no
// code_symbol node ever reached the graph).

let base: string
let work: string

const withFs = <A>(f: (fsys: FSUtil.Interface) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      return yield* f(fsys)
    }).pipe(Effect.provide(FSUtil.defaultLayer)),
  )

const graphIds = (workspacePath: string, task: string): readonly string[] =>
  Effect.runSync(
    Effect.gen(function* () {
      const svc = yield* DeepAgentGraphQuery.Service
      const result = yield* svc.query({ workspacePath, task })
      return (result.byType["code_symbol"] ?? []).map((h) => h.doc.description)
    }).pipe(Effect.provide(DeepAgentGraphQuery.layer)),
  )

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-idx-base-"))
  work = mkdtempSync(path.join(tmpdir(), "deepagent-idx-work-"))
  // Configure the shared knowledge-source base so the trigger's projectStoreFor + GraphQuery's
  // storesForWorkspace resolve the SAME cached store instance under this temp base.
  AgentGateway.DeepAgentKnowledgeSource.configure(base)
})
afterEach(() => {
  AgentGateway.DeepAgentKnowledgeSource.invalidateCache()
  rmSync(base, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

describe("CodeIndexTrigger (Phase 3 trigger)", () => {
  test("indexes real workspace files and they are GraphQuery-hittable", async () => {
    mkdirSync(path.join(work, "src"), { recursive: true })
    writeFileSync(path.join(work, "src", "retry.ts"), "export function retryWithBackoff() { return 42 }")
    writeFileSync(path.join(work, "src", "pagination.ts"), "export function paginate(items) { return items }")
    // A non-code file + an excluded dir must NOT be indexed.
    writeFileSync(path.join(work, "README.md"), "docs about retryWithBackoff")
    mkdirSync(path.join(work, "node_modules", "pkg"), { recursive: true })
    writeFileSync(path.join(work, "node_modules", "pkg", "index.ts"), "export const dep = 1")

    const result = await withFs((fsys) => CodeIndexTrigger.indexWorkspace({ workspacePath: work, fsys }))
    expect(result.created).toBe(2)

    // GraphQuery (which unions knowledge-source's cached project store) finds the indexed code node.
    const hits = graphIds(work, "retry backoff")
    expect(hits).toContain("src/retry.ts")
    // Excluded / non-code paths are absent.
    expect(hits).not.toContain("node_modules/pkg/index.ts")
    expect(hits).not.toContain("README.md")
  })

  test("re-running is idempotent — no new nodes (T4.1: mtime-unchanged files are skipped without reading)", async () => {
    writeFileSync(path.join(work, "a.ts"), "export const a = 1")
    const first = await withFs((fsys) => CodeIndexTrigger.indexWorkspace({ workspacePath: work, fsys }))
    expect(first.created).toBe(1)
    // Second pass: the file's mtime is unchanged since the first pass recorded it, so T4.1's mtime gate
    // skips the READ + HASH entirely — the file never reaches indexFiles, so it is neither created nor
    // counted as "unchanged" (the whole point: zero I/O, zero new versions). The node still exists.
    const second = await withFs((fsys) => CodeIndexTrigger.indexWorkspace({ workspacePath: work, fsys }))
    expect(second.created).toBe(0)
    expect(second.updated).toBe(0)
    // The already-indexed node is still GraphQuery-hittable (not dropped by the skip).
    expect(graphIds(work, "const a")).toContain("a.ts")
  })

  test("T4.1: a genuine content change (with a bumped mtime) is re-read and re-indexed", async () => {
    const file = path.join(work, "b.ts")
    writeFileSync(file, "export const b = 1")
    const first = await withFs((fsys) => CodeIndexTrigger.indexWorkspace({ workspacePath: work, fsys }))
    expect(first.created).toBe(1)
    // Rewrite the content AND push mtime forward (a real edit does both) — the mtime no longer matches
    // the recorded value, so the file is re-read and the content-sha gate sees a genuine change → update.
    writeFileSync(file, "export const b = 2 // changed")
    const future = new Date(Date.now() + 5_000)
    utimesSync(file, future, future)
    const second = await withFs((fsys) => CodeIndexTrigger.indexWorkspace({ workspacePath: work, fsys }))
    expect(second.updated).toBe(1)
    expect(second.created).toBe(0)
  })

  test("default-safe: a workspace with no code files yields an empty no-op result (no throw)", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "deepagent-idx-empty-"))
    try {
      const result = await withFs((fsys) => CodeIndexTrigger.indexWorkspace({ workspacePath: empty, fsys }))
      expect(result).toEqual({ nodeIds: [], created: 0, updated: 0, unchanged: 0, edgesCreated: 0, outcomes: [] })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
