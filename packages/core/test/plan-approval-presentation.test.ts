import { expect, test } from "bun:test"
import { PlanApprovalPresentation } from "../src/deepagent/plan-approval-presentation"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"

function fixture(extra = {}) {
  const body = CanonicalJson.stringify({
    plan_id: "plan-original",
    session_id: "ses-original",
    goal: "Change only src/original.ts",
    assumptions: ["Keep existing authentication"],
    active_step_id: "one",
    created_at: "2026-10-14",
    steps: [
      {
        step_id: "one",
        title: "Original scope",
        status: "active",
        acceptance: "Original targeted test passes",
        assigned_agent: "auto",
        note: "No deployment",
        evidence: ["original evidence"],
      },
    ],
    ...extra,
  })
  const digest = Hash.sha256(body)
  const approval = { documentID: "doc-original", planID: "plan-original", version: 2, hash: digest }
  return {
    body,
    digest,
    approval,
    question: `Approve plan plan-original, version 2 (${digest})? Approval queues this exact version in the same Session. Later drafts will not replace it.\n\n${body}`,
    approved: `The user approved the exact plan below for execution under the existing permissions. This approved snapshot is the execution request; later drafts are observations, not substitutes for the approved scope.\nPlan: plan-original; version: 2; SHA256: ${digest}\n\n${body}`,
  }
}

test("question and queued approval display the same exact immutable scope and retain copy bytes", async () => {
  const original = fixture()
  const pending = await PlanApprovalPresentation.read(original.question, {
    kind: "question",
    sessionID: "ses-original",
  })
  const queued = await PlanApprovalPresentation.read(original.approved, {
    kind: "approved",
    sessionID: "ses-original",
    approval: original.approval,
  })
  expect(
    PlanApprovalPresentation.readWithDigest(
      original.question,
      { kind: "question", sessionID: "ses-original" },
      Hash.sha256,
    ),
  ).toEqual(pending)
  expect(
    PlanApprovalPresentation.readWithDigest(
      original.approved,
      { kind: "approved", sessionID: "ses-original", approval: original.approval },
      Hash.sha256,
    ),
  ).toEqual(queued)
  expect(pending?.body).toBe(original.body)
  expect(queued?.body).toBe(original.body)
  expect(pending?.plan).toEqual(queued?.plan)
  expect(queued?.hash).toBe(original.digest)
  expect(queued?.version).toBe(2)
  const text = PlanApprovalPresentation.format(queued!, (key) => key)
  for (const value of [
    "src/original.ts",
    "Keep existing authentication",
    "Original scope",
    "Original targeted test passes",
    "auto",
    "No deployment",
    "original evidence",
    original.digest,
    "ses-original",
    "2026-10-14",
  ])
    expect(text).toContain(value)
  expect(original.approval).toEqual({
    documentID: "doc-original",
    planID: "plan-original",
    version: 2,
    hash: original.digest,
  })
})

test("unverified, changed, cross-session or future-scope payloads stay ordinary original text", async () => {
  const original = fixture()
  for (const approval of [
    undefined,
    { ...original.approval, hash: "0".repeat(64) },
    { ...original.approval, version: 3 },
    { ...original.approval, planID: "other" },
  ])
    expect(
      await PlanApprovalPresentation.read(original.approved, { kind: "approved", sessionID: "ses-original", approval }),
    ).toBeUndefined()
  for (const text of [
    original.question.replace("Original scope", "Later draft"),
    fixture({ futurePermissionScope: "write all files" }).question,
    fixture({ goal: "界".repeat(50000) }).question,
    original.question + " extra",
    "ordinary question",
  ])
    expect(await PlanApprovalPresentation.read(text, { kind: "question", sessionID: "ses-original" })).toBeUndefined()
  expect(
    await PlanApprovalPresentation.read(original.question, { kind: "question", sessionID: "other-session" }),
  ).toBeUndefined()
})
