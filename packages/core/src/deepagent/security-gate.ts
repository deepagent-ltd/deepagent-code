export * as SecurityGate from "./security-gate"

import { DeepAgentEvent } from "./deepagent-event"
import type { AgentDescriptor } from "../im/mention-parser"

// V4.0 §E1 — the four-layer permission GATE POLICY. This is a PURE, deterministic decision function:
// given the RESOLVED facts about an event (its source's trust tier, the actor's workspace/project
// permission, the agent's declared capabilities, and the tool/session runtime verdict), it runs the
// four checks IN ORDER and fail-closes on the FIRST failure.
//
// LAYERING: lives in `core` and imports NOTHING runtime. This module does NO IO — the caller (the
// deepagent-code wiring) resolves each fact (is the source trusted? does the actor hold the perm? did
// the runtime allow the op?) and passes booleans in, so this stays a pure, unit-testable policy with no
// Effect, no DB, no permission-store import. The wiring resolves the facts, calls `check`, and either
// proceeds or surfaces the `{failedLayer, reason}` fail-closed verdict.
//
// §E1 责任, mapped to the four layers (ALL must pass; any failure = fail closed):
//   1. event_source     : is the event's origin system in the trusted set?
//   2. actor_permission : does the acting user/agent hold the workspace/project permission?
//   3. agent_capability : if a capability is required, does the agent declare it?
//   4. runtime_operation: does the tool/session runtime allow the ACTUAL operation about to run?

// The four checks, in the ORDER they run. Failing earlier = shorter blast radius revealed to the caller.
export type SecurityLayer =
  | "event_source"
  | "actor_permission"
  | "agent_capability"
  | "runtime_operation"

// The verdict. `allowed:true` only when all four layers pass; otherwise the first failed layer + reason.
export type SecurityDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly failedLayer: SecurityLayer; readonly reason: string }

export interface SecurityInput {
  // §E1 layer 1 — resolved by the caller from the event's source + the workspace's trusted-source list.
  readonly eventSourceTrusted: boolean
  // §E1 layer 2 — resolved by the caller against the workspace/project ACL for the acting user/agent.
  readonly actorHasPermission: boolean
  // §E1 layer 3 — the agent's declared capabilities (AgentDescriptor.capabilities projection).
  readonly agentCapabilities: ReadonlyArray<string>
  // the capability this operation requires. When omitted, layer 3 is a no-op (nothing required).
  readonly requiredCapability?: string
  // §E1 layer 4 — resolved by the caller from the tool/session runtime for the ACTUAL operation.
  readonly runtimeAllowed: boolean
}

/**
 * §E1 — the pure four-layer permission check. Runs the layers in order and fail-closes on the FIRST
 * failure, returning that layer and a reason. Returns `{allowed:true}` only when every layer passes:
 *   1. event_source      → fails if !eventSourceTrusted.
 *   2. actor_permission  → fails if !actorHasPermission.
 *   3. agent_capability  → fails if requiredCapability is set AND not in agentCapabilities.
 *   4. runtime_operation → fails if !runtimeAllowed.
 */
export const check = (input: SecurityInput): SecurityDecision => {
  if (!input.eventSourceTrusted) {
    return { allowed: false, failedLayer: "event_source", reason: "event source is not trusted" }
  }

  if (!input.actorHasPermission) {
    return { allowed: false, failedLayer: "actor_permission", reason: "actor lacks workspace/project permission" }
  }

  if (input.requiredCapability != null && !input.agentCapabilities.includes(input.requiredCapability)) {
    return {
      allowed: false,
      failedLayer: "agent_capability",
      reason: `agent lacks required capability: ${input.requiredCapability}`,
    }
  }

  if (!input.runtimeAllowed) {
    return { allowed: false, failedLayer: "runtime_operation", reason: "runtime denied the operation" }
  }

  return { allowed: true }
}

// §E1 layer-1 helper — is the event's source in the workspace's trusted-source set? Pure set membership.
export const isTrustedSource = (
  source: DeepAgentEvent.EventSource,
  trusted: ReadonlyArray<DeepAgentEvent.EventSource>,
): boolean => trusted.includes(source)

// §E1 layer-3 helper — does the agent descriptor declare `cap`? Treats a missing list as empty.
export const hasCapability = (descriptor: Pick<AgentDescriptor, "capabilities">, cap: string): boolean =>
  (descriptor.capabilities ?? []).includes(cap)
