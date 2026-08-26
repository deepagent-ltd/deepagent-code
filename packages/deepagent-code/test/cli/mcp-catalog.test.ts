import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

// PARITY-004 quick-win regression: `mcp catalog` mirrors the GUI preset catalog
// (groups/mcp.ts `catalog` endpoint consumed by dialog-add-mcp.tsx). Listing is
// metadata only — nothing connects — so the fixture needs no LLM traffic.
describe("deepagentCode mcp catalog (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "lists the vetted preset catalog as JSON",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.spawn(["mcp", "catalog", "--format", "json"])
        deepagentCode.expectExit(result, 0)

        const entries = JSON.parse(result.stdout) as Array<{
          id: string
          title: string
          transport: string
          riskTier: string
          credentials: Array<{ key: string }>
        }>
        const ids = entries.map((entry) => entry.id)
        expect(ids).toContain("github")
        expect(ids).toContain("filesystem")

        for (const entry of entries) {
          expect(["local", "remote"]).toContain(entry.transport)
          expect(["read_only", "write_guarded", "external_fetch"]).toContain(entry.riskTier)
          expect(entry.title.length).toBeGreaterThan(0)
        }

        const github = entries.find((entry) => entry.id === "github")!
        expect(github.credentials.some((credential) => credential.key.length > 0)).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints a human-readable table by default",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.spawn(["mcp", "catalog"])
        deepagentCode.expectExit(result, 0)
        const output = result.stdout + result.stderr
        expect(output).toContain("github")
        expect(output).toContain("GitHub")
      }),
    60_000,
  )
})
