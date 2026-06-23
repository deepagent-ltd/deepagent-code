import { describe, expect, test } from "bun:test"
import {
  promoteLearningCandidate,
  promotionCandidate,
  rejectLearningCandidate,
  type LearningCandidate,
} from "./review"

const directory = "/repo/deepagent"
const candidate: LearningCandidate = {
  candidateId: "strategy_candidate:run_1:first-fast-design",
  type: "strategy",
  status: "staged",
  sourceRunId: "run_1",
  sourceRound: 1,
  summary: "use first fast design",
  evidenceRefs: ["RUN_CONTEXT.md"],
  confidence: 0.9,
}

const promotedCandidate = {
  candidate_id: "strategy_candidate:run_1:first-fast-design",
  type: "strategy",
  status: "staged",
  source_run_id: "run_1",
  source_round: 1,
  summary: "use first fast design",
  evidence_refs: ["RUN_CONTEXT.md"],
  confidence: 0.9,
} satisfies ReturnType<typeof promotionCandidate>

function client(calls: { promote: unknown[]; reject: unknown[] }) {
  return {
    deepagent: {
      knowledge: {
        promote: async (payload: unknown) => {
          calls.promote.push(payload)
          return { data: { promoted: { id: "promoted" } } }
        },
        reject: async (payload: unknown) => {
          calls.reject.push(payload)
          return { data: { rejected: { candidateId: "rejected" } } }
        },
      },
    },
  }
}

describe("DeepAgent review page behavior", () => {
  test("maps review candidates to the SDK promotion schema", () => {
    expect(promotionCandidate(candidate)).toEqual(promotedCandidate)
  })

  test("promotes learning candidates with the current workspace context", async () => {
    const calls = { promote: [] as unknown[], reject: [] as unknown[] }

    await promoteLearningCandidate({
      client: client(calls),
      directory,
      candidate,
      approver: " reviewer ",
      note: " looks good ",
    })

    expect(calls.promote).toEqual([
      {
        directory,
        candidate: promotedCandidate,
        origin: "run_local",
        verdict: { pass: true, reason: "looks good", evidence: ["RUN_CONTEXT.md"] },
        approval: { approver: "reviewer", approved: true, note: "looks good" },
      },
    ])
  })

  test("rejects learning candidates with the current workspace context", async () => {
    const calls = { promote: [] as unknown[], reject: [] as unknown[] }

    await rejectLearningCandidate({
      client: client(calls),
      directory,
      candidate,
      reason: " too vague ",
    })

    expect(calls.reject).toEqual([
      {
        directory,
        candidate: promotedCandidate,
        reason: "too vague",
      },
    ])
  })

  test("requires human approval and rejection reasons before SDK calls", async () => {
    const calls = { promote: [] as unknown[], reject: [] as unknown[] }

    await expect(
      promoteLearningCandidate({
        client: client(calls),
        directory,
        candidate,
        approver: " ",
        note: "",
      }),
    ).rejects.toThrow("请先填写审批人")
    await expect(
      rejectLearningCandidate({
        client: client(calls),
        directory,
        candidate,
        reason: " ",
      }),
    ).rejects.toThrow("请先填写拒绝理由")
    expect(calls.promote).toEqual([])
    expect(calls.reject).toEqual([])
  })
})
