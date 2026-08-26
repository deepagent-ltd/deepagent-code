import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

// PARITY-004 long-tail: `mcp edit` rewrites an EXISTING server entry in place
// (updateMcpConfig semantics). Like add/remove, edits must preserve comments
// and sibling keys (jsonc-parser field-level modify).
describe("deepagentCode mcp edit (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "updates a remote server url/header while preserving comments and siblings",
    ({ home, deepagentCode }) =>
      Effect.gen(function* () {
        const configPath = path.join(home, ".deepagent", "code", "config.jsonc")
        const seeded = [
          "{",
          "  // user comment must survive the edit",
          '  "theme": "dark",',
          '  "mcp": {',
          '    "github": {',
          '      "type": "remote",',
          '      "url": "https://old.example.com/mcp",',
          '      "headers": { "x-token": "keep-me" }',
          "    },",
          '    "keeper": {',
          '      "type": "local",',
          '      "command": ["echo", "hi"]',
          "    }",
          "  }",
          "}",
        ].join("\n")
        yield* Effect.promise(async () => {
          await mkdir(path.dirname(configPath), { recursive: true })
          await writeFile(configPath, seeded, "utf8")
        })

        const result = yield* deepagentCode.spawn([
          "mcp",
          "edit",
          "github",
          "--url",
          "https://new.example.com/mcp",
          "--header",
          "Authorization=Bearer abc",
        ])
        deepagentCode.expectExit(result, 0)

        const text = yield* Effect.promise(() => readFile(configPath, "utf8"))
        expect(text).toContain("// user comment must survive the edit")
        const config = parse(text)
        expect(config.theme).toBe("dark")
        expect(config.mcp.github).toEqual({
          type: "remote",
          url: "https://new.example.com/mcp",
          headers: { "x-token": "keep-me", Authorization: "Bearer abc" },
        })
        expect(config.mcp.keeper).toEqual({ type: "local", command: ["echo", "hi"] })
      }),
    60_000,
  )

  cliIt.concurrent(
    "merges environment into a local server defined in the project config",
    ({ home, deepagentCode }) =>
      Effect.gen(function* () {
        const configPath = path.join(home, "deepagent-code.json")
        const seeded = [
          "{",
          '  "mcp": {',
          '    "fs-server": {',
          '      "type": "local",',
          '      "command": ["echo", "hi"],',
          '      "environment": { "EXISTING": "1" }',
          "    }",
          "  }",
          "}",
        ].join("\n")
        yield* Effect.promise(() => writeFile(configPath, seeded, "utf8"))

        const result = yield* deepagentCode.spawn(["mcp", "edit", "fs-server", "--env", "DEBUG=true"])
        deepagentCode.expectExit(result, 0)

        const config = parse(yield* Effect.promise(() => readFile(configPath, "utf8")))
        expect(config.mcp["fs-server"]).toEqual({
          type: "local",
          command: ["echo", "hi"],
          environment: { EXISTING: "1", DEBUG: "true" },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects edits that do not match the server type",
    ({ home, deepagentCode }) =>
      Effect.gen(function* () {
        const configPath = path.join(home, "deepagent-code.json")
        const seeded = [
          "{",
          '  "mcp": {',
          '    "local-only": {',
          '      "type": "local",',
          '      "command": ["echo", "hi"]',
          "    }",
          "  }",
          "}",
        ].join("\n")
        yield* Effect.promise(() => writeFile(configPath, seeded, "utf8"))

        const result = yield* deepagentCode.spawn(["mcp", "edit", "local-only", "--url", "https://example.com/mcp"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).toContain("--url/--header only apply to remote servers")

        // The file must be untouched.
        const config = parse(yield* Effect.promise(() => readFile(configPath, "utf8")))
        expect(config.mcp["local-only"]).toEqual({ type: "local", command: ["echo", "hi"] })
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails with a clear error when the server is not configured anywhere",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.spawn(["mcp", "edit", "ghost", "--url", "https://example.com/mcp"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).toContain("MCP server not found: ghost")

        const noChanges = yield* deepagentCode.spawn(["mcp", "edit", "ghost"])
        expect(noChanges.exitCode).not.toBe(0)
        expect(noChanges.stderr + noChanges.stdout).toContain("No changes provided")
      }),
    60_000,
  )
})
