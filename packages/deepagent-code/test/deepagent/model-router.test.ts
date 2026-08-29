import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { cleanupRunsDir, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent model router", () => {
  test("records auditable router decisions inside the global runtime boundary", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({
        enabled: true,
        runsDir: dir,
        modelRouter: {
          upstreamProviderID: "anthropic",
          upstreamModelID: "claude-test",
          reason: "test route for hard user preference",
          userPreference: "hard",
        },
      })
      const runDir = await runDeepAgentStream(dir)
      expect(await readJson(runDir, "MODEL_ROUTER_AUDIT.json")).toMatchObject({
        silent_fallback_allowed: false,
        gateway_enforced: true,
        decisions: [
          {
            execution_provider_id: "deepagent",
            selected_provider_id: "anthropic",
            selected_model_id: "claude-test",
            original_provider_id: "deepagent",
            user_preference: "hard",
            route_scope: "user_pinned_intent",
            reason: "test route for hard user preference",
          },
        ],
        execution_contract: expect.stringContaining("does not silently switch generic provider execution"),
      })
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
