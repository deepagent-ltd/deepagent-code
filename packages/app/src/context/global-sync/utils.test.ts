import { describe, expect, test } from "bun:test"
import type { Agent } from "@deepagent-code/sdk/v2/client"
import { directoryKey, normalizeAgentList, normalizeProviderList } from "./utils"

const agent = (name = "build") =>
  ({
    name,
    mode: "primary",
    permission: {},
    options: {},
  }) as Agent

describe("normalizeAgentList", () => {
  test("keeps array payloads", () => {
    expect(normalizeAgentList([agent("build"), agent("docs")])).toEqual([agent("build"), agent("docs")])
  })

  test("wraps a single agent payload", () => {
    expect(normalizeAgentList(agent("docs"))).toEqual([agent("docs")])
  })

  test("extracts agents from keyed objects", () => {
    expect(
      normalizeAgentList({
        build: agent("build"),
        docs: agent("docs"),
      }),
    ).toEqual([agent("build"), agent("docs")])
  })

  test("drops invalid payloads", () => {
    expect(normalizeAgentList({ name: "AbortError" })).toEqual([])
    expect(normalizeAgentList([{ name: "build" }, agent("docs")])).toEqual([agent("docs")])
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\deepagent-code"))).toBe("C:/Repos/sst/deepagent-code")
    expect(String(directoryKey("C:/Repos/lessweb/deepagent-code"))).toBe("C:/Repos/lessweb/deepagent-code")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/lessweb/deepagent-code/"))).toBe("C:/Repos/lessweb/deepagent-code")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})

describe("normalizeProviderList", () => {
  const provider = (id: string, name = id) =>
    ({
      id,
      name,
      models: {
        current: { id: "current", status: "stable" },
        old: { id: "old", status: "deprecated" },
      },
    }) as any

  test("preserves provider capabilities and filters deprecated models", () => {
    const result = normalizeProviderList({
      all: [
        provider("openai", "OpenAI"),
        provider("deepseek", "DeepSeek"),
        provider("anthropic", "Anthropic"),
        provider("deepagent-code", "DeepAgent Code Zen"),
        provider("google", "Google"),
      ],
      connected: ["openai", "deepagent-code", "google"],
      default: {
        openai: "gpt",
        deepseek: "deepseek-chat",
        anthropic: "claude",
        "deepagent-code": "big-pickle",
        google: "gemini",
      },
    } as any)

    expect([...result.all.keys()]).toEqual(["openai", "deepseek", "anthropic", "deepagent-code", "google"])
    expect(result.all.get("deepagent-code")?.name).toBe("DeepAgent Code Zen")
    expect(Object.keys(result.all.get("deepagent-code")?.models ?? {})).toEqual(["current"])
    expect(result.connected).toEqual(["openai", "deepagent-code", "google"])
    expect(result.default).toEqual({
      openai: "gpt",
      deepseek: "deepseek-chat",
      anthropic: "claude",
      "deepagent-code": "big-pickle",
      google: "gemini",
    })
  })
})
