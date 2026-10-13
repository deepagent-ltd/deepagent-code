export * as GoalClient from "./goal-client"

import type { GoalControlSchema } from "./goal-control.schema"

export type Snapshot = GoalControlSchema.Snapshot
export type Action = GoalControlSchema.Action
export type ControlInput = GoalControlSchema.ControlInput
export type StartInput = {
  sessionID: string
  requestID: string
  objective?: string
  criteria?: { kind: string; commands?: string[]; maxSeverity?: string; severityAtMost?: string }[]
  limits?: { maxTicks?: number; maxTokens?: number; maxWallclockMs?: number; maxCost?: number }
  stallThreshold?: number
}
export type Client = {
  client: {
    request<T>(options: {
      method: string
      url: string
      body?: unknown
      headers?: Record<string, string>
      throwOnError?: boolean
    }): Promise<{ data?: T; error?: unknown; response?: { status: number } }>
  }
}
export type Scope = { server: string; directory: string; sessionID: string }
export type Descriptor = {
  readonly client: Client
  readonly scope: Readonly<Scope>
  readonly action: Action | "start"
  readonly body: Readonly<ControlInput | StartInput>
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | undefined,
    readonly unknownOutcome: boolean,
  ) {
    super(message)
    this.name = "GoalRequestError"
  }
}

/** Capture the actual client and placement once. Retrying this descriptor never reads a newer
 * Goal, revision, server, directory or composer payload. No automatic retry is performed here. */
export function capture(
  client: Client,
  scope: Scope,
  action: Action | "start",
  body: ControlInput | StartInput,
): Descriptor {
  if (
    scope.sessionID !== body.sessionID ||
    !body.requestID ||
    (action !== "start" &&
      (!("goalId" in body) ||
        !body.goalId ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 1))
  )
    throw new RequestError("Goal request target is incomplete", "invalid_request", 400, false)
  return Object.freeze({
    client,
    scope: Object.freeze({ ...scope }),
    action,
    body: Object.freeze(structuredClone(body)),
  })
}

export const scopeKey = (scope: Scope) => JSON.stringify([scope.server, scope.directory, scope.sessionID])

export async function send(request: Descriptor): Promise<Snapshot> {
  return mutate(request.client, request.action, request.body)
}

export const start = (client: Client, input: StartInput) => mutate(client, "start", input)
export const control = (client: Client, action: Action, input: ControlInput) => mutate(client, action, input)

async function mutate(client: Client, action: Action | "start", body: ControlInput | StartInput) {
  const snapshot = decodeSnapshot(
    await call<unknown>(client, {
      method: "POST",
      url: `/deepagent/goal/${action}`,
      body,
      headers: { "Content-Type": "application/json" },
    }),
  )
  if ("goalId" in body && snapshot.goalId !== body.goalId)
    throw new RequestError("Goal acknowledgement belongs to a different target", "target_mismatch", undefined, true)
  return snapshot
}

export function status(client: Client, sessionID: string): Promise<Snapshot | null> {
  return call<{ goal?: unknown }>(client, {
    method: "GET",
    url: `/deepagent/goal/status?sessionID=${encodeURIComponent(sessionID)}`,
  })
    .then((data) => (data?.goal === null ? null : decodeSnapshot(data?.goal)))
    .catch((error: unknown) => {
      const result = failure(error)
      // Read failures have no mutation to reconcile. They must not offer a nonexistent write retry.
      throw new RequestError(result.message, result.code, result.status, false)
    })
}

export function canControl(goal: Snapshot | undefined | null, action: Action) {
  if (!goal || goal.revision < 1 || goal.preparation !== "ready" || goal.recoveryRequired) return false
  if (action === "resume") return goal.requestedPhase === "paused" && !goal.inFlight && goal.wakeState !== "pending"
  if (action === "pause") return goal.requestedPhase === "running"
  return goal.requestedPhase === "running" || goal.requestedPhase === "paused"
}

export function confirmedTerminal(goal: Snapshot) {
  return (
    !goal.inFlight &&
    !goal.recoveryRequired &&
    goal.preparation === "ready" &&
    ["done", "needs_human", "rolled_back", "stopped"].includes(goal.phase)
  )
}

/** Equal revisions can acquire new in-flight/lease observations. Request epochs still decide
 * which read is current; revision ordering alone cannot order different Goal identities. */
export function accepts(current: Snapshot | undefined, incoming: Snapshot) {
  return !current || current.goalId !== incoming.goalId || incoming.revision >= current.revision
}

async function call<T>(client: Client, options: Parameters<Client["client"]["request"]>[0]): Promise<T | undefined> {
  const result = await client.client.request<T>({ ...options, throwOnError: false }).catch((error: unknown) => {
    throw failure(error)
  })
  if (result.error !== undefined || (result.response && result.response.status >= 400))
    throw failure(result.error, result.response?.status)
  return result.data
}

function failure(value: unknown, status?: number): RequestError {
  if (value instanceof RequestError) return value
  const body =
    value && typeof value === "object"
      ? (value as { code?: unknown; message?: unknown; data?: { message?: unknown } })
      : undefined
  const code = typeof body?.code === "string" ? body.code : "request_failed"
  const message =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.data?.message === "string"
        ? body.data.message
        : typeof value === "string"
          ? value
          : "Goal request outcome could not be confirmed"
  // A 503 may be emitted after durable admission. Only an explicit client rejection proves that
  // no mutation was accepted; transport/5xx uncertainty must retain the exact request identity.
  const rejected =
    status !== undefined
      ? status >= 400 && status < 500
      : [
          "invalid_request",
          "not_found",
          "target_conflict",
          "revision_conflict",
          "request_conflict",
          "busy",
          "unsupported",
          "recovery_required",
        ].includes(code)
  return new RequestError(message, code, status, !rejected)
}

function decodeSnapshot(value: unknown): Snapshot {
  const goal = value && typeof value === "object" ? (value as Partial<Snapshot>) : undefined
  if (
    !goal ||
    typeof goal.goalId !== "string" ||
    typeof goal.planDocId !== "string" ||
    typeof goal.phase !== "string" ||
    typeof goal.running !== "boolean" ||
    !Number.isSafeInteger(goal.revision) ||
    goal.revision! < 0 ||
    !["running", "paused", "stopped", "done", "needs_human", "rolled_back"].includes(goal.requestedPhase ?? "") ||
    !["preparing", "ready", "recovery_required"].includes(goal.preparation ?? "") ||
    typeof goal.inFlight !== "boolean" ||
    typeof goal.recoveryRequired !== "boolean" ||
    !["none", "pending", "published", "superseded"].includes(goal.wakeState ?? "") ||
    typeof goal.replayed !== "boolean"
  )
    throw new RequestError(
      "Goal status is unavailable or uses an unsupported control contract",
      "unsupported_snapshot",
      undefined,
      true,
    )
  return goal as Snapshot
}
