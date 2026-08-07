import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore } from "../../src/deepagent/document-store"
import {
  PlanEditBusyError,
  PlanEditChallengeError,
  PlanEditMailboxConflictError,
  PlanEditProtocolCorruptionError,
  PlanEditRequestConflictError,
  admitPlanEditCommand,
  createPlanEditCommand,
  decodePlanEditReceipt,
  issuePlanEditChallenge,
  readPendingPlanEditCommand,
  readPlanEditReceipt,
  readPlanEditReceiptByRequest,
  settlePlanEditCommand,
} from "../../src/deepagent/plan-edit-protocol"
import type { PlanWriteInput } from "../../src/deepagent/plan-controller"

let root: string
let store: DocumentStore

const write: PlanWriteInput = {
  operation: "advance",
  expected_plan_id: "plan_1",
  expected_version: 3,
  goal: "ship safely",
  assumptions: ["authority exists"],
  steps: [
    { step_id: "s1", title: "implement", status: "done", acceptance: "tests pass" },
    { step_id: "s2", title: "verify", status: "active", acceptance: "review complete" },
  ],
  active_step_id: "s2",
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-plan-edit-"))
  store = new DocumentStore(root)
})

afterEach(() => {
  DocumentStore.__resetSharedRegistryForTests()
  rmSync(root, { recursive: true, force: true })
})

