import { createStore } from "solid-js/store"

export function createComposerDraft() {
  const [state, setState] = createStore({
    content: "",
    sending: false,
    failed: false,
    requestID: "",
    requestContent: "",
  })
  return { state, setState }
}

export type ComposerDraft = ReturnType<typeof createComposerDraft>

// Owned by the IM panel, so navigating between conversations keeps an ambiguous
// send's identity without persisting message text outside the current panel.
export function createComposerDrafts() {
  const drafts = new Map<string, ComposerDraft>()
  return (groupID: string, threadID?: string) => {
    const key = JSON.stringify([groupID, threadID ?? null])
    const existing = drafts.get(key)
    if (existing) return existing
    const draft = createComposerDraft()
    drafts.set(key, draft)
    return draft
  }
}
