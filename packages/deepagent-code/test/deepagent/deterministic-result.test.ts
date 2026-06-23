import { describe, expect, test } from "bun:test"
import { Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { cleanupRunsDir, deepagentRunInput, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

const queryInput = {
  ...deepagentRunInput,
  feature: "请查询当前日志里有多少个 ERROR",
}

describe("DeepAgent deterministic result artifact", () => {
  test("keeps deterministic query completion unverified when no tool result exists", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(
        dir,
        Stream.make(
          LLMEvent.textDelta({ id: "text-0", text: "查询完成，结果通过。" }),
          LLMEvent.finish({ reason: "stop" }),
        ),
        "max",
        queryInput,
      )
      const result = await readJson(runDir, "DETERMINISTIC_RESULT.json")
      expect(result).toMatchObject({
        enabled: true,
        task_kind: "deterministic_query",
        verified_state: "unverified",
        final_answer_state: "unverified",
        completion_gate: {
          auto_complete_allowed: false,
        },
        token_policy: {
          extra_model_calls: 0,
          raw_tool_output_in_prompt: false,
        },
      })
      expect(result.mismatches).toEqual([
        {
          field: "deterministic_result",
          detail: "model output appears to claim success for a deterministic task, but no tool or runner evidence was observed",
        },
      ])
      expect(await readJson(runDir, "SCHEMA_VALIDATION_REPORT.json")).toMatchObject({ status: "pass" })
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  test("marks deterministic query verified when a tool result is observed", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(
        dir,
        Stream.make(
          LLMEvent.toolCall({ id: "tool_1", name: "local_shell", input: { command: "rg -c ERROR app.log" } }),
          LLMEvent.toolResult({ id: "tool_1", name: "local_shell", result: { type: "text", value: "3" } }),
          LLMEvent.finish({ reason: "stop" }),
        ),
        "max",
        queryInput,
      )
      const result = await readJson(runDir, "DETERMINISTIC_RESULT.json")
      expect(result).toMatchObject({
        enabled: true,
        verified_state: "verified",
        final_answer_state: "verified",
        completion_gate: {
          auto_complete_allowed: true,
        },
      })
      expect(result.result.result_ref).toBe("HISTORY.md#event-2")

      const workPackage = await readJson(runDir, "MODEL_WORK_PACKAGE.json")
      expect(workPackage.artifact_refs.map((ref: { ref_id: string }) => ref.ref_id)).toContain("artifact:deterministic_result")
      expect(workPackage.deterministic_result).toMatchObject({
        ref: "DETERMINISTIC_RESULT.json",
        enabled: true,
        verified_state: "verified",
        read_only: true,
      })
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
