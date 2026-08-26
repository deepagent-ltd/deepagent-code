import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer, Option, Stream } from "effect"
import type { Diagnostic } from "../../src/lsp/client"
import {
  GoalLoopWiring,
  buildGraderPorts,
  buildStepExecutor,
  highestDiagnosticSeverity,
  makeGoalLoopWiring,
  makePlanBridge,
  makeTaskSubagentRunner,
  type PanelQuestionInput,
  type SubagentTurnResult,
  type SubagentTurnRunner,
} from "../../src/session/goal-loop-wiring"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { LegacyExecutionUnavailable } from "../../src/session/legacy-execution-zero"
import type { ReviewResult } from "../../src/agent/schema/orchestration"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionV2 } from "@deepagent-code/core/session"
import type { Snapshot } from "../../src/snapshot"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import type { Session } from "../../src/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { PLAN_WRITE_OWN_GOAL } from "../../src/agent/subagent-permissions"
import { createPlanDoc, planScope, type PlanDoc, type PlanStep } from "@deepagent-code/core/deepagent/plan-controller"

/**
 * V3.9 §D wiring unit tests. Every leaf (LSP diagnostics, validation runner, subagent turn) is
 * injected as a deterministic stub, so these assert the real port-assembly logic (severity reduction,
 * reviewer/panel decision mapping, flag gating, step→executor result mapping) without any LLM / LSP.
 */

const diag = (severity: number): Diagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: "x",
  severity: severity as Diagnostic["severity"],
})

const turnFrom = (over: Partial<SubagentTurnResult> = {}): SubagentTurnResult => ({
  ok: true,
  structured: undefined,
  text: "",
  tokensUsed: 0,
  cost: 0,
  ...over,
})

// V4.0.1 P2 — the StepExecutor input now also carries the goal's ledger + limits (so the wiring can
// thread a tiered cost soft-notice into the step-prompt tail). This helper builds a minimal valid input
// for the buildStepExecutor unit tests; individual tests override ledger/limits when they exercise the
// budget notice.
const execInput = (
  over: Partial<Parameters<ReturnType<typeof buildStepExecutor>>[0]> = {},
): Parameters<ReturnType<typeof buildStepExecutor>>[0] => ({
  goalId: "g",
  sessionId: "s",
  planDocId: "p",
  goal: "reach goal",
  activeStepId: null,
  activeStep: null,
  graderFeedback: [],
  ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0, startedAtMs: 0 },
  limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000 },
  ...over,
})

const reviewTurn =
  (result: ReviewResult): SubagentTurnRunner =>
  () =>
    Effect.succeed(turnFrom({ structured: result }))

const panelQuestion = (): PanelQuestionInput => ({
  question: "approve the migration?",
  codeRefs: [],
  lenses: ["correctness", "security"],
  maxRounds: 1,
})

