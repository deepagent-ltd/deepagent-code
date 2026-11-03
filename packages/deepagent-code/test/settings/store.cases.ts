import assert from "node:assert/strict"
import fs from "node:fs/promises"
import type { SettingsStore } from "@/settings/store"

type Fixture = {
  store: Pick<typeof SettingsStore, "read" | "update" | "invalidate">
  file: string
  writeFixture: (text: string) => Promise<void>
}

export function registerSettingsStoreCases(test: (name: string, run: (fixture: Fixture) => Promise<void>) => void) {
  test("missing file reads as empty settings", async (fixture) => {
    assert.deepEqual(await fixture.store.read(), {})
  })

  test("refuses to overwrite a corrupt settings file", async (fixture) => {
    await fixture.writeFixture("{broken")

    await assert.rejects(fixture.store.read(), /Cannot read settings/)
    await assert.rejects(fixture.store.update({ deepagent: { agentMode: "high" } }), /Cannot read settings/)
    assert.equal(await fs.readFile(fixture.file, "utf8"), "{broken")
  })

  test("update persists deepagent settings and reports changed", async (fixture) => {
    const first = await fixture.store.update({
      deepagent: { agentMode: "xhigh", intelligenceModel: "zhipuai/glm-4.7" },
    })
    assert.equal(first.changed, true)
    assert.deepEqual(first.settings.deepagent, { agentMode: "xhigh", intelligenceModel: "zhipuai/glm-4.7" })

    fixture.store.invalidate()
    const reread = await fixture.store.read()
    assert.deepEqual(reread.deepagent, { agentMode: "xhigh", intelligenceModel: "zhipuai/glm-4.7" })

    // file exists and is valid JSON
    const raw = JSON.parse(await fs.readFile(fixture.file, "utf8"))
    assert.equal(raw.deepagent.agentMode, "xhigh")
  })

  // Tier-2 legacy-compat: an existing user's settings.json written before the wish→intelligence
  // rename still carries `wishModel` and `promptMode: "wish"`. Read must accept both and normalize
  // to the canonical `intelligenceModel` / "intelligence" (read-old, write-new).
  test("reads legacy wishModel and promptMode 'wish' as intelligence", async (fixture) => {
    await fixture.writeFixture(
      JSON.stringify({ deepagent: { promptMode: "wish", wishModel: "zhipuai/glm-4.7" } }),
    )
    fixture.store.invalidate()
    const reread = await fixture.store.read()
    assert.deepEqual(reread.deepagent, { promptMode: "intelligence", intelligenceModel: "zhipuai/glm-4.7" })
  })

  test("prefers the new intelligenceModel key over legacy wishModel when both are present", async (fixture) => {
    await fixture.writeFixture(
      JSON.stringify({ deepagent: { intelligenceModel: "openai/gpt-5", wishModel: "zhipuai/glm-4.7" } }),
    )
    fixture.store.invalidate()
    const reread = await fixture.store.read()
    assert.deepEqual(reread.deepagent, { intelligenceModel: "openai/gpt-5" })
  })

  test("no-op update reports unchanged", async (fixture) => {
    await fixture.store.update({ deepagent: { agentMode: "high" } })
    const again = await fixture.store.update({ deepagent: { agentMode: "high" } })
    assert.equal(again.changed, false)
  })

  test("merges partial deepagent patches", async (fixture) => {
    await fixture.store.update({ deepagent: { agentMode: "high" } })
    const merged = await fixture.store.update({ deepagent: { selfLearning: "auto" } })
    assert.deepEqual(merged.settings.deepagent, { agentMode: "high", selfLearning: "auto" })
  })

  test("serializes concurrent disjoint updates without losing either field", async (fixture) => {
    await Promise.all([
      fixture.store.update({ deepagent: { agentMode: "xhigh" } }),
      fixture.store.update({ deepagent: { selfLearning: "auto" } }),
    ])

    fixture.store.invalidate()
    assert.deepEqual((await fixture.store.read()).deepagent, { agentMode: "xhigh", selfLearning: "auto" })
  })

  test("re-reads disk under the update lock instead of merging from a stale cache", async (fixture) => {
    await fixture.store.update({ deepagent: { agentMode: "high" } })
    await fixture.writeFixture(JSON.stringify({ deepagent: { selfLearning: "manual" } }))

    await fixture.store.update({ deepagent: { subagentIntensity: "downgrade" } })
    fixture.store.invalidate()
    assert.deepEqual((await fixture.store.read()).deepagent, { selfLearning: "manual", subagentIntensity: "downgrade" })
  })

  test("subagentIntensity round-trips (write → read back)", async (fixture) => {
    const w = await fixture.store.update({ deepagent: { subagentIntensity: "downgrade" } })
    assert.equal(w.changed, true)
    assert.deepEqual(w.settings.deepagent, { subagentIntensity: "downgrade" })

    fixture.store.invalidate()
    const reread = await fixture.store.read()
    assert.deepEqual(reread.deepagent, { subagentIntensity: "downgrade" })

    // "inherit" is also accepted
    const inherit = await fixture.store.update({ deepagent: { subagentIntensity: "inherit" } })
    assert.deepEqual(inherit.settings.deepagent, { subagentIntensity: "inherit" })
  })

  test("invalid subagentIntensity is dropped on read", async (fixture) => {
    await fixture.writeFixture(
      JSON.stringify({ deepagent: { subagentIntensity: "bogus", agentMode: "high" } }),
    )
    fixture.store.invalidate()
    assert.deepEqual((await fixture.store.read()).deepagent, { agentMode: "high" })
  })

  // V3.9 §C: the global Expert Panel default seeds each new conversation's armed state.
  test("expertPanelDefault round-trips (write → read back)", async (fixture) => {
    const w = await fixture.store.update({ deepagent: { expertPanelDefault: true } })
    assert.equal(w.changed, true)
    assert.deepEqual(w.settings.deepagent, { expertPanelDefault: true })

    fixture.store.invalidate()
    assert.deepEqual((await fixture.store.read()).deepagent, { expertPanelDefault: true })
  })

  test("non-boolean expertPanelDefault is dropped on read", async (fixture) => {
    await fixture.writeFixture(
      JSON.stringify({ deepagent: { expertPanelDefault: "yes", agentMode: "high" } }),
    )
    fixture.store.invalidate()
    assert.deepEqual((await fixture.store.read()).deepagent, { agentMode: "high" })
  })

  test("keeps transport only for official providers", async (fixture) => {
    const result = await fixture.store.update({
      providers: {
        zhipuai: { headerTimeout: 15000, maxRetries: 3 },
        // not an official provider — must be dropped
        "some-third-party": { headerTimeout: 999 } as never,
      },
    })
    assert.deepEqual(result.settings.providers, { zhipuai: { headerTimeout: 15000, maxRetries: 3 } })
  })

  test("newly-official zhipu family is accepted", async (fixture) => {
    const result = await fixture.store.update({
      providers: {
        "zhipuai-coding-plan": { headerTimeout: 20000 },
        zai: { timeout: 60000 },
        "zai-coding-plan": { chunkTimeout: 30000 },
      },
    })
    assert.deepEqual(result.settings.providers, {
      "zhipuai-coding-plan": { headerTimeout: 20000 },
      zai: { timeout: 60000 },
      "zai-coding-plan": { chunkTimeout: 30000 },
    })
  })

  test("headerTimeout=false (disabled) is preserved; invalid values dropped", async (fixture) => {
    const result = await fixture.store.update({
      providers: { openai: { headerTimeout: false, chunkTimeout: -1 as never, maxRetries: 0 as never } },
    })
    // false kept; negative chunkTimeout and non-positive maxRetries dropped
    assert.deepEqual(result.settings.providers, { openai: { headerTimeout: false } })
  })

  test("removing all transport keys for a provider drops the entry", async (fixture) => {
    await fixture.store.update({ providers: { openai: { headerTimeout: 10000 } } })
    const cleared = await fixture.store.update({ providers: { openai: { headerTimeout: undefined as never } } })
    assert.equal(cleared.settings.providers, undefined)
  })

  test("baseURL override for an official provider round-trips (proxy/gateway routing)", async (fixture) => {
    const result = await fixture.store.update({
      providers: { openai: { baseURL: "https://proxy.corp.internal/openai/v1", maxRetries: 5 } },
    })
    assert.deepEqual(result.settings.providers, {
      openai: { baseURL: "https://proxy.corp.internal/openai/v1", maxRetries: 5 },
    })
  })

  test("http(s) baseURL accepted; malformed / non-http endpoints dropped", async (fixture) => {
    const ok = await fixture.store.update({ providers: { openai: { baseURL: "http://localhost:8080/v1" } } })
    assert.deepEqual(ok.settings.providers, { openai: { baseURL: "http://localhost:8080/v1" } })

    await fixture.store.update({ providers: { openai: { baseURL: undefined as never } } })
    fixture.store.invalidate()
    // file:// (non-http), a bare non-URL string, and empty string are all rejected so a hand-edited
    // settings file can never route an official provider somewhere unexpected.
    const bad = await fixture.store.update({
      providers: {
        openai: { baseURL: "file:///etc/passwd" as never },
        anthropic: { baseURL: "not a url" as never },
        google: { baseURL: "" as never },
      },
    })
    assert.equal(bad.settings.providers, undefined)
  })

  test("ignores unknown/garbage on read", async (fixture) => {
    await fixture.writeFixture(
      JSON.stringify({ deepagent: { agentMode: "bogus", intelligenceModel: 42 }, providers: { notreal: { x: 1 } } }),
    )
    fixture.store.invalidate()
    assert.deepEqual(await fixture.store.read(), {})
  })
}
