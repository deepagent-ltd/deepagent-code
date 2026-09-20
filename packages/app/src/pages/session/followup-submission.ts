export const FOLLOWUP_SUBMISSION_LIMIT = 128

export function createFollowupSubmissionRegistry() {
  // Keyed by sessionID → Map<id, entry> so multiple concurrent followups per session
  // are all tracked and cancelled on revert (fixes single-entry overwrite gap).
  const submissions = new Map<string, Map<string, { controller: AbortController; promise: Promise<boolean> }>>()

  return {
    run(input: { sessionID: string; id: string }, task: (signal: AbortSignal) => Promise<boolean>) {
      let slot = submissions.get(input.sessionID)
      const current = slot?.get(input.id)
      if (current) return current.promise
      const size = [...submissions.values()].reduce((total, entries) => total + entries.size, 0)
      if (size >= FOLLOWUP_SUBMISSION_LIMIT) {
        return Promise.reject(new Error(`Too many active follow-up submissions (limit ${FOLLOWUP_SUBMISSION_LIMIT})`))
      }
      if (!slot) {
        slot = new Map()
        submissions.set(input.sessionID, slot)
      }
      const controller = new AbortController()
      const promise = Promise.resolve()
        .then(() => task(controller.signal))
        .finally(() => {
          const current = submissions.get(input.sessionID)
          if (current?.get(input.id)?.promise !== promise) return
          current.delete(input.id)
          if (current.size === 0) submissions.delete(input.sessionID)
        })
      slot.set(input.id, { controller, promise })
      return promise
    },
    async cancel(sessionID: string) {
      const slot = submissions.get(sessionID)
      if (!slot) return
      for (const sub of slot.values()) sub.controller.abort()
      await Promise.all([...slot.values()].map((sub) => sub.promise.catch(() => false)))
    },
    active() {
      return [...submissions.values()].reduce((total, entries) => total + entries.size, 0)
    },
  }
}
