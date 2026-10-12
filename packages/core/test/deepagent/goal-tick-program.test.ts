import { expect, test } from "bun:test"
import { Schema } from "effect"
import { GoalTickProgram } from "../../src/deepagent/goal-tick-program"

const hash = "f".repeat(64)
const ref = "r".repeat(128)
const parent = {
  sessionID: "ses_parent",
  sourceSeq: 1,
  authorityHash: hash,
  authority: "{}",
  steering: { cutoff: 0, mutationEpoch: 0, rows: [] },
}
function program(roles = 1): GoalTickProgram.Program {
  return {
    version: 2,
    contract: "owned-goal-v2",
    localEffectSlots: 33,
    nextStateBytes: 131072,
    documents: [
      { id: "doc:plan:parent", kind: "plan", payloadBytes: 65536, bodyBytes: 32768, metadataHash: hash, links: [] },
      {
        id: "doc:run_context:goal",
        kind: "state",
        payloadBytes: 131072,
        bodyBytes: 65536,
        metadataHash: hash,
        links: ["doc:plan:parent"],
      },
      {
        id: "doc:worklog:tick",
        kind: "worklog",
        payloadBytes: 32768,
        bodyBytes: 16384,
        metadataHash: hash,
        links: ["doc:run_context:goal"],
      },
      {
        id: "doc:diagnosis:tick",
        kind: "diagnosis",
        payloadBytes: 16384,
        bodyBytes: 8192,
        metadataHash: hash,
        links: [],
      },
      {
        id: "doc:decision:goal",
        kind: "completion",
        payloadBytes: 32768,
        bodyBytes: 16384,
        metadataHash: hash,
        links: [],
      },
    ],
    roles: Array.from({ length: roles }, (_, ordinal) => ({
      key: `reviewer:${ordinal}`,
      agent: "reviewer",
      kind: "reviewer",
      ordinal,
      criterion: ordinal,
      round: null,
      lens: null,
      mode: "structured",
      policyHash: hash,
      recipe: { id: "goal-reviewer-v2", hash, schemaHash: hash, dependencies: ordinal === 0 ? [] : [ordinal - 1] },
    })),
  }
}

test("v2 maximum role slots, both full state copies and all fixed receipts fit before execution", () => {
  const reserved = GoalTickProgram.reservation(program(64), parent)
  expect(reserved.stageSlots).toBe(192)
  expect(reserved.bytes).toBeLessThanOrEqual(GoalTickProgram.MAX_BYTES)
  expect(reserved.bytes).toBeGreaterThan(192 * 2048 + 33 * 2048 + 2 * 131072)
  expect(() => GoalTickProgram.reservation(program(64), { ...parent, authority: "x".repeat(262144) })).toThrow(
    "reserve",
  )
  expect(GoalTickProgram.validateJournal(reserved.empty).bytes).toBe(reserved.bytes)
})

test("local proof maximum legal scalar/reference encoding is measured, not assumed to be 1 KiB", () => {
  const output = { ref, hash, bytes: Number.MAX_SAFE_INTEGER, truncated: false }
  const proof: GoalTickProgram.LocalEffect = {
    version: 2,
    id: ref,
    kind: "validation",
    commandHash: hash,
    cwdHash: hash,
    profileHash: hash,
    instanceID: ref,
    handleID: ref,
    state: "stop_confirmed",
    outcome: "cancelled",
    containment: "single-process",
    stopProof: "owned_process_exit",
    exitCode: null,
    signal: "S".repeat(32),
    stdout: output,
    stderr: output,
    startedAt: Number.MAX_SAFE_INTEGER,
    endedAt: Number.MAX_SAFE_INTEGER,
  }
  expect(GoalTickProgram.validateLocalEffect(proof)).toBe(proof)
  expect(GoalTickProgram.bytes(proof)).toBeGreaterThan(1024)
  expect(GoalTickProgram.bytes(proof)).toBe(1451)
  expect(GoalTickProgram.bytes(proof)).toBeLessThanOrEqual(GoalTickProgram.EFFECT_BYTES)
  expect(Schema.is(GoalTickProgram.LocalEffect)({ ...proof, id: "\u0000".repeat(128) })).toBe(false)
})

test("program identities, dependency order and exact link set cannot be widened", () => {
  const initial = program(2)
  expect(() => GoalTickProgram.validate({ ...initial, roles: [initial.roles[0], initial.roles[0]] })).toThrow(
    "duplicated",
  )
  expect(() =>
    GoalTickProgram.validate({
      ...initial,
      roles: [{ ...initial.roles[0], recipe: { ...initial.roles[0].recipe, dependencies: [1] } }, initial.roles[1]],
    }),
  ).toThrow("preceding")
  expect(() =>
    GoalTickProgram.validate({
      ...initial,
      documents: [{ ...initial.documents[0], links: ["doc:plan:unregistered"] }],
    }),
  ).toThrow("exact set")
  expect(() => GoalTickProgram.validate({ ...initial, roles: [{ ...initial.roles[0], kind: "panel" }] })).toThrow()
})

