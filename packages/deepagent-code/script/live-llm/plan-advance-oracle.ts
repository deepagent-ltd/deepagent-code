type PlanStep = {
  step_id: string
  title: string
  status: string
  acceptance?: string | null
  assigned_agent?: string | null
  note?: string | null
}

type PlanDocument = {
  plan_id: string
  goal: string
  assumptions: readonly string[]
  active_step_id: string | null
  steps: readonly PlanStep[]
}

type ToolCall = {
  messageID: string
  id: string
  name: string
  status: string
  input: unknown
  metadata?: unknown
}

type RequestReceipt = {
  receipt_id: string
  assistant_message_id: string | null
  request_state: string
  final_offered_tool_ids: readonly string[]
  call_ids: readonly string[]
  tool_definition_hash: string | null
}

type ArgumentReceipt = {
  receipt_id: string
  layer: string
  call_id: string | null
  tool_name: string | null
  event_type: string
  payload_hash: string | null
  payload_length: number | null
  payload_keys: readonly string[]
  unavailable_reason: string | null
  validation_outcome: string
}

export function assertPlanAdvanceObservation(input: {
  caseName: string
  observation: {
    newTools: readonly ToolCall[]
    plan?: { document: PlanDocument | null; ref: { id: string; version: number } | null }
    durability?: {
      requestReceipts: readonly RequestReceipt[]
      argumentReceipts: readonly ArgumentReceipt[]
    }
  }
  immutable: PlanDocument
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
  if (calls.length !== input.expectedCalls.length || input.observation.newTools.length !== calls.length) {
    throw new Error(
      `${input.caseName} tool sequence mismatch: ${JSON.stringify(
        input.observation.newTools.map((tool) => `${tool.name}:${tool.status}`),
      )}`,
    )
  }

  calls.forEach((call, index) => {
    if (call.status !== "completed") throw new Error(`${input.caseName} plan call ${index + 1} did not complete`)
    const args = record(call.input, `${input.caseName} plan input ${index + 1}`)
    const metadata = record(call.metadata, `${input.caseName} plan metadata ${index + 1}`)
    const expected = input.expectedCalls[index]!
    if (
      args.operation !== "advance" ||
      args.expected_plan_id !== input.immutable.plan_id ||
      args.expected_version !== expected.version
    ) {
      throw new Error(`${input.caseName} plan precondition mismatch: ${JSON.stringify(args)}`)
    }
    const allowedKeys = new Set(["operation", "expected_plan_id", "expected_version", "steps", "active_step_id"])
    for (const key of Object.keys(args)) {
      if (!allowedKeys.has(key)) throw new Error(`${input.caseName} plan input supplied non-patch field ${key}`)
    }
    if (args.active_step_id !== expected.activeStepID) {
      throw new Error(`${input.caseName} plan call ${index + 1} supplied the wrong active_step_id`)
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
    }
    const statuses = Object.fromEntries(steps.map((step) => [step.step_id, step.status]))
    if (JSON.stringify(statuses) !== JSON.stringify(expected.statuses)) {
      throw new Error(`${input.caseName} plan call ${index + 1} supplied the wrong status patch`)
    }
    if (metadata.plan_protocol !== expected.protocol) {
      throw new Error(
        `${input.caseName} plan call ${index + 1} expected ${expected.protocol}, received ${String(metadata.plan_protocol)}`,
      )
    }
    assertArgumentReceipts(input.caseName, call, input.observation.durability, expected.protocol)
  })

  const plan = input.observation.plan?.document
  const ref = input.observation.plan?.ref
  if (!plan || !ref) throw new Error(`${input.caseName} did not capture the durable Plan authority`)
  if (ref.version !== input.expectedVersion) {
    throw new Error(`${input.caseName} expected Plan version ${input.expectedVersion}, received ${ref.version}`)
  }
  if (
    plan.plan_id !== input.immutable.plan_id ||
    plan.goal !== input.immutable.goal ||
    JSON.stringify(plan.assumptions) !== JSON.stringify(input.immutable.assumptions) ||
    plan.active_step_id !== input.expectedActiveStepID
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
    if (step.status !== input.expectedStatuses[step.step_id]) {
      throw new Error(`${input.caseName} unexpected status for ${step.step_id}: ${step.status}`)
    }
    if (input.expectedNotes && (step.note ?? null) !== (input.expectedNotes[step.step_id] ?? null)) {
      throw new Error(`${input.caseName} unexpected note for ${step.step_id}: ${String(step.note)}`)
    }
  })
}

function assertArgumentReceipts(
  caseName: string,
  call: ToolCall,
  durability:
    | {
        requestReceipts: readonly RequestReceipt[]
        argumentReceipts: readonly ArgumentReceipt[]
      }
    | undefined,
  protocol: "success" | "conflict",
) {
  if (!durability) throw new Error(`${caseName} did not capture request/argument receipts`)
  const request = durability.requestReceipts.find(
    (receipt) => receipt.assistant_message_id === call.messageID && receipt.call_ids.includes(call.id),
  )
  if (
    !request ||
    request.request_state !== "dispatched" ||
    !request.final_offered_tool_ids.includes("plan") ||
    !request.tool_definition_hash
  ) {
    throw new Error(`${caseName} request receipt was incomplete: ${JSON.stringify(request)}`)
  }
  const receipts = durability.argumentReceipts.filter(
    (receipt) => receipt.receipt_id === request.receipt_id && receipt.call_id === call.id,
  )
  const aiSdkInput = receipts.find((receipt) => receipt.layer === "ai_sdk_input")
  const adapter = receipts.find((receipt) => receipt.layer === "adapter_assembly" && receipt.event_type === "tool-call")
  const decoded = receipts.find((receipt) => receipt.layer === "processor_decoded")
  const rawFrame = durability.argumentReceipts.find(
    (receipt) => receipt.receipt_id === request.receipt_id && receipt.layer === "raw_frame",
  )
  if (
    !aiSdkInput?.payload_hash ||
    !adapter?.payload_hash ||
    !decoded?.payload_hash ||
    aiSdkInput.tool_name !== "plan" ||
    adapter.tool_name !== "plan" ||
    decoded.tool_name !== "plan" ||
    adapter.payload_hash !== decoded.payload_hash ||
    adapter.payload_length !== decoded.payload_length ||
    JSON.stringify(adapter.payload_keys) !== JSON.stringify(decoded.payload_keys) ||
    aiSdkInput.validation_outcome !== "schema_valid" ||
    adapter.validation_outcome !== "schema_valid" ||
    decoded.validation_outcome !== (protocol === "success" ? "semantic_valid" : "conflict")
  ) {
    throw new Error(`${caseName} argument receipt chain was incomplete: ${JSON.stringify(receipts)}`)
  }
  if (
    !rawFrame ||
    (rawFrame.payload_hash == null && rawFrame.unavailable_reason !== "provider_transport_did_not_expose_raw_frame")
  ) {
    throw new Error(`${caseName} raw-frame provenance was neither captured nor explicitly unavailable`)
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
