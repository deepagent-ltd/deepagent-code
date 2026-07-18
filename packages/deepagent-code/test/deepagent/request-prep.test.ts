import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect } from "effect"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { ToolProvenance } from "../../src/tool/provenance"

const plugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

const user = (providerID: string, modelID: string, sessionID: string, metadata?: Record<string, unknown>) =>
  ({
    id: "msg_deepagent_request_prep",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID, modelID },
    metadata,
  }) as any

const model = (providerID: string, modelID: string) =>
  ({
    id: modelID,
    providerID,
    api: {
      id: modelID,
      url: "https://example.invalid",
      npm: "@ai-sdk/openai-compatible",
    },
    name: modelID,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, input: 128_000, output: 32_000 },
    status: "active",
    options: {},
    headers: {},
  }) as any

// Prompt-cache split (docs/deepagent-cache-hit-fix-plan.md): the round/stage/budget context is no
// longer baked into the cached system prefix — it is appended as a trailing user message. Read it
// back from the LAST message so the round-advance assertions test the right place.
const tailContext = (prepared: { messages: any[] }): string => {
  const last = prepared.messages[prepared.messages.length - 1]
  if (!last || last.role !== "user") return ""
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content)
}

async function prepare(
  providerID: string,
  modelID: string,
  sessionID = `ses_deepagent_request_prep_${providerID}_${modelID}`,
  options: { messages?: any[]; metadata?: Record<string, unknown> } = {},
) {
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: user(providerID, modelID, sessionID, options.metadata),
      sessionID,
      model: model(providerID, modelID),
      agent: {
        name: "build",
        mode: "primary",
        prompt: "generic agent prompt",
        options: {},
        permission: [],
      } as any,
      system: ["You are deepagent-code, an interactive CLI tool that helps users with software engineering tasks."],
      messages: options.messages ?? [{ role: "user", content: "hello" }],
      tools: {},
      provider: { id: providerID, options: {} } as any,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }),
  )
}

