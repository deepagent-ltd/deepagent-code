import { Effect } from "effect"
import { runPanel, type PanelArchiver } from "./orchestrator"
import { buildPanelistRunner, type PanelTurnRunner } from "./panelist-runner"
import {
  PANEL_LENSES,
  DEFAULT_QUORUM_POLICY,
  SECURITY_AUDIT_QUORUM_POLICY,
  type PanelLens,
  type PanelVerdict,
  type QuorumPolicy,
} from "../agent/schema/panel"

/**
 * V3.9 §C — the STANDALONE Expert Panel entry (会诊), decoupled from the Goal Loop.
 *
 * The panel engine (`orchestrator.runPanel` + deterministic `arbiter`) is convened here directly by a
 * user action (the chat-dialog panel button) instead of only as a goal-loop grader. The flow matches
 * §C.4: freeze the question → fan out the lens panelists (mutually invisible) → optional debate rounds
 * → deterministic arbitration → `PanelVerdict`. Activation semantics (§C, per the product spec):
 *   - The panel is "armed" per conversation (seeded from the global `expertPanelDefault` setting).
 *   - Arming mid-conversation (button OFF→ON) convenes ONE panel on the CURRENT context immediately,
 *     then goes quiet ("等待唤醒") — no per-turn re-runs.
 *   - A subsequent button press while armed re-convenes on demand.
 * The server route owns the arm/disarm state (session-state.panelArmed) and the "run now" trigger; this
 * module owns the convening itself so it is unit-testable without HTTP.
 */

export type ConsultInput = {
  /** The frozen question the panel answers (built from the current conversation context by the caller). */
  readonly question: string
  /** Code references (file / file:line) the panelists ground findings in. May be empty. */
  readonly codeRefs: readonly string[]
  /** Parent (conversation) session id — the TaskConcurrency semaphore key + panelist child parent. */
  readonly parentSessionID: string
  /** The lens set to convene. Defaults to all five core lenses (§C.3). Deduped + capped by runPanel. */
  readonly lenses?: readonly PanelLens[]
  /** Debate-round cap R (≥ 1). Round 1 always runs; 2..R are debate. Defaults to 1 (single round). */
  readonly maxRounds?: number
  /**
   * Which quorum policy governs arbitration. "default" = weighted majority / conservative-on-tie;
   * "security" = any block blocks (§C.6 安全审计). Defaults to "default". A caller may also pass a full
   * QuorumPolicy object for a custom event type.
   */
  readonly policy?: "default" | "security" | QuorumPolicy
}

export type ConsultDeps = {
  /** The real subagent turn runner (a lens-prompted reviewer child session); tests inject a stub. */
  readonly runTurn: PanelTurnRunner
  /** Optional archiver so each opinion is projected into the Document Graph (§B Wiki). */
  readonly archive?: PanelArchiver
}

const resolvePolicy = (policy: ConsultInput["policy"]): QuorumPolicy => {
  if (policy == null || policy === "default") return DEFAULT_QUORUM_POLICY
  if (policy === "security") return SECURITY_AUDIT_QUORUM_POLICY
  return policy
}

/**
 * Convene the Expert Panel on a frozen question and return the deterministic `PanelVerdict`. Never
 * throws: a panel that cannot reach quorum (all panelists absent / below minQuorum) returns a
 * `needs_human` verdict via the Arbiter, never a silent approve.
 */
export const consultPanel = (input: ConsultInput, deps: ConsultDeps): Effect.Effect<PanelVerdict> =>
  runPanel({
    question: {
      question: input.question,
      codeRefs: input.codeRefs,
      lenses: input.lenses ?? PANEL_LENSES,
      maxRounds: input.maxRounds ?? 1,
      policy: resolvePolicy(input.policy),
    },
    runPanelist: buildPanelistRunner(deps.runTurn),
    ...(deps.archive ? { archive: deps.archive } : {}),
    parentSessionID: input.parentSessionID,
  })

export * as PanelConsult from "./consult"
