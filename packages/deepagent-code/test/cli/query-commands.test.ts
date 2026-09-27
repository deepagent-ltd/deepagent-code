import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

// PARITY-004 long-tail: the unified "query command" template — instance SDK
// client + table/json output. Each command gets at least one subprocess test
// against a fresh isolated home (in-process httpapi, no server needed).
describe("deepagentCode query commands (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "oversight list returns an empty approval queue on a fresh home",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const table = yield* deepagentCode.spawn(["oversight", "list"])
        deepagentCode.expectExit(table, 0, "oversight list")
        expect(table.stdout).toContain("(empty)")

        const json = yield* deepagentCode.spawn(["oversight", "list", "--format", "json"])
        deepagentCode.expectExit(json, 0, "oversight list --format json")
        expect(deepagentCode.expectJsonStdout(json, "oversight list --format json")).toEqual([])
      }),
    60_000,
  )

  cliIt.concurrent(
    "panel status resolves the global default for any session",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const json = yield* deepagentCode.spawn(["panel", "status", "ses_parity000003", "--format", "json"])
        deepagentCode.expectExit(json, 0, "panel status --format json")
        // W3.9 stdout hygiene: whole stdout parses as one JSON payload with no log line pollution.
        const parsed = deepagentCode.expectJsonStdout(json, "panel status --format json") as {
          sessionID: string
          armed: boolean
          explicit: boolean
          rounds: string
        }
        expect(parsed.sessionID).toBe("ses_parity000003")
        expect(typeof parsed.armed).toBe("boolean")
        expect(parsed.explicit).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "review list returns an empty set on a fresh home",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const json = yield* deepagentCode.spawn(["review", "list", "--format", "json"])
        deepagentCode.expectExit(json, 0, "review list --format json")
        expect(deepagentCode.expectJsonStdout(json, "review list --format json")).toEqual([])
      }),
    60_000,
  )

  cliIt.concurrent(
    "wiki list/search return well-formed results (wiki flag on by default)",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        // Full-suite macOS cold starts have exceeded the harness's 30s default;
        // the separate run-timeout suite still enforces prompt subprocess deadlines.
        const list = yield* deepagentCode.spawn(["wiki", "list", "--format", "json"], { timeoutMs: 60_000 })
        deepagentCode.expectExit(list, 0, "wiki list --format json")
        const pages = deepagentCode.expectJsonStdout(list, "wiki list --format json") as Array<{
          docId: string
          type: string
          title: string
        }>
        expect(Array.isArray(pages)).toBe(true)
        // The builtin skill pack projects durable skill pages even on a fresh home.
        expect(pages.length).toBeGreaterThan(0)
        expect(pages[0]!.docId).toBeString()

        const search = yield* deepagentCode.spawn(["wiki", "search", "query", "--format", "json"], {
          timeoutMs: 60_000,
        })
        deepagentCode.expectExit(search, 0, "wiki search --format json")
        const hits = deepagentCode.expectJsonStdout(search, "wiki search --format json") as Array<{
          docId: string
          score: number
        }>
        expect(Array.isArray(hits)).toBe(true)
      }),
    150_000,
  )

  cliIt.concurrent(
    "packs list shows the active set with a snapshot id",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const json = yield* deepagentCode.spawn(["packs", "list", "--format", "json"])
        deepagentCode.expectExit(json, 0, "packs list --format json")
        const parsed = deepagentCode.expectJsonStdout(json, "packs list --format json") as {
          packs: Array<{ id: string }>
          snapshotId: string
        }
        expect(Array.isArray(parsed.packs)).toBe(true)
        expect(parsed.snapshotId).toBeString()

        const all = yield* deepagentCode.spawn(["packs", "list", "--all", "--format", "json"])
        deepagentCode.expectExit(all, 0, "packs list --all --format json")
        const catalog = deepagentCode.expectJsonStdout(all, "packs list --all --format json") as {
          packs: Array<{ id: string; builtin: boolean }>
        }
        expect(catalog.packs.length).toBeGreaterThan(0)
      }),
    60_000,
  )
})
