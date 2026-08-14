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
}

export function assertActivityProgressObservation(input: {
  caseName: string
  triggerText: string
  steerText: string
  marker: string
  expectedTools: readonly string[]
  observation: {
    users: ReadonlyArray<{ text: string }>
    steering: ReadonlyArray<{
      delivery: string
      activeBeforeAdmission: boolean
      pendingAfterAdmission: boolean
      consumedAfterAdmission: boolean
    }>
    assistantTurns: number
    finalText: string
    newTools: ReadonlyArray<{ name: string; status: string }>
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
  if (
    input.observation.newTools.length !== input.expectedTools.length ||
    input.observation.newTools.some(
      (tool, index) => tool.name !== input.expectedTools[index] || tool.status !== "completed",
    )
  ) {
    throw new Error(`${input.caseName} tool sequence did not complete as requested`)
  }
  if (input.observation.finalText.split(input.marker).length !== 2) {
    throw new Error(`${input.caseName} final response did not contain the marker exactly once`)
  }

  const durability = input.observation.durability
  if (!durability) throw new Error(`${input.caseName} did not capture activity durability`)
  if (durability.activityAdmissions.length !== 2) {
    throw new Error(`${input.caseName} expected two activity admissions`)
  }
  const trigger = durability.activityAdmissions.find((admission) => admission.delivery === "turn")
  const steer = durability.activityAdmissions.find((admission) => admission.delivery === "steer")
  if (!trigger || !steer) throw new Error(`${input.caseName} did not persist trigger and steer admissions`)

  const activity = durability.legacyActivities[0]
  if (
    durability.legacyActivities.length !== 1 ||
    !activity ||
    activity.state !== "settled" ||
    activity.terminal_reason !== "assistant_completed" ||
    activity.owner_token.length === 0 ||
    activity.owner_token === "pre-owner-migration"
  ) {
    throw new Error(`${input.caseName} did not settle one process-owned activity`)
  }
  const memberships = [...durability.legacyActivityAdmissions].sort((left, right) => left.ordinal - right.ordinal)
  if (
    memberships.length !== 2 ||
    memberships[0]?.activity_id !== activity.activity_id ||
    memberships[0]?.admission_id !== trigger.admission_id ||
    memberships[0]?.ordinal !== 0 ||
    memberships[0]?.role !== "trigger" ||
    memberships[1]?.activity_id !== activity.activity_id ||
    memberships[1]?.admission_id !== steer.admission_id ||
    memberships[1]?.ordinal !== 1 ||
    memberships[1]?.role !== "steer"
  ) {
    throw new Error(`${input.caseName} activity membership was not trigger plus steer in durable order`)
  }

  const progress = [...durability.activityProgress].sort((left, right) => left.revision - right.revision)
  if (
    progress.length < 2 ||
    progress.some((item, index) => item.activity_id !== activity.activity_id || item.revision !== index) ||
    progress.slice(0, -1).some((item) => item.state !== "progress") ||
    progress.at(-1)?.state !== "final"
  ) {
    throw new Error(`${input.caseName} activity progress was not contiguous progress-to-final`)
  }
  const receiptIDs = new Set(
    durability.requestReceipts
      .filter((receipt) => receipt.request_state === "dispatched")
      .map((receipt) => receipt.receipt_id),
  )
  if (progress.some((item) => !receiptIDs.has(item.provider_receipt_id))) {
    throw new Error(`${input.caseName} progress row lacked a dispatched provider receipt`)
  }
  const run = durability.legacyActivityRuns[0]
  const terminal = durability.legacyActivityTerminals[0]
  const final = progress.at(-1)
  if (
    durability.legacyActivityRuns.length !== 1 ||
    !run ||
    run.activity_id !== activity.activity_id ||
    run.owner_token !== activity.owner_token ||
    run.state !== "completed" ||
    run.terminal_reason !== "assistant_completed" ||
    durability.legacyActivityTerminals.length !== 1 ||
    !terminal ||
    terminal.activity_id !== activity.activity_id ||
    terminal.state !== "settled" ||
    terminal.reason_code !== "assistant_completed" ||
    terminal.source !== "provider_final" ||
    terminal.run_id !== run.run_id ||
    terminal.progress_revision !== final?.revision ||
    terminal.membership_ordinal !== final?.input_membership_ordinal ||
    terminal.owner_token !== activity.owner_token
  ) {
    throw new Error(`${input.caseName} lacked one matching run and terminal receipt`)
  }
  progress.forEach((item) => {
    const parts = durability.activityTextParts.filter((part) => part.message_id === item.assistant_message_id)
    parts.forEach((part) => {
      const marker = activityMarker(part.data)
      if (
        !marker ||
        marker.activity_id !== activity.activity_id ||
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
  return { activity, progress }
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
