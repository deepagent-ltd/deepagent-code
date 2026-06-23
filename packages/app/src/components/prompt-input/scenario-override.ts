// D1/D3: scenario-mode override, set by the send-adjacent scenario toggle (D1).
// It overrides the configured promptMode for a turn. Reset to `direct` on stop (D3) so any
// interrupt returns to the fail-safe mode until the user re-engages wish.
//
// Keys: the toggle writes a DIRECTORY-scoped key (stable before a session exists, e.g. on the
// new-session composer); submit reads the SESSION key first, then falls back to the directory
// key, so a toggle made before the first turn still applies to it. Once a session exists the
// session key can hold a per-session override.
//
// This lives in its own module (no SolidJS imports) so submit.ts and the toggle UI can share it
// and it stays unit-testable without loading the router/runtime.
export type ScenarioOverride = "direct" | "wish"

const scenarioOverride = new Map<string, ScenarioOverride>()
const listeners = new Set<() => void>()

const notifyScenarioOverrideListeners = () => {
  for (const listener of listeners) listener()
}

export const subscribeScenarioOverride = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const setScenarioOverride = (key: string, mode: ScenarioOverride): void => {
  scenarioOverride.set(key, mode)
  notifyScenarioOverrideListeners()
}

export const getScenarioOverride = (key: string): ScenarioOverride | undefined => scenarioOverride.get(key)

// Submit-side resolution: prefer a per-session override, else the directory-scoped one.
export const resolveScenarioOverride = (sessionKey: string, dirKey: string): ScenarioOverride | undefined =>
  scenarioOverride.get(sessionKey) ?? scenarioOverride.get(dirKey)

// D3: any stop resets the scenario to `direct` (fail-safe) for both the session and its directory
// scope, so the next user message is a plain direct submission until they re-engage wish.
export const resetScenarioOnStop = (sessionKey: string, dirKey?: string): void => {
  scenarioOverride.set(sessionKey, "direct")
  if (dirKey) scenarioOverride.set(dirKey, "direct")
  notifyScenarioOverrideListeners()
}
