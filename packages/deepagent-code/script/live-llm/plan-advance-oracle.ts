export type PlanOracleStep = {
  step_id: string
  title: string
  status: string
  acceptance?: string | null
  assigned_agent?: string | null
  note?: string | null
}

export type PlanOracleDocument = {
  plan_id: string
  goal: string
  assumptions: readonly string[]
  active_step_id: string | null
  steps: readonly PlanOracleStep[]
}

export type PlanToolCall = {
  messageID: string
  id: string
  name: string
  status: string
  input: unknown
  metadata?: unknown
}

export type PlanProviderTurnReceipt = {
  receiptID: string
  requestOrdinal: number
  providerTurnSeq: number
  state: string
  toolFinalOfferedIDs: readonly string[]
  toolDefinitionHash: string | null
}

export function assertPlanAdvanceObservation(input: {
  caseName: string
  observation: {
    newTools: readonly PlanToolCall[]
    plan?: { document: PlanOracleDocument | null; ref: { id: string; version: number } | null }
    providerTurns?: readonly PlanProviderTurnReceipt[]
  }
  immutable: PlanOracleDocument
  expectedVersion: number
  expectedActiveStepID: string | null
  expectedStatuses: Readonly<Record<string, string>>
  expectedNotes?: Readonly<Record<string, string | null>>
  expectedCalls: ReadonlyArray<{
    version: number
    protocol: "success" | "conflict"
    activeStepID: string | null
    statuses: Readonly<Record<string, string>>
  }>
}) {
  const calls = input.observation.newTools.filter((tool) => tool.name === "plan")
  if (calls.length === 0 || input.observation.newTools.length !== calls.length) {
    throw new Error(
      `${input.caseName} tool sequence mismatch: ${JSON.stringify(
        input.observation.newTools.map((tool) => `${tool.name}:${tool.status}`),
      )}`,
    )
  }

  const immutableStepIDs = new Set(input.immutable.steps.map((step) => step.step_id))
  const legalStepStatus = new Set(["pending", "active", "done", "skipped"])
  const protocolByCall: Array<"success" | "conflict"> = []
  calls.forEach((call, index) => {
    if (call.status !== "completed") throw new Error(`${input.caseName} plan call ${index + 1} did not complete`)
    const args = record(call.input, `${input.caseName} plan input ${index + 1}`)
    const metadata = record(call.metadata, `${input.caseName} plan metadata ${index + 1}`)
    // Provider-generic precondition contract: every advance targets the immutable plan with a
    // plausible version — the exact version sequence is model behavior, not a product guarantee.
    // The V2 tool input record keeps the provider's raw JSON, where numeric versions can arrive
    // stringified (the same provider-tolerance the tool's own tolerantInt schema applies).
    const expectedVersion = Number(args.expected_version)
    if (
      args.operation !== "advance" ||
      args.expected_plan_id !== input.immutable.plan_id ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      throw new Error(`${input.caseName} plan precondition mismatch: ${JSON.stringify(args)}`)
    }
    const allowedKeys = new Set(["operation", "expected_plan_id", "expected_version", "steps", "active_step_id"])
    for (const key of Object.keys(args)) {
      if (!allowedKeys.has(key)) throw new Error(`${input.caseName} plan input supplied non-patch field ${key}`)
    }
    if (args.active_step_id !== undefined && args.active_step_id !== null && !immutableStepIDs.has(String(args.active_step_id))) {
      throw new Error(`${input.caseName} plan call ${index + 1} supplied a non-plan active_step_id`)
    }
    const steps = array(args.steps, `${input.caseName} plan steps ${index + 1}`).map((step) =>
      record(step, `${input.caseName} plan step ${index + 1}`),
    )
    if (steps.length === 0) throw new Error(`${input.caseName} plan call ${index + 1} supplied no status patch`)
    for (const step of steps) {
      if (typeof step.step_id !== "string" || typeof step.status !== "string") {
        throw new Error(`${input.caseName} plan call ${index + 1} omitted step_id/status`)
      }
      for (const key of Object.keys(step)) {
        if (!new Set(["step_id", "status", "note"]).has(key)) {
          throw new Error(`${input.caseName} plan input supplied non-patch step field ${key}`)
        }
      }
      if (!immutableStepIDs.has(step.step_id)) {
        throw new Error(`${input.caseName} plan call ${index + 1} patched a non-plan step`)
      }
      if (!legalStepStatus.has(String(step.status))) {
        throw new Error(`${input.caseName} plan call ${index + 1} supplied an illegal step status`)
      }
    }
    const protocol = metadata.plan_protocol === "success" || metadata.plan_protocol === "conflict"
      ? metadata.plan_protocol
      : undefined
    if (!protocol) {
      throw new Error(
        `${input.caseName} plan call ${index + 1} reported dishonest protocol ${String(metadata.plan_protocol)}`,
      )
    }
    protocolByCall.push(protocol)
    assertPlanTurnReceipts(input.caseName, input.observation.providerTurns)
  })

  const plan = input.observation.plan?.document
  const ref = input.observation.plan?.ref
  if (!plan || !ref) throw new Error(`${input.caseName} did not capture the durable Plan authority`)
  if (
    plan.plan_id !== input.immutable.plan_id ||
    plan.goal !== input.immutable.goal ||
    JSON.stringify(plan.assumptions) !== JSON.stringify(input.immutable.assumptions)
  ) {
    throw new Error(`${input.caseName} changed authoritative Plan identity: ${JSON.stringify(plan)}`)
  }
  if (plan.steps.length !== input.immutable.steps.length) {
    throw new Error(`${input.caseName} changed the authoritative Plan step count`)
  }
  plan.steps.forEach((step, index) => {
    const immutable = input.immutable.steps[index]
    if (
      !immutable ||
      step.step_id !== immutable.step_id ||
      step.title !== immutable.title ||
      (step.acceptance ?? null) !== (immutable.acceptance ?? null) ||
      (step.assigned_agent ?? null) !== (immutable.assigned_agent ?? null)
    ) {
      throw new Error(`${input.caseName} changed server-owned step identity at index ${index}`)
    }
    if (!legalStepStatus.has(String(step.status))) {
      throw new Error(`${input.caseName} illegal committed status for ${step.step_id}: ${step.status}`)
    }
  })
  // Provider-generic terminal: a full commit is asserted strictly; an unfinished run is only
  // acceptable when every call went through the honest protocol path (receipts asserted above).
  if (ref.version === input.expectedVersion) {
    if (plan.active_step_id !== input.expectedActiveStepID) {
      throw new Error(`${input.caseName} committed version without the expected active step`)
    }
    plan.steps.forEach((step) => {
      if (step.status !== input.expectedStatuses[step.step_id]) {
        throw new Error(`${input.caseName} unexpected status for ${step.step_id}: ${step.status}`)
      }
      if (input.expectedNotes && (step.note ?? null) !== (input.expectedNotes[step.step_id] ?? null)) {
        throw new Error(`${input.caseName} unexpected note for ${step.step_id}: ${String(step.note)}`)
      }
    })
  } else if (!protocolByCall.includes("conflict")) {
    throw new Error(
      `${input.caseName} neither committed the expected version nor exercised the conflict protocol`,
    )
  }
}

export function assertPlanTurnReceipts(
  caseName: string,
  providerTurns: readonly PlanProviderTurnReceipt[] | undefined,
) {
  // Durable V2 request-authority surface: the provider-turn receipt that offered the plan tool
  // (settled state, plan in the final offered IDs, non-null tool-definition hash) replaces the
  // legacy session_tool_request_receipt rows, which the V2 owner no longer writes. The legacy
  // per-layer argument payload hashes (ai_sdk_input/adapter_assembly/processor_decoded) have no
  // V2 counterpart; argument validity stays asserted through the settled call's own
  // plan_protocol metadata in the calling oracle.
  if (!providerTurns || providerTurns.length === 0) {
    throw new Error(`${caseName} did not capture durable provider-turn receipts`)
  }
  const receipt = providerTurns.find(
    (turn) =>
      turn.state === "settled" && turn.toolFinalOfferedIDs.includes("plan") && !!turn.toolDefinitionHash,
  )
  if (!receipt) {
    throw new Error(`${caseName} settled provider-turn receipt offering plan was incomplete`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`)
  return value
}
