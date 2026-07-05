import type { Accessor } from "solid-js"

// Pure reducer for the right-side-panel mode. Kept out of the provider so the
// open/close/toggle contract — most importantly "toggling the active tab closes
// the panel" — is unit-testable without constructing the full LayoutProvider.
// `undefined` means the panel is closed.
export function toggledPanelMode<Mode extends string>(current: Mode | undefined, mode: Mode): Mode | undefined {
  return current === mode ? undefined : mode
}

export function isPanelOpen(current: string | undefined): boolean {
  return current !== undefined
}

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}
