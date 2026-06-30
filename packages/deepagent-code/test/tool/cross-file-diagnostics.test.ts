import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { crossFileCallerDiagnostics } from "../../src/tool/cross-file-diagnostics"
import type { LSP } from "@/lsp/lsp"

// L4 (S1-v3.4) §1 acceptance (a): after a change, diagnostics in *referencing* files are
// surfaced (bounded). Gated to high+ — a NO-OP in lightweight (general/direct) modes.

const CHANGED = "/repo/src/changed.ts"
const CALLER = "/repo/src/caller.ts"

// A mock LSP that says: changed.ts has one top-level symbol, referenced from caller.ts,
// and caller.ts now has an error diagnostic. Everything else is empty.
const mockLsp = (overrides: Partial<LSP.Interface> = {}): LSP.Interface =>
  ({
    documentSymbol: () =>
      Effect.succeed([{ name: "doStuff", kind: 12, selectionRange: { start: { line: 0, character: 16 } } }] as any),
    references: () => Effect.succeed([{ uri: `file://${CALLER}`, range: { start: { line: 4, character: 2 } } }] as any),
    touchFile: () => Effect.void,
    diagnostics: () =>
      Effect.succeed({
        [CALLER]: [
          {
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
            severity: 1,
            message: "arg count",
          },
        ],
      } as any),
    ...overrides,
  }) as unknown as LSP.Interface

describe("L4 cross-file caller diagnostics", () => {
  test("high mode: surfaces error diagnostics in a referencing file", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const out = await Effect.runPromise(crossFileCallerDiagnostics(mockLsp(), CHANGED, "/repo"))
    expect(out).toContain("referencing file")
    expect(out).toContain("arg count")
    expect(out).toContain("src/caller.ts")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("general mode: NO-OP, returns empty and makes no LSP calls (no regression)", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "general" })
    let called = false
    const spy = mockLsp({
      documentSymbol: () => {
        called = true
        return Effect.succeed([] as any)
      },
    })
    const out = await Effect.runPromise(crossFileCallerDiagnostics(spy, CHANGED, "/repo"))
    expect(out).toBe("")
    expect(called).toBe(false)
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("high mode: changed file's own diagnostics are not double-reported as caller diagnostics", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    // References point back to the changed file only → no other files → empty.
    const selfOnly = mockLsp({
      references: () =>
        Effect.succeed([{ uri: `file://${CHANGED}`, range: { start: { line: 0, character: 0 } } }] as any),
    })
    const out = await Effect.runPromise(crossFileCallerDiagnostics(selfOnly, CHANGED, "/repo"))
    expect(out).toBe("")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })
})
