import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { DeepAgentActivityAuthority } from "../../src/deepagent/activity-authority"
import { Hash } from "../../src/util/hash"
import { seedActivity, seedSession } from "./attention"
import { expect } from "bun:test"

export function challenge(
  database: Database.Interface,
  name: string,
  options: { project?: string; workspace?: string; leaseMs?: number } = {},
) {
  return Effect.gen(function* () {
    const sessionID = yield* seedSession(database, name, options)
    const activityID = yield* seedActivity(database, sessionID, name, "active")
    const ref = { activityKind: "v2" as const, activityID }
    const configured = yield* DeepAgentActivityAuthority.configure({
      ...ref,
      expectedVersion: 1,
      objectiveText: "Complete the current task",
      completionCriteria: [{ kind: "plan_complete" }],
      enforcementState: "monitoring",
      stallThreshold: 2,
    })
    const observe = (expectedVersion: number) =>
      DeepAgentActivityAuthority.observe({
        ...ref,
        expectedVersion,
        idempotencyKey: `${name}:observation:${expectedVersion}`,
        workspaceRevision: "workspace-1",
        evidence: [],
        effectReceipts: [],
        nextAction: "continue",
      })
    const first = yield* observe(configured.version)
    const second = yield* observe(first.objective.version)
    const stalled = yield* observe(second.objective.version)
    expect(stalled.objective.state).toBe("needs_human")
    const ownerID = `owner:${name}`
    yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID, leaseMs: options.leaseMs ?? 60_000 })
    const requestID = `per_${Hash.sha256(`v2-no-progress:${activityID}:${stalled.observation.revision}`).slice(0, 48)}`
    yield* DeepAgentActivityAuthority.requestPermission({
      ...ref,
      requestID,
      requestKind: "no_progress",
      idempotencyKey: `request:${name}`,
      permission: "doom_loop",
      patterns: ["activity"],
      alwaysPatterns: ["activity"],
      metadata: { kind: "no_progress", activity_id: activityID, observation_revision: stalled.observation.revision },
      ownerID,
      workspaceID: options.workspace,
      expiresAt: Date.now() + 86_400_000,
    })
    return { sessionID, activityID, requestID, ownerID }
  })
}