describe("DeepAgent request prep", () => {
  // V3.1 global runtime: in high/max the DeepAgent system prompt is injected for EVERY provider
  // (DeepAgent is a global agent system, not a provider). The distinguishing axis is strength
  // (general vs high/max), not providerID. See deepagent-production-contract.md "Runtime Boundary".
  test("injects the DeepAgent system prompt for every provider in high mode", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const deepagent = await prepare("deepagent", "deepseek-deepseek-v4-flash")
    expect(deepagent.system[0]).toContain("DeepAgent Code")
    expect(deepagent.system[0]).not.toContain("DeepCode")
    expect(deepagent.system[0]).toContain("High")
    // Prompt-cache split: the activation stage is round-derived and now lives in the volatile tail
    // message, NOT the cached system prefix.
    expect(deepagent.system[0]).not.toContain("first_fast_design")
    expect(tailContext(deepagent)).toContain("first_fast_design")
    expect(deepagent.system[0]).not.toContain("generic agent prompt")
    expect(deepagent.system[0]).not.toContain("You are deepagent-code")
    expect(deepagent.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("DeepAgent Code"),
    })

    // An ordinary upstream provider now also runs under the DeepAgent runtime in high mode.
    const ordinary = await prepare("deepseek", "deepseek-v4-flash")
    expect(ordinary.system[0]).toContain("DeepAgent Code")
    expect(ordinary.system[0]).toContain("High")
    expect(ordinary.system[0]).not.toContain("generic agent prompt")
    expect(ordinary.system[0]).not.toContain("You are deepagent-code")
    expect(ordinary.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("DeepAgent Code"),
    })
    expect(ordinary.messages[1]).toMatchObject({ role: "user", content: "hello" })
  })

  test("general mode keeps the DeepAgent provider on the default agent path", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "general" })

    const prepared = await prepare("deepagent", "deepseek-deepseek-v4-flash", "ses_deepagent_request_prep_general")
    expect(prepared.system[0]).toContain("generic agent prompt")
    expect(prepared.system[0]).toContain("You are deepagent-code")
    expect(prepared.system[0]).not.toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
    expect(prepared.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("generic agent prompt"),
    })
    expect(prepared.messages[0]).toMatchObject({
      role: "system",
      content: expect.not.stringContaining(AgentGateway.DEEPAGENT_BOOT_MESSAGE),
    })
    expect(prepared.messages[1]).toMatchObject({ role: "user", content: "hello" })

    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  // L2 (v3.8.0 §L2): the orchestration guidance section is injected on BOTH assembly paths.
  test("injects the orchestration section on the DeepAgent path (high mode)", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const prepared = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_deepagent_high")
    expect(prepared.system[0]).toContain("多-Agent 编排")
    expect(prepared.system[0]).toContain("扇出判据")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("injects the tier-0 orchestration section on the non-DeepAgent path (general)", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "general" })
    const prepared = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_general")
    // non-DeepAgent path keeps the inherited prompt AND appends the tier-0 (off-by-default) guidance
    expect(prepared.system[0]).toContain("generic agent prompt")
    expect(prepared.system[0]).toContain("多-Agent 编排")
    expect(prepared.system[0]).toContain("默认不自动编排")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  // Prompt-cache split (docs/deepagent-cache-hit-fix-plan.md): the non-DeepAgent path no longer inlines
  // a per-turn fan-out VERDICT into the system prompt — that was request-text-derived and busted the
  // cache. The system block now carries only the STABLE, mode-derived generic guidance, so it is
  // byte-identical regardless of the request. (The DeepAgent path surfaces the concrete verdict via the
  // volatile tail context instead.)
  test("§5b system prompt carries only stable orchestration guidance, no per-turn verdict (non-DeepAgent, high)", async () => {
    AgentGateway.configure({ enabled: false, agentMode: "high" })
    const complex = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_decision_complex", {
      messages: [{ role: "user", content: "migrate the auth interface across subsystems and review it thoroughly" }],
    })
    const trivial = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_decision_trivial", {
      messages: [{ role: "user", content: "fix the typo in utils.ts" }],
    })
    // Generic guidance is present...
    expect(complex.system[0]).toContain("扇出判据")
    // ...but no task-specific verdict is inlined into the cached prefix.
    expect(complex.system[0]).not.toContain("本轮调度判定")
    expect(trivial.system[0]).not.toContain("不建议扇出")
    // And the orchestration guidance is identical across two very different requests (stable prefix).
    expect(trivial.system[0]).toBe(complex.system[0])
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("wish-routed general turns use the inherited prompt and bypass DeepAgent metadata", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const prepared = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      "ses_deepagent_request_prep_wish_general",
      {
        metadata: { deepagent: { agent_mode_override: "general" } },
      },
    )
    expect(prepared.system[0]).toContain("generic agent prompt")
    expect(prepared.system[0]).not.toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
    expect(prepared.metadata.deepagent).toMatchObject({ agent_mode_override: "general" })
  })

  test("SECURITY: a client-supplied agent_mode_override cannot escalate above the process-global mode", async () => {
    // The override rides on the client-writable user-message metadata. When the process-global mode
    // is "high", an "ultra" override (an ESCALATION) must be clamped away — the prepared metadata must
    // NOT re-emit `agent_mode_override: "ultra"`, so a subagent/HTTP client cannot self-promote into
    // autonomous ultra mode. A downgrade ("general") on the same global is still honored.
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const escalated = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      "ses_deepagent_request_prep_escalate",
      { metadata: { deepagent: { agent_mode_override: "ultra" } } },
    )
    // Clamped: the escalation is dropped, so no override is re-emitted (falls back to global "high").
    expect((escalated.metadata.deepagent as Record<string, unknown> | undefined)?.agent_mode_override).toBeUndefined()

    const downgraded = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      "ses_deepagent_request_prep_downgrade",
      { metadata: { deepagent: { agent_mode_override: "general" } } },
    )
    expect((downgraded.metadata.deepagent as Record<string, unknown>).agent_mode_override).toBe("general")
  })

  test("plain later user messages do not advance DeepAgent rounds", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const prepared = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      `ses_deepagent_request_prep_no_count_round_${crypto.randomUUID()}`,
      {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      },
    )
    expect(tailContext(prepared)).toContain("第 1 轮")
    // The round number must NOT be in the cached system prefix (prompt-cache invariant).
    expect(prepared.system[0]).not.toContain("第 1 轮")
  })

  test("explicit round control advances DeepAgent rounds", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const prepared = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      `ses_deepagent_request_prep_explicit_round_${crypto.randomUUID()}`,
      {
        metadata: { deepagent: { round_control: { action: "continue" } } },
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "continue" },
        ],
      },
    )
    expect(tailContext(prepared)).toContain("第 2 轮")
  })

  // T3 (S1-v3.4): the advance-trigger set {continue, revise, narrow} advances the round; the terminal
  // markers {stop, escalate} inject no turn and must NOT advance (else a non-existent round is counted).
  for (const action of ["revise", "narrow"]) {
    test(`round control "${action}" advances DeepAgent rounds`, async () => {
      AgentGateway.configure({ enabled: true, agentMode: "high" })
      const prepared = await prepare(
        "deepagent",
        "deepseek-deepseek-v4-flash",
        `ses_rc_adv_${action}_${crypto.randomUUID()}`,
        {
          metadata: { deepagent: { round_control: { action } } },
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "next" },
          ],
        },
      )
      expect(tailContext(prepared)).toContain("第 2 轮")
    })
  }

  test("system prefix is byte-stable across rounds (prompt-cache invariant)", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_deepagent_prefix_stable_${crypto.randomUUID()}`

    const round1 = await prepare("deepagent", "deepseek-deepseek-v4-flash", sessionID, {
      messages: [{ role: "user", content: "first" }],
    })
    const round2 = await prepare("deepagent", "deepseek-deepseek-v4-flash", sessionID, {
      metadata: { deepagent: { round_control: { action: "continue" } } },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ],
    })

    // The cached system prefix must not change even though the round advanced 1 → 2.
    expect(round2.system[0]).toBe(round1.system[0])
    // ...and the round actually advanced, proving the round number lives only in the volatile tail.
    expect(tailContext(round1)).toContain("第 1 轮")
    expect(tailContext(round2)).toContain("第 2 轮")
  })

  for (const action of ["stop", "escalate"]) {
    test(`terminal round control "${action}" does NOT advance rounds`, async () => {
      AgentGateway.configure({ enabled: true, agentMode: "high" })
      const prepared = await prepare(
        "deepagent",
        "deepseek-deepseek-v4-flash",
        `ses_rc_term_${action}_${crypto.randomUUID()}`,
        {
          metadata: { deepagent: { round_control: { action } } },
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "next" },
          ],
        },
      )
      expect(tailContext(prepared)).toContain("第 1 轮")
    })
  }

  test("does not inject DeepAgent identity when gateway is disabled", async () => {
    AgentGateway.configure({ enabled: false, agentMode: "max" })

    const prepared = await prepare("deepagent", "deepseek-deepseek-v4-flash", "ses_deepagent_request_prep_disabled")
    expect(prepared.system[0]).not.toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
    expect(prepared.messages[0]).toMatchObject({
      role: "system",
      content: expect.not.stringContaining(AgentGateway.DEEPAGENT_BOOT_MESSAGE),
    })

    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("returns run metadata with tool capabilities", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const sessionID = "ses_deepagent_request_prep_metadata"
    // M2 (S1-v3.4): source is now read from explicit provenance, not the tool name.
    // A `_`-named MCP tool (default naming) must classify as mcp; a `:`-named tool
    // WITHOUT provenance must NOT be misread as mcp anymore.
    const bashTool = {} as any
    const mcpTool = {} as any
    ToolProvenance.set(mcpTool, { source: "mcp", mcpServer: "lookup", mcpToolName: "search" })
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: user("deepagent", "deepseek-deepseek-v4-flash", sessionID),
        sessionID,
        parentSessionID: "ses_parent",
        model: model("deepagent", "deepseek-deepseek-v4-flash"),
        agent: {
          name: "build",
          mode: "primary",
          prompt: "generic agent prompt",
          options: {},
          permission: [],
        } as any,
        system: ["You are deepagent-code, an interactive CLI tool that helps users with software engineering tasks."],
        messages: [{ role: "user", content: "hello" }],
        tools: {
          bash: bashTool,
          invalid: {} as any,
          lookup_search: mcpTool,
        },
        provider: { id: "deepagent", options: {} } as any,
        auth: undefined,
        plugin,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
      }),
    )

    expect(prepared.metadata).toMatchObject({
      "deepagent-code": {
        callKind: "session_turn",
        feature: "session_chat",
        sessionID,
        messageID: "msg_deepagent_request_prep",
        parentSessionID: "ses_parent",
        agent: "build",
      },
      deepagent: {
        tool_capabilities: [
          {
            name: "bash",
            source: "generic_agent_tool_registry",
            execution_owner: "generic_agent_tool_registry_or_mcp",
          },
          {
            name: "lookup_search",
            source: "mcp_or_namespaced_tool",
            execution_owner: "generic_agent_tool_registry_or_mcp",
          },
        ],
      },
    })
  })
})

// S41-2: goal-loop scorer false positives. extractValidationResults must only treat outputs of the
// DECLARED validation commands as validation evidence (diagnostic bash calls like grep/tail of logs
// must not poison the score), and per declared command the LATEST run must win so a fixed failure
// does not stay "failed" forever.
describe("extractValidationResults (S41-2)", () => {
  const validationCommands = ["bun run typecheck", "bun run lint", "bun run test"]

  const bashCall = (id: string, command: string) =>
    ({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: { command } }],
    }) as any

  const bashResult = (id: string, output: string) =>
    ({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: output } },
      ],
    }) as any

  test("ignores diagnostic bash outputs that merely mention errors", () => {
    const results = LLMRequestPrep.extractValidationResults(
      [
        bashCall("c1", "grep '(fail)' /tmp/turbo-test.log | tail -5"),
        bashResult("c1", "ERROR run failed: command exited (1)\nerror: script exited with code 1"),
        bashCall("c2", "bun run typecheck >/dev/null 2>&1 && echo done"),
        bashResult("c2", "typecheck validation exit code: 0"),
      ],
      validationCommands,
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ command: "bun run typecheck", passed: true, exit_code: 0 })
  })

  test("latest run per declared command wins over an older failure", () => {
    const results = LLMRequestPrep.extractValidationResults(
      [
        bashCall("c1", "bun run test"),
        bashResult("c1", "error: script \"test\" exited with code 1"),
        bashCall("c2", "bun run test >/dev/null 2>&1 && echo done"),
        bashResult("c2", "test validation exit code: 0"),
      ],
      validationCommands,
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ command: "bun run test", passed: true, exit_code: 0 })
  })

  test("keeps a genuinely failing declared command as failed with its real command name", () => {
    const results = LLMRequestPrep.extractValidationResults(
      [bashCall("c1", "bun run test"), bashResult("c1", "20 passed, 1 failed")],
      validationCommands,
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ command: "bun run test", passed: false, exit_code: 1 })
  })

  test("one combined invocation covers every declared command it contains", () => {
    const results = LLMRequestPrep.extractValidationResults(
      [
        bashCall("c1", "bun run typecheck && bun run lint && bun run test"),
        bashResult("c1", "all three declared validation commands exit code: 0"),
      ],
      validationCommands,
    )
    expect(results).toHaveLength(3)
    expect(results.map((item) => item.command).sort()).toEqual([...validationCommands].sort())
    expect(results.every((item) => item.passed)).toBe(true)
  })

  test("returns nothing when no validation commands are declared", () => {
    const results = LLMRequestPrep.extractValidationResults(
      [bashCall("c1", "bun run test"), bashResult("c1", "FAILED")],
      [],
    )
    expect(results).toHaveLength(0)
  })
})

// STALE-REHARVEST GUARD: extractValidationResults re-scans the WHOLE transcript every turn, so a single
// early test run (e.g. "✓ cancel with queued callers [3882.11ms]") is re-extracted verbatim on every
// later turn as long as it stays in history. validationFingerprint lets the caller tell a genuine NEW
// run apart from a stale re-harvest, so the same result is not re-recorded as a fresh candidate N times
// (the "26轮逐字不变" duplication).
describe("validationFingerprint (stale-reharvest guard)", () => {
  const vr = (command: string, exit_code: number, output: string): AgentGateway.ValidationResult => ({
    command,
    passed: exit_code === 0,
    exit_code,
    output,
    duration_ms: 0,
  })

  test("identical result sets fingerprint equal (a stale re-harvest is detected)", () => {
    const a = [vr("bun run test", 0, "✓ cancel with queued callers [3882.11ms]")]
    const b = [vr("bun run test", 0, "✓ cancel with queued callers [3882.11ms]")]
    expect(LLMRequestPrep.validationFingerprint(a)).toBe(LLMRequestPrep.validationFingerprint(b))
  })

  test("is order-independent across map-iteration order", () => {
    const a = [vr("bun run typecheck", 0, "ok"), vr("bun run test", 0, "ok")]
    const b = [vr("bun run test", 0, "ok"), vr("bun run typecheck", 0, "ok")]
    expect(LLMRequestPrep.validationFingerprint(a)).toBe(LLMRequestPrep.validationFingerprint(b))
  })

  test("a genuine state change (pass→fail via exit code) fingerprints differently", () => {
    const pass = [vr("bun run test", 0, "20 passed")]
    const fail = [vr("bun run test", 1, "19 passed, 1 failed")]
    expect(LLMRequestPrep.validationFingerprint(pass)).not.toBe(LLMRequestPrep.validationFingerprint(fail))
  })

  test("volatile output with the SAME exit code fingerprints EQUAL (guard not defeated by noise)", () => {
    // Same command, same exit 0, but the output carries a volatile duration/timestamp. Keying on
    // command+exit_code (not output) means this is correctly seen as the SAME evidence, so a noisy
    // re-harvest does not masquerade as a new run.
    const run1 = [vr("bun run test", 0, "✓ cancel with queued callers [3882.11ms]")]
    const run2 = [vr("bun run test", 0, "✓ cancel with queued callers [4021.55ms]")]
    expect(LLMRequestPrep.validationFingerprint(run1)).toBe(LLMRequestPrep.validationFingerprint(run2))
  })

  test("an empty set differs from any non-empty set (first evidence is always new)", () => {
    expect(LLMRequestPrep.validationFingerprint([])).not.toBe(
      LLMRequestPrep.validationFingerprint([vr("bun run test", 0, "ok")]),
    )
  })
})
