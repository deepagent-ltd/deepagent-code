import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Model } from "@deepagent-code/llm"
import { AgentGateway } from "../src/agent-gateway"
import { writePinnedPacks } from "../src/deepagent/pinned-packs"
import { DeepAgentDurableLearning } from "../src/deepagent/durable-learning"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { releasedUserGlobalSelection } from "./deepagent/released-selection-fixture"

const deepagentRunInput = {
  callKind: "session_turn" as const,
  feature: "session_chat",
  providerID: "deepagent",
  modelID: "deepagent/default",
  sessionID: "ses_test",
  messageID: "msg_test",
  workspaceID: "workspace_test",
  agent: "user:test",
  origin: {
    file: "packages/core/src/session/runner/llm.ts",
    function: "SessionRunner.runTurn",
  },
}

const defaultProviderRunInput = {
  ...deepagentRunInput,
  providerID: "openai",
  modelID: "gpt-test",
}

const tempRunsDir = () => mkdtemp(path.join(tmpdir(), "deepagent-runs-"))

const readOnlyRunDir = async (dir: string) => {
  const runs = await readdir(dir)
  expect(runs).toHaveLength(1)
  return path.join(dir, runs[0]!)
}

const readJson = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, name), "utf8"))

describe("AgentGateway", () => {
  test("global runtime manages upstream providers under high/max", async () => {
    // V3.1 global runtime: DeepAgent is provider-agnostic. A high/max turn on any upstream
    // provider (here openai) is managed and writes run artifacts, and the DeepAgent system
    // prompt is injected regardless of providerID. (Pre-V3.1 this provider was passthrough.)
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          defaultProviderRunInput,
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "hello" }), LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta", "finish"])
      expect(await readdir(dir)).toHaveLength(1)
      expect(AgentGateway.systemPrompt("openai").join("\n").length).toBeGreaterThan(0)
      // FEAT-007: the run entry locks the active pack snapshot id onto the session state so the
      // session prompt loop can attribute each tool-request receipt (no registry configured here →
      // the deterministic `pack_snapshot:empty` sentinel, still a valid `pack_snapshot:%` value).
      expect(AgentGateway.DeepAgentSessionState.get("ses_test")?.packSnapshotId).toMatch(/^pack_snapshot:/)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("flag-gated durable learning finalization admits one immutable background job", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    const admissions: Array<Parameters<AgentGateway.LearningAuthority["enqueue"]>[0]> = []
    const runStatesAtAdmission: string[] = []
    const runStatesAtEnqueue: string[] = []
    try {
      AgentGateway.setLearningAuthority({
        record: async (admission) => {
          const runs = await readdir(runsDir)
          const state = await readJson(path.join(runsDir, runs[0]!), "DEEPAGENT_RUN_STATE.json")
          runStatesAtAdmission.push(state.state as string)
          admissions.push(admission)
        },
        enqueue: async (admission) => {
          const content = await readFile(admission.terminalArtifact.path, "utf8")
          runStatesAtEnqueue.push((JSON.parse(content) as { state: string }).state)
          expect(createHash("sha256").update(content).digest("hex")).toBe(admission.terminalArtifact.sha256)
        },
      })
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        baseDir: root,
        runsDir,
        durableLearning: true,
        selfLearning: "auto",
        allowProviderExecutedTools: false,
      })

      await Effect.runPromise(
        AgentGateway.manageStream(
          { ...deepagentRunInput, workspaceID: path.join(root, "workspace") },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      expect(admissions).toHaveLength(1)
      expect(runStatesAtAdmission).toEqual(["completed"])
      expect(runStatesAtEnqueue).toEqual(["completed"])
      expect(admissions[0]).toMatchObject({
        baseDir: root,
        workspacePath: path.join(root, "workspace"),
        rejectedBufferDir: path.join(root, "memory"),
        terminalArtifact: {
          schema_version: "deepagent-code.learning_terminal_artifact.v1",
          path: expect.stringContaining("DEEPAGENT_RUN_STATE.json"),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        input: {
          sessionID: "ses_test",
          finalStatus: "completed",
          trigger: "session_finalization",
          policy: "auto_merge_safe_project",
        },
      })
      expect(admissions[0]?.input.roundState).not.toBe(AgentGateway.DeepAgentSessionState.get("ses_test")?.roundState)
      expect(await readJson(await readOnlyRunDir(runsDir), "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        state: "completed",
      })
      expect(await readJson(await readOnlyRunDir(runsDir), AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)).toMatchObject(
        {
          schema_version: "deepagent-code.learning_admission_receipt.v1",
          state: "submitted",
          last_error: null,
        },
      )
    } finally {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps provider success terminal when the durable learning authority is unavailable", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    const workspace = path.join(root, "workspace")
    try {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        baseDir: root,
        runsDir,
        durableLearning: true,
        selfLearning: "manual",
        allowProviderExecutedTools: false,
      })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          { ...deepagentRunInput, workspaceID: workspace },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      const runDir = await readOnlyRunDir(runsDir)

      expect(Array.from(events).map((event) => event.type)).toEqual(["finish"])
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({ state: "completed" })
      expect(await readJson(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)).toMatchObject({
        state: "local_pending",
        last_error: {
          code: "authority_unavailable",
          detail: "Durable learning authority is unavailable",
        },
        admission_intent: {
          session_id: "ses_test",
          final_status: "completed",
          terminal_artifact: { path: path.join(runDir, "DEEPAGENT_RUN_STATE.json") },
        },
      })
      await AgentGateway.flushLearning()
      expect(await Bun.file(path.join(root, "project")).exists()).toBe(false)
    } finally {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("isolates durable learning record failures from provider success and recovers the exact receipt", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    const workspace = path.join(root, "workspace")
    const recovered: Array<Parameters<AgentGateway.LearningAuthority["enqueue"]>[0]> = []
    try {
      AgentGateway.setLearningAuthority({
        record: async () => {
          throw new Error("record storage unavailable")
        },
        enqueue: async () => {
          throw new Error("enqueue must not run after record failure")
        },
      })
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        baseDir: root,
        runsDir,
        durableLearning: true,
        selfLearning: "manual",
        allowProviderExecutedTools: false,
      })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          { ...deepagentRunInput, workspaceID: workspace },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      const runDir = await readOnlyRunDir(runsDir)
      expect(Array.from(events).map((event) => event.type)).toEqual(["finish"])
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({ state: "completed" })
      expect(await readJson(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)).toMatchObject({
        state: "local_pending",
        last_error: { code: "record_failed", detail: "record storage unavailable" },
      })
      await AgentGateway.flushLearning()
      expect(await Bun.file(path.join(root, "project")).exists()).toBe(false)

      const authority: AgentGateway.LearningAuthority = {
        record: async (admission) => {
          recovered.push(admission)
        },
        enqueue: async (admission) => {
          recovered.push(admission)
        },
      }
      AgentGateway.setLearningAuthority(authority)
      await AgentGateway.flushLearningAdmissionRecovery()
      expect(await AgentGateway.recoverLearningAdmissions(authority, runsDir)).toEqual([])
      expect(recovered).toHaveLength(2)
      expect(recovered[0]).toEqual(recovered[1])
      expect(recovered[0]).toMatchObject({
        terminalArtifact: { path: path.join(runDir, "DEEPAGENT_RUN_STATE.json") },
        input: { sessionID: "ses_test", finalStatus: "completed" },
      })
      expect(await readJson(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)).toMatchObject({
        state: "submitted",
        last_error: null,
      })
    } finally {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a forged local learning receipt whose admission no longer matches the terminal fingerprint", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    const calls: string[] = []
    try {
      AgentGateway.setLearningAuthority({
        record: async () => {
          throw new Error("record storage unavailable")
        },
        enqueue: async () => undefined,
      })
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        baseDir: root,
        runsDir,
        durableLearning: true,
        selfLearning: "manual",
        allowProviderExecutedTools: false,
      })
      await Effect.runPromise(
        AgentGateway.manageStream(
          { ...deepagentRunInput, workspaceID: path.join(root, "workspace") },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      const runDir = await readOnlyRunDir(runsDir)
      const receipt = await readJson(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)
      receipt.admission_intent.policy = "auto_merge_safe_project"
      receipt.admission_intent.terminal_artifact.learning_admission_fingerprint =
        DeepAgentDurableLearning.admissionFingerprint(
          DeepAgentDurableLearning.admissionFromLocalReceipt(receipt)!.admission,
        )
      await writeFile(
        path.join(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE),
        `${JSON.stringify(receipt, null, 2)}\n`,
      )

      const authority: AgentGateway.LearningAuthority = {
        record: async () => {
          calls.push("record")
        },
        enqueue: async () => {
          calls.push("enqueue")
        },
      }
      expect(await AgentGateway.recoverLearningAdmissions(authority, runsDir)).toEqual([])
      expect(calls).toEqual([])
    } finally {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a local learning receipt moved under a different run directory", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    const calls: string[] = []
    try {
      AgentGateway.setLearningAuthority({
        record: async () => {
          throw new Error("record storage unavailable")
        },
        enqueue: async () => undefined,
      })
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        baseDir: root,
        runsDir,
        durableLearning: true,
        selfLearning: "manual",
        allowProviderExecutedTools: false,
      })
      await Effect.runPromise(
        AgentGateway.manageStream(
          { ...deepagentRunInput, workspaceID: path.join(root, "workspace") },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      const runDir = await readOnlyRunDir(runsDir)
      const forgedRunDir = path.join(runsDir, "run_forged")
      await mkdir(forgedRunDir)
      await rename(
        path.join(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE),
        path.join(forgedRunDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE),
      )

      const authority: AgentGateway.LearningAuthority = {
        record: async () => {
          calls.push("record")
        },
        enqueue: async () => {
          calls.push("enqueue")
        },
      }
      expect(await AgentGateway.recoverLearningAdmissions(authority, runsDir)).toEqual([])
      expect(calls).toEqual([])
    } finally {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves the original provider failure when durable learning record fails", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    try {
      AgentGateway.setLearningAuthority({
        record: async () => {
          throw new Error("learning record failed")
        },
        enqueue: async () => {
          throw new Error("enqueue must not run after record failure")
        },
      })
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        baseDir: root,
        runsDir,
        durableLearning: true,
        selfLearning: "manual",
        allowProviderExecutedTools: false,
      })

      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(
            { ...deepagentRunInput, workspaceID: path.join(root, "workspace") },
            Stream.fail(new Error("provider stream failed")),
          ).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow("provider stream failed")
      const runDir = await readOnlyRunDir(runsDir)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({ state: "failed" })
      expect(await readJson(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)).toMatchObject({
        state: "local_pending",
        last_error: { code: "record_failed", detail: "learning record failed" },
        admission_intent: { final_status: "failed" },
      })
      await AgentGateway.flushLearning()
      expect(await Bun.file(path.join(root, "project")).exists()).toBe(false)
    } finally {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("leaves a durable pending receipt when learning admission reconciliation fails", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    const recorded: Array<Parameters<AgentGateway.LearningAuthority["enqueue"]>[0]> = []
    try {
      AgentGateway.setLearningAuthority({
        record: async (admission) => {
          recorded.push(admission)
        },
        enqueue: async () => {
          throw new Error("learning admission failed")
        },
      })
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        baseDir: root,
        runsDir,
        durableLearning: true,
        selfLearning: "manual",
        allowProviderExecutedTools: false,
      })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          { ...deepagentRunInput, workspaceID: path.join(root, "workspace") },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      const runDir = await readOnlyRunDir(runsDir)
      expect(Array.from(events).map((event) => event.type)).toEqual(["finish"])
      expect(recorded).toHaveLength(1)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({ state: "completed" })
      expect(await readJson(runDir, AgentGateway.LEARNING_ADMISSION_RECEIPT_FILE)).toMatchObject({
        state: "durable_pending",
        last_error: { code: "enqueue_failed", detail: "learning admission failed" },
      })
      expect(await AgentGateway.recoverLearningAdmissions(undefined, runsDir)).toEqual([])
      await AgentGateway.flushLearning()
      expect(await Bun.file(path.join(root, "project")).exists()).toBe(false)
    } finally {
      AgentGateway.setLearningAuthority(undefined)
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("general mode bypasses DeepAgent runtime artifacts", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "general", runsDir: dir, allowProviderExecutedTools: false })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          deepagentRunInput,
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "hello" }), LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta", "finish"])
      expect(await readdir(dir)).toHaveLength(0)
      expect(AgentGateway.systemPrompt("deepagent").join("\n")).toBe("")
      expect(AgentGateway.snapshot()).toMatchObject({
        mode: "off",
        agentMode: "general",
        agentManaged: false,
        originalPathAllowed: true,
        knowledgeEnabled: false,
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("disabled high/max mode stays inactive in snapshot and request decoration", async () => {
    AgentGateway.configure({ enabled: false, agentMode: "max", runsDir: undefined })

    expect(AgentGateway.snapshot()).toMatchObject({
      mode: "off",
      agentMode: "max",
      agentManaged: false,
      originalPathAllowed: true,
      knowledgeEnabled: false,
    })
    expect(AgentGateway.systemPrompt("deepagent")).toEqual([])
    expect(AgentGateway.systemPrompt("openai")).toEqual([])

    const request = LLM.request({
      id: "req_disabled_deepagent",
      model: Model.make({ id: "deepagent/default", provider: "deepagent", route: OpenAIChat.route }),
      prompt: "hello",
    })
    const routed = AgentGateway.routeRequest(request)
    expect(routed).toBe(request)

    AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
  })

  test("agent_mode_override is a DOWNGRADE-ONLY per-request channel (clamped to the process-global mode)", () => {
    const base = {
      id: "req_override",
      model: Model.make({ id: "deepagent/default", provider: "deepagent", route: OpenAIChat.route }),
      prompt: "hello",
    }

    // SECURITY: the override rides on the client-writable user-message metadata. It may LOWER the
    // effective mode (a downgraded subagent pinning a weaker mode) but must NEVER escalate above the
    // operator-configured process-global agentMode. Otherwise any authenticated HTTP client could set
    // `agent_mode_override: "ultra"` and unlock autonomous macro-rounds / higher budget on demand.

    // (1) Global "max": a downgrade override ("high"/"xhigh") is honored; an escalation override
    //     ("ultra") is rejected and falls back to the global mode.
    AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: undefined })
    try {
      for (const mode of ["general", "high", "xhigh", "max"] as const) {
        const req = LLM.request({ ...base, metadata: { deepagent: { agent_mode_override: mode } } })
        const routed = AgentGateway.routeRequest(req)
        // "general" override ⇒ unmanaged passthrough (unchanged); the rest stay managed (decorated).
        if (mode === "general") {
          expect(routed).toBe(req)
        } else {
          expect(routed).not.toBe(req)
          expect((routed.metadata?.deepagent as Record<string, unknown> | undefined)?.router).toBeDefined()
        }
      }
      // Escalation attempt: global "max" + override "ultra" ⇒ clamped back to "max" (still managed,
      // but NOT promoted to ultra). We assert it did not error and stayed within the global ceiling by
      // confirming the request is still routed as managed (max), not that ultra took effect.
      const escalate = LLM.request({ ...base, metadata: { deepagent: { agent_mode_override: "ultra" } } })
      const escalated = AgentGateway.routeRequest(escalate)
      expect(escalated).not.toBe(escalate)
      expect((escalated.metadata?.deepagent as Record<string, unknown> | undefined)?.router).toBeDefined()
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
    }

    // (2) Global "general" (unmanaged): NO override can promote a request into managed routing —
    //     every escalation attempt is clamped down to general and returned unchanged.
    AgentGateway.configure({ enabled: true, agentMode: "general", runsDir: undefined })
    try {
      const plain = LLM.request(base)
      expect(AgentGateway.routeRequest(plain)).toBe(plain)

      for (const mode of ["high", "xhigh", "max", "ultra"] as const) {
        const req = LLM.request({ ...base, metadata: { deepagent: { agent_mode_override: mode } } })
        // Escalation above the global "general" ceiling is rejected ⇒ unmanaged ⇒ unchanged.
        expect(AgentGateway.routeRequest(req)).toBe(req)
      }

      // Invalid/garbage override falls back to the global mode (general ⇒ unmanaged, unchanged).
      const bogus = LLM.request({ ...base, metadata: { deepagent: { agent_mode_override: "bogus" } } })
      expect(AgentGateway.routeRequest(bogus)).toBe(bogus)
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
    }
  })

  test("writes minimal DeepAgent artifacts for managed passthrough streams", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      await Effect.runPromise(
        AgentGateway.manageStream(
          deepagentRunInput,
          Stream.make(
            LLMEvent.textDelta({ id: "text-0", text: "hello" }),
            LLMEvent.finish({ reason: "stop", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } }),
          ),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(dir)
      const files = await readdir(runDir)
      expect(files).toContain("DEEPAGENT_RUN_STATE.json")
      expect(files).toContain("deepagent_generic_agent_binding.json")
      expect(files).toContain("run_monitor_snapshot.json")
      expect(files).toContain("token_usage_ledger.json")
      expect(files).toContain("run_checkpoint_manifest.json")
      expect(files).toContain("MODEL_WORK_PACKAGE.json")
      expect(files).toContain("DESIGN.md")
      expect(files).toContain("HANDOFF.md")
      expect(files).toContain("TEST.md")
      expect(files).toContain("HISTORY.md")
      expect(await readJson(runDir, "deepagent_generic_agent_binding.json")).toMatchObject({
        schema_version: "deepagent_generic_agent_binding.v1",
        call_kind: "session_turn",
        runtime_feature: "session_chat",
        provider_id: "deepagent",
        model_id: "deepagent/default",
        agent_mode: "high",
        // docs/39 §3: durable knowledge retrieval is enabled for ALL non-general modes (high enables
        // skills + project/fact-memory bounded retrieval), so high activates first_fast_design_bounded_knowledge.
        activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
        agent_managed: true,
        original_path_allowed: false,
        generic_agent_session_id: "ses_test",
        generic_agent_message_id: "msg_test",
      })
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        schema_version: "deepagent_global_run_state.v1",
        provider_id: "deepagent",
        agent_mode: "high",
        activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
        state: "completed",
        passthrough: true,
        default_agent_preserved: true,
        tool_mcp_preserved: true,
      })
      expect(await readJson(runDir, "MODEL_WORK_PACKAGE.json")).toMatchObject({
        agent_mode: "high",
        // docs/39 §3: high enables bounded retrieval (skills + project/fact memory). Strategies stay
        // max/ultra-only, and this bare session_chat task with no tools/keywords selects nothing, so
        // the per-kind ref lists are empty while retrieval itself is enabled.
        activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
        selected_memory_refs: [],
        selected_strategy_refs: [],
        knowledge_retrieval: { enabled: true, mode: "bounded_retrieval_refs_only" },
      })
      expect(await readFile(path.join(runDir, "HISTORY.md"), "utf8")).toContain('"event_type": "finish"')
      expect(await readJson(runDir, "token_usage_ledger.json")).toMatchObject({
        schema_version: "token_usage_ledger.v1",
        model_provider: "deepagent",
        input_tokens: 3,
        output_tokens: 5,
      })
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("writes an MCP capability index from generic agent prepared tool metadata", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            metadata: {
              deepagent: {
                tool_capabilities: [
                  { name: "bash", source: "generic_agent_tool_registry" },
                  { name: "github:list_issues", source: "mcp_or_namespaced_tool" },
                ],
              },
            },
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "MCP_CAPABILITY_INDEX.json")).toMatchObject({
        execution_owner: "generic_agent_tool_registry_or_mcp",
        capability_summary: { total: 2, enabled: 2 },
        capabilities: [
          {
            name: "bash",
            source: "generic_agent_tool_registry",
            execution_owner: "generic_agent_tool_registry_or_mcp",
          },
          {
            name: "github:list_issues",
            source: "mcp_or_namespaced_tool",
            execution_owner: "generic_agent_tool_registry_or_mcp",
          },
        ],
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("routes low complexity to the configured upstream execution and records upstream intent for higher complexity", async () => {
    const lowDir = await tempRunsDir()
    const highDir = await tempRunsDir()
    try {
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        runsDir: lowDir,
        allowProviderExecutedTools: false,
        modelRouter: {
          upstreamProviderID: "anthropic",
          upstreamModelID: "claude-frontier",
          reason: "frontier route",
          userPreference: "none",
        },
      })
      await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )
      expect(await readJson(await readOnlyRunDir(lowDir), "MODEL_ROUTER_AUDIT.json")).toMatchObject({
        decisions: [
          {
            execution_provider_id: "deepagent",
            selected_provider_id: "deepagent",
            selected_model_id: "deepagent/default",
            route_scope: "configured_upstream_execution",
          },
        ],
      })

      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        runsDir: highDir,
        allowProviderExecutedTools: false,
        modelRouter: {
          upstreamProviderID: "anthropic",
          upstreamModelID: "claude-frontier",
          reason: "frontier route",
          userPreference: "none",
        },
      })
      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            metadata: {
              deepagent: {
                tool_capabilities: [{ name: "github:list_issues", source: "mcp_or_namespaced_tool" }],
              },
            },
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      expect(await readJson(await readOnlyRunDir(highDir), "MODEL_ROUTER_AUDIT.json")).toMatchObject({
        decisions: [
          {
            execution_provider_id: "deepagent",
            selected_provider_id: "anthropic",
            selected_model_id: "claude-frontier",
            route_scope: "configured_upstream_intent",
          },
        ],
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(lowDir, { recursive: true, force: true })
      await rm(highDir, { recursive: true, force: true })
    }
  })

  test("max mode records bounded knowledge policy without inlining full knowledge", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: dir, allowProviderExecutedTools: false })

      await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )

      const runDir = await readOnlyRunDir(dir)
      expect(await readFile(path.join(runDir, "DEEPAGENT_BOOT_MESSAGE.md"), "utf8")).toContain(
        "bounded knowledge retrieval",
      )
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        agent_mode: "max",
        activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
      })
      expect(await readJson(runDir, "MODEL_WORK_PACKAGE.json")).toMatchObject({
        agent_mode: "max",
        activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
        knowledge_retrieval: {
          enabled: true,
          mode: "bounded_retrieval_refs_only",
          full_skill_body_allowed: false,
          hidden_evaluator_feedback_allowed: false,
        },
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("max mode synchronizes context-selected knowledge refs into work package", async () => {
    const root = await tempRunsDir()
    const runsDir = path.join(root, "runs")
    try {
      AgentGateway.configure({
        enabled: true,
        agentMode: "max",
        baseDir: root,
        runsDir,
        allowProviderExecutedTools: false,
      })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            releasedKnowledgeSelection: releasedUserGlobalSelection(root),
            metadata: {
              deepagent: {
                tool_capabilities: [{ name: "github:list_issues", source: "mcp_or_namespaced_tool" }],
              },
            },
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(runsDir)
      const knowledge = await readJson(runDir, "KNOWLEDGE_RETRIEVAL_RESULT.json")
      const workPackage = await readJson(runDir, "MODEL_WORK_PACKAGE.json")
      const refIDs = knowledge.selected_refs.map((ref: { ref_id: string }) => ref.ref_id)
      // DAP-11: strategies are disk-seeded into DocumentStore, so the ref is the store-allocated id
      // (doc:strategy:<slug>), not the authoring ref (strategy:mcp-tool-coordination).
      const mcpCoordinationRef = "doc:strategy:strategy-mcp-tool-coordination"
      expect(knowledge.candidate_refs.map((ref: { ref_id: string }) => ref.ref_id)).toContain(mcpCoordinationRef)
      expect(refIDs).toContain(mcpCoordinationRef)
      expect(knowledge).toMatchObject({
        retriever: "packages/core/src/deepagent/knowledge-retriever.ts",
        retrieval_policy: {
          // V3 anti-misleading gates (docs/30 §4): mandatory per-kind top-k + evidence gate.
          // TOPK_DEFAULT (knowledge-retriever.ts): strategy 3 / methodology 2 / memory 3 / skill 2 / knowledge 2.
          topk_by_kind: { strategy: 3, methodology: 2, memory: 3 },
          evidence_threshold: 0.6,
          body_policy: "refs_and_short_synthesis_only",
          deterministic_ranking: true,
        },
      })
      expect(knowledge.candidate_refs.length).toBeGreaterThanOrEqual(knowledge.selected_refs.length)
      const candidateAuthorityRefs = new Set(
        knowledge.candidate_refs.map((ref: { authority_ref: string }) => ref.authority_ref),
      )
      expect(
        knowledge.selected_refs.every((ref: { authority_ref: string }) =>
          candidateAuthorityRefs.has(ref.authority_ref),
        ),
      ).toBe(true)
      expect(knowledge.rejected_refs.length).toBeGreaterThan(0)
      expect(
        knowledge.rejected_refs.every(
          (ref: { authority_ref: string; reason: string; ref_id: string }) =>
            ref.authority_ref.length > 0 && ref.reason.length > 0 && ref.ref_id.length > 0,
        ),
      ).toBe(true)
      expect(workPackage.knowledge_retrieval.selected_refs).toEqual(refIDs)
      expect(workPackage.knowledge_retrieval.selected_ref_details.map((ref: { ref_id: string }) => ref.ref_id)).toEqual(
        refIDs,
      )
      expect(workPackage.selected_strategy_refs).toContain(mcpCoordinationRef)
      expect(knowledge.synthesis).toContain("MCP tools extend capabilities")
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("records interrupted streams as cancelled instead of completed", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(
            deepagentRunInput,
            Stream.make(LLMEvent.textDelta({ id: "text-0", text: "partial" })).pipe(
              Stream.concat(Stream.fromEffect(Effect.interrupt)),
            ),
          ).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow()

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        state: "cancelled",
        cancellation_reasons: ["user_or_runtime_interrupt"],
      })
      expect(await readJson(runDir, "run_checkpoint_manifest.json")).toMatchObject({
        state: "cancelled",
        resume_policy: { decision: "review_required" },
      })
      expect(await readFile(path.join(runDir, "FAILURE_DOSSIER.md"), "utf8")).toContain("interrupted or cancelled")
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("freezes run-local config for artifacts after the run opens", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({
        enabled: true,
        agentMode: "max",
        runsDir: dir,
        allowProviderExecutedTools: false,
        modelRouter: {
          upstreamProviderID: "anthropic",
          upstreamModelID: "claude-frontier",
          reason: "frontier route",
          userPreference: "none",
        },
      })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            metadata: {
              deepagent: {
                tool_capabilities: [{ name: "github:list_issues", source: "mcp_or_namespaced_tool" }],
              },
            },
          },
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "hello" })).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                AgentGateway.configure({
                  enabled: true,
                  agentMode: "high",
                  runsDir: dir,
                  modelRouter: {
                    upstreamProviderID: "openai",
                    upstreamModelID: "gpt-cheap",
                    reason: "changed after run opened",
                    userPreference: "hard",
                  },
                })
              }),
            ),
            Stream.concat(Stream.make(LLMEvent.finish({ reason: "stop" }))),
          ),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        agent_mode: "max",
        knowledge_enabled: true,
      })
      expect(await readJson(runDir, "MODEL_ROUTER_AUDIT.json")).toMatchObject({
        decisions: [
          {
            selected_provider_id: "anthropic",
            selected_model_id: "claude-frontier",
            route_scope: "configured_upstream_intent",
          },
        ],
      })
      expect(await readJson(runDir, "release_bundle_manifest.json")).toMatchObject({
        agent_mode: "max",
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("schema report validates cross-artifact contracts", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: dir, allowProviderExecutedTools: false })
      await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )

      const report = await readJson(await readOnlyRunDir(dir), "SCHEMA_VALIDATION_REPORT.json")
      expect(report).toMatchObject({
        status: "pass",
        validator: "structural_and_cross_artifact_contract_validator",
      })
      expect(report.cross_checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifact: "artifact_graph:run_id_consistency", status: "pass" }),
          expect.objectContaining({ artifact: "artifact_graph:knowledge_ref_consistency", status: "pass" }),
          expect.objectContaining({ artifact: "artifact_graph:checkpoint_hash_coverage", status: "pass" }),
        ]),
      )
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("bypasses DeepAgent artifacts when the global runtime is disabled", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: false, runsDir: dir })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )
      expect(Array.from(events).map((event) => event.type)).toEqual(["finish"])
      expect(await readdir(dir)).toHaveLength(0)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fails closed on provider-executed tools", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, runsDir: dir, allowProviderExecutedTools: false })

      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(
            deepagentRunInput,
            Stream.make(
              LLMEvent.toolCall({
                id: "call_1",
                name: "code_interpreter_call",
                input: { query: "docs" },
                providerExecuted: true,
              }),
            ),
          ).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow("provider-executed tool")

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "deepagent_generic_agent_binding.json")).toMatchObject({
        provider_id: "deepagent",
        provider_executed_tool_observations: [
          {
            provider_executed: true,
            tool_type: "code_interpreter_call",
            policy_decision: "blocked",
            security_impact: "blocking",
            comparability_impact: "must_report",
          },
        ],
      })
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        state: "blocked",
        blocking_reasons: ["provider_executed_tool_blocked"],
      })
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not mark streams without terminal finish as completed", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, runsDir: dir, allowProviderExecutedTools: false })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          deepagentRunInput,
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "partial" })),
        ).pipe(Stream.runCollect),
      )

      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta"])
      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        state: "failed",
        failure_dossier_ref: expect.any(String),
      })
      expect(await readdir(runDir)).toContain("FAILURE_DOSSIER.md")
      expect(await readJson(runDir, "run_checkpoint_manifest.json")).toMatchObject({
        resume_policy: { decision: "review_required" },
      })
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// FEAT-001: GUI-pinned domain packs must actually shape gateway behavior — the pinned pack set read
// from <baseDir>/memory/pinned-packs.json must appear in the run's active_pack_set and the pinned
// pack's refs must be force-selected by knowledge retrieval.
describe("AgentGateway pinned domain packs (FEAT-001)", () => {
  const genericFeature = "rename a local helper function in the user service module"

  const runMaxTurn = async (root: string) => {
    const runsDir = path.join(root, "runs")
    await mkdir(runsDir, { recursive: true })
    AgentGateway.configure({
      enabled: true,
      agentMode: "max",
      baseDir: root,
      runsDir,
      allowProviderExecutedTools: false,
    })
    // workspaceID stays non-absolute (user-global retrieval) so the fixture's global released
    // selection matches the query project; pin wiring is independent of workspace scoping.
    await Effect.runPromise(
      AgentGateway.manageStream(
        {
          ...deepagentRunInput,
          feature: genericFeature,
          releasedKnowledgeSelection: releasedUserGlobalSelection(root),
        },
        Stream.make(LLMEvent.textDelta({ id: "text-0", text: "done" }), LLMEvent.finish({ reason: "stop" })),
      ).pipe(Stream.runCollect),
    )
    const runDir = await readOnlyRunDir(runsDir)
    return readJson(runDir, "MODEL_WORK_PACKAGE.json")
  }

  test("a pinned pack appears in active_pack_set and its refs are force-selected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deepagent-pin-"))
    try {
      writePinnedPacks(path.join(root, "memory"), ["code.gpu-kernel"])
      const workPackage = await runMaxTurn(root)
      expect(workPackage.active_pack_set).toContain("code.gpu-kernel")
      const selectedRefs: string[] = workPackage.knowledge_retrieval.selected_refs
      expect(selectedRefs.some((ref) => ref.includes("gpu"))).toBe(true)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("without pins the pack stays inactive (unpinned behavior unchanged)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deepagent-nopin-"))
    try {
      const workPackage = await runMaxTurn(root)
      expect(workPackage.active_pack_set).not.toContain("code.gpu-kernel")
      const selectedRefs: string[] = workPackage.knowledge_retrieval.selected_refs
      expect(selectedRefs.some((ref) => ref.includes("gpu"))).toBe(false)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a corrupt pinned-packs.json degrades to no pins and still completes the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deepagent-corrupt-pin-"))
    try {
      await mkdir(path.join(root, "memory"), { recursive: true })
      await writeFile(path.join(root, "memory", "pinned-packs.json"), "{not json")
      const workPackage = await runMaxTurn(root)
      expect(workPackage.active_pack_set).not.toContain("code.gpu-kernel")
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(root, { recursive: true, force: true })
    }
  })
})

