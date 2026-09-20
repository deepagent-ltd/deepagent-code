import { createSignal } from "solid-js"
import { Persist, persisted } from "@/utils/persist"
import { createStore, produce } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useParams } from "@solidjs/router"
import type { Prompt } from "@/context/prompt"

// W3-2 — parity with the TUI prompt stash (packages/tui/src/prompt/stash.tsx): a per-workspace
// LIFO of composer drafts with a 50-entry cap. The TUI persists jsonl on disk; the app keeps the
// same semantics in its per-server workspace persistence slot.
export type StashEntry = {
  prompt: Prompt
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

export function createPromptStash() {
  const params = useParams()
  const serverSDK = useServerSDK()

  const [store, setStore] = createStore<{ entries: StashEntry[] }>({ entries: [] })
  persisted(Persist.serverWorkspace(serverSDK.scope, params.dir ?? "", "prompt-stash", ["prompt-stash.v1"]), [
    store,
    setStore,
  ])

  const [version, bump] = createSignal(0)

  const push = (prompt: Prompt) => {
    setStore(
      produce((draft) => {
        draft.entries.push({ prompt: structuredClone(prompt), timestamp: Date.now() })
        if (draft.entries.length > MAX_STASH_ENTRIES) draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
      }),
    )
    bump((v) => v + 1)
  }

  const pop = () => {
    const entry = store.entries[store.entries.length - 1]
    if (!entry) return undefined
    setStore(
      produce((draft) => {
        draft.entries.pop()
      }),
    )
    bump((v) => v + 1)
    return entry
  }

  const remove = (index: number) => {
    if (index < 0 || index >= store.entries.length) return
    setStore(
      produce((draft) => {
        draft.entries.splice(index, 1)
      }),
    )
    bump((v) => v + 1)
  }

  // Signal-touched reads keep consumers reactive to push/pop/remove without exposing the store.
  const list = () => {
    void version()
    return store.entries
  }

  return { list, push, pop, remove }
}