test("single activation and deterministic skipped disposition are separate from provider result proofs", () => {
  const journal = GoalTickProgram.reservation(program(2), parent).empty
  const activated = {
    ...journal,
    activations: [
      {
        role: 0,
        recipeHash: hash,
        dependencies: { count: 0, through: 0, hash },
        promptHash: hash,
        unitID: "goalchild_fixed",
        inputID: GoalTickProgram.inputID("goalchild_fixed", "research"),
        activatedAt: 1,
      },
    ],
    dispositions: [
      { role: 1, kind: "skipped" as const, rule: "cheap-gate-v2" as const, evidence: { count: 0, through: 0, hash } },
    ],
  }
  expect(() => GoalTickProgram.validateJournal(activated)).not.toThrow()
  expect(activated.results).toHaveLength(0)
  expect(() =>
    GoalTickProgram.validateJournal({
      ...activated,
      activations: [...activated.activations, activated.activations[0]],
    }),
  ).toThrow("activation")
  expect(() =>
    GoalTickProgram.validateJournal({ ...activated, dispositions: [{ ...activated.dispositions[0], role: 0 }] }),
  ).toThrow("disposition")
  expect(() => GoalTickProgram.validateJournal({ ...activated, programHash: "0".repeat(64) })).toThrow("hash")
})

function document(body = "a"): GoalTickProgram.DocumentPayload {
  return {
    id: "doc:plan:parent",
    type: "plan",
    scope: "run:ses_parent",
    status: "draft",
    version: 1,
    superseded_by: null,
    created_round: null,
    domain: null,
    tags: [],
    description: "parent plan",
    provenance: { source: "runner", run_ref: "run:ses_parent" },
    links: [],
    body,
  }
}

test("encoded payload escaping, full document creation and state copies consume independent slots", () => {
  const payload = GoalTickProgram.canonical(document())
  const initial = program()
  const journal = GoalTickProgram.reservation(
    {
      ...initial,
      documents: [
        {
          ...initial.documents[0],
          bodyBytes: 8,
          payloadBytes: 2048,
          metadataHash: GoalTickProgram.hash(GoalTickProgram.documentMetadata(document())),
        },
      ],
      nextStateBytes: 8,
    },
    parent,
  ).empty
  const doc = {
    documentID: initial.documents[0].id,
    expectedVersion: null,
    expectedHash: null,
    payload,
    payloadHash: GoalTickProgram.hash(payload),
    state: "pending" as const,
    observedVersion: null,
    observedHash: null,
  }
  expect(() =>
    GoalTickProgram.validateJournal({
      ...journal,
      documents: [doc],
      nextState: "a",
      nextStateHash: GoalTickProgram.hash("a"),
    }),
  ).not.toThrow()
  expect(GoalTickProgram.bytes("\u0000\u0000")).toBe(14)
  const escaped = GoalTickProgram.canonical(document("\u0000\u0000"))
  expect(() =>
    GoalTickProgram.validateJournal({
      ...journal,
      documents: [{ ...doc, payload: escaped, payloadHash: GoalTickProgram.hash(escaped) }],
    }),
  ).toThrow("body")
  expect(() =>
    GoalTickProgram.validateJournal({
      ...journal,
      documents: [doc],
      nextState: "\u0000\u0000",
      nextStateHash: GoalTickProgram.hash("\u0000\u0000"),
    }),
  ).toThrow("reservation")
  expect(() => GoalTickProgram.validateJournal({ ...journal, documents: [{ ...doc, expectedVersion: 1 }] })).toThrow(
    "prior revision",
  )
  expect(() => GoalTickProgram.validateJournal({ ...journal, documents: [{ ...doc, observedVersion: 1 }] })).toThrow(
    "confirmation",
  )
  expect(() =>
    GoalTickProgram.validateJournal(GoalTickProgram.reservation({ ...initial, nextStateBytes: 0 }, parent).empty),
  ).not.toThrow()
})

