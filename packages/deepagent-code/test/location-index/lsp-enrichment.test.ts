import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { LSP } from "../../src/lsp/lsp"
import { make } from "../../src/code-intelligence/lsp-enrichment"

describe("LiveCodeLSPEnrichment", () => {
  test("reports a missing server without treating an empty result as ready", async () => {
    const result = await Effect.runPromise(make({
      root: "/workspace",
      lsp: service({ status: () => Effect.succeed([]) }),
      timeoutMs: 100,
    }).enrich({ intent: "search", query: "target", limit: 10 }))

    expect(result).toEqual({ state: "unavailable", reasonCode: "lsp_unavailable", observations: [] })
  })

  test("normalizes connected workspace symbols into Location-relative observations", async () => {
    const root = path.resolve("/workspace")
    const result = await Effect.runPromise(make({
      root,
      lsp: service({
        status: () => Effect.succeed([{ id: "ts", name: "ts", root: "", status: "connected" }]),
        workspaceSymbol: () => Effect.succeed([{
          name: "target",
          kind: 12,
          location: {
            uri: pathToFileURL(path.join(root, "src", "target.ts")).href,
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
          },
        }]),
      }),
      timeoutMs: 100,
    }).enrich({ intent: "search", query: "target", limit: 10 }))

    expect(result).toEqual({
      state: "ready",
      observations: [{
        path: "src/target.ts",
        startLine: 5,
        startCharacter: 2,
        endLine: 5,
        endCharacter: 8,
        symbol: "target",
        kind: 12,
      }],
    })
  })

  test("contains an LSP timeout as a typed degradation", async () => {
    const result = await Effect.runPromise(make({
      root: "/workspace",
      lsp: service({
        status: () => Effect.succeed([{ id: "ts", name: "ts", root: "", status: "connected" }]),
        workspaceSymbol: () => Effect.never,
      }),
      timeoutMs: 5,
    }).enrich({ intent: "search", query: "target", limit: 10 }))

    expect(result).toEqual({ state: "degraded", reasonCode: "source_timeout", observations: [] })
  })
})

function service(overrides: Partial<LSP.Interface>) {
  return {
    status: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    ...overrides,
  } as unknown as LSP.Interface
}
