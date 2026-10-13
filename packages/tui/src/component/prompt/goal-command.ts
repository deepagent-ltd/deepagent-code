import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"

/** A command owns its captured target until acknowledgement. Leaving the view stops the
 * status-to-control handoff, and unknown writes can only retry their original descriptor. */
export function createGoalCommands() {
  const pending = new Map<string, GoalClient.Descriptor>()
  const busy = new Set<string>()
  return {
    async run(input: { client: GoalClient.Client; scope: GoalClient.Scope; command: string; current(): boolean }) {
      const key = GoalClient.scopeKey(input.scope)
      if (busy.has(key))
        throw new GoalClient.RequestError("Goal command is already awaiting acknowledgement", "busy", 409, false)
      const prior = pending.get(key)
      if (prior && input.command !== "retry")
        throw new GoalClient.RequestError(
          "Previous Goal outcome is unknown. Use /goal retry to retry the same request",
          "pending_request",
          undefined,
          true,
        )
      if (!prior && input.command === "retry")
        throw new GoalClient.RequestError("No unconfirmed Goal request exists for this target", "not_found", 404, false)
      busy.add(key)
      try {
        const request =
          prior ??
          (await (async () => {
            const action =
              input.command === "pause" || input.command === "resume" || input.command === "stop"
                ? input.command
                : "start"
            if (action === "start")
              return GoalClient.capture(input.client, input.scope, action, {
                sessionID: input.scope.sessionID,
                requestID: crypto.randomUUID(),
                ...(input.command ? { objective: input.command } : {}),
              })
            const snapshot = await GoalClient.status(input.client, input.scope.sessionID)
            if (!input.current())
              throw new GoalClient.RequestError(
                "Goal target changed before control admission",
                "target_conflict",
                409,
                false,
              )
            if (!GoalClient.canControl(snapshot, action))
              throw new GoalClient.RequestError("Goal control is unavailable in the current state", "busy", 409, false)
            return GoalClient.capture(input.client, input.scope, action, {
              sessionID: input.scope.sessionID,
              goalId: snapshot!.goalId,
              expectedRevision: snapshot!.revision,
              requestID: crypto.randomUUID(),
            })
          })())
        if (!input.current())
          throw new GoalClient.RequestError(
            "Goal target changed before control admission",
            "target_conflict",
            409,
            false,
          )
        pending.set(key, request)
        const snapshot = await GoalClient.send(request).catch((error: unknown) => {
          if (!(error instanceof GoalClient.RequestError) || !error.unknownOutcome) pending.delete(key)
          throw error
        })
        pending.delete(key)
        return { snapshot, request }
      } finally {
        busy.delete(key)
      }
    },
  }
}