test("command completion is distinct from contained stop and unknown never claims passed", () => {
  const output = { ref: "artifact", hash, bytes: 0, truncated: false }
  const effect: GoalTickProgram.LocalEffect = {
    version: 2,
    id: "effect",
    kind: "validation",
    commandHash: hash,
    cwdHash: hash,
    profileHash: hash,
    instanceID: "instance",
    handleID: "handle",
    state: "exited",
    outcome: "passed",
    containment: "posix-group",
    stopProof: "not_requested",
    exitCode: 0,
    signal: null,
    stdout: output,
    stderr: output,
    startedAt: 1,
    endedAt: 2,
  }
  expect(GoalTickProgram.validateLocalEffect(effect)).toBe(effect)
  expect(() =>
    GoalTickProgram.validateLocalEffect({
      ...effect,
      state: "stop_confirmed",
      outcome: "cancelled",
      stopProof: "contained_tree_exit",
    }),
  ).toThrow("contained")
  expect(() => GoalTickProgram.validateLocalEffect({ ...effect, state: "unknown", stopProof: "unconfirmed" })).toThrow(
    "Unknown",
  )
  expect(() =>
    GoalTickProgram.validateLocalEffect({
      ...effect,
      state: "cancelled_before_dispatch",
      outcome: "cancelled",
      stopProof: "not_started",
    }),
  ).toThrow("invented")
  expect(() => GoalTickProgram.validateLocalEffect({ ...effect, endedAt: 0 })).toThrow("backwards")
})

test("full Doc metadata plus a double-encoded body is exactly reserved, including Unicode and escapes", () => {
  const payload = document('中文\\"\u0000🙂')
  const budget = GoalTickProgram.documentBudget(
    payload,
    "plan",
    GoalTickProgram.bytes(GoalTickProgram.canonical(payload.body)),
  )
  expect(budget.payloadBytes).toBe(GoalTickProgram.bytes(GoalTickProgram.canonical(payload)))
  const journal = GoalTickProgram.reservation({ ...program(), documents: [budget] }, parent).empty
  const encoded = GoalTickProgram.canonical(payload)
  expect(() =>
    GoalTickProgram.validateJournal({
      ...journal,
      documents: [
        {
          documentID: payload.id,
          expectedVersion: null,
          expectedHash: null,
          payload: encoded,
          payloadHash: GoalTickProgram.hash(encoded),
          state: "confirmed",
          observedVersion: 1,
          observedHash: GoalTickProgram.hash(payload),
        },
      ],
    }),
  ).not.toThrow()
  expect(() => GoalTickProgram.documentBudget(payload, "plan", budget.bodyBytes - 1)).toThrow("allocation")
})

test("completed disposition requires the exact activated terminal stage and unique execution receipts", () => {
  const journal = GoalTickProgram.reservation(program(), parent).empty
  const unitID = "goalchild_exact"
  const activation: GoalTickProgram.Activation = {
    role: 0,
    recipeHash: hash,
    dependencies: { count: 0, through: 0, hash },
    promptHash: hash,
    unitID,
    inputID: GoalTickProgram.inputID(unitID, "research"),
    activatedAt: 1,
  }
  const result = (stage: "research" | "finalizer.1" | "finalizer.2", outcome: "valid" | "schema_invalid") => ({
    version: 1 as const,
    unitID,
    stage,
    inputID: GoalTickProgram.inputID(unitID, stage),
    admittedSeq: 1,
    activityID: `activity_${stage}`,
    messageID: `message_${stage}`,
    executionID: `execution_${stage}`,
    claimToken: 1,
    providers: { count: 1, through: 1, hash },
    tools: { count: 0, through: 0, hash },
    outcome,
    resultHash: hash,
    schemaHash: hash,
    usage: {
      input: 10,
      nonCachedInput: 10,
      output: 5,
      reasoning: null,
      visibleOutput: null,
      cacheRead: 0,
      cacheWrite: 0,
    },
    usageDerivation: { version: 1 as const, inferredInputCategories: [] },
  })
  const completed = {
    ...journal,
    cursor: { role: 1, stage: "plain" as const },
    activations: [activation],
    results: [result("research", "valid"), result("finalizer.1", "valid")],
    dispositions: [
      {
        role: 0,
        kind: "completed" as const,
        rule: "actual-result-v2" as const,
        evidence: { count: 2, through: 2, hash },
      },
    ],
  }
  expect(() => GoalTickProgram.validateJournal(completed)).not.toThrow()
  expect(() => GoalTickProgram.validateJournal({ ...completed, results: [completed.results[0]] })).toThrow(
    "disposition",
  )
  expect(() => GoalTickProgram.validateJournal({ ...completed, activations: [] })).toThrow("activated")
  expect(() =>
    GoalTickProgram.validateJournal({ ...completed, results: [...completed.results, result("finalizer.2", "valid")] }),
  ).toThrow("stage order")
  expect(() =>
    GoalTickProgram.validateJournal({
      ...completed,
      results: [completed.results[0], { ...completed.results[1], inputID: completed.results[0].inputID }],
    }),
  ).toThrow("duplicated")
  expect(() =>
    GoalTickProgram.validateJournal({
      ...completed,
      dispositions: [{ ...completed.dispositions[0], kind: "skipped", rule: "cheap-gate-v2" }],
    }),
  ).toThrow("disposition")
})
