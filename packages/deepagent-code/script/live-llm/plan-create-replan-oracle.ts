import {
  assertPlanArgumentReceipts,
  type PlanArgumentReceipt,
  type PlanOracleDocument,
  type PlanRequestReceipt,
  type PlanToolCall,
} from "./plan-advance-oracle"

type PlanObservation = {
  newTools: readonly PlanToolCall[]
  plan?: { document: PlanOracleDocument | null; ref: { id: string; version: number } | null }
  durability?: {
    requestReceipts: readonly PlanRequestReceipt[]
    argumentReceipts: readonly PlanArgumentReceipt[]
  }
}

export function assertPlanCreateObservation(input: {
  caseName: string
  observation: PlanObservation
  goal: string
  assumptions: readonly string[]
  steps: ReadonlyArray<{ title: string; status: string }>
}) {
  const call = requirePlanCalls(input.caseName, input.observation, 1)[0]!
  const args = record(call.input, `${input.caseName} plan input`)
  const metadata = record(call.metadata, `${input.caseName} plan metadata`)
  assertKeys(
    input.caseName,
    args,
    new Set(["operation", "expected_plan_id", "expected_version", "goal", "assumptions", "steps"]),
  )
  if (
    args.operation !== "create" ||
    args.expected_plan_id !== null ||
    args.expected_version !== null ||
    args.goal !== input.goal ||
    JSON.stringify(args.assumptions) !== JSON.stringify(input.assumptions)
  ) {
    throw new Error(`${input.caseName} create parameters were not authoritative: ${JSON.stringify(args)}`)
  }
  const steps = array(args.steps, `${input.caseName} create steps`).map((step, index) => {
    const value = record(step, `${input.caseName} create step ${index + 1}`)
    assertKeys(input.caseName, value, new Set(["title", "status"]))
    if ("step_id" in value) throw new Error(`${input.caseName} create supplied a model-owned step_id`)
    return value
  })
  if (
    steps.length !== input.steps.length ||
    steps.some((step, index) => step.title !== input.steps[index]?.title || step.status !== input.steps[index]?.status)
  ) {
    throw new Error(`${input.caseName} create steps differed from the requested structure`)
  }
  if (metadata.plan_protocol !== "success") throw new Error(`${input.caseName} create did not succeed`)
  assertPlanArgumentReceipts(input.caseName, call, input.observation.durability, "success")

  const plan = input.observation.plan?.document
  const ref = input.observation.plan?.ref
  if (!plan || !ref || ref.version !== 1) throw new Error(`${input.caseName} did not commit Plan version 1`)
  if (
    plan.goal !== input.goal ||
    JSON.stringify(plan.assumptions) !== JSON.stringify(input.assumptions) ||
    plan.steps.length !== input.steps.length
  ) {
    throw new Error(`${input.caseName} committed the wrong Plan structure`)
  }
  const allocated = new Set(plan.steps.map((step) => step.step_id))
  if (allocated.size !== plan.steps.length || [...allocated].some((id) => id.length === 0)) {
    throw new Error(`${input.caseName} did not allocate unique server step IDs`)
  }
  plan.steps.forEach((step, index) => {
    if (step.title !== input.steps[index]?.title || step.status !== input.steps[index]?.status) {
      throw new Error(`${input.caseName} committed an unexpected step at index ${index}`)
    }
  })
  const active = plan.steps.find((step) => step.status === "active")
  if (!active || plan.active_step_id !== active.step_id) {
    throw new Error(`${input.caseName} did not derive active_step_id from the allocated active step`)
  }
  return plan
}

