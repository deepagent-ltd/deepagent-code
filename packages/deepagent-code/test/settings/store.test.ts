import { test, expect, describe, afterEach, beforeEach } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SettingsStore } from "@/settings/store"

// SettingsStore resolves its file under Global.Path.data, which honors DEEPAGENT_CODE_HOME. Point it
// at a throwaway dir so we never touch the real ~/.deepagent/code.
let home: string
const prevHome = process.env.DEEPAGENT_CODE_HOME

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-settings-test-"))
  process.env.DEEPAGENT_CODE_HOME = home
  SettingsStore.invalidate()
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = prevHome
  SettingsStore.invalidate()
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
})

const settingsFile = () => path.join(home, "settings.json")

describe("SettingsStore", () => {
  test("missing file reads as empty settings", async () => {
    expect(await SettingsStore.read()).toEqual({})
  })

  test("update persists deepagent settings and reports changed", async () => {
    const first = await SettingsStore.update({ deepagent: { agentMode: "xhigh", intelligenceModel: "zhipuai/glm-4.7" } })
    expect(first.changed).toBe(true)
    expect(first.settings.deepagent).toEqual({ agentMode: "xhigh", intelligenceModel: "zhipuai/glm-4.7" })

    SettingsStore.invalidate()
    const reread = await SettingsStore.read()
    expect(reread.deepagent).toEqual({ agentMode: "xhigh", intelligenceModel: "zhipuai/glm-4.7" })

    // file exists and is valid JSON
    const raw = JSON.parse(await fs.readFile(settingsFile(), "utf8"))
    expect(raw.deepagent.agentMode).toBe("xhigh")
  })

  // Tier-2 legacy-compat: an existing user's settings.json written before the wish→intelligence
  // rename still carries `wishModel` and `promptMode: "wish"`. Read must accept both and normalize
  // to the canonical `intelligenceModel` / "intelligence" (read-old, write-new).
  test("reads legacy wishModel and promptMode 'wish' as intelligence", async () => {
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({ deepagent: { promptMode: "wish", wishModel: "zhipuai/glm-4.7" } }),
    )
    SettingsStore.invalidate()
    const reread = await SettingsStore.read()
    expect(reread.deepagent).toEqual({ promptMode: "intelligence", intelligenceModel: "zhipuai/glm-4.7" })
  })

  test("prefers the new intelligenceModel key over legacy wishModel when both are present", async () => {
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({ deepagent: { intelligenceModel: "openai/gpt-5", wishModel: "zhipuai/glm-4.7" } }),
    )
    SettingsStore.invalidate()
    const reread = await SettingsStore.read()
    expect(reread.deepagent).toEqual({ intelligenceModel: "openai/gpt-5" })
  })

  test("no-op update reports unchanged", async () => {
    await SettingsStore.update({ deepagent: { agentMode: "high" } })
    const again = await SettingsStore.update({ deepagent: { agentMode: "high" } })
    expect(again.changed).toBe(false)
  })

  test("merges partial deepagent patches", async () => {
    await SettingsStore.update({ deepagent: { agentMode: "high" } })
    const merged = await SettingsStore.update({ deepagent: { selfLearning: "auto" } })
    expect(merged.settings.deepagent).toEqual({ agentMode: "high", selfLearning: "auto" })
  })

  test("subagentIntensity round-trips (write → read back)", async () => {
    const w = await SettingsStore.update({ deepagent: { subagentIntensity: "downgrade" } })
    expect(w.changed).toBe(true)
    expect(w.settings.deepagent).toEqual({ subagentIntensity: "downgrade" })

    SettingsStore.invalidate()
    const reread = await SettingsStore.read()
    expect(reread.deepagent).toEqual({ subagentIntensity: "downgrade" })

    // "inherit" is also accepted
    const inherit = await SettingsStore.update({ deepagent: { subagentIntensity: "inherit" } })
    expect(inherit.settings.deepagent).toEqual({ subagentIntensity: "inherit" })
  })

  test("invalid subagentIntensity is dropped on read", async () => {
    await fs.writeFile(settingsFile(), JSON.stringify({ deepagent: { subagentIntensity: "bogus", agentMode: "high" } }))
    SettingsStore.invalidate()
    expect((await SettingsStore.read()).deepagent).toEqual({ agentMode: "high" })
  })

  test("keeps transport only for official providers", async () => {
    const result = await SettingsStore.update({
      providers: {
        zhipuai: { headerTimeout: 15000, maxRetries: 3 },
        // not an official provider — must be dropped
        "some-third-party": { headerTimeout: 999 } as never,
      },
    })
    expect(result.settings.providers).toEqual({ zhipuai: { headerTimeout: 15000, maxRetries: 3 } })
  })

  test("newly-official zhipu family is accepted", async () => {
    const result = await SettingsStore.update({
      providers: {
        "zhipuai-coding-plan": { headerTimeout: 20000 },
        zai: { timeout: 60000 },
        "zai-coding-plan": { chunkTimeout: 30000 },
      },
    })
    expect(result.settings.providers).toEqual({
      "zhipuai-coding-plan": { headerTimeout: 20000 },
      zai: { timeout: 60000 },
      "zai-coding-plan": { chunkTimeout: 30000 },
    })
  })

  test("headerTimeout=false (disabled) is preserved; invalid values dropped", async () => {
    const result = await SettingsStore.update({
      providers: { openai: { headerTimeout: false, chunkTimeout: -1 as never, maxRetries: 0 as never } },
    })
    // false kept; negative chunkTimeout and non-positive maxRetries dropped
    expect(result.settings.providers).toEqual({ openai: { headerTimeout: false } })
  })

  test("removing all transport keys for a provider drops the entry", async () => {
    await SettingsStore.update({ providers: { openai: { headerTimeout: 10000 } } })
    const cleared = await SettingsStore.update({ providers: { openai: { headerTimeout: undefined as never } } })
    expect(cleared.settings.providers).toBeUndefined()
  })

  test("ignores unknown/garbage on read", async () => {
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({ deepagent: { agentMode: "bogus", intelligenceModel: 42 }, providers: { notreal: { x: 1 } } }),
    )
    SettingsStore.invalidate()
    expect(await SettingsStore.read()).toEqual({})
  })
})
