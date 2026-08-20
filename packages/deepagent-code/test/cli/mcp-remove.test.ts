import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

// PARITY-004 quick-win regression: `mcp remove` mirrors the GUI delete button
// (dialog-select-mcp.tsx → server-sync removeMcpConfig). The server definition
// lives in a jsonc config file, so removal must preserve comments + siblings.
describe("deepagentCode mcp remove (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "removes a server from the global config while preserving comments and siblings",
    ({ home, deepagentCode }) =>
      Effect.gen(function* () {
        const configPath = path.join(home, ".deepagent", "code", "config.jsonc")
        const seeded = [
          "{",
          "  // user comment must survive the removal",
          '  "theme": "dark",',
          '  "mcp": {',
          '    "github": {',
          '      "type": "remote",',
          '      "url": "https://example.com/mcp"',
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

        const result = yield* deepagentCode.spawn(["mcp", "remove", "github"])
        deepagentCode.expectExit(result, 0)

        const text = yield* Effect.promise(() => readFile(configPath, "utf8"))
        expect(text).toContain("// user comment must survive the removal")
        const config = parse(text)
        expect(config.theme).toBe("dark")
        expect(config.mcp.github).toBeUndefined()
        expect(config.mcp.keeper).toEqual({ type: "local", command: ["echo", "hi"] })
      }),
    60_000,
  )

  cliIt.concurrent(
    "removes a server defined in the project config",
    ({ home, deepagentCode }) =>
      Effect.gen(function* () {
        // spawn() runs with cwd=home, so the project candidates resolve under home.
        const configPath = path.join(home, "deepagent-code.json")
        const seeded = [
          "{",
          '  "mcp": {',
          '    "project-server": {',
          '      "type": "remote",',
          '      "url": "https://project.example.com/mcp"',
          "    }",
          "  }",
          "}",
        ].join("\n")
        yield* Effect.promise(() => writeFile(configPath, seeded, "utf8"))

        const result = yield* deepagentCode.spawn(["mcp", "remove", "project-server"])
        deepagentCode.expectExit(result, 0)

        const config = parse(yield* Effect.promise(() => readFile(configPath, "utf8")))
        expect(config.mcp ?? {}).toEqual({})
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails with a clear error when the server is not configured anywhere",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.spawn(["mcp", "remove", "ghost"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).toContain("MCP server not found: ghost")
      }),
    60_000,
  )
})