export function assertPlanReplanObservation(input: {
  caseName: string
  observation: PlanObservation
  authority: PlanOracleDocument
  expectedVersion: number
  expectedActiveTitle: string
  expectedReason: string
  expectedStatuses: Readonly<Record<string, string>>
  expectedNewTitles: readonly string[]
  expectedCalls: ReadonlyArray<{
    version: number
    protocol: "success" | "conflict"
    notes?: Readonly<Record<string, string | null>>
  }>
  expectedNotes?: Readonly<Record<string, string | null>>
}) {
  const calls = requirePlanCalls(input.caseName, input.observation, input.expectedCalls.length)
  calls.forEach((call, index) => {
    const expected = input.expectedCalls[index]!
    const args = record(call.input, `${input.caseName} replan input ${index + 1}`)
    const metadata = record(call.metadata, `${input.caseName} replan metadata ${index + 1}`)
    assertKeys(
      input.caseName,
      args,
      new Set(["operation", "expected_plan_id", "expected_version", "replan_reason", "goal", "steps"]),
    )
    if (
      args.operation !== "replan" ||
      args.expected_plan_id !== input.authority.plan_id ||
      args.expected_version !== expected.version ||
      args.replan_reason !== input.expectedReason ||
      args.goal !== input.authority.goal ||
      "active_step_id" in args ||
      "assumptions" in args
    ) {
      throw new Error(`${input.caseName} replan parameters were not authoritative: ${JSON.stringify(args)}`)
    }
    const steps = array(args.steps, `${input.caseName} replan steps ${index + 1}`).map((step, stepIndex) =>
      record(step, `${input.caseName} replan step ${index + 1}.${stepIndex + 1}`),
    )
    if (steps.length !== input.authority.steps.length + input.expectedNewTitles.length) {
      throw new Error(`${input.caseName} replan supplied the wrong number of steps`)
    }
    input.authority.steps.forEach((authority, stepIndex) => {
      const step = steps[stepIndex]!
      if (step.step_id !== authority.step_id || step.status !== input.expectedStatuses[authority.title]) {
        throw new Error(`${input.caseName} changed retained step identity ${authority.title}`)
      }
      for (const key of Object.keys(step)) {
        if (!new Set(["step_id", "status", "title", "acceptance", "assigned_agent", "note"]).has(key)) {
          throw new Error(`${input.caseName} retained step supplied unsupported field ${key}`)
        }
      }
      if (
        (step.title !== undefined && step.title !== authority.title) ||
        (step.acceptance !== undefined && step.acceptance !== authority.acceptance) ||
        (step.assigned_agent !== undefined && step.assigned_agent !== authority.assigned_agent) ||
        (step.note !== undefined && step.note !== (expected.notes?.[authority.title] ?? authority.note))
      ) {
        throw new Error(`${input.caseName} guessed or mutated hidden identity for ${authority.title}`)
      }
    })
    input.expectedNewTitles.forEach((title, newIndex) => {
      const step = steps[input.authority.steps.length + newIndex]!
      if ("step_id" in step) throw new Error(`${input.caseName} supplied an ID for new step ${title}`)
      assertKeys(input.caseName, step, new Set(["title", "status"]))
      if (step.title !== title || step.status !== input.expectedStatuses[title]) {
        throw new Error(`${input.caseName} supplied the wrong new step ${title}`)
      }
    })
    if (metadata.plan_protocol !== expected.protocol) {
      throw new Error(`${input.caseName} expected ${expected.protocol}, received ${String(metadata.plan_protocol)}`)
    }
    assertPlanArgumentReceipts(input.caseName, call, input.observation.durability, expected.protocol)
  })

  const plan = input.observation.plan?.document
  const ref = input.observation.plan?.ref
  if (!plan || !ref || ref.version !== input.expectedVersion) {
    throw new Error(`${input.caseName} expected Plan version ${input.expectedVersion}`)
  }
  if (
    plan.plan_id !== input.authority.plan_id ||
    plan.goal !== input.authority.goal ||
    JSON.stringify(plan.assumptions) !== JSON.stringify(input.authority.assumptions)
  ) {
    throw new Error(`${input.caseName} changed Plan identity or omitted assumptions`)
  }
  input.authority.steps.forEach((authority, index) => {
    const step = plan.steps[index]
    if (
      !step ||
      step.step_id !== authority.step_id ||
      step.title !== authority.title ||
      step.acceptance !== authority.acceptance ||
      step.assigned_agent !== authority.assigned_agent ||
      step.status !== input.expectedStatuses[authority.title] ||
      (step.note ?? null) !== (input.expectedNotes?.[authority.title] ?? authority.note ?? null)
    ) {
      throw new Error(`${input.caseName} failed to preserve retained authority for ${authority.title}`)
    }
  })
  const allocated = plan.steps.slice(input.authority.steps.length)
  if (
    allocated.length !== input.expectedNewTitles.length ||
    allocated.some(
      (step, index) =>
        step.title !== input.expectedNewTitles[index] ||
        step.status !== input.expectedStatuses[step.title] ||
        input.authority.steps.some((authority) => authority.step_id === step.step_id),
    )
  ) {
    throw new Error(`${input.caseName} did not allocate the expected new steps`)
  }
  const active = plan.steps.find((step) => step.title === input.expectedActiveTitle)
  if (!active || active.status !== "active" || plan.active_step_id !== active.step_id) {
    throw new Error(`${input.caseName} did not derive the expected active step`)
  }
  return plan
}

function requirePlanCalls(caseName: string, observation: PlanObservation, count: number) {
  const calls = observation.newTools.filter((tool) => tool.name === "plan")
  if (calls.length !== count || calls.length !== observation.newTools.length) {
    throw new Error(`${caseName} tool sequence mismatch: ${observation.newTools.map((tool) => tool.name).join(", ")}`)
  }
  if (calls.some((call) => call.status !== "completed")) throw new Error(`${caseName} Plan call did not complete`)
  return calls
}

function assertKeys(caseName: string, value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${caseName} supplied unsupported field ${key}`)
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
