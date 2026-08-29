// D1/D3: scenario-mode override, set by the send-adjacent scenario toggle (D1).
// It overrides the configured promptMode for a turn. Cleared on stop (D3) so the override is
// strictly per-turn: once a turn ends, resolution falls back to the configured default (e.g. intelligence)
// rather than being pinned to a stale value. The next turn re-enters the configured scenario unless
// the user toggles again.
//
// Keys: the toggle writes a DIRECTORY-scoped key (stable before a session exists, e.g. on the
// new-session composer); submit reads the SESSION key first, then falls back to the directory
// key, so a toggle made before the first turn still applies to it. Once a session exists the
// session key can hold a per-session override.
//
// This lives in its own module (no SolidJS imports) so submit.ts and the toggle UI can share it
// and it stays unit-testable without loading the router/runtime.
export type ScenarioOverride = "direct" | "intelligence"

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

// D3: any stop CLEARS the per-turn override for both the session and its directory scope. Clearing
// (not pinning "direct") is deliberate: a pinned "direct" would permanently shadow the configured
// default and, because submit resolves the session key before the dir key, the toggle (which only
// writes the dir key) could never re-engage intelligence. After clearing, the next turn falls back to the
// configured scenario default.
export const resetScenarioOnStop = (sessionKey: string, dirKey?: string): void => {
  scenarioOverride.delete(sessionKey)
  if (dirKey) scenarioOverride.delete(dirKey)
  notifyScenarioOverrideListeners()
}