describe("makeTaskSubagentRunner capability boundary", () => {
  const worker: Agent.Info = {
    name: "goal-worker",
    mode: "subagent",
    permission: Permission.fromConfig({ "*": "deny", read: "allow" }),
    capabilities: [PLAN_WRITE_OWN_GOAL],
    options: {},
  }
  const parent: Agent.Info = {
    name: "parent",
    mode: "primary",
    permission: [],
    options: {},
  }

  const run = async (
    input: { readonly allowPlanWriteCapability?: boolean; readonly purpose?: "goal-loop" | "panel" | "generic" },
    turn: {
      readonly outputSchema?: Record<string, unknown>
      readonly finalizer?: "structured" | "text_fallback" | "degraded"
    } = {},
  ) => {
    const created: Array<NonNullable<Session.CreateInput>> = []
    const prompted: SessionPrompt.PromptInput[] = []
    const assistants: SessionV1.WithParts[] = []
    const sessions = {
      get: () => Effect.succeed({ id: SessionID.make("ses_parent"), agent: parent.name, permission: [] }),
      create: (createInput: NonNullable<Session.CreateInput>) => {
        created.push(createInput)
        return Effect.succeed({ id: SessionID.make("ses_child") })
      },
      messages: () => Effect.succeed(assistants),
    } as unknown as Session.Interface
    const agents = {
      get: (name: string) => Effect.succeed(name === worker.name ? worker : name === parent.name ? parent : undefined),
    } as unknown as Agent.Interface
    const sessionPrompt = {
      resolvePromptParts: () => Effect.succeed([]),
      cancel: () => Effect.void,
      prompt: (promptInput: SessionPrompt.PromptInput) => {
        prompted.push(promptInput)
        const structured =
          promptInput.metadata?.deepagent?.structured_finalizer?.attempt === 1 && turn.finalizer !== undefined
            ? undefined
            : promptInput.format
              ? { verdict: "revise" }
              : undefined
        const text =
          promptInput.metadata?.deepagent?.structured_finalizer?.attempt === 2 && turn.finalizer === "degraded"
            ? "not json"
            : promptInput.metadata?.deepagent?.structured_finalizer?.attempt === 2 && turn.finalizer === "text_fallback"
              ? '{"verdict":"revise"}'
              : promptInput.format
                ? undefined
                : "grounded review draft"
        const assistant = {
          info: {
            role: "assistant",
            id: `msg_${prompted.length}`,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            ...(structured === undefined ? {} : { structured }),
          },
          parts: text === undefined ? [] : [{ type: "text", text, synthetic: false, ignored: false }],
        } as unknown as SessionV1.WithParts
        assistants.push(assistant)
        return Effect.succeed(assistant)
      },
    } as unknown as SessionPrompt.Interface
    const runner = makeTaskSubagentRunner({
      sessions,
      agents,
      sessionPrompt,
      parentSessionID: SessionID.make("ses_parent"),
      model: { providerID: "test", modelID: "test" },
      ...input,
    })

    const result = await Effect.runPromise(
      runner({ agentType: worker.name, prompt: "run", goalId: "goal-exact", outputSchema: turn.outputSchema }),
    )
    return { result, createInput: created[0], prompted }
  }

  test("defaults plan-write capability to false and labels generic children accurately", async () => {
    const { result, createInput } = await run({})
    expect(result.ok).toBe(true)
    expect(createInput?.title).toBe("goal-worker (generic)")
    expect(Permission.evaluate("plan", "*", createInput?.permission ?? []).action).not.toBe("allow")
  })

  test("goal-loop callers explicitly opt in and receive the capability grant", async () => {
    const { result, createInput, prompted } = await run({ allowPlanWriteCapability: true, purpose: "goal-loop" })
    expect(result.ok).toBe(true)
    expect(createInput?.title).toBe("goal-worker (goal-loop)")
    expect(Permission.evaluate("plan", "*", createInput?.permission ?? []).action).toBe("allow")
    expect(createInput?.metadata).toMatchObject({ goalID: "goal-exact" })
    expect(prompted[0]?.metadata).toMatchObject({ deepagent: { goal_id: "goal-exact" } })
  })

  test("panel callers remain opted out and use a panel child title", async () => {
    const { result, createInput } = await run({ allowPlanWriteCapability: false, purpose: "panel" })
    expect(result.ok).toBe(true)
    expect(createInput?.title).toBe("goal-worker (panel)")
    expect(Permission.evaluate("plan", "*", createInput?.permission ?? []).action).not.toBe("allow")
  })

  test("v2-wired plain turns drive V2 admission and never call legacy prompt orchestration", async () => {
    const created: Array<NonNullable<Session.CreateInput>> = []
    const legacyPrompts: unknown[] = []
    const v2Calls: Array<{
      kind: "prompt" | "resume" | "interrupt"
      text?: string
      resume?: boolean
      sessionID?: string
    }> = []
    const sessions = {
      get: () => Effect.succeed({ id: SessionID.make("ses_parent"), agent: parent.name, permission: [] }),
      create: (createInput: NonNullable<Session.CreateInput>) => {
        created.push(createInput)
        return Effect.succeed({ id: SessionID.make("ses_child_v2") })
      },
      messages: () => Effect.succeed([]),
    } as unknown as Session.Interface
    const agents = {
      get: (name: string) => Effect.succeed(name === worker.name ? worker : name === parent.name ? parent : undefined),
    } as unknown as Agent.Interface
    const sessionPrompt = {
      resolvePromptParts: (template: string) => Effect.succeed([{ type: "text", text: template }]),
      cancel: () => Effect.void,
      prompt: (promptInput: unknown) => {
        legacyPrompts.push(promptInput)
        return Effect.succeed({ info: { role: "assistant" }, parts: [] })
      },
    } as unknown as SessionPrompt.Interface
    const v2History: unknown[] = []
    const v2Session = {
      prompt: (input: { prompt: { text: string }; resume?: boolean; sessionID: string }) => {
        v2Calls.push({ kind: "prompt", text: input.prompt.text, resume: input.resume, sessionID: input.sessionID })
        // The admission produces this turn's assistant messages; the seam reads them as NEW messages.
        v2History.push(
          { type: "assistant", id: "msg_1", content: [{ type: "text", id: "part_1", text: "first step text" }] },
          { type: "assistant", id: "msg_2", content: [{ type: "text", id: "part_2", text: "v2 grounded text" }] },
        )
        return Effect.succeed({})
      },
      resume: () => {
        v2Calls.push({ kind: "resume" })
        return Effect.void
      },
      interrupt: (sessionID: string) =>
        Effect.sync(() => {
          v2Calls.push({ kind: "interrupt", sessionID })
        }),
      messages: () => Effect.succeed(v2History),
    } as unknown as SessionV2.Interface
    const runner = makeTaskSubagentRunner({
      sessions,
      agents,
      sessionPrompt,
      v2Session,
      parentSessionID: SessionID.make("ses_parent"),
      model: { providerID: "test", modelID: "test" },
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run v2", goalId: "goal-v2" }))
    expect(result.ok).toBe(true)
    // Multiple assistant messages: the LAST text part wins (ascending projection).
    expect(result.text).toBe("v2 grounded text")
    // The typed adapter admits through V2 (admission-before-wake: resume stays false) and joins the
    // drain explicitly; legacy orchestration stays untouched.
    expect(v2Calls).toEqual([
      { kind: "prompt", text: "run v2", resume: false, sessionID: "ses_child_v2" },
      { kind: "resume" },
    ])
    expect(legacyPrompts).toEqual([])
    // The driver model is frozen onto the child session for V2 model resolution.
    expect(created[0]?.model).toEqual({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") })
  })

  const wiredHarness = (input: {
    readonly snapshot?: Snapshot.Interface
    readonly messages?: unknown[]
    readonly resumeFails?: boolean
    readonly updatePartFails?: boolean
  }) => {
    const parts: unknown[] = []
    const mirrored: unknown[] = []
    const sessions = {
      get: () =>
        Effect.succeed({
          id: SessionID.make("ses_parent"),
          agent: parent.name,
          permission: [],
          directory: "/project",
        }),
      create: () => Effect.succeed({ id: SessionID.make("ses_child_v2") }),
      messages: () => Effect.succeed([]),
      updateMessage: (message: unknown) => {
        mirrored.push(message)
        return Effect.succeed(message)
      },
      updatePart: (part: unknown) => {
        if (input.updatePartFails) return Effect.fail(new Error("message not in v1 store"))
        parts.push(part)
        return Effect.succeed(part)
      },
    } as unknown as Session.Interface
    const agents = {
      get: (name: string) => Effect.succeed(name === worker.name ? worker : undefined),
    } as unknown as Agent.Interface
    const sessionPrompt = {
      resolvePromptParts: (template: string) => Effect.succeed([{ type: "text", text: template }]),
      cancel: () => Effect.void,
      prompt: () => Effect.die(new Error("legacy prompt must not be called")),
    } as unknown as SessionPrompt.Interface
    const v2History: unknown[] = []
    const v2Session = {
      prompt: () => {
        if (input.messages === undefined)
          v2History.push({
            type: "assistant",
            id: "msg_assist_last",
            agent: "goal-worker",
            model: { id: "model-test", providerID: "test" },
            time: { created: DateTime.makeUnsafe(1000) },
            tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.5,
            content: [{ type: "text", id: "part_1", text: "done" }],
          })
        return Effect.succeed({})
      },
      resume: () => (input.resumeFails ? Effect.fail(new Error("drain failed")) : Effect.void),
      interrupt: () => Effect.void,
      messages: () => Effect.succeed(input.messages ?? v2History),
    } as unknown as SessionV2.Interface
    const runner = makeTaskSubagentRunner({
      sessions,
      agents,
      sessionPrompt,
      v2Session,
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      parentSessionID: SessionID.make("ses_parent"),
      model: { providerID: "test", modelID: "test" },
    })
    return { runner, parts, mirrored }
  }

  test("v2-wired turns record revert patch evidence on the last assistant message", async () => {
    const { runner, parts } = wiredHarness({
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.succeed({ hash: "patch_hash", files: ["src/a.ts"] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    expect(parts).toEqual([
      expect.objectContaining({ type: "text", text: "done", id: "prt_assist_last_0" }),
      expect.objectContaining({
        type: "patch",
        hash: "patch_hash",
        files: ["src/a.ts"],
        messageID: "msg_assist_last",
        sessionID: "ses_child_v2",
      }),
    ])
  })

  test("v2-wired turns skip patch evidence when the turn changed no files", async () => {
    const { runner, parts } = wiredHarness({
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.succeed({ hash: "patch_hash", files: [] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    // The patch part is skipped but the mirrored text part still lands.
    expect(parts).toEqual([expect.objectContaining({ type: "text", text: "done", id: "prt_assist_last_0" })])
  })

  test("v2-wired turns stay successful when revert evidence recording fails", async () => {
    const { runner, parts } = wiredHarness({
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.fail(new Error("snapshot unavailable")),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    expect(result.text).toBe("done")
    // Patch evidence failed but the mirrored text part still lands.
    expect(parts).toEqual([expect.objectContaining({ type: "text", text: "done", id: "prt_assist_last_0" })])
  })

  test("v2-wired turns mirror V2 messages into the V1 store for revert and accounting", async () => {
    const { runner, mirrored, parts } = wiredHarness({
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.succeed({ hash: "patch_hash", files: ["src/a.ts"] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    // The V2 assistant message is mirrored with its accounting evidence and a deterministic text part.
    expect(mirrored).toEqual([
      expect.objectContaining({
        role: "assistant",
        id: "msg_assist_last",
        sessionID: "ses_child_v2",
        agent: "goal-worker",
        mode: "goal-worker",
        path: { cwd: "/project", root: "/project" },
      }),
    ])
    expect(parts).toEqual([
      expect.objectContaining({ type: "text", text: "done", id: "prt_assist_last_0" }),
      expect.objectContaining({ type: "patch", files: ["src/a.ts"], id: "prt_msg_assist_last_patch" }),
    ])
  })

  test("v2-wired turns still record revert evidence when the drain fails", async () => {
    const { runner, parts } = wiredHarness({
      resumeFails: true,
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.succeed({ hash: "patch_hash", files: ["src/partial.ts"] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    // Rollbacks fire exactly when turns fail: the partial side effects must stay revertible.
    expect(result.ok).toBe(false)
    expect(parts).toEqual([
      expect.objectContaining({ type: "text", text: "done", id: "prt_assist_last_0" }),
      expect.objectContaining({ type: "patch", files: ["src/partial.ts"], messageID: "msg_assist_last" }),
    ])
  })

  test("v2-wired turns skip revert evidence when no assistant message exists", async () => {
    const { runner, parts } = wiredHarness({
      messages: [],
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.succeed({ hash: "patch_hash", files: ["src/a.ts"] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    expect(parts).toEqual([])
  })

  test("v2-wired turns survive a failing baseline capture without evidence", async () => {
    const { runner, parts } = wiredHarness({
      snapshot: {
        track: () => Effect.fail(new Error("snapshot store unavailable")),
        patch: () => Effect.succeed({ hash: "patch_hash", files: ["src/a.ts"] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    expect(result.text).toBe("done")
    expect(parts).toEqual([expect.objectContaining({ type: "text", text: "done", id: "prt_assist_last_0" })])
  })

  test("v2-wired turns stay successful when the part store rejects the evidence", async () => {
    const { runner, parts } = wiredHarness({
      updatePartFails: true,
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.succeed({ hash: "patch_hash", files: ["src/a.ts"] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    expect(result.text).toBe("done")
    expect(parts).toEqual([])
  })

  test("v2-wired turns pair assistant mirrors with the preceding user message", async () => {
    const { runner, mirrored } = wiredHarness({
      messages: [
        { type: "user", id: "msg_user_1", time: { created: DateTime.makeUnsafe(900) }, content: [] },
        {
          type: "assistant",
          id: "msg_assist_1",
          agent: "goal-worker",
          model: { id: "model-test", providerID: "test" },
          time: { created: DateTime.makeUnsafe(1000) },
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.5,
          content: [{ type: "text", id: "part_1", text: "done" }],
        },
      ],
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    // The ascending pass mirrors the user row first, then anchors the assistant onto it — the same
    // anchor SessionRevert resolves when walking back to the driving prompt.
    expect(mirrored).toEqual([
      expect.objectContaining({ role: "user", id: "msg_user_1", sessionID: "ses_child_v2", time: { created: 900 } }),
      expect.objectContaining({
        role: "assistant",
        id: "msg_assist_1",
        parentID: "msg_user_1",
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.5,
      }),
    ])
  })

  test("v2-wired turns mirror assistant accounting fields for V1 token rollups", async () => {
    const { runner, mirrored } = wiredHarness({})
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    expect(mirrored).toEqual([
      expect.objectContaining({
        role: "assistant",
        modelID: "model-test",
        providerID: "test",
        mode: "goal-worker",
        time: { created: 1000 },
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.5,
      }),
    ])
  })

  test("v2-wired turns mirror messages even without a snapshot, skipping only the patch part", async () => {
    const { runner, mirrored, parts } = wiredHarness({})
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    expect(mirrored).toEqual([expect.objectContaining({ role: "assistant", id: "msg_assist_last" })])
    // Mirrored text part lands; no snapshot means no baseline, so the patch part is skipped.
    expect(parts).toEqual([expect.objectContaining({ type: "text", text: "done", id: "prt_assist_last_0" })])
  })

  test("v2-wired turns mirror reasoning, tool, and error payloads with full fidelity", async () => {
    const { runner, mirrored, parts } = wiredHarness({
      messages: [
        {
          type: "assistant",
          id: "msg_assist_full",
          agent: "goal-worker",
          model: { id: "model-test", providerID: "test" },
          time: { created: DateTime.makeUnsafe(1000), completed: DateTime.makeUnsafe(2000) },
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
          cost: 0.25,
          finish: "length",
          error: { type: "unknown", message: "context overflowed mid-step" },
          content: [
            { type: "reasoning", id: "rsn_1", text: "thinking it through" },
            {
              type: "tool",
              id: "call_1",
              name: "bash",
              state: { status: "completed", input: { command: "ls" }, result: "file.ts" },
              time: { created: DateTime.makeUnsafe(1100), completed: DateTime.makeUnsafe(1200) },
            },
            {
              type: "tool",
              id: "call_2",
              name: "edit",
              state: { status: "error", input: { path: "a.ts" }, error: { type: "unknown", message: "denied" } },
              time: { created: DateTime.makeUnsafe(1300), completed: DateTime.makeUnsafe(1400) },
            },
            { type: "text", id: "txt_1", text: "final answer" },
          ],
        },
      ],
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(true)
    // The canonical converter carries the error payload (as UnknownError) and finish reason.
    expect(mirrored).toEqual([
      expect.objectContaining({
        role: "assistant",
        id: "msg_assist_full",
        error: { name: "UnknownError", data: { message: "context overflowed mid-step" } },
        finish: "length",
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
        cost: 0.25,
      }),
    ])
    // All three part kinds land in the V1 store with deterministic ids.
    expect(parts).toEqual([
      expect.objectContaining({ type: "reasoning", text: "thinking it through", id: "prt_assist_full_0" }),
      expect.objectContaining({
        type: "tool",
        callID: "call_1",
        tool: "bash",
        id: "prt_assist_full_1",
        state: expect.objectContaining({ status: "completed", output: "file.ts", title: "bash" }),
      }),
      expect.objectContaining({
        type: "tool",
        callID: "call_2",
        tool: "edit",
        id: "prt_assist_full_2",
        state: expect.objectContaining({ status: "error", error: "denied" }),
      }),
      expect.objectContaining({ type: "text", text: "final answer", id: "prt_assist_full_3" }),
    ])
  })

  test("failed v2 drains degrade to failedTurn and interrupt the orphaned child", async () => {
    const interrupts: string[] = []
    const sessions = {
      get: () => Effect.succeed({ id: SessionID.make("ses_parent"), agent: parent.name, permission: [] }),
      create: () => Effect.succeed({ id: SessionID.make("ses_child_v2") }),
      messages: () => Effect.succeed([]),
    } as unknown as Session.Interface
    const agents = {
      get: (name: string) => Effect.succeed(name === worker.name ? worker : undefined),
    } as unknown as Agent.Interface
    const sessionPrompt = {
      resolvePromptParts: (template: string) => Effect.succeed([{ type: "text", text: template }]),
      cancel: () => Effect.void,
      prompt: () => Effect.die(new Error("legacy prompt must not be called")),
    } as unknown as SessionPrompt.Interface
    const v2Session = {
      prompt: () => Effect.succeed({}),
      resume: () => Effect.fail(new Error("drain failed")),
      interrupt: (sessionID: string) => {
        interrupts.push(sessionID)
        return Effect.void
      },
      messages: () => Effect.succeed([]),
    } as unknown as SessionV2.Interface
    const runner = makeTaskSubagentRunner({
      sessions,
      agents,
      sessionPrompt,
      v2Session,
      parentSessionID: SessionID.make("ses_parent"),
      model: { providerID: "test", modelID: "test" },
    })
    const result = await Effect.runPromise(runner({ agentType: worker.name, prompt: "run", goalId: "goal-x" }))
    expect(result.ok).toBe(false)
    expect(interrupts).toEqual(["ses_child_v2"])
  })

  // A `null` reply simulates a finalizer turn that settles without any assistant text part.
  const structuredHarness = (input: {
    readonly replies: readonly (string | null)[]
    readonly snapshot?: Snapshot.Interface
  }) => {
    const v2Prompts: string[] = []
    const legacyPrompts: unknown[] = []
    const mirrored: unknown[] = []
    const parts: unknown[] = []
    const history: Array<Record<string, unknown>> = []
    let turn = 0
    const sessions = {
      get: () =>
        Effect.succeed({
          id: SessionID.make("ses_parent"),
          agent: parent.name,
          permission: [],
          directory: "/project",
        }),
      create: () => Effect.succeed({ id: SessionID.make("ses_child_struct") }),
      messages: () => Effect.succeed([]),
      updateMessage: (message: unknown) => {
        mirrored.push(message)
        return Effect.succeed(message)
      },
      updatePart: (part: unknown) => {
        parts.push(part)
        return Effect.succeed(part)
      },
    } as unknown as Session.Interface
    const agents = {
      get: (name: string) => Effect.succeed(name === worker.name ? worker : undefined),
    } as unknown as Agent.Interface
    const sessionPrompt = {
      resolvePromptParts: (template: string) => Effect.succeed([{ type: "text", text: template }]),
      cancel: () => Effect.void,
      prompt: (promptInput: unknown) => {
        legacyPrompts.push(promptInput)
        return Effect.die(new Error("legacy prompt must not be called"))
      },
    } as unknown as SessionPrompt.Interface
    const v2Session = {
      prompt: (admission: { readonly prompt: { readonly text: string } }) => {
        v2Prompts.push(admission.prompt.text)
        const reply = input.replies[Math.min(turn, input.replies.length - 1)]
        turn += 1
        history.push({
          type: "assistant",
          id: `msg_assist_${turn}`,
          agent: "goal-worker",
          model: { id: "model-test", providerID: "test" },
          time: { created: DateTime.makeUnsafe(1000 + turn) },
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
          content: reply === null ? [] : [{ type: "text", id: `part_${turn}`, text: reply }],
        })
        return Effect.succeed({})
      },
      resume: () => Effect.void,
      interrupt: () => Effect.void,
      messages: () => Effect.succeed(history),
    } as unknown as SessionV2.Interface
    const runner = makeTaskSubagentRunner({
      sessions,
      agents,
      sessionPrompt,
      v2Session,
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      parentSessionID: SessionID.make("ses_parent"),
      model: { providerID: "test", modelID: "test" },
    })
    const run = () =>
      Effect.runPromise(
        runner({
          agentType: worker.name,
          prompt: "research the change",
          goalId: "goal-x",
          outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
        }),
      )
    return { run, v2Prompts, legacyPrompts, mirrored, parts }
  }

  test("v2-wired structured turns drive research and finalizer admissions with seam-side validation", async () => {
    const { run, v2Prompts, legacyPrompts } = structuredHarness({
      replies: ["the migration looks correct", '{"verdict":"approve"}'],
    })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ verdict: "approve" })
    expect(result.text).toBe('{"verdict":"approve"}')
    expect(result.structuredOutput).toEqual({ attempt: 1, transport: "text_fallback" })
    expect(legacyPrompts).toEqual([])
    // One research admission + one finalizer admission; the finalizer embeds the research result
    // and the schema because V2 has no provider-side format to carry them.
    expect(v2Prompts).toHaveLength(2)
    expect(v2Prompts[0]).toBe("research the change")
    expect(v2Prompts[1]).toContain("<research_result>")
    expect(v2Prompts[1]).toContain("the migration looks correct")
    expect(v2Prompts[1]).toContain("<output_schema>")
    expect(v2Prompts[1]).not.toContain("Previous validation error:")
  })

  test("v2-wired structured turns mirror and attach patch evidence on every driven turn", async () => {
    const { run, mirrored, parts } = structuredHarness({
      replies: ["research body", '{"verdict":"approve"}'],
      snapshot: {
        track: () => Effect.succeed("baseline_hash"),
        patch: () => Effect.succeed({ hash: "patch_hash", files: ["src/a.ts"] }),
      } as unknown as Snapshot.Interface,
    })
    const result = await run()
    expect(result.ok).toBe(true)
    // Both turns are mirrored (the second drive re-mirrors the first — upsert-idempotent).
    const mirroredIDs = mirrored.map((message) => (message as { id: string }).id)
    expect(mirroredIDs).toContain("msg_assist_1")
    expect(mirroredIDs).toContain("msg_assist_2")
    // Each drive attaches its aggregate patch part to ITS OWN last assistant message.
    const partIDs = parts.map((part) => (part as { id: string }).id)
    expect(partIDs).toContain("prt_msg_assist_1_patch")
    expect(partIDs).toContain("prt_msg_assist_2_patch")
    expect(partIDs).toContain("prt_assist_1_0")
    expect(partIDs).toContain("prt_assist_2_0")
  })

  test("a text-less finalizer attempt never inherits the previous turn's text", async () => {
    // Regression: without turn-delimited reads, attempt 1 would extract the schema-valid JSON from
    // the RESEARCH text and report a structured success that no finalizer ever produced.
    const { run, v2Prompts } = structuredHarness({
      replies: ['{"verdict":"evil"}', null, '{"verdict":"approve"}'],
    })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ verdict: "approve" })
    expect(result.structuredOutput).toEqual({ attempt: 2, transport: "text_fallback" })
    expect(v2Prompts[2]).toContain("Previous validation error: Model did not return a JSON value.")
  })

  test("v2-wired structured turns feed validation errors back as a bounded correction attempt", async () => {
    const { run, v2Prompts } = structuredHarness({
      replies: ["research body", '{"verdict":123}', '{"verdict":"approve"}'],
    })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ verdict: "approve" })
    expect(result.structuredOutput).toEqual({ attempt: 2, transport: "text_fallback" })
    expect(v2Prompts).toHaveLength(3)
    expect(v2Prompts[2]).toContain("Previous validation error:")
  })

  test("v2-wired structured turns degrade with a receipt when no attempt yields JSON", async () => {
    const { run } = structuredHarness({ replies: ["research body", "no json here", "still nothing"] })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.structured).toBeUndefined()
    expect(result.structuredOutput).toEqual({
      attempt: 2,
      transport: "degraded_text",
      reason: "structured_output_missing",
    })
    expect(JSON.parse(result.text)).toMatchObject({ _degraded: true, _reason: "structured_output_missing" })
  })

  test("v2-wired structured turns degrade as invalid when JSON never satisfies the schema", async () => {
    const { run } = structuredHarness({ replies: ["research body", '{"verdict":1}', '{"verdict":2}'] })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.structured).toBeUndefined()
    expect(result.structuredOutput).toEqual({
      attempt: 2,
      transport: "degraded_text",
      reason: "structured_output_invalid",
    })
  })

  test("v2-wired structured turns fail closed when the research turn produced no text", async () => {
    const { run, v2Prompts } = structuredHarness({ replies: [""] })
    const result = await run()
    expect(result.ok).toBe(false)
    // Only the research admission ran — the finalizer loop never started on an empty result.
    expect(v2Prompts).toHaveLength(1)
  })

  test("structured reviewer turns collect evidence before the separate finalizer", async () => {
    const { result, prompted } = await run(
      { purpose: "panel" },
      {
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ verdict: "revise" })
    expect(prompted).toHaveLength(2)
    expect(prompted[0]?.format).toBeUndefined()
    expect(prompted[1]?.format?.type).toBe("json_schema")
    expect(prompted[1]?.metadata?.deepagent?.structured_finalizer).toBeDefined()
  })

  test("explicit-schema panel caller accepts validated JSON text as structured output", async () => {
    const { result, prompted } = await run(
      { purpose: "panel" },
      {
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
        finalizer: "text_fallback",
      },
    )

    expect(result.structured).toEqual({ verdict: "revise" })
    expect(result.structuredOutput).toEqual({ attempt: 2, transport: "text_fallback" })
    expect(prompted).toHaveLength(3)
    expect(prompted[2]?.format).toBeUndefined()
  })

  test("Level-2 text remains fail-closed for structured grader consumers", async () => {
    const { result, prompted } = await run(
      { purpose: "panel" },
      {
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
        finalizer: "degraded",
      },
    )

    expect(result.ok).toBe(true)
    expect(result.structured).toBeUndefined()
    expect(result.structuredOutput).toEqual({
      attempt: 2,
      transport: "degraded_text",
      reason: "structured_output_missing",
    })
    expect(JSON.parse(result.text)).toEqual({
      _degraded: true,
      _reason: "structured_output_missing",
      _attempts: 2,
      _raw: "grounded review draft",
    })
    expect(prompted).toHaveLength(3)
  })
})

const baseDeps = (over: Partial<Parameters<typeof buildGraderPorts>[0]> = {}) => ({
  runValidation: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null as string | null, checked: true }),
  runTurn: (() => Effect.succeed(turnFrom())) as SubagentTurnRunner,
  panelQuestion,
  parentSessionID: "parent-1",
  expertPanelEnabled: true, // default ON so the panel-path tests exercise the real runPanel
  ...over,
})

describe("V3.9 §D wiring — highestDiagnosticSeverity (LSP severity reduction)", () => {
  test("empty map → null", () => {
    expect(highestDiagnosticSeverity({})).toBeNull()
    expect(highestDiagnosticSeverity({ "a.ts": [] })).toBeNull()
  })
  test("reduces to the single most-severe label (lower LSP number = more severe)", () => {
    expect(highestDiagnosticSeverity({ "a.ts": [diag(2), diag(3)], "b.ts": [diag(1)] })).toBe("error")
    expect(highestDiagnosticSeverity({ "a.ts": [diag(2), diag(4)] })).toBe("warning")
    expect(highestDiagnosticSeverity({ "a.ts": [diag(4)] })).toBe("hint")
  })
  test("undefined severity is treated as Error (never a silent pass)", () => {
    expect(highestDiagnosticSeverity({ "a.ts": [{ ...diag(3), severity: undefined }] })).toBe("error")
  })
})

describe("V3.9 §D wiring — GraderPorts.diagnostics", () => {
  test("maps live diagnostics through the reducer", async () => {
    const ports = buildGraderPorts(
      baseDeps({ diagnostics: () => Effect.succeed({ maxSeverity: "warning", checked: true }) }),
    )
    expect(await Effect.runPromise(ports.diagnostics())).toEqual({ maxSeverity: "warning", checked: true })
  })

  test("a diagnostics DEFECT surfaces checked:false (unknown, not clean) — fail-open fix", async () => {
    // The safe() wrapper catches a defect from the injected diagnostics fn. It must fall back to
    // checked:false so the grader treats it as an unmet gap, NOT { maxSeverity: null } read as clean.
    const ports = buildGraderPorts(baseDeps({ diagnostics: () => Effect.die("LSP crashed") }))
    expect(await Effect.runPromise(ports.diagnostics())).toEqual({ maxSeverity: null, checked: false })
  })
})

describe("V3.9 §D wiring — GraderPorts.runTests", () => {
  test("passes through the validation runner result", async () => {
    const pass = buildGraderPorts(baseDeps({ runValidation: () => Effect.succeed({ pass: true }) }))
    expect(await Effect.runPromise(pass.runTests(["bun test"]))).toEqual({ pass: true })
    const fail = buildGraderPorts(baseDeps({ runValidation: () => Effect.succeed({ pass: false }) }))
    expect(await Effect.runPromise(fail.runTests(["bun test"]))).toEqual({ pass: false })
  })
  test("a defect in the runner degrades to pass:false (fail-closed)", async () => {
    const ports = buildGraderPorts(baseDeps({ runValidation: () => Effect.die("boom") }))
    expect(await Effect.runPromise(ports.runTests(["bun test"]))).toEqual({ pass: false })
  })
})

describe("V3.9 §D wiring — GraderPorts.reviewerClean", () => {
  const review = (findings: ReviewResult["findings"], verdict: ReviewResult["verdict"] = "approve"): ReviewResult => ({
    findings,
    verdict,
  })
  const finding = (severity: string) => ({
    severity: severity as ReviewResult["findings"][number]["severity"],
    category: "correctness" as const,
    file: "a.ts",
    summary: "s",
    failureScenario: "f",
    confidence: 0.9,
  })

  test("clean when no finding exceeds maxSeverity", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: reviewTurn(review([finding("medium")])) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: true })
  })
  test("not clean when a finding exceeds maxSeverity", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: reviewTurn(review([finding("critical")])) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: false })
  })
  test("no confirmable structured result → NOT clean (fail-closed, never a silent pass)", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: () => Effect.succeed(turnFrom({ structured: undefined })) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: false })
  })
  test("a failed turn → NOT clean", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: () => Effect.succeed(turnFrom({ ok: false })) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: false })
  })
})

describe("V3.9 §D wiring — GraderPorts.panelApproves (real runPanel + arbiter)", () => {
  const finding = () => ({
    severity: "high" as const,
    category: "security" as const,
    file: "a.ts",
    summary: "s",
    failureScenario: "repro",
    confidence: 0.95,
  })
  test("all panelists approve → decision approve", async () => {
    const runTurn: SubagentTurnRunner = () =>
      Effect.succeed(turnFrom({ structured: { findings: [], verdict: "approve" } as ReviewResult }))
    const ports = buildGraderPorts(baseDeps({ runTurn }))
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "approve" })
  })
  test("a high-confidence block → decision block (fail-closed via real arbiter)", async () => {
    const runTurn: SubagentTurnRunner = () =>
      Effect.succeed(turnFrom({ structured: { findings: [finding()], verdict: "block" } as ReviewResult }))
    const ports = buildGraderPorts(baseDeps({ runTurn }))
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "block" })
  })
  test("all panelists absent → needs_human (never a silent approve)", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: () => Effect.succeed(turnFrom({ ok: false })) }))
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "needs_human" })
  })
  test("§F.3 panel flag OFF → needs_human WITHOUT convening the panel (flag independence)", async () => {
    let ran = false
    const runTurn: SubagentTurnRunner = () => {
      ran = true
      return Effect.succeed(turnFrom({ structured: { findings: [], verdict: "approve" } as ReviewResult }))
    }
    const ports = buildGraderPorts(baseDeps({ runTurn, expertPanelEnabled: false }))
    // With the Expert Panel disabled the goal loop must NOT run the panel (would couple the two flags);
    // it fail-closes to needs_human — never silently approving, never silently running a disabled cap.
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "needs_human" })
    expect(ran).toBe(false) // the panel was NOT convened
  })
})

describe("V3.9 §D wiring — buildStepExecutor", () => {
  test("maps a good turn → tokens/cost, no critical", async () => {
    const exec = buildStepExecutor(() => Effect.succeed(turnFrom({ ok: true, tokensUsed: 42, cost: 0.1 })))
    const res = await Effect.runPromise(exec(execInput({ activeStepId: "a" })))
    expect(res.tokensUsed).toBe(42)
    expect(res.cost).toBe(0.1)
    expect(res.critical).toBeUndefined()
  })
  test("a failed turn → critical (loop rolls back)", async () => {
    const exec = buildStepExecutor(() => Effect.succeed(turnFrom({ ok: false })))
    const res = await Effect.runPromise(exec(execInput()))
    expect(res.critical).toBe(true)
  })
  test("a defect → critical, never thrown", async () => {
    const exec = buildStepExecutor(() => Effect.die("boom"))
    const res = await Effect.runPromise(exec(execInput()))
    expect(res.critical).toBe(true)
  })

  test("threads prior grader gaps into the next goal-worker prompt", async () => {
    let seenPrompt = ""
    const exec = buildStepExecutor((input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    })

    await Effect.runPromise(
      exec(
        execInput({
          graderFeedback: ["plan_complete: outstanding steps [a]", "tests_pass: one or more of [bun test] failed"],
        }),
      ),
    )

    expect(seenPrompt).toContain("GRADER FEEDBACK FROM THE PREVIOUS TICK")
    expect(seenPrompt).toContain("plan_complete: outstanding steps [a]")
    expect(seenPrompt).toContain("tests_pass: one or more of [bun test] failed")
    expect(seenPrompt.indexOf("GRADER FEEDBACK")).toBeLessThan(seenPrompt.indexOf("Advance goal"))
  })

  // V4.0.1 P2 §4.4 — tiered cost soft-notice threaded into the step-prompt TAIL.
  test("budgetSoftNotify ON: a tick past the cost tier threads a BUDGET NOTICE into the prompt tail", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    // 8/10 = 80% cost → crosses the default 0.7 tier.
    const exec = buildStepExecutor(runTurn, undefined, undefined, true)
    await Effect.runPromise(
      exec(
        execInput({
          ledger: { ticks: 1, tokens: 0, cost: 8, wallclockMs: 0, startedAtMs: 0 },
          limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000, maxCost: 10 },
        }),
      ),
    )
    expect(seenPrompt).toMatch(/BUDGET NOTICE/)
    expect(seenPrompt).toMatch(/80% used/)
    // The notice is in the TAIL (after the fixed advance instruction), never a prefix.
    expect(seenPrompt.indexOf("BUDGET NOTICE")).toBeGreaterThan(seenPrompt.indexOf("Advance goal"))
  })

  test("budgetSoftNotify OFF: no notice is threaded even when the cost tier is crossed", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    const exec = buildStepExecutor(runTurn, undefined, undefined, false)
    await Effect.runPromise(
      exec(
        execInput({
          ledger: { ticks: 1, tokens: 0, cost: 9, wallclockMs: 0, startedAtMs: 0 },
          limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000, maxCost: 10 },
        }),
      ),
    )
    expect(seenPrompt).not.toMatch(/BUDGET NOTICE/)
  })

  // V4.0.1 P2 §4.4 — the real turn runner surfaces the granular breakdown feeding the NET-token ledger.
  test("surfaces granular net-token fields (input/output/carriedPrefix) from a turn", async () => {
    const exec = buildStepExecutor(() =>
      Effect.succeed(
        turnFrom({ ok: true, tokensUsed: 100, inputTokens: 80, outputTokens: 20, carriedPrefixTokens: 60 }),
      ),
    )
    const res = await Effect.runPromise(exec(execInput()))
    expect(res.tokensUsed).toBe(100)
    expect(res.inputTokens).toBe(80)
    expect(res.outputTokens).toBe(20)
    expect(res.carriedPrefixTokens).toBe(60)
  })

  // V4.0.1 P1 §3.3 — the World State provider re-injects the latest volatile facts into the step-prompt
  // TAIL every tick (P3(d) gate-free goal-worker recall). Ordering: World State BEFORE the budget notice.
  test("worldStateProvider ON: the rendered block is threaded into the prompt tail, before the budget notice", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    const provider = () => Effect.succeed("<world-state>\n## Version Control\nbranch main\n</world-state>")
    const exec = buildStepExecutor(runTurn, undefined, undefined, true, provider)
    await Effect.runPromise(
      exec(
        execInput({
          ledger: { ticks: 1, tokens: 0, cost: 8, wallclockMs: 0, startedAtMs: 0 },
          limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000, maxCost: 10 },
        }),
      ),
    )
    expect(seenPrompt).toContain("<world-state>")
    expect(seenPrompt).toContain("branch main")
    // World State rides the tail AFTER the advance instruction …
    expect(seenPrompt.indexOf("<world-state>")).toBeGreaterThan(seenPrompt.indexOf("Advance goal"))
    // … and BEFORE the (more volatile) budget notice (most volatile content stays last).
    expect(seenPrompt.indexOf("<world-state>")).toBeLessThan(seenPrompt.indexOf("BUDGET NOTICE"))
  })

  test("worldStateProvider omitted ⇒ no World State block (byte-for-byte pre-V4.0.1)", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    const exec = buildStepExecutor(runTurn, undefined, undefined, false)
    await Effect.runPromise(exec(execInput()))
    expect(seenPrompt).not.toContain("<world-state>")
  })

  test("a defect in the World State provider never fails the tick (default-safe: '' ⇒ turn still runs)", async () => {
    let ran = false
    const runTurn: SubagentTurnRunner = () => {
      ran = true
      return Effect.succeed(turnFrom({ ok: true, tokensUsed: 7 }))
    }
    // The provider itself is default-safe in production; here it returns "" (as refreshWorldState does on
    // any defect) and the tick proceeds normally.
    const exec = buildStepExecutor(runTurn, undefined, undefined, false, () => Effect.succeed(""))
    const res = await Effect.runPromise(exec(execInput()))
    expect(ran).toBe(true)
    expect(res.tokensUsed).toBe(7)
    expect(res.critical).toBeUndefined()
  })
})

