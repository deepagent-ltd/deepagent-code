// V3 hook control plane (docs/31 §4): control-plane events with executable decisions,
// instead of relying on the model to "not do dangerous things". Includes the StopHookGate
// that blocks finalization when required validations were not run this round.
export * as DeepAgentHooks from "./hooks"

export type HookEventName =
  | "before_tool_use"
  | "after_tool_use"
  | "before_patch_apply"
  | "after_patch_apply"
  | "before_validation"
  | "stop"

export type HookEvent = { readonly name: HookEventName; readonly payload: Readonly<Record<string, unknown>> }
export type HookDecision = { readonly decision: "allow" | "block" | "warn" | "continue"; readonly blockReason?: string }
export type HookHandler = (e: HookEvent) => HookDecision

export class HookPolicy {
  private handlers = new Map<HookEventName, HookHandler[]>()
  on(name: HookEventName, handler: HookHandler): this {
    const arr = this.handlers.get(name) ?? []
    arr.push(handler)
    this.handlers.set(name, arr)
    return this
  }
  // `block` dominates regardless of handler registration order; a `warn` only wins if no handler
  // blocked. (Previously the first block-or-warn returned, so an earlier `warn` could mask a
  // later `block`.) Otherwise allow.
  evaluate(event: HookEvent): HookDecision {
    let warn: HookDecision | undefined
    for (const h of this.handlers.get(event.name) ?? []) {
      const d = h(event)
      if (d.decision === "block") return d
      if (d.decision === "warn" && !warn) warn = d
    }
    return warn ?? { decision: "allow" }
  }
}

// Block finalization unless required validations ran this round.
// U1 extends this: finalization is ALSO blocked while the plan latch is stale. U9 adds: under the
// hard gate (high+), finalization requires a completion_report. The caller passes planStale,
// requiredValidationsRun, and (U9) hardGate + hasCompletionReport.
export const stopHookGate = (): HookHandler => (e) => {
  if (e.name !== "stop") return { decision: "continue" }
  if (e.payload["planStale"] === true)
    return { decision: "block", blockReason: "the plan is stale (reality changed); update the plan before finalizing" }
  // U9: high+ runs that HAVE a plan must produce a completion_report (all steps resolved) before
  // finalizing. If the run never created a plan (planExists=false), the hard report requirement does
  // not apply — we don't retroactively demand a report from a run that worked without one.
  if (e.payload["hardGate"] === true && e.payload["planExists"] === true && e.payload["hasCompletionReport"] !== true)
    return {
      decision: "block",
      blockReason:
        "high-strength runs require a completion report before finalizing; resolve or cancel outstanding plan steps first",
    }
  return e.payload["requiredValidationsRun"] === true
    ? { decision: "allow" }
    : { decision: "block", blockReason: "required validations were not run; run them before finalizing" }
}

// U1 PlanController soft gate (wired into before_tool_use). While the plan latch is stale, MUTATING
// tools (write/edit/patch/shell) are soft-blocked so the model must update the plan before changing
// more files; READ/diagnosis tools always pass (otherwise a stale plan could never be
// repaired). Lightweight modes (general/direct) only WARN — ordinary tasks are never slowed
// (docs/38 §9). The caller supplies planStale, isMutating and lightweight in the payload.
//
// U9 hard gate (high+): even with a fresh plan, a mutating tool must be BOUND to an active step.
// hardGateMissBlocks=true (xhigh/max/ultra) -> block on a missing active step; false (high) -> warn.
// The payload carries hardGate, hasActiveStep, hardGateMissBlocks.
//
// DESIGN (aligned with codex core/src/exec_policy.rs render_decision_for_unmatched_command): command
// safety classification and plan bookkeeping are ORTHOGONAL to whether a tool may run. In codex the
// "is this a known-safe command" check only decides auto-approve-vs-prompt; a command that is NOT
// known-safe is at worst prompted, and is Forbidden ONLY when it is genuinely dangerous AND the user
// disabled prompts. Staleness of the plan ledger is not a safety property, so — like codex — it must
// never REJECT execution. Our previous code coupled the two: a mutating tool on a stale plan was
// hard-blocked in high+ mode, which deadlocked a model that did not repair the plan (observed: 280
// consecutive blocked bash calls, and a read-only `ssh/docker exec` probe misclassified as mutating
// then denied outright). This gate now downgrades EVERY plan-ledger condition to a WARN (the tool
// runs, a reminder is attached), so plan state can nudge but can never deny the agent its tools.
//
// The two remaining honest signals differ only in wording:
//   - staleReason === "user_appended": a new user message MIGHT change intent — nudge to re-align.
//   - graceRelease === true: repeated stale blocks with no forward progress (runtime-driven counter).
// Both warn; neither blocks.
export const planGate = (): HookHandler => (e) => {
  if (e.name !== "before_tool_use") return { decision: "continue" }
  if (e.payload["isMutating"] !== true) return { decision: "allow" }
  // U1 soft layer: stale plan → WARN only (never block). Reality changed / a user message arrived is
  // a reason to re-sync the plan, not a reason to deny work.
  if (e.payload["planStale"] === true) {
    const reason = "the plan is stale (reality changed); review it and update the `plan` tool to resync — this action still proceeds"
    const userAppendedReason =
      "a new user message arrived; your plan may no longer match the request — review it and update the `plan` tool if the goal changed"
    if (e.payload["staleReason"] === "user_appended") return { decision: "warn", blockReason: userAppendedReason }
    return { decision: "warn", blockReason: reason }
  }
  // U9 hard layer: per-step binding (high+ only; lightweight never reaches here with hardGate set). A
  // mutating tool under a strict hard gate must be bound to an active step. This is a workflow-
  // discipline gate, not a safety gate, so it MUST also have a runtime-driven release: if the gate has
  // already blocked this many times with no forward progress (graceRelease), stop blocking and let the
  // tool through with a reminder — otherwise a model that never marks a step active would be
  // permanently denied its tools (the same deadlock class the stale layer just fixed).
  if (e.payload["hardGate"] === true && e.payload["hasActiveStep"] !== true) {
    const reason =
      "no active plan step is bound to this edit; mark the step you are working on active via the plan tool"
    if (e.payload["hardGateMissBlocks"] === true && e.payload["graceRelease"] !== true)
      return { decision: "block", blockReason: reason }
    return { decision: "warn", blockReason: reason }
  }
  return { decision: "allow" }
}

// Reject oversized diffs before applying a patch.
// P2-2 (RESERVED, not yet wired): this is a real but independent safety feature. It is exported
// for future wiring into the before_patch_apply event; there is intentionally no production
// caller yet. Do not treat it as an active gate until it is registered.
export const patchSizeGuard =
  (maxLines: number): HookHandler =>
  (e) => {
    if (e.name !== "before_patch_apply") return { decision: "continue" }
    const lines = Number(e.payload["diffLines"] ?? 0)
    return lines > maxLines
      ? { decision: "block", blockReason: `diff too large (${lines} > ${maxLines})` }
      : { decision: "allow" }
  }

// P2-2: providerToolGuard was DELETED here — the gateway's ProviderExecutedToolPolicy
// (deny-by-default + allowlist) is the single authoritative provider-executed-tool gate. A second
// hook-based copy was a parallel implementation and is removed to avoid two sources of truth.
