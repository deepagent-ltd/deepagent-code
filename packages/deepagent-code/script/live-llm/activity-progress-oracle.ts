type ActivityProgressMarker = {
  activity_id: string
  revision: number
  state: "progress" | "final" | "interrupted" | "recovery_required"
}

type ActivityDurability = {
  activityAdmissions: ReadonlyArray<{
    admission_id: string
    delivery: string
    admitted_message_id: string
  }>
  legacyActivities: ReadonlyArray<{
    activity_id: string
    owner_token: string
    state: string
    terminal_reason: string | null
  }>
  legacyActivityRuns: ReadonlyArray<{
    run_id: string
    activity_id: string
    owner_token: string
    state: string
    terminal_reason: string | null
  }>
  legacyActivityTerminals: ReadonlyArray<{
    activity_id: string
    state: string
    reason_code: string
    source: string
    run_id: string | null
    progress_revision: number | null
    membership_ordinal: number
    owner_token: string
  }>
  legacyActivityAdmissions: ReadonlyArray<{
    activity_id: string
    admission_id: string
    ordinal: number
    role: string
  }>
  activityProgress: ReadonlyArray<{
    activity_id: string
    revision: number
    assistant_message_id: string
    provider_receipt_id: string
    input_membership_ordinal: number
    state: string
  }>
  activityTextParts: ReadonlyArray<{
    id: string
    message_id: string
    data: unknown
  }>
  requestReceipts: ReadonlyArray<{
    receipt_id: string
    request_state: string
  }>
  v2?: {
    inputs: ReadonlyArray<{ id: string; delivery: string; admitted_seq: number; promoted_seq: number | null }>
    activities: ReadonlyArray<{
      activity_id: string
      ordinal: number
      trigger_input_id: string
      state: string
      settled_at: number | null
    }>
    activityInputs: ReadonlyArray<{
      activity_id: string
      input_id: string
      ordinal: number
      admitted_seq: number
      role: string
    }>
    providerAttempts: ReadonlyArray<{
      attempt_id: string
      activity_id: string
      provider_turn_seq: number
      owner_token: string | null
      state: string
    }>
    providerReceipts: ReadonlyArray<{
      receipt_id: string
      activity_id: string
      request_ordinal: number
      provider_turn_seq: number
      provider_attempt_id: string | null
      owner_token: string
      state: string
      toolCalls: ReadonlyArray<{ id: string; name: string }>
    }>
    toolAdmissions: ReadonlyArray<{
      receipt_id: string
      provider_attempt_id: string
      tool_call_id: string
      tool_name: string
    }>
    toolEffects: ReadonlyArray<{
      receipt_id: string
      provider_attempt_id: string
      tool_call_id: string
      tool_name: string
      state: string
    }>
  }
}