describe("V3.9 §E F3 wiring — plan bridge (worker plan edits reach the goal plan doc)", () => {
  const roots: string[] = []
  // I33-1: the structural plan now lives in the DocumentStore authority reached via session-state's
  // configured root (plan-store). Configure a fresh state dir per case so the child session's
  // getPlan/setPlan (used by seedChildPlan/mirrorChildPlan) has a plan-store root.
  beforeEach(() => {
    AgentGateway.DeepAgentSessionState.configure(mkdtempSync(path.join(tmpdir(), "deepagent-f3-state-")))
  })
  const step = (id: string, status: PlanStep["status"]): PlanStep => ({
    step_id: id,
    title: id,
    status,
    acceptance: null,
    assigned_agent: null,
    evidence: [],
    note: null,
  })
  // Persist a plan doc exactly as the plan tool does (body = JSON PlanDoc, scope run:<sessionId>).
  const putGoalPlan = (store: DocumentStore, sessionId: string, steps: PlanStep[]): string => {
    const plan = createPlanDoc(sessionId, "reach goal", steps)
    return store.upsert({
      type: "plan",
      scope: planScope(sessionId),
      description: `plan ${sessionId}`,
      idSlug: `plan-${sessionId}`,
      body: JSON.stringify(plan),
      provenance: { source: "model", run_ref: planScope(sessionId) },
    }).id
  }
  const freshStore = () => {
    const root = mkdtempSync(path.join(tmpdir(), "deepagent-f3-"))
    roots.push(root)
    return new DocumentStore(root)
  }
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  test("seedChildPlan copies the goal plan into the child session's plan-state", () => {
    const store = freshStore()
    const goalSession = "goal-sess-1"
    const planDocId = putGoalPlan(store, goalSession, [step("a", "active"), step("b", "pending")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-1"
    bridge.seedChildPlan(childId)
    const seeded = AgentGateway.DeepAgentSessionState.getPlan(childId)
    expect(seeded).not.toBeNull()
    expect(seeded!.steps.map((s) => s.step_id)).toEqual(["a", "b"])
    expect(seeded!.steps[0].status).toBe("active")
  })

  test("mirrorChildPlan writes the worker's edited plan BACK into the goal plan doc (new version)", () => {
    const store = freshStore()
    const goalSession = "goal-sess-2"
    const planDocId = putGoalPlan(store, goalSession, [step("a", "active"), step("b", "pending")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-2"
    bridge.seedChildPlan(childId)
    const before = store.get(planDocId)!.version

    // Worker advances step a→done, b→active (as the plan tool would, via setPlan on the child session).
    const seeded = AgentGateway.DeepAgentSessionState.getPlan(childId)!
    const advanced: PlanDoc = {
      ...seeded,
      steps: [
        { ...seeded.steps[0], status: "done" },
        { ...seeded.steps[1], status: "active" },
      ],
      active_step_id: "b",
    }
    AgentGateway.DeepAgentSessionState.setPlan(childId, advanced)
    bridge.mirrorChildPlan(childId)

    const goalDoc = store.get(planDocId)!
    expect(goalDoc.version).toBeGreaterThan(before) // a new version was written
    const goalPlan = JSON.parse(goalDoc.body) as PlanDoc
    expect(goalPlan.steps.find((s) => s.step_id === "a")!.status).toBe("done")
    expect(goalPlan.active_step_id).toBe("b")
  })

  test("mirrorChildPlan rejects goal and step-structure rewrites while preserving status progress", () => {
    const store = freshStore()
    const planDocId = putGoalPlan(store, "goal-sess-restricted", [step("a", "active"), step("b", "pending")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-restricted"
    bridge.seedChildPlan(childId)
    const seeded = AgentGateway.DeepAgentSessionState.getPlan(childId)!
    AgentGateway.DeepAgentSessionState.setPlan(childId, {
      ...seeded,
      goal: "rewritten goal",
      steps: [
        { ...seeded.steps[0], title: "rewritten title", status: "done" },
        { ...seeded.steps[1], status: "active" },
        step("injected", "pending"),
      ],
      active_step_id: "b",
    })

    bridge.mirrorChildPlan(childId)
    const mirrored = JSON.parse(store.get(planDocId)!.body) as PlanDoc
    expect(mirrored.goal).toBe("reach goal")
    expect(mirrored.steps.map((item) => item.step_id)).toEqual(["a", "b"])
    expect(mirrored.steps.map((item) => item.title)).toEqual(["a", "b"])
    expect(mirrored.steps.map((item) => item.status)).toEqual(["done", "active"])
    expect(mirrored.active_step_id).toBe("b")
  })

  test("mirrorChildPlan is a no-op version-wise when the worker changed nothing (idempotency-safe)", () => {
    const store = freshStore()
    const planDocId = putGoalPlan(store, "goal-sess-3", [step("a", "active")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-3"
    bridge.seedChildPlan(childId)
    const before = store.get(planDocId)!.version
    // Re-set the identical plan (no status change) then mirror — must NOT bump the version (INV-4).
    AgentGateway.DeepAgentSessionState.setPlan(childId, AgentGateway.DeepAgentSessionState.getPlan(childId)!)
    bridge.mirrorChildPlan(childId)
    expect(store.get(planDocId)!.version).toBe(before)
  })

  test("buildStepExecutor with a bridge factory seeds before and mirrors after the turn", async () => {
    const store = freshStore()
    const goalSession = "goal-sess-4"
    const planDocId = putGoalPlan(store, goalSession, [step("a", "active")])
    const bridgeFor = (id: string) => makePlanBridge({ store, planDocId: id, agentMode: "general" })

    // A stub runTurn that behaves like the worker: on its turn it advances the (seeded) child plan,
    // and it reports the child session id so the executor can mirror it back.
    const childId = "child-sess-4"
    const runTurn: SubagentTurnRunner = (input) => {
      input.prepareSession?.(childId) // the real runner calls this after creating the child session
      const p = AgentGateway.DeepAgentSessionState.getPlan(childId)!
      AgentGateway.DeepAgentSessionState.setPlan(childId, {
        ...p,
        steps: [{ ...p.steps[0], status: "done" }],
        active_step_id: null,
      })
      return Effect.succeed(turnFrom({ ok: true, tokensUsed: 5, sessionID: childId }))
    }
    const exec = buildStepExecutor(runTurn, bridgeFor)
    const res = await Effect.runPromise(exec(execInput({ sessionId: goalSession, planDocId, activeStepId: "a" })))
    expect(res.critical).toBeUndefined()
    // The worker's advance is now visible in the GOAL plan doc (what the grader reads).
    const goalPlan = JSON.parse(store.get(planDocId)!.body) as PlanDoc
    expect(goalPlan.steps[0].status).toBe("done")
  })
})

describe("V3.9 §D/§F.3 wiring — makeGoalLoopWiring flag gate", () => {
  const input = {
    store: {} as never,
    parentSessionID: "s",
    cwd: "/tmp",
    runTurn: (() => Effect.succeed(turnFrom())) as SubagentTurnRunner,
    panelQuestion,
    diagnostics: () => Effect.succeed({ diagnostics: {} as Record<string, Diagnostic[]>, checked: true }),
    rollback: () => Effect.void,
  }
  test("flag OFF → null (goal loop unavailable, no wiring constructed)", async () => {
    const deps = await Effect.runPromise(
      makeGoalLoopWiring(input).pipe(Effect.provide(RuntimeFlags.layer({ experimentalGoalLoop: false }))),
    )
    expect(deps).toBeNull()
  })
  test("flag ON → a full ControllerDeps is constructed", async () => {
    const deps = await Effect.runPromise(
      makeGoalLoopWiring(input).pipe(Effect.provide(RuntimeFlags.layer({ experimentalGoalLoop: true }))),
    )
    expect(deps).not.toBeNull()
    expect(typeof deps!.ports.runTests).toBe("function")
    expect(typeof deps!.executor).toBe("function")
    expect(typeof deps!.now).toBe("function")
  })
})
// LEGACY-EXECUTION-ZERO: the subagent-drive V2 seam resolution must (a) stay legacy when both the
// experimental flag and the V2-only profile are off, (b) resolve the V2 stack when the flag is on,
// (c) FORCE the V2 stack under the V2-only profile even with the flag off, and (d) refuse typed at
// layer build when the V2-only profile runs without the SessionV2 stack in the composition root.
const stubSessionV2 = SessionV2.Service.of({
  list: () => Effect.die("stub unused"),
  create: () => Effect.die("stub unused"),
  get: () => Effect.die("stub unused"),
  messages: () => Effect.die("stub unused"),
  message: () => Effect.die("stub unused"),
  context: () => Effect.die("stub unused"),
  events: () => Stream.empty as never,
  switchAgent: () => Effect.die("stub unused"),
  switchModel: () => Effect.die("stub unused"),
  prompt: () => Effect.die("stub unused"),
  shell: () => Effect.die("stub unused"),
  skill: () => Effect.die("stub unused"),
  compact: () => Effect.die("stub unused"),
  wait: () => Effect.die("stub unused"),
  resume: () => Effect.die("stub unused"),
  interrupt: () => Effect.void,
})

const resolveDrive = (overrides: Partial<RuntimeFlags.Info>, withV2: boolean) =>
  GoalLoopWiring.resolveV2SubagentDrive().pipe(
    Effect.provide(
      withV2
        ? RuntimeFlags.layer({ ...overrides }).pipe(Layer.provideMerge(Layer.succeed(SessionV2.Service, stubSessionV2)))
        : RuntimeFlags.layer({ ...overrides }),
    ),
  )

describe("resolveV2SubagentDrive (LEGACY-EXECUTION-ZERO)", () => {
  test("flag OFF and profile OFF resolves no V2 seam (legacy stays the default)", async () => {
    const { v2Session } = await Effect.runPromise(resolveDrive({}, false))
    expect(v2Session).toBeUndefined()
  })

  test("flag ON resolves the V2 seam from the composition root", async () => {
    const { v2Session } = await Effect.runPromise(resolveDrive({ experimentalV2SubagentDrive: true }, true))
    expect(v2Session).toBe(stubSessionV2)
  })

  test("V2-only profile forces the V2 seam even with the experimental flag off", async () => {
    const { v2Session } = await Effect.runPromise(resolveDrive({ coreV2Only: true }, true))
    expect(v2Session).toBe(stubSessionV2)
  })

  test("V2-only profile without the V2 stack resolves v2Only (refusal is turn-time, no build die)", async () => {
    const resolved = await Effect.runPromise(resolveDrive({ coreV2Only: true }, false))
    expect(resolved.v2Only).toBe(true)
    expect(resolved.v2Session).toBeUndefined()
  })

  test("profile OFF with the flag on and no stack keeps legacy (no v2Only flag)", async () => {
    const resolved = await Effect.runPromise(resolveDrive({ experimentalV2SubagentDrive: true }, false))
    expect(resolved.v2Only).toBe(false)
    expect(resolved.v2Session).toBeUndefined()
  })
})

