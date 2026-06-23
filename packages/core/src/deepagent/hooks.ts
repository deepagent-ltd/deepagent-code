// V3 hook control plane (docs/31 §4): control-plane events with executable decisions,
// instead of relying on the model to "not do dangerous things". Includes the StopHookGate
// that blocks finalization when required validations were not run this round.
export * as DeepAgentHooks from "./hooks"

export type HookEventName =
  | "before_tool_use" | "after_tool_use" | "before_patch_apply" | "after_patch_apply" | "before_validation" | "stop"

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
export const stopHookGate = (): HookHandler => (e) => {
  if (e.name !== "stop") return { decision: "continue" }
  return e.payload["requiredValidationsRun"] === true
    ? { decision: "allow" }
    : { decision: "block", blockReason: "required validations were not run; run them before finalizing" }
}

// Reject oversized diffs before applying a patch.
// P2-2 (RESERVED, not yet wired): this is a real but independent safety feature. It is exported
// for future wiring into the before_patch_apply event; there is intentionally no production
// caller yet. Do not treat it as an active gate until it is registered.
export const patchSizeGuard = (maxLines: number): HookHandler => (e) => {
  if (e.name !== "before_patch_apply") return { decision: "continue" }
  const lines = Number(e.payload["diffLines"] ?? 0)
  return lines > maxLines ? { decision: "block", blockReason: `diff too large (${lines} > ${maxLines})` } : { decision: "allow" }
}

// P2-2: providerToolGuard was DELETED here — the gateway's ProviderExecutedToolPolicy
// (deny-by-default + allowlist) is the single authoritative provider-executed-tool gate. A second
// hook-based copy was a parallel implementation and is removed to avoid two sources of truth.