export function assertActivityProgressObservation(input: {
  caseName: string
  triggerText: string
  steerText: string
  marker: string
  expectedTools: readonly string[]
  authority?: "v1" | "v2"
  observation: {
    users: ReadonlyArray<{ id?: string; text: string }>
    steering: ReadonlyArray<{
      id?: string
      delivery: string
      activeBeforeAdmission: boolean
      pendingAfterAdmission: boolean
      consumedAfterAdmission: boolean
    }>
    assistantTurns: number
    finalText: string
    newTools: ReadonlyArray<{ id?: string; name: string; status: string }>
    providerErrors: readonly unknown[]
    durability?: ActivityDurability
  }
}) {
  if (input.observation.providerErrors.length > 0) {
    throw new Error(`${input.caseName} recorded Provider errors`)
  }
  if (
    input.observation.users.length !== 2 ||
    input.observation.users.filter((user) => user.text === input.triggerText).length !== 1 ||
    input.observation.users.filter((user) => user.text === input.steerText).length !== 1
  ) {
    throw new Error(`${input.caseName} did not materialize trigger and steer exactly once`)
  }
  const steering = input.observation.steering[0]
  if (
    input.observation.steering.length !== 1 ||
    !steering ||
    steering.delivery !== "steer" ||
    !steering.activeBeforeAdmission ||
    !steering.pendingAfterAdmission ||
    !steering.consumedAfterAdmission
  ) {
    throw new Error(`${input.caseName} did not durably absorb one active-turn steer`)
  }
  // Provider-generic tool contract: the requested work happens with only the requested tool
  // family and every call reaches a terminal status — the exact call count and order are model
  // behavior, not a product guarantee, so they are not asserted.
  if (
    input.observation.newTools.length === 0 ||
    input.observation.newTools.some((tool) => tool.name !== input.expectedTools[0]) ||
    input.observation.newTools.some((tool) => tool.status !== "completed")
  ) {
    throw new Error(`${input.caseName} did not complete the requested tool work`)
  }
  if (input.observation.finalText.split(input.marker).length !== 2) {
    throw new Error(`${input.caseName} final response did not contain the marker exactly once`)
  }

  const durability = input.observation.durability
  if (!durability) throw new Error(`${input.caseName} did not capture activity durability`)
  if (input.authority === "v2") {
    return assertV2ActivityDurability({
      caseName: input.caseName,
      steeringID: steering.id,
      userIDs: input.observation.users.map((user) => user.id),
      assistantTurns: input.observation.assistantTurns,
      newTools: input.observation.newTools,
      durability: durability.v2,
    })
  }
  // Provider-generic durability contract: trigger and steer admissions both persist, every
  // activity settles process-owned, each activity's progress is contiguous to a final row with
  // dispatched receipts, and runs/terminals match. A model that finishes before the steer lands
  // legitimately produces a second follow-up activity instead of mid-turn absorption.
  const admissions = durability.activityAdmissions
  const activities = durability.legacyActivities
  if (activities.length === 0 || activities.length > 2) {
    throw new Error(`${input.caseName} admitted ${activities.length} activities`)
  }
  for (const activity of activities) {
    if (
      activity.state !== "settled" ||
      activity.terminal_reason !== "assistant_completed" ||
      activity.owner_token.length === 0 ||
      activity.owner_token === "pre-owner-migration"
    ) {
      throw new Error(`${input.caseName} did not settle process-owned activity ${activity.activity_id}`)
    }
  }
  const memberships = [...durability.legacyActivityAdmissions].sort((left, right) => left.ordinal - right.ordinal)
  if (
    memberships.length < 2 ||
    memberships.some((membership) => !activities.some((activity) => activity.activity_id === membership.activity_id))
  ) {
    throw new Error(`${input.caseName} activity memberships did not cover the settled activities`)
  }
  const linked = new Set(memberships.map((membership) => membership.admission_id))
  const trigger = admissions.find((admission) => admission.delivery === "turn" && linked.has(admission.admission_id))
  const steer = admissions.find((admission) => admission.delivery === "steer" && linked.has(admission.admission_id))
  if (!trigger || !steer || admissions.length < 2 || admissions.length > 3) {
    throw new Error(
      `${input.caseName} did not persist trigger and steer admissions (${admissions.length} admissions)`,
    )
  }
  // A steer that lands before the trigger turn is admitted persists as its own durable input
  // row without an activity membership — allowed; an unlinked TURN is never acceptable.
  for (const admission of admissions) {
    if (!linked.has(admission.admission_id) && admission.delivery === "turn") {
      throw new Error(`${input.caseName} persisted an unlinked turn admission`)
    }
  }

  const triggerMembership = memberships.find(
    (membership) => membership.admission_id === trigger.admission_id && membership.role === "trigger",
  )
  const steerMembership = memberships.find((membership) => membership.admission_id === steer.admission_id)
  if (!triggerMembership || triggerMembership.ordinal !== 0 || !steerMembership) {
    throw new Error(`${input.caseName} activity membership was not trigger plus steer in durable order`)
  }

  const progress = [...durability.activityProgress].sort((left, right) => left.revision - right.revision)
  const receiptIDs = new Set(
    durability.requestReceipts
      .filter((receipt) => receipt.request_state === "dispatched")
      .map((receipt) => receipt.receipt_id),
  )
  for (const activity of activities) {
    const rows = progress.filter((item) => item.activity_id === activity.activity_id)
    if (
      rows.length === 0 ||
      rows.some((item, index) => item.revision !== index) ||
      rows.slice(0, -1).some((item) => item.state !== "progress") ||
      rows.at(-1)?.state !== "final"
    ) {
      throw new Error(`${input.caseName} activity progress was not contiguous progress-to-final`)
    }
    if (rows.some((item) => !receiptIDs.has(item.provider_receipt_id))) {
      throw new Error(`${input.caseName} progress row lacked a dispatched provider receipt`)
    }
  }
  const final = progress.at(-1)
  if (
    durability.legacyActivityRuns.length !== activities.length ||
    durability.legacyActivityTerminals.length !== activities.length ||
    activities.some(
      (activity) =>
        !durability.legacyActivityRuns.some(
          (run) =>
            run.activity_id === activity.activity_id &&
            run.owner_token === activity.owner_token &&
            run.state === "completed" &&
            run.terminal_reason === "assistant_completed",
        ) ||
        !durability.legacyActivityTerminals.some(
          (terminal) =>
            terminal.activity_id === activity.activity_id &&
            terminal.state === "settled" &&
            terminal.reason_code === "assistant_completed" &&
            terminal.source === "provider_final" &&
            terminal.owner_token === activity.owner_token,
        ),
    )
  ) {
    throw new Error(`${input.caseName} lacked matching runs and terminal receipts`)
  }
  progress.forEach((item) => {
    const parts = durability.activityTextParts.filter((part) => part.message_id === item.assistant_message_id)
    parts.forEach((part) => {
      const marker = activityMarker(part.data)
      if (
        !marker ||
        marker.activity_id !== item.activity_id ||
        marker.revision !== item.revision ||
        marker.state !== item.state
      ) {
        throw new Error(`${input.caseName} text part ${part.id} lacked the durable progress marker`)
      }
    })
  })
  if (input.observation.assistantTurns !== progress.length) {
    throw new Error(`${input.caseName} assistant turns and progress revisions diverged`)
  }
  return {
    activities,
    progressStates: progress.map((item) => `${item.revision}:${item.state}`),
    evidenceKind: "legacy_activity_progress" as const,
  }
}

