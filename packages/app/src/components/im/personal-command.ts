import { createStore } from "solid-js/store"
import type { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"

export type DacBinding = IMDacSessionSchema.BindingResponse
export type DacCommand = IMDacSessionSchema.CommandResponse
export type DacInput = IMDacSessionSchema.Submit

// Only the owner's input invokes the command. Incoming messages never pass through this parser.
export function parseDacCommand(text: string) {
  if (!/^\/dac(?:\s|$)/.test(text)) return undefined
  return text.slice(4)
}

export function createDacDraft() {
  const [state, setState] = createStore({
    text: "",
    delivery: "queue" as "queue" | "steer",
    reference: undefined as { id: string; content: string } | undefined,
    newSession: false,
    pending: undefined as Readonly<DacInput> | undefined,
    command: undefined as DacCommand | undefined,
  })
  return { state, setState }
}

export type DacDraft = ReturnType<typeof createDacDraft>

export function createDacDrafts(initial: readonly [string, DacDraft["state"]][] = []) {
  if (initial.length > 32 || new Set(initial.map(([groupID]) => groupID)).size !== initial.length)
    throw new Error("DAC draft capacity")
  const drafts = new Map<string, DacDraft>()
  const [state, setState] = createStore({ revision: 0 })
  for (const [groupID, state] of initial) {
    const draft = createDacDraft()
    draft.setState(state)
    drafts.set(groupID, draft)
  }
  const get = (groupID: string) => {
    const existing = drafts.get(groupID)
    if (existing) return existing
    // Ambiguous submissions retain their original identity; capacity never evicts one.
    if (drafts.size >= 32) return undefined
    const draft = createDacDraft()
    drafts.set(groupID, draft)
    setState("revision", (value) => value + 1)
    return draft
  }
  return Object.assign(get, {
    find: (groupID: string) => {
      state.revision
      return drafts.get(groupID)
    },
    entries: () => [...drafts.entries()],
  })
}
