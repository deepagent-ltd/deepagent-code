import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"

// V4.1 — a durable audit record of a human GOVERNANCE action on a running goal (a plan hot-edit or a
// mid-run steer), written into the goal's Document Graph alongside the per-tick worklog trail. This
// gives "user X edited/steered goal Y at T" a queryable home (worklog docs record the loop's own ticks;
// these record the HUMAN interventions).
//
// Lives in its own module (not goal-manager.ts) because the REAL steer path is
// SessionPrompt.promptOrSteer (prompt.ts), and goal-manager imports prompt.ts — so prompt.ts cannot
// import goal-manager without a cycle. Both call THIS leaf module instead. Best-effort + idempotent per
// (kind, monotonic clock): a failure never blocks the governance action. `detail` carries the redacted
// specifics (step count / steer length, not full free-text) to keep the audit body bounded and PII-light.

// The DocumentStore holding a session's goal docs (mirrors goal-manager.goalStoreRoot). Co-located with
// the run graph under the agent data root, keyed by session id.
const goalStoreRoot = (sessionID: string): string =>
  path.join(Global.Path.agent.data, "state", "goal", sessionID, "graph")

export const writeGovernanceAudit = (
  sessionID: string,
  goalId: string,
  kind: "plan_edit" | "steer",
  detail: Record<string, unknown>,
): void => {
  try {
    const store = new DocumentStore(goalStoreRoot(sessionID))
    // A stable-ish slug that does not collide across repeated actions: include the current doc count so
    // successive edits/steers each land their own audit record rather than overwriting (upsert would
    // no-op an identical body, but sequential human actions differ).
    const seq = store.list({ type: "worklog", scope: `run:${sessionID}` }).length
    store.upsert({
      type: "worklog",
      scope: `run:${sessionID}`,
      description: `goal ${goalId} human ${kind} #${seq}`,
      idSlug: `goal-governance-${goalId}-${kind}-${seq}`,
      body: JSON.stringify({ kind, goalId, sessionID, ...detail }, null, 2),
      provenance: { source: "human", run_ref: `run:${sessionID}` },
      extensions: { goal_id: goalId, governance: kind },
    })
  } catch {
    /* best-effort audit — never block the governance action */
  }
}
