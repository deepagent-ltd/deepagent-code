export * as V2AgentRoster from "./v2-agent-roster"

import { Option } from "effect"
import { Effect } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { Agent } from "@/agent/agent"

/**
 * RI-26 read-model convergence (2026-09-10 ruling): under the V2-only profile the Core
 * Location-scoped roster is the single selectable authority. This bridge reads it the same way
 * core's own admission check does (`SessionV2.requireSelectableAgent`): keyed Location tree from
 * the process LocationServiceMap, await PluginBoot (the roster populates asynchronously at boot),
 * then `AgentV2.all()`.
 *
 * Returns `undefined` when the composition has no LocationServiceMap (bare legacy test graphs) —
 * that composition has no V2 execution placement either, so callers keep their legacy read model
 * instead of treating it as an empty roster. A present map with an empty roster is a REAL empty
 * roster (post-boot confirmed miss).
 */
export const agentsFor = (ref: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* Effect.serviceOption(LocationServiceMap)
    if (Option.isNone(locations)) return undefined
    const services = yield* Effect.all({
      boot: Effect.serviceOption(PluginBoot.Service),
      agents: Effect.serviceOption(AgentV2.Service),
    }).pipe(Effect.provide(locations.value.get(ref)))
    if (Option.isNone(services.agents)) return undefined
    if (Option.isSome(services.boot)) yield* services.boot.value.wait()
    return yield* services.agents.value.all()
  })

/** Resolves one roster entry, applying the same legacy "build"→"auto" fallback as AgentV2. */
export const resolveFor = (ref: Location.Ref, name: string) =>
  Effect.map(agentsFor(ref), (roster) => (roster ? resolveIn(roster, name) : undefined))

/** Pure variant over an already-fetched roster (callers that also need the list for hints). */
export const resolveIn = (roster: readonly AgentV2.Info[], name: string) => {
  const byID = (id: string) => roster.find((item) => String(item.id) === id)
  return byID(name) ?? (name === "build" ? byID(String(AgentV2.defaultID)) : undefined)
}

/** Selectable names for fail-fast hints: primary/all, not hidden. */
export const selectableNames = (roster: readonly AgentV2.Info[]) =>
  roster.filter((item) => item.mode !== "subagent" && !item.hidden).map((item) => String(item.id))

/**
 * Wire projection onto the V1 `Agent.Info` egress shape (the /agent HTTP contract and GUI picker).
 * `permission` is egress-inert: V2 rulesets are not the V1 permission vocabulary, and no consumer
 * of this list evaluates them.
 */
export const toWireAgent = (info: AgentV2.Info): Agent.Info => ({
  name: String(info.id),
  ...(info.description !== undefined ? { description: info.description } : {}),
  mode: info.mode,
  native: true,
  hidden: info.hidden,
  permission: [],
  ...(info.model !== undefined
    ? { model: { modelID: info.model.id, providerID: info.model.providerID } }
    : {}),
  ...(info.model?.variant !== undefined ? { variant: info.model.variant } : {}),
  options: {},
})