// FEAT-002: ONE pack-activation authority per run. The gateway builds the run profile once at run
// entry (profile-builder) and both knowledge retrieval (RetrievalInput.profileOverride) and the
// recorded active_pack_set consume it — so the deterministic read-only policy flip (which consumes
// active_pack_set via activePackIds.includes("code.query")) is regression-locked end to end.
describe("AgentGateway unified pack activation authority (FEAT-002)", () => {
  const runMaxTurn = async (root: string, feature: string) => {
    const runsDir = path.join(root, "runs")
    const workspace = path.join(root, "workspace")
    await mkdir(runsDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    AgentGateway.configure({
      enabled: true,
      agentMode: "max",
      baseDir: root,
      runsDir,
      allowProviderExecutedTools: false,
    })
    // Absolute workspaceID => the run profile detects workspace facts from an empty dir (no
    // README/package.json noise), keeping the activation verdict deterministic in this test.
    await Effect.runPromise(
      AgentGateway.manageStream(
        { ...deepagentRunInput, feature, workspaceID: workspace },
        Stream.make(LLMEvent.textDelta({ id: "text-0", text: "done" }), LLMEvent.finish({ reason: "stop" })),
      ).pipe(Stream.runCollect),
    )
    const runDir = await readOnlyRunDir(runsDir)
    return readJson(runDir, "MODEL_WORK_PACKAGE.json")
  }

  test("a deterministic query run records code.query in active_pack_set and flips read-only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deepagent-feat002-query-"))
    try {
      const workPackage = await runMaxTurn(root, "请查一下数据库里有多少条用户记录")
      expect(workPackage.active_pack_set).toContain("code.query")
      // Same source: the recorded set is the retrieval-constrained activation (includes fallbacks).
      expect(workPackage.active_pack_set).toContain("code.core")
      expect(workPackage.deterministic_result.enabled).toBe(true)
      expect(workPackage.deterministic_result.read_only).toBe(true)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a mutation run keeps code.query out of active_pack_set and tools writable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deepagent-feat002-mutation-"))
    try {
      const workPackage = await runMaxTurn(root, "请修复登录逻辑并更新依赖")
      expect(workPackage.active_pack_set).not.toContain("code.query")
      expect(workPackage.deterministic_result.enabled).toBe(false)
      expect(workPackage.deterministic_result.read_only).toBe(false)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(root, { recursive: true, force: true })
    }
  })
})
