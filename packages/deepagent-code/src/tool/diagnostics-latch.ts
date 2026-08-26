import { Effect } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Diagnostic } from "@/lsp/diagnostic"
import type * as LSPClient from "@/lsp/client"

/**
 * L4 (S1-v3.4): derive the plan-stale latch from post-edit diagnostics — but ONLY in high+
 * modes. The runtime derives staleness from real signals (not model self-report); an
 * error-severity diagnostic after an edit is exactly such a signal. In lightweight
 * (general/direct) modes this is a NO-OP: we never touch the latch, never add a model call,
 * so the default agent does not regress (docs/S1-v3.4 L4 acceptance (e)).
 */
export const latchPlanOnDiagnosticsError = (
  sessionID: string,
  diagnostics: Record<string, LSPClient.Diagnostic[]>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const agentMode = AgentGateway.snapshot().agentMode ?? "high"
    if (AgentGateway.DeepAgentPlanController.isLightweightMode(agentMode)) return
    if (!Diagnostic.hasErrors(diagnostics)) return
    AgentGateway.DeepAgentSessionState.markPlanStale(sessionID, "diagnostics_error")
  })
