import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DeepAgentCodeHome } from "../../src/deepagent/workspace"
import {
  PromptDraftStore,
  PromptRefiner,
  WISH_REFINEMENT_SYSTEM_PROMPT,
  buildWishContextBriefing,
  classifyWishRoute,
  draftFromWishRefinement,
  isWishRefinementOutput,
  isUsefulWishRefinement,
  normalizeWishRefinementOutput,
  renderDraftMarkdown,
  scrubMemoryContext,
  wishContextMessage,
  wishRefinementSystemPrompt,
} from "../../src/deepagent/prompt-pipeline"

let root: string
let home: DeepAgentCodeHome

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-code-prompt-"))
  home = new DeepAgentCodeHome(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const storeFor = () => new PromptDraftStore(home.ensureSession("projA", "sess1"))

describe("V3.1 Prompt Pipeline", () => {
  test("wish mode keeps raw input out of TaskThread until confirmation", () => {
    const store = storeFor()
    const refiner = new PromptRefiner(store)
    const { draft, contextPlan } = refiner.refine({
      rawInput: "请实现 V3.1 prompt pipeline，并运行测试",
      selectedSkills: ["skill:test"],
    })

    expect(draft.schema_version).toBe("deepagent-code.prompt_draft.v1")
    expect(contextPlan.schema_version).toBe("deepagent-code.context_plan.v1")
    expect(draft.state).toBe("draft_ready")
    expect(() => store.submitConfirmed(draft.id)).toThrow("confirmed prompt draft")
    expect(readFileSync(home.ensureSession("projA", "sess1").rawInputs, "utf8")).toContain("prompt pipeline")

    store.confirm(draft.id, "Implement V3.1 prompt pipeline and run focused tests")
    const submitted = store.submitConfirmed(draft.id)
    expect(submitted).toMatchObject({
      prompt_draft_id: draft.id,
      context_plan_id: contextPlan.id,
      task_prompt: "Implement V3.1 prompt pipeline and run focused tests",
    })
    expect(submitted.memory_snapshot_id).toBe(contextPlan.memory_snapshot_id)
    expect(submitted.skill_snapshot_id).toBe(contextPlan.skill_snapshot_id)
  })

  test("draft shows source labels, pending assumptions, selected skills, and memory refs", () => {
    const store = storeFor()
    const { draft, contextPlan } = new PromptRefiner(store).refine({
      rawInput: "修复登录测试，不要改动 public API",
      selectedSkills: ["skill:focused-test"],
      projectMemory: [
        {
          id: "memory:login",
          project_id: "projA",
          title: "Login",
          summary: "Use focused auth tests",
          provenance: "projA:memory:login",
          decision: "match_only",
        },
      ],
    })

    expect(draft.assumptions.some((item) => item.status === "pending_confirmation")).toBe(true)
    expect(draft.source_blocks.map((block) => block.source_label)).toEqual(["user_input", "project_memory"])
    expect(draft.selected_skills).toEqual(["skill:focused-test"])
    expect(contextPlan.topk).toMatchObject({ project_memory: 5, skills: 5 })
    expect(contextPlan.admitted_refs).toEqual([])
    expect(contextPlan.suggested_refs).toEqual(["memory:login", "skill:focused-test"])
  })

  test("later turns can include handoff refs in the draft sources", () => {
    const { draft } = new PromptRefiner(storeFor()).refine({
      rawInput: "继续上一轮未完成的测试修复",
      turn: 2,
      handoffRefs: ["handoff:latest"],
    })
    expect(
      draft.source_blocks.some((block) => block.source_label === "handoff" && block.ref === "handoff:latest"),
    ).toBe(true)
  })

  test("direct override submits only this turn and still locks snapshots", () => {
    const result = storeFor().directOverride("直接执行这个精确 prompt")
    expect(result.prompt_draft_id).toContain("prompt_draft:sess1")
    expect(result.memory_snapshot_id).toContain("memsnap:")
    expect(result.skill_snapshot_id).toContain("skillsnap:")
    const confirmedFile = path.join(
      home.ensureSession("projA", "sess1").confirmedDir,
      result.prompt_draft_id.replace(/:/g, "__") + ".json",
    )
    expect(existsSync(confirmedFile)).toBe(true)
  })

  test("partial draft marks incomplete context when refine exceeds timeout", () => {
    const { contextPlan } = new PromptRefiner(storeFor()).refine({
      rawInput: "调研并实现",
      timeoutMs: 1,
      startedAt: Date.now() - 10,
    })
    expect(contextPlan.incomplete_context).toBe(true)
  })

  test("memory context fencing scrubs internal recall blocks", () => {
    expect(scrubMemoryContext("hello <memory-context>secret host</memory-context> world")).toBe(
      "hello [memory context hidden] world",
    )
    expect(scrubMemoryContext("a <!-- memory-context secret --> b")).toBe("a [memory context hidden] b")
  })

  // A2: model-driven wish first-turn refinement.
  test("draftFromWishRefinement uses the model prompt and surfaces inferences as assumptions", () => {
    const store = storeFor()
    const { draft } = draftFromWishRefinement(store, "add login", {
      route: "code",
      refined_prompt: "Implement a JWT-based login endpoint under the existing /auth router with tests.",
      goal: "add login",
      task_type: "implementation",
      constraints: ["Do not change the public API shape"],
      acceptance: ["Login returns a signed JWT", "Auth tests pass"],
      assumptions: ["Use JWT for auth", "Add under existing /auth router"],
    })

    // The submittable prompt is the model's complete, directly-executable prompt.
    expect(draft.goal).toContain("JWT-based login endpoint")
    expect(draft.task_type).toBe("implementation")
    expect(draft.acceptance).toContain("Auth tests pass")
    // Every inference is surfaced as an explicit, reviewable assumption (not buried in prose).
    expect(draft.assumptions.map((a) => a.text)).toEqual(["Use JWT for auth", "Add under existing /auth router"])
    expect(draft.assumptions.every((a) => a.status === "pending_confirmation")).toBe(true)
    expect(draft.state).toBe("draft_ready")
  })

  test("renderDraftMarkdown stays human-readable and omits template scaffolding", () => {
    const { draft } = draftFromWishRefinement(storeFor(), "add login", {
      route: "code",
      refined_prompt: "Implement a JWT-based login endpoint under the existing /auth router with tests.",
      goal: "add login",
      task_type: "implementation",
      constraints: ["Do not change the public API shape"],
      acceptance: ["Login returns a signed JWT"],
      assumptions: ["Use JWT for auth"],
    })

    const preview = renderDraftMarkdown(draft)
    expect(preview).toContain("JWT-based login endpoint")
    expect(preview).toContain("Do not change the public API shape")
    expect(preview).not.toContain("Mode:")
    expect(preview).not.toContain("Task type:")
    expect(preview).not.toContain("Confirm the refined prompt before execution.")
  })

  test("draftFromWishRefinement falls back to a default assumption when the model lists none", () => {
    const { draft } = draftFromWishRefinement(storeFor(), "do the thing", {
      route: "code",
      refined_prompt: "Do the thing precisely.",
      goal: "do the thing",
      task_type: "unknown",
      constraints: [],
      acceptance: [],
      assumptions: [],
    })
    expect(draft.assumptions).toHaveLength(1)
    expect(draft.assumptions[0]!.status).toBe("pending_confirmation")
  })

  test("isWishRefinementOutput rejects malformed model output", () => {
    expect(
      isWishRefinementOutput({
        route: "code",
        refined_prompt: "x",
        goal: "y",
        task_type: "implementation",
        constraints: [],
        acceptance: [],
        assumptions: [],
      }),
    ).toBe(true)
    expect(
      isWishRefinementOutput({
        route: "general",
        refined_prompt: "x",
        goal: "y",
        task_type: "unknown",
        constraints: [],
        acceptance: [],
        assumptions: [],
      }),
    ).toBe(true)
    expect(isWishRefinementOutput({ refined_prompt: "x" })).toBe(false)
    expect(isWishRefinementOutput(null)).toBe(false)
  })

  test("normalizeWishRefinementOutput fills optional fields from partial JSON-mode output", () => {
    expect(
      normalizeWishRefinementOutput(
        {
          route: "code",
          refined_prompt: "请定位登录测试失败原因，修复实现或测试夹具，并运行对应测试。",
          assumptions: ["存在已有登录测试"],
        },
        "修复登录测试",
      ),
    ).toEqual({
      route: "code",
      refined_prompt: "请定位登录测试失败原因，修复实现或测试夹具，并运行对应测试。",
      goal: "修复登录测试",
      task_type: "unknown",
      constraints: [],
      acceptance: [],
      assumptions: ["存在已有登录测试"],
    })
    expect(normalizeWishRefinementOutput({ route: "code" }, "修复登录测试")).toBeUndefined()
  })

  test("useful wish refinement rejects code prompts equivalent to raw input", () => {
    expect(
      isUsefulWishRefinement("修复登录测试", {
        route: "code",
        refined_prompt: "修复登录测试",
        goal: "修复登录测试",
        task_type: "implementation",
        constraints: [],
        acceptance: [],
        assumptions: [],
      }),
    ).toBe(false)
    expect(
      isUsefulWishRefinement("修复登录测试", {
        route: "code",
        refined_prompt: "请在当前仓库中定位登录相关测试失败的原因，修复实现或测试夹具，并运行对应测试验证。",
        goal: "修复登录测试",
        task_type: "implementation",
        constraints: [],
        acceptance: [],
        assumptions: [],
      }),
    ).toBe(true)
  })

  test("wish refinement prompt is compatible with OpenAI JSON mode", () => {
    expect(WISH_REFINEMENT_SYSTEM_PROMPT.toLowerCase()).toContain("json")
  })

  test("wish refinement prompt pins the requested output language", () => {
    expect(wishRefinementSystemPrompt("chinese")).toContain("in Chinese")
    expect(wishRefinementSystemPrompt("english")).toContain("in English")
  })

  test("fallback route classifier keeps obvious chat out of DeepAgent", () => {
    expect(classifyWishRoute("你好")).toBe("general")
    expect(classifyWishRoute("你是谁")).toBe("general")
    expect(classifyWishRoute("修复登录测试")).toBe("code")
  })

  test("wish refinement system prompt forbids guessing the environment and asks to leave gaps", () => {
    const prompt = WISH_REFINEMENT_SYSTEM_PROMPT.toLowerCase()
    expect(prompt).toContain("already known")
    expect(prompt).toContain("not guess a concrete value")
    expect(prompt).toContain("placeholder")
    expect(prompt).toContain("never invent a working directory")
    // It must tell the model to refine the task description only, not expand scope.
    expect(prompt).toContain("only the task description")
  })

  test("buildWishContextBriefing keeps recent turns and is empty on first turn", () => {
    expect(buildWishContextBriefing([])).toBe("")
    expect(buildWishContextBriefing([{ role: "user", text: "   " }])).toBe("")

    const briefing = buildWishContextBriefing([
      { role: "user", text: "work in packages/app" },
      { role: "assistant", text: "ok, scoped to packages/app" },
    ])
    expect(briefing).toContain("User: work in packages/app")
    expect(briefing).toContain("Assistant: ok, scoped to packages/app")
  })

  test("buildWishContextBriefing caps turns and truncates long messages", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, text: `turn ${i}` }))
    const briefing = buildWishContextBriefing(turns, { maxTurns: 4 })
    expect(briefing.split("\n")).toHaveLength(4)
    expect(briefing).toContain("turn 11")
    expect(briefing).not.toContain("turn 7")

    const long = buildWishContextBriefing([{ role: "user", text: "x".repeat(50) }], { maxCharsPerTurn: 10 })
    expect(long).toContain("…")
    expect(long.length).toBeLessThan("User: ".length + 50)
  })

  test("wishContextMessage wraps the briefing and instructs reuse over guessing", () => {
    const msg = wishContextMessage("User: target dir is packages/app")
    expect(msg).toContain("<conversation_context>")
    expect(msg).toContain("target dir is packages/app")
    expect(msg.toLowerCase()).toContain("do not")
  })
})
