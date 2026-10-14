import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"

/** Stop owns the original Goal/revision until a write outcome is known. */
export function createGoalStop() {
  const pending = new Map<string, GoalClient.Descriptor>()
  const busy = new Set<string>()
  return async (input: { client: GoalClient.Client; scope: GoalClient.Scope; goalID: string; current(): boolean }) => {
    const key = `${GoalClient.scopeKey(input.scope)}\n${input.goalID}`
    if (busy.has(key)) throw new GoalClient.RequestError("Pause is awaiting acknowledgement", "busy", 409, false)
    if (!pending.has(key) && pending.size >= 32)
      throw new GoalClient.RequestError("Too many unconfirmed Goal controls", "busy", 409, false)
    busy.add(key)
    try {
      const prior = pending.get(key)
      const snapshot = prior ? undefined : await GoalClient.status(input.client, input.scope.sessionID)
      if (!input.current()) throw new GoalClient.RequestError("Goal view changed", "target_conflict", 409, false)
      if (!prior && (!snapshot || snapshot.goalId !== input.goalID))
        throw new GoalClient.RequestError("Goal target changed", "target_conflict", 409, false)
      if (!prior && snapshot?.requestedPhase === "paused") return snapshot
      if (!prior && !GoalClient.canControl(snapshot, "pause"))
        throw new GoalClient.RequestError("Goal pause is unavailable", "busy", 409, false)
      const request =
        prior ??
        GoalClient.capture(input.client, input.scope, "pause", {
          sessionID: input.scope.sessionID,
          goalId: snapshot!.goalId,
          expectedRevision: snapshot!.revision,
          requestID: crypto.randomUUID(),
        })
      pending.set(key, request)
      const result = await GoalClient.send(request).catch((error: unknown) => {
        if (!(error instanceof GoalClient.RequestError) || !error.unknownOutcome) pending.delete(key)
        throw error
      })
      pending.delete(key)
      return result
    } finally {
      busy.delete(key)
    }
  }
}
