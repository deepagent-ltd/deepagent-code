export type FollowupSubmission = {
  readonly sessionID: string
  readonly id: string
  readonly controller: AbortController
  readonly promise: Promise<boolean>
}

export function createFollowupSubmissionRegistry() {
  // Keyed by sessionID → Map<id, entry> so multiple concurrent followups per session
  // are all tracked and cancelled on revert (fixes single-entry overwrite gap).
  const submissions = new Map<string, Map<string, Omit<FollowupSubmission, "sessionID">>>()

  return {
    register(input: FollowupSubmission) {
      let slot = submissions.get(input.sessionID)
      if (!slot) {
        slot = new Map()
        submissions.set(input.sessionID, slot)
      }
      slot.set(input.id, {
        id: input.id,
        controller: input.controller,
        promise: input.promise,
      })
    },
    clear(sessionID: string, id: string) {
      const slot = submissions.get(sessionID)
      if (!slot) return
      slot.delete(id)
      if (slot.size === 0) submissions.delete(sessionID)
    },
    async cancel(sessionID: string) {
      const slot = submissions.get(sessionID)
      if (!slot) return
      for (const sub of slot.values()) sub.controller.abort()
      await Promise.all([...slot.values()].map((sub) => sub.promise.catch(() => false)))
    },
  }
}
