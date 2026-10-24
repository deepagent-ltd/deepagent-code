import { createSignal } from "solid-js"
import { createComposerDrafts } from "./composer-draft"
import { createDacDrafts } from "./personal-command"
import type { ServerConnection } from "@/context/server"

type IMNavigationState = {
  scope: string
  connection: ServerConnection.HttpBase
  accountID: string
  owner: object
  connected: boolean
  unread: boolean
  current: boolean
}

// The navigation observes the panel's single communication owner. It does not
// open a second socket, list watcher or read cursor when the panel is hidden.
const [navigation, setNavigation] = createSignal<IMNavigationState>()
export const imNavigationState = navigation
export function publishIMNavigation(value: IMNavigationState) {
  setNavigation(value)
}
export function retireIMNavigation(owner: object) {
  setNavigation((value) => (value?.owner === owner ? { ...value, current: false } : value))
}

type CommunicationState = {
  scope: string
  connection: ServerConnection.HttpBase
  accountID: string
  drafts: ReturnType<typeof createComposerDrafts>
  personal: Map<string, ReturnType<typeof createDacDrafts>>
  selected: string | null
}
const communications: CommunicationState[] = []
export function sameIMConnection(left: ServerConnection.HttpBase, right: ServerConnection.HttpBase) {
  return (
    left.url === right.url &&
    left.username === right.username &&
    left.password === right.password &&
    left.bearer === right.bearer
  )
}

export function imCommunicationState(scope: string, connection: ServerConnection.HttpBase, accountID: string) {
  const existing = communications.find(
    (item) => item.scope === scope && item.accountID === accountID && sameIMConnection(item.connection, connection),
  )
  if (existing) return existing
  // Dropping credentials never restores a different account's UI drafts. An
  // ambiguous command is retained within its original account until window exit.
  const state: CommunicationState = {
    scope,
    connection: { ...connection },
    accountID,
    drafts: createComposerDrafts(),
    personal: new Map(),
    selected: null,
  }
  communications.push(state)
  return state
}