function assertV2ActivityDurability(input: {
  caseName: string
  steeringID: string | undefined
  userIDs: ReadonlyArray<string | undefined>
  assistantTurns: number
  newTools: ReadonlyArray<{ id?: string; name: string; status: string }>
  durability: ActivityDurability["v2"]
}) {
  const v2 = input.durability
  if (!v2) throw new Error(`${input.caseName} did not capture V2 activity durability`)
  const inputs = [...v2.inputs].sort((left, right) => left.admitted_seq - right.admitted_seq)
  const [trigger, steer] = inputs
  if (
    inputs.length !== 2 ||
    !trigger ||
    !steer ||
    trigger.id !== input.userIDs[0] ||
    steer.id !== input.userIDs[1] ||
    steer.id !== input.steeringID ||
    steer.delivery !== "steer" ||
    trigger.promoted_seq === null ||
    steer.promoted_seq === null ||
    trigger.promoted_seq >= steer.promoted_seq
  ) {
    throw new Error(`${input.caseName} did not persist and promote exactly one trigger and steer input`)
  }
  const activities = [...v2.activities].sort((left, right) => left.ordinal - right.ordinal)
  if (
    activities.length < 1 ||
    activities.length > 2 ||
    activities.some(
      (activity, index) => activity.state !== "settled" || activity.settled_at === null || activity.ordinal !== index,
    )
  ) {
    throw new Error(`${input.caseName} did not settle one or two V2 activities`)
  }
  const memberships = v2.activityInputs
  const triggerMembership = memberships.find((item) => item.input_id === trigger.id)
  const steerMembership = memberships.find((item) => item.input_id === steer.id)
  if (
    memberships.length !== 2 ||
    !triggerMembership ||
    !steerMembership ||
    triggerMembership.activity_id !== activities[0]?.activity_id ||
    triggerMembership.role !== "trigger" ||
    triggerMembership.ordinal !== 0 ||
    triggerMembership.admitted_seq !== trigger.admitted_seq ||
    steerMembership.admitted_seq !== steer.admitted_seq ||
    !activities.some((activity) => activity.activity_id === steerMembership.activity_id) ||
    (activities.length === 1 && (steerMembership.role !== "steer" || steerMembership.ordinal !== 1)) ||
    (activities.length === 2 && (steerMembership.role !== "trigger" || steerMembership.ordinal !== 0)) ||
    activities.some(
      (activity) =>
        activity.trigger_input_id !==
        memberships.find((item) => item.activity_id === activity.activity_id && item.role === "trigger")?.input_id,
    )
  ) {
    throw new Error(`${input.caseName} activity inputs did not cover trigger and steer`)
  }
  const receipts = [...v2.providerReceipts].sort((left, right) => left.request_ordinal - right.request_ordinal)
  if (
    receipts.length !== input.assistantTurns ||
    receipts.some(
      (receipt, index) =>
        receipt.state !== "settled" ||
        receipt.request_ordinal !== index + 1 ||
        receipt.provider_turn_seq !== index + 1 ||
        !activities.some((activity) => activity.activity_id === receipt.activity_id) ||
        !v2.providerAttempts.some(
          (attempt) =>
            attempt.attempt_id === receipt.provider_attempt_id &&
            attempt.activity_id === receipt.activity_id &&
            attempt.provider_turn_seq === receipt.provider_turn_seq &&
            attempt.owner_token === receipt.owner_token &&
            receipt.owner_token.length > 0 &&
            attempt.state === "settled",
        ),
    )
  ) {
    throw new Error(`${input.caseName} provider receipt lacked its exact attempt or terminal state`)
  }
  if (v2.providerAttempts.length !== receipts.length) {
    throw new Error(`${input.caseName} provider attempts and receipts diverged`)
  }
  const toolIDs = input.newTools.map((tool) => tool.id)
  const receiptToolCalls = receipts.flatMap((receipt) => receipt.toolCalls)
  if (
    toolIDs.some((id) => !id) ||
    new Set(toolIDs).size !== toolIDs.length ||
    receiptToolCalls.length !== toolIDs.length ||
    receiptToolCalls.some((call) => !toolIDs.includes(call.id)) ||
    v2.toolAdmissions.length !== toolIDs.length
  ) {
    throw new Error(`${input.caseName} tool calls did not match V2 admissions`)
  }
  for (const tool of input.newTools) {
    const admission = v2.toolAdmissions.find((item) => item.tool_call_id === tool.id)
    const receipt = receipts.find((item) => item.receipt_id === admission?.receipt_id)
    const effect = v2.toolEffects.find((item) => item.receipt_id === admission?.receipt_id && item.tool_call_id === tool.id)
    if (
      !admission ||
      !receipt ||
      admission.tool_name !== tool.name ||
      admission.provider_attempt_id !== receipt.provider_attempt_id ||
      !effect ||
      effect.provider_attempt_id !== admission.provider_attempt_id ||
      effect.tool_name !== tool.name ||
      effect.state !== "settled" ||
      !receipt.toolCalls.some((call) => call.id === tool.id && call.name === tool.name)
    ) {
      throw new Error(`${input.caseName} tool ${String(tool.id)} lacked a matching durable tool effect`)
    }
  }
  if (v2.toolEffects.length !== toolIDs.length) {
    throw new Error(`${input.caseName} tool effects and observed calls diverged`)
  }
  return {
    activities,
    progressStates: receipts.map((receipt) => `${receipt.provider_turn_seq}:${receipt.state}`),
    evidenceKind: "v2_provider_turn" as const,
  }
}

function activityMarker(data: unknown): ActivityProgressMarker | undefined {
  const part = record(data)
  const metadata = record(part?.metadata)
  const marker = record(metadata?.deepagent_activity_progress)
  if (
    typeof marker?.activity_id !== "string" ||
    typeof marker.revision !== "number" ||
    !["progress", "final", "interrupted", "recovery_required"].includes(String(marker.state))
  ) {
    return
  }
  return marker as ActivityProgressMarker
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}
