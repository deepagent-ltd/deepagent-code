type SessionNode = {
  id: string
  parentID?: string
}

export function createSessionTree(root: string, lookup: (sessionID: string) => Promise<SessionNode | undefined>) {
  const owned = new Map([[root, true]])

  return {
    track(sessionID: string) {
      owned.set(sessionID, true)
    },
    async contains(sessionID: string) {
      const cached = owned.get(sessionID)
      if (cached !== undefined) return cached

      const path: string[] = []
      const seen = new Set<string>()
      let current: string | undefined = sessionID
      while (current && !seen.has(current)) {
        const known = owned.get(current)
        if (known !== undefined) {
          path.forEach((item) => owned.set(item, known))
          return known
        }

        seen.add(current)
        path.push(current)
        const session = await lookup(current)
        current = session?.parentID
      }

      path.forEach((item) => owned.set(item, false))
      return false
    },
  }
}

export function backgroundTask(part: unknown) {
  if (!isRecord(part) || part.tool !== "task" || !isRecord(part.state) || part.state.status !== "completed") return
  if (!isRecord(part.state.metadata) || part.state.metadata.background !== true) return
  const sessionID = text(part.state.metadata.sessionId) ?? text(part.state.metadata.sessionID)
  const messageID = text(part.messageID)
  if (!messageID) return
  if (!sessionID) return
  return {
    sessionID,
    messageID,
  }
}

export function questionAnswers(count: number, configured: string[] | undefined) {
  if (!configured || configured.length !== count) return
  return configured.map((answer) => [answer])
}

export function createBackgroundSessions() {
  const sessions = new Map<string, string>()
  const settled = new Set<string>()

  return {
    admit(sessionID: string, parentMessageID: string) {
      sessions.set(sessionID, parentMessageID)
    },
    has(sessionID: string) {
      return sessions.has(sessionID)
    },
    settle(sessionID: string) {
      if (sessions.has(sessionID)) settled.add(sessionID)
    },
    parentAssistant(messageID: string) {
      for (const sessionID of settled) {
        if (sessions.get(sessionID) === messageID) continue
        sessions.delete(sessionID)
        settled.delete(sessionID)
      }
    },
    pending() {
      return sessions.size > 0
    },
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
