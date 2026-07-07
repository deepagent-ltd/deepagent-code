import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Location } from "@deepagent-code/core/location"
import { Policy } from "@deepagent-code/core/policy"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ServerCapabilities } from "@deepagent-code/core/server-capabilities"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Policy.locationLayer.pipe(
    Layer.provide(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("test") }))),
    ),
  ),
)

describe("ServerCapabilities.toStatements", () => {
  test("emits nothing for an empty capability set (partial sets are safe)", () => {
    expect(ServerCapabilities.toStatements(new ServerCapabilities.Info({}))).toEqual([])
  })

  test("only emits deny statements for the booleans explicitly set to false", () => {
    const statements = ServerCapabilities.toStatements(
      new ServerCapabilities.Info({
        allowShell: false,
        allowGitPush: false,
        allowMcpInstall: false,
        // left true / unset — must NOT produce statements:
        allowPublicRepoClone: true,
        allowExtensionInstall: undefined,
      }),
    )
    expect(statements.map((statement) => `${statement.effect} ${statement.action} ${statement.resource}`)).toEqual([
      "deny shell.exec *",
      "deny git.push *",
      "deny mcp.install *",
    ])
  })

  test("translates allowedProviders into a deny-all + re-allow allowlist", () => {
    const statements = ServerCapabilities.toStatements(
      new ServerCapabilities.Info({ allowedProviders: ["anthropic", "openai"] }),
    )
    expect(statements.map((statement) => `${statement.effect} ${statement.action} ${statement.resource}`)).toEqual([
      "deny provider.use *",
      "allow provider.use anthropic",
      "allow provider.use openai",
    ])
  })

  test("an empty allowedProviders list denies nothing", () => {
    expect(ServerCapabilities.toStatements(new ServerCapabilities.Info({ allowedProviders: [] }))).toEqual([])
  })
})

describe("ServerCapabilities.parseModelRef", () => {
  test("splits a well-formed providerID/modelID on the first slash", () => {
    expect(ServerCapabilities.parseModelRef("deepseek/deepseek-chat")).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-chat",
    })
  })

  test("keeps later slashes in the modelID (only the first slash separates)", () => {
    expect(ServerCapabilities.parseModelRef("openrouter/anthropic/claude-3.5")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-3.5",
    })
  })

  test("returns null for undefined / empty / missing-slash / empty-side refs", () => {
    expect(ServerCapabilities.parseModelRef(undefined)).toBeNull()
    expect(ServerCapabilities.parseModelRef("")).toBeNull()
    expect(ServerCapabilities.parseModelRef("deepseek")).toBeNull()
    expect(ServerCapabilities.parseModelRef("/deepseek-chat")).toBeNull()
    expect(ServerCapabilities.parseModelRef("deepseek/")).toBeNull()
  })

  test("fromEnv decodes imModel as a string capability", () => {
    const KEY = "DEEPAGENT_SERVER_CAPABILITIES"
    const original = process.env[KEY]
    try {
      process.env[KEY] = JSON.stringify({ imModel: "deepseek/deepseek-chat" })
      expect(ServerCapabilities.fromEnv()?.imModel).toBe("deepseek/deepseek-chat")
    } finally {
      if (original === undefined) delete process.env[KEY]
      else process.env[KEY] = original
    }
  })
})

describe("ServerCapabilities.fromEnv", () => {
  const KEY = "DEEPAGENT_SERVER_CAPABILITIES"
  const original = process.env[KEY]
  beforeEach(() => {
    delete process.env[KEY]
  })
  afterEach(() => {
    if (original === undefined) delete process.env[KEY]
    else process.env[KEY] = original
  })

  test("returns null when unset", () => {
    expect(ServerCapabilities.fromEnv()).toBeNull()
    expect(ServerCapabilities.envStatements()).toEqual([])
  })

  test("returns null on invalid JSON rather than throwing", () => {
    process.env[KEY] = "{not json"
    expect(ServerCapabilities.fromEnv()).toBeNull()
    expect(ServerCapabilities.envStatements()).toEqual([])
  })

  test("ignores unknown properties and decodes known capabilities", () => {
    process.env[KEY] = JSON.stringify({ allowShell: false, somethingUnknown: 123 })
    const info = ServerCapabilities.fromEnv()
    expect(info?.allowShell).toBe(false)
    expect(ServerCapabilities.envStatements().map((statement) => statement.action)).toEqual(["shell.exec"])
  })
})

describe("ServerCapabilities.isAllowed (service-free env-direct evaluator)", () => {
  const KEY = "DEEPAGENT_SERVER_CAPABILITIES"
  const original = process.env[KEY]
  beforeEach(() => {
    delete process.env[KEY]
  })
  afterEach(() => {
    if (original === undefined) delete process.env[KEY]
    else process.env[KEY] = original
  })

  test("allows everything when no capability set is injected (fail-open)", () => {
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.repoCloneRemote)).toBe(true)
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.mcpInstall)).toBe(true)
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.providerConfigWrite)).toBe(true)
  })

  test("denies the gated action and leaves unrelated actions allowed", () => {
    process.env[KEY] = JSON.stringify({
      allowPublicRepoClone: false,
      allowMcpInstall: false,
      providerConfigEditable: false,
    })
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.repoCloneRemote, "https://x/y.git")).toBe(false)
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.mcpInstall)).toBe(false)
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.providerConfigWrite)).toBe(false)
    // an action not present in the capability set stays allowed
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.shell)).toBe(true)
  })

  test("matches Policy.evaluate allowlist semantics (last-match-wins over resources)", () => {
    process.env[KEY] = JSON.stringify({ allowedProviders: ["anthropic"] })
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.providerUse, "anthropic")).toBe(true)
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.providerUse, "openai")).toBe(false)
  })

  test("ignores invalid JSON and stays fail-open", () => {
    process.env[KEY] = "{not json"
    expect(ServerCapabilities.isAllowed(ServerCapabilities.Actions.mcpInstall)).toBe(true)
  })
})

describe("ServerCapabilities end-to-end through Policy", () => {
  it.effect("an admin deny wins over a user allow loaded before it (last-match-wins)", () =>
    Effect.gen(function* () {
      const policy = yield* Policy.Service
      // Order mirrors config.ts: user/repo statements first, admin capability
      // statements appended last.
      yield* policy.load([
        new Policy.Info({ action: "shell.exec", effect: "allow", resource: "*" }),
        ...ServerCapabilities.toStatements(new ServerCapabilities.Info({ allowShell: false })),
      ])
      expect(yield* policy.evaluate("shell.exec", "anything", "allow")).toBe("deny")
    }),
  )

  it.effect("allowedProviders allowlist permits listed and denies unlisted", () =>
    Effect.gen(function* () {
      const policy = yield* Policy.Service
      yield* policy.load(
        ServerCapabilities.toStatements(new ServerCapabilities.Info({ allowedProviders: ["anthropic"] })),
      )
      expect(yield* policy.evaluate("provider.use", "anthropic", "allow")).toBe("allow")
      expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("deny")
    }),
  )
})
