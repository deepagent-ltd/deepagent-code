import { expect } from "bun:test"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Plugin } from "../../src/plugin"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderTest } from "../fake/provider"
import { SkillTest } from "../fake/skill"
import { testEffect } from "../lib/effect"

// V3.9 §D: the `goal` primary agent is registered ONLY when experimentalGoalLoop is on, so goal mode
// never appears in the mode switcher without a backend that can start a goal.

const provider = ProviderTest.fake()
const configLayer = Config.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)

const agentLayerWithFlags = (overrides: Parameters<typeof RuntimeFlags.layer>[0]) => {
  const pluginLayer = Plugin.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(configLayer),
    Layer.provide(RuntimeFlags.layer(overrides)),
  )
  return Agent.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(AuthTest.empty),
    Layer.provide(SkillTest.empty),
    Layer.provide(provider.layer),
    Layer.provide(pluginLayer),
    Layer.provide(RuntimeFlags.layer(overrides)),
  )
}

const whenOn = testEffect(agentLayerWithFlags({ experimentalGoalLoop: true, disableDefaultPlugins: true }))
whenOn.instance("goal primary agent IS registered when experimentalGoalLoop is on", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.use.list()
    const goal = agents.find((a) => a.name === "goal")
    expect(goal).toBeDefined()
    expect(goal?.mode).toBe("primary")
  }),
)

const whenOff = testEffect(agentLayerWithFlags({ experimentalGoalLoop: false, disableDefaultPlugins: true }))
whenOff.instance("goal primary agent is NOT registered when experimentalGoalLoop is off", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.use.list()
    expect(agents.find((a) => a.name === "goal")).toBeUndefined()
    // build + plan remain unconditionally.
    expect(agents.find((a) => a.name === "build")).toBeDefined()
    expect(agents.find((a) => a.name === "plan")).toBeDefined()
  }),
)
