import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("deepagentCode mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        deepagentCode.expectExit(result, 0)

        const configPath = path.join(home, ".deepagent", "code", "config.jsonc")
        const config = parse(yield* Effect.promise(() => Bun.file(configPath).text()))
        expect(config.mcp.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, ".config", "deepagent-code", "deepagent-code.json")).exists()),
        ).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        deepagentCode.expectExit(result, 0)

        const configPath = path.join(home, ".deepagent", "code", "config.jsonc")
        const config = parse(yield* Effect.promise(() => Bun.file(configPath).text()))
        expect(config.mcp.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, ".config", "deepagent-code", "deepagent-code.json")).exists()),
        ).toBe(false)
      }),
    60_000,
  )
})
