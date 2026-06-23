import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

// [v3-2-architecture-relayer] guardrail: after the control plane moved into core, modules under
// core/src/deepagent must REUSE core facilities instead of re-implementing parallel wheels. This
// test greps the source so a regression (a second project-id hash, a stray storage-root resolver,
// a bare process spawn) fails CI instead of silently re-introducing the dual-source bugs we fixed.

const deepagentDir = path.join(__dirname, "..", "..", "src", "deepagent")

const sourceFiles = (): { file: string; text: string }[] =>
  readdirSync(deepagentDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(path.join(deepagentDir, f), "utf8") }))

describe("no parallel implementations in core/src/deepagent", () => {
  test("the project-id hash lives in exactly one file (durable-knowledge-store) — single derivation", () => {
    // docs/34 §8: every caller must delegate to projectIdForWorkspace. A second inline
    // `project_${createHash(...)}` is the dual-derivation bug (write side / read side disagree).
    const offenders = sourceFiles()
      .filter(({ text }) => /project_\$\{\s*createHash/.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual(["durable-knowledge-store.ts"])
  })

  test("storage-root resolution lives only in workspace.ts", () => {
    // [storage-root-dual-resolver]: a second resolveDeepAgentCodeHome (or an inline
    // ~/.deepagent/code path build) is exactly the divergence that wrote tests into the real home.
    const offenders = sourceFiles()
      .filter(({ file, text }) => file !== "workspace.ts" && /resolveDeepAgentCodeHome/.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  test("no bare process spawning in core/src/deepagent (pure control plane)", () => {
    // External-process execution belongs in the deepagent-code layer (validation-exec / git-
    // groundtruth), never in the core control plane modules.
    const offenders = sourceFiles()
      .filter(({ text }) => /\bBun\.spawn\b|\bchild_process\b|\bexecSync\b|\bspawnSync\b/.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  test("no global crypto.randomUUID without an explicit import (P1-1)", () => {
    // Relying on the runtime global `crypto` is fragile; randomUUID must be imported from
    // node:crypto. Catch a bare `crypto.randomUUID(` in any file that does not import crypto.
    const offenders = sourceFiles()
      .filter(({ text }) => /\bcrypto\.randomUUID\s*\(/.test(text) && !/from\s+"node:crypto"/.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  test("durable knowledge has a single body — no parallel memory-store / project-memory store (P0-S)", () => {
    // docs/34 §P0-S: the ONE durable knowledge body is the DocumentStore (durable-knowledge-store.ts
    // over document-store.ts). The retired flat stores (`memory-store.jsonl`, the ProjectMemoryIndex)
    // must never return: a parallel body splits the redaction/approval gate from the retrieval path —
    // the exact bug that made learned knowledge unretrievable. Catch re-introduction at the source.
    const stripComments = (text: string) =>
      text
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n")
    const offenders = sourceFiles()
      .map(({ file, text }) => ({ file, text: stripComments(text) }))
      .filter(
        ({ text }) =>
          /["'`][^"'`]*(memor(y|ies)|strateg(y|ies)|anti-?patterns?)[^"'`]*\.jsonl/i.test(text) ||
          /\bnew\s+MemoryStore\b|\bProjectMemoryIndex\b/.test(text) ||
          /from\s+["']\.\/(memory-store|project-memory)["']/.test(text),
      )
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})
