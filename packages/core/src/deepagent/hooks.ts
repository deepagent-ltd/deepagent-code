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

// U1 PlanController soft gate (wired into before_tool_use). It NUDGES the model to keep its plan in
// sync but MUST NEVER deny a tool its execution. The caller supplies planStale, staleReason,
// isMutating, hardGate, hasActiveStep and planExists in the payload.
//
// DESIGN (aligned with codex core/src/exec_policy.rs render_decision_for_unmatched_command): command
// safety classification and plan bookkeeping are ORTHOGONAL to whether a tool may run. In codex the
// "is this a known-safe command" check only decides auto-approve-vs-prompt; a command that is NOT
// known-safe is at worst prompted, and is Forbidden ONLY when it is genuinely dangerous AND the user
// disabled prompts. Staleness of the plan ledger is not a safety property, so — like codex — it must
// never REJECT execution.
//
// WHY THIS IS NOW WARN-ONLY (the recurring deadlock, fixed for real this time):
// three prior fixes (1783c9d6, 7bc8bed8, db5e64e6) each neutered the STALE layer but left the U9
// per-step-binding layer as a hard BLOCK. Empirically that binding block was the live deadlock —
// across 68 real sessions it produced 677 hard blocks (530 on bash), 49/68 sessions hit it, and the
// worst session had 120 consecutive commands rejected because NO plan was ever bound at session start.
// Its "grace release" was non-sticky: the counter reset to 0 on every tool that got through, so the
// pattern oscillated block-block-block-pass and denied ~75% of mutating calls indefinitely — including
// ssh/docker-exec probes the lexical classifier can only see as "mutating". A workflow-discipline gate
// must not have a blast radius like that. Every plan-ledger condition is now a WARN: the tool runs, a
// reminder rides along, and plan state can nudge but can never deny the agent its tools. If plan
// discipline needs to be ENFORCED, that belongs at finalization (stopHookGate), not at every tool call.
export const planGate = (): HookHandler => (e) => {
  if (e.name !== "before_tool_use") return { decision: "continue" }
  if (e.payload["isMutating"] !== true) return { decision: "allow" }
  // U1 soft layer: stale plan → WARN only (never block). Reality changed is a reason to re-sync the
  // plan, not a reason to deny work.
  if (e.payload["planStale"] === true) {
    const reason =
      "the plan is stale (reality changed); review it and update the `plan` tool to resync — this action still proceeds"
    const userAppendedReason =
      "a new user message arrived; your plan may no longer match the request — review it and update the `plan` tool if the goal changed"
    if (e.payload["staleReason"] === "user_appended") return { decision: "warn", blockReason: userAppendedReason }
    return { decision: "warn", blockReason: reason }
  }
  // U9 per-step binding: nudge only, and ONLY when a plan actually exists. A run that never created a
  // plan (planExists !== true) is not missing an "active step" — there is no plan to bind to — so it
  // must pass silently rather than be nagged (this also mirrors stopHookGate's planExists guard, which
  // the old hard-block path was missing). Under the hard gate WITH a plan present, a mutating tool that
  // is not bound to an active step gets a reminder, never a block.
  if (e.payload["hardGate"] === true && e.payload["planExists"] === true && e.payload["hasActiveStep"] !== true) {
    return {
      decision: "warn",
      blockReason: "no active plan step is bound to this edit; mark the step you are working on active via the plan tool",
    }
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
