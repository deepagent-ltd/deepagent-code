/** This single-use process-local record holds a callback, never routing credentials or disk state. */
export function createIMTaskReturn(input: { sessionID: string; current: () => boolean; restore: () => void }) {
  let used = false
  return {
    available(sessionID: string) {
      if (!input.current()) used = true
      return !used && input.sessionID === sessionID
    },
    restore(sessionID: string) {
      if (!input.current()) used = true
      if (used || input.sessionID !== sessionID) return false
      used = true
      input.restore()
      return true
    },
  }
}

export type IMTaskReturn = ReturnType<typeof createIMTaskReturn>