describe("durable plan edit protocol", () => {
  test("queues durably, survives a reopened store, and clears pending work after settlement", () => {
    const command = createPlanEditCommand({
      requestID: "request-1",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: write,
    })
    expect(admitPlanEditCommand(store, command).state).toBe("queued")
    expect(readPendingPlanEditCommand(new DocumentStore(root), "session-1", "goal-1")).toEqual(command)

    settlePlanEditCommand(store, command, {
      state: "rejected",
      failure: {
        kind: "validation",
        code: "unsafe_step_identity",
        offending_step_ids: ["s2"],
        previous_plan_id: "plan_1",
        previous_plan_version: 3,
      },
    })
    expect(readPendingPlanEditCommand(store, "session-1", "goal-1")).toBeNull()
    expect(readPlanEditReceipt(new DocumentStore(root), "session-1", "goal-1")?.state).toBe("rejected")
  })

  test("preserves nullable HTTP plan fields across a mailbox reopen", () => {
    const nullableWrite: PlanWriteInput = {
      ...write,
      steps: [
        { step_id: "s1", title: "implement", status: "done", acceptance: null, assigned_agent: null, note: null },
        { step_id: "s2", title: "verify", status: "active", acceptance: "review complete", note: null },
      ],
    }
    const command = createPlanEditCommand({
      requestID: "request-nullable",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: nullableWrite,
    })

    admitPlanEditCommand(store, command)

    expect(readPendingPlanEditCommand(new DocumentStore(root), "session-1", "goal-1")).toEqual(command)
  })

  test("reconciles exact request retries and rejects last-write-wins overwrite", () => {
    const command = createPlanEditCommand({
      requestID: "request-1",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: write,
    })
    const first = admitPlanEditCommand(store, command)
    expect(admitPlanEditCommand(store, command)).toEqual(first)
    expect(() =>
      admitPlanEditCommand(
        store,
        createPlanEditCommand({ requestID: "request-2", sessionID: "session-1", goalID: "goal-1", planWrite: write }),
      ),
    ).toThrow(PlanEditBusyError)
  })

  test("reconciles a historical request after newer activities and rejects conflicting reuse", () => {
    const first = createPlanEditCommand({
      requestID: "request-1",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: write,
    })
    admitPlanEditCommand(store, first)
    const firstReceipt = settlePlanEditCommand(store, first, {
      state: "applied",
      result: { plan_id: "plan_1", doc_id: "doc:plan:1", version: 4, changed: true },
    })
    const secondWrite = { ...write, expected_version: 4, steps: write.steps.map((step) => ({ ...step })) }
    const second = createPlanEditCommand({
      requestID: "request-2",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: secondWrite,
    })
    admitPlanEditCommand(store, second)
    settlePlanEditCommand(store, second, {
      state: "applied",
      result: { plan_id: "plan_1", doc_id: "doc:plan:1", version: 4, changed: false },
    })

    expect(admitPlanEditCommand(store, first)).toEqual(firstReceipt)
    expect(readPlanEditReceiptByRequest(store, "session-1", "goal-1", "request-1")).toEqual(firstReceipt)
    expect(() =>
      admitPlanEditCommand(
        store,
        createPlanEditCommand({
          requestID: "request-1",
          sessionID: "session-1",
          goalID: "goal-1",
          planWrite: { ...write, goal: "different content" },
        }),
      ),
    ).toThrow(PlanEditRequestConflictError)
  })

  test("binds quality confirmation to challenge, candidate, version, and expiry", () => {
    const now = new Date("2026-08-07T00:00:00.000Z")
    const candidate = createPlanEditCommand({
      requestID: "request-challenge",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: { ...write, operation: "replan", replan_reason: "intentional replacement" },
      now,
    })
    const challenged = issuePlanEditChallenge(store, candidate, "challenge-1", now)
    expect(challenged.state).toBe("challenged")

    const mismatched = createPlanEditCommand({
      requestID: "request-confirm-mismatch",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: { ...candidate.plan_write, expected_version: 4 },
      confirmedChallengeID: "challenge-1",
      now,
    })
    expect(() => admitPlanEditCommand(store, mismatched, now)).toThrow(PlanEditChallengeError)

    const confirmed = createPlanEditCommand({
      requestID: "request-confirm",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: candidate.plan_write,
      confirmedChallengeID: "challenge-1",
      now,
    })
    expect(admitPlanEditCommand(store, confirmed, new Date("2026-08-07T00:14:59.000Z")).state).toBe("queued")

    const expiredCandidate = createPlanEditCommand({
      requestID: "request-expired",
      sessionID: "session-2",
      goalID: "goal-2",
      planWrite: candidate.plan_write,
      now,
    })
    issuePlanEditChallenge(store, expiredCandidate, "challenge-expired", now)
    const expiredConfirmation = createPlanEditCommand({
      requestID: "request-expired-confirm",
      sessionID: "session-2",
      goalID: "goal-2",
      planWrite: candidate.plan_write,
      confirmedChallengeID: "challenge-expired",
      now,
    })
    expect(() => admitPlanEditCommand(store, expiredConfirmation, new Date("2026-08-07T00:15:00.000Z"))).toThrow(
      PlanEditChallengeError,
    )
  })

  test("detects cross-handle CAS races instead of overwriting a mailbox", () => {
    const first = new DocumentStore(root)
    const stale = new DocumentStore(root)
    admitPlanEditCommand(
      first,
      createPlanEditCommand({ requestID: "request-1", sessionID: "session-1", goalID: "goal-1", planWrite: write }),
    )
    expect(() =>
      admitPlanEditCommand(
        stale,
        createPlanEditCommand({ requestID: "request-2", sessionID: "session-1", goalID: "goal-1", planWrite: write }),
      ),
    ).toThrow(PlanEditMailboxConflictError)
  })

  test("fails closed on malformed or internally inconsistent receipts", () => {
    const command = createPlanEditCommand({
      requestID: "request-1",
      sessionID: "session-1",
      goalID: "goal-1",
      planWrite: write,
    })
    expect(
      decodePlanEditReceipt({
        protocol_version: 1,
        state: "applied",
        command,
        updated_at: new Date().toISOString(),
        result: { plan_id: "plan_1", doc_id: "doc:plan:1", version: 4, changed: true },
        failure: { kind: "runtime_error", message: "must not coexist" },
      }),
    ).toBeNull()

    store.upsert({
      type: "run_context",
      scope: "run:session-1",
      description: "corrupt mailbox",
      idSlug: "corrupt-mailbox",
      body: "{not-json",
      provenance: { source: "human" },
      extensions: { plan_edit_goal_id: "goal-1" },
    })
    expect(() => readPlanEditReceipt(store, "session-1", "goal-1")).toThrow(PlanEditProtocolCorruptionError)
  })
})
