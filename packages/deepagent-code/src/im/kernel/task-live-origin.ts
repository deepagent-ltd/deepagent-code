export * as KernelTaskLiveOrigin from "./task-live-origin"

import type { ProtectedDeliveryProvider, ProtectedLiveObservation } from "@deepagent-code/im-kernel-sdk"

const captures = new WeakMap<object, {
  provider: ProtectedDeliveryProvider
  observation: ProtectedLiveObservation
  owner: { active: boolean }
  receivedAt: number
  deadline: number
}>()

/** Only this subscription's original current SDK callback populates the private map.
 * Its transport observation is not a source receipt, member proof or execution grant. */
export function subscribe(provider: ProtectedDeliveryProvider, receive: (handle: object) => void) {
  const owner = { active: true }
  const unsubscribe = provider.onProtectedLiveMessage((observation) => {
    if (!owner.active || !provider.readProtectedLiveMessage(observation)) return
    const handle = Object.freeze({})
    captures.set(handle, { provider, observation, owner, receivedAt: Date.now(), deadline: performance.now() + 30_000 })
    receive(handle)
  })
  return () => {
    owner.active = false
    unsubscribe()
  }
}

export function read(handle: object) {
  const captured = captures.get(handle)
  if (!captured?.owner.active || performance.now() >= captured.deadline) return
  const observation = captured.provider.readProtectedLiveMessage(captured.observation)
  return observation ? { observation, receivedAt: captured.receivedAt } : undefined
}

/** Only a page sealed by the original private native query can supply handles.
 * The fixed SDK deadline/receive time survive this mechanical Host bridge. */
export function capturePage(provider: ProtectedDeliveryProvider, handle: object) {
  const original = provider.readProtectedLivePage(handle)
  if (!original || performance.now() >= original.deadline) return
  const observations = original.observations.map((observation) => {
    if (!provider.readProtectedLiveMessage(observation)) return
    const handle = Object.freeze({})
    captures.set(handle, { provider, observation, owner: { active: true }, receivedAt: original.receivedAt, deadline: original.deadline })
    return handle
  })
  if (observations.some((observation) => observation === undefined) || !provider.readProtectedLivePage(handle)) return
  return { page: original.page, handles: observations.filter((observation): observation is object => observation !== undefined) }
}
