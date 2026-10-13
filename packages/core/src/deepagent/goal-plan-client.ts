export * as GoalPlanClient from "./goal-plan-client"

import type { GoalPlanRebaseSchema } from "./goal-plan-rebase.schema"
import type { PlanDoc } from "./plan-controller"

// Browser-safe client observations. These values never grant execution or operator authority.
export type Response = GoalPlanRebaseSchema.Response
export type Command = GoalPlanRebaseSchema.Command
export type Candidate = GoalPlanRebaseSchema.Candidate
export type Begin = GoalPlanRebaseSchema.Begin
export type Target = GoalPlanRebaseSchema.Target
export type Scope = {
  server: string
  url: string
  directory: string
  workspace?: string
  operator: string
  sessionID: string
  goalID: string
}
export type Query = Pick<Target, "sessionID" | "goalID" | "editID" | "requestID">
export type Transport = {
  send(command: Command): Promise<unknown>
  get(query: Query, signal?: AbortSignal): Promise<unknown>
  /** Only the private local transport provides this ownership barrier. It is not
   * a server cancellation or business-success receipt. */
  whenSettled?(): Promise<void>
}
export type Client = {
  client: {
    request<T>(input: {
      method: string
      url: string
      body?: unknown
      headers?: Record<string, string>
      signal?: AbortSignal
      throwOnError?: boolean
    }): Promise<{ data?: T; error?: unknown; response?: { status: number } }>
  }
}
type Result = { data?: unknown; error?: unknown; response?: { status: number } }
type Mutable<T> = T extends readonly (infer A)[]
  ? Mutable<A>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T
type Options = { throwOnError: false; signal?: AbortSignal }
type Placement = { directory?: string; workspace?: string }
export type SDK = {
  deepagent: {
    goalStatus(input: { sessionID: string } & Placement, options: Options): Promise<Result>
    goalPlanRebaseBegin(input: Begin & Placement, options: Options): Promise<Result>
    goalPlanRebaseApply(input: Mutable<GoalPlanRebaseSchema.Apply> & Placement, options: Options): Promise<Result>
    goalPlanRebaseCancel(input: Target & Placement, options: Options): Promise<Result>
    goalPlanRebaseGet(input: Query & Placement, options: Options): Promise<Result>
    goalPlanRebaseReconcile(
      input: Omit<Target, "editID"> & { path_editID: string; body_editID: string } & Placement,
      options: Options,
    ): Promise<Result>
  }
}
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly unknownOutcome: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = "GoalPlanRequestError"
  }
}
export const maxRecords = 32
export const maxRecordBytes = 1_048_576
export const maxStoreBytes = 4_194_304
export type Draft = {
  version: 1
  id: string
  revision: number
  scope: Scope
  begin: Begin
  editID: string
  command?: Command
  response?: Response
  candidate?: Candidate
  reason?: string
  phase: "draft" | "sending" | "unknown" | "observed" | "rejected"
  updatedAt: number
}
export type Store = {
  list(scope: Scope): Promise<Draft[]>
  put(draft: Draft, expectedRevision?: number): Promise<Draft>
  discard(draft: Draft): Promise<void>
  close?(): void
}

export const scopeKey = (scope: Scope) =>
  canonical(Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== undefined)))
export const sameScope = (a: Scope, b: Scope) => scopeKey(a) === scopeKey(b)

/** Only a deterministic lookup address, never an authorization proof. Keep the complete
 * Begin request: the server hashes this exact command, including the original revision. */
export async function locator(begin: Begin) {
  requireBegin(begin)
  return `rebase_${await digest({ action: "begin", request: begin })}`
}

export async function create(scope: Scope, expectedControlRevision: number): Promise<Draft> {
  requireScope(scope)
  const begin = {
    sessionID: scope.sessionID,
    goalID: scope.goalID,
    expectedControlRevision,
    requestID: globalThis.crypto.randomUUID(),
  }
  return {
    version: 1,
    id: globalThis.crypto.randomUUID(),
    revision: 0,
    scope: structuredClone(scope),
    begin,
    editID: await locator(begin),
    phase: "draft",
    updatedAt: Date.now(),
  }
}

export function http(client: Client, placement: Pick<Scope, "directory" | "workspace">): Transport {
  async function call(method: string, suffix: string, body?: unknown, signal?: AbortSignal) {
    const url = new URL(`/deepagent/goal/plan-rebase${suffix}`, "http://client.invalid")
    url.searchParams.set("directory", placement.directory)
    if (placement.workspace) url.searchParams.set("workspace", placement.workspace)
    const result = await client.client
      .request<unknown>({
        method,
        url: `${url.pathname}${url.search}`,
        body,
        headers: { "Content-Type": "application/json" },
        signal,
        throwOnError: false,
      })
      .catch(() => {
        throw new RequestError("CONNECTION_UNKNOWN", "Plan edit response is unavailable", method !== "GET")
      })
    if (result.error !== undefined || (result.response && result.response.status >= 400)) {
      const status = result.response?.status
      const error = object(result.error) ? result.error : {}
      throw new RequestError(
        typeof error.code === "string" ? error.code : "REQUEST_FAILED",
        typeof error.message === "string" ? error.message : "Plan edit request was rejected",
        method !== "GET" && (status === undefined || status >= 500),
        status,
      )
    }
    return result.data
  }
  return {
    send: (command) => {
      requireCommand(command)
      return call(
        "POST",
        command.action === "reconcile"
          ? `/${encodeURIComponent(command.request.editID)}/reconcile`
          : `/${command.action}`,
        command.request,
      )
    },
    get: (query, signal) => {
      const params = new URLSearchParams({
        sessionID: query.sessionID,
        goalID: query.goalID,
        requestID: query.requestID,
      })
      return call("GET", `/${encodeURIComponent(query.editID)}?${params}`, undefined, signal)
    },
  }
}

/** Production UI uses the generated SDK's five public methods. No protected raw
 * SDK property or wider hand-written nullable payload is needed. */
export function sdk(
  client: SDK,
  placement: Placement,
): Transport & { goal(sessionID: string): Promise<{ goalId: string; revision: number } | null> } {
  const options = { throwOnError: false } as const
  const call = (operation: Promise<Result>, mutation: boolean) =>
    operation
      .then((result) => {
        if (result.error !== undefined || (result.response && result.response.status >= 400)) {
          const error = object(result.error) ? result.error : {}
          const status = result.response?.status
          throw new RequestError(
            typeof error.code === "string" ? error.code : "REQUEST_FAILED",
            typeof error.message === "string" ? error.message : "Plan edit request failed",
            mutation && (status === undefined || status >= 500),
            status,
          )
        }
        return result.data
      })
      .catch((error: unknown) => {
        if (error instanceof RequestError) throw error
        throw new RequestError("CONNECTION_UNKNOWN", "Plan edit response is unavailable", mutation)
      })
  return {
    async goal(sessionID) {
      const result = await call(client.deepagent.goalStatus({ sessionID, ...placement }, options), false)
      if (!object(result)) invalid("Invalid Goal status")
      if (result.goal === null) return null
      if (!object(result.goal) || !text(result.goal.goalId, 512) || !count(result.goal.revision))
        invalid("Invalid Goal target")
      return { goalId: result.goal.goalId, revision: result.goal.revision }
    },
    get: (query, signal) =>
      call(client.deepagent.goalPlanRebaseGet({ ...query, ...placement }, { ...options, signal }), false),
    send(command) {
      requireCommand(command)
      if (command.action === "begin")
        return call(client.deepagent.goalPlanRebaseBegin({ ...command.request, ...placement }, options), true)
      if (command.action === "cancel")
        return call(client.deepagent.goalPlanRebaseCancel({ ...command.request, ...placement }, options), true)
      if (command.action === "reconcile")
        return call(
          client.deepagent.goalPlanRebaseReconcile(
            {
              ...command.request,
              ...placement,
              path_editID: command.request.editID,
              body_editID: command.request.editID,
            },
            options,
          ),
          true,
        )
      return call(
        client.deepagent.goalPlanRebaseApply(
          {
            ...command.request,
            ...placement,
            candidate: {
              ...command.request.candidate,
              steps: command.request.candidate.steps.map((step) => ({
                ...step,
                evidence: step.evidence ? [...step.evidence] : undefined,
              })),
              dispositions: command.request.candidate.dispositions.map((entry) => ({ ...entry })),
            },
          },
          options,
        ),
        true,
      )
    },
  }
}

export function query(draft: Draft): Query {
  return {
    sessionID: draft.scope.sessionID,
    goalID: draft.scope.goalID,
    editID: draft.editID,
    requestID: draft.command?.request.requestID ?? draft.begin.requestID,
  }
}

/** Persist the exact command before dispatch. A timeout, unmount, or dropped ACK is not a cancellation. */
export async function send(store: Store, transport: Transport, draft: Draft, command: Command) {
  requireCommand(command)
  if (
    command.request.sessionID !== draft.scope.sessionID ||
    command.request.goalID !== draft.scope.goalID ||
    (command.action !== "begin" && command.request.editID !== draft.editID)
  )
    invalid("Command scope changed")
  const pending = await store.put(
    {
      ...draft,
      revision: draft.revision + 1,
      command: structuredClone(command),
      phase: "sending",
      updatedAt: Date.now(),
    },
    draft.revision,
  )
  try {
    const response = decode(await transport.send(command))
    await requireResponseTarget(pending, response)
    const observed = {
      ...pending,
      revision: pending.revision + 1,
      response,
      phase: "observed" as const,
      updatedAt: Date.now(),
    }
    await store.put(observed, pending.revision)
    return observed
  } catch (error) {
    // Even a typed rejection can follow an earlier lost ACK for this immutable request.
    // Retain its identity; deciding to edit or retry always follows an explicit user action.
    await store.put(
      {
        ...pending,
        revision: pending.revision + 1,
        phase:
          error instanceof RequestError && error.code === "CLIENT_SCOPE_CHANGED"
            ? "draft"
            : error instanceof RequestError && !error.unknownOutcome && error.code !== "INVALID_CLIENT_CONTRACT"
              ? "rejected"
              : "unknown",
        updatedAt: Date.now(),
      },
      pending.revision,
    )
    throw error
  }
}

export async function refresh(store: Store, transport: Transport, draft: Draft, signal?: AbortSignal) {
  const response = decode(await transport.get(query(draft), signal))
  await requireResponseTarget(draft, response)
  if (draft.response && response.current.revision < draft.response.current.revision) return draft
  const next = {
    ...draft,
    revision: draft.revision + 1,
    response,
    phase: response.originalReceipt
      ? ("observed" as const)
      : draft.phase === "rejected"
        ? ("rejected" as const)
        : ("unknown" as const),
    updatedAt: Date.now(),
  }
  await store.put(next, draft.revision)
  return next
}

export function target(draft: Draft): Target {
  if (!draft.response) invalid("Read the current plan edit before controlling it")
  return {
    ...query(draft),
    requestID: globalThis.crypto.randomUUID(),
    expectedEditRevision: draft.response.current.revision,
    expectedControlRevision: draft.response.current.controlRevision,
  }
}

export function apply(draft: Draft): Command {
  const source = draft.response?.current.editSource
  if (!source || draft.response?.current.state !== "ready" || !draft.candidate || !draft.reason?.trim())
    invalid("The plan edit is not ready to apply")
  validateCandidate(plan(draft.response), draft.candidate, source.attemptedStepIDs)
  return {
    action: "apply",
    request: {
      ...target(draft),
      expectedPlanRevision: draft.response.current.planRevision,
      expectedDocVersion: source.planDocument.version,
      expectedDocHash: source.planDocHash,
      candidate: structuredClone(draft.candidate),
      reason: draft.reason,
    },
  }
}

export function plan(response: Response): PlanDoc {
  const source = response.current.editSource
  if (!source) invalid("The running step has not reached an editable boundary")
  const parsed: unknown = JSON.parse(source.planDocument.body)
  if (
    !object(parsed) ||
    !text(parsed.plan_id) ||
    !text(parsed.session_id) ||
    !text(parsed.goal) ||
    !text(parsed.created_at) ||
    !Array.isArray(parsed.assumptions) ||
    !parsed.assumptions.every((x) => typeof x === "string") ||
    !Array.isArray(parsed.steps) ||
    !parsed.steps.length ||
    parsed.steps.length > 128 ||
    !parsed.steps.every(step) ||
    !(parsed.active_step_id === null || text(parsed.active_step_id)) ||
    new Set(parsed.steps.map((x) => x.step_id)).size !== parsed.steps.length
  )
    invalid("Plan document is invalid")
  return parsed as PlanDoc
}

export function candidate(response: Response): Candidate {
  const source = plan(response)
  return { steps: structuredClone(source.steps), activeStepID: source.active_step_id, dispositions: [] }
}

export function validateCandidate(source: PlanDoc, value: Candidate, attempted: readonly string[]) {
  if (!isCandidate(value)) invalid("Plan candidate is invalid")
  for (const previous of source.steps) {
    const next = value.steps.find((entry) => entry.step_id === previous.step_id)
    if (previous.status === "done" && (!next || canonical(previous) !== canonical(next)))
      invalid("Completed steps are immutable")
    if (attempted.includes(previous.step_id) && !next) invalid("Attempted steps cannot be removed")
    if (!next) continue
    if (
      canonical(previous.evidence ?? []) !== canonical(next.evidence ?? []) ||
      previous.assigned_agent !== next.assigned_agent
    )
      invalid("Evidence and assigned agents are immutable")
    if (previous.status === "pending" && !attempted.includes(previous.step_id) && next.status !== "pending")
      invalid("Unattempted steps cannot be advanced")
    if (previous.status !== "done" && next.status === "done") invalid("Plan editing cannot fabricate completion")
    if (
      attempted.includes(previous.step_id) &&
      canonical(previous) !== canonical(next) &&
      !value.dispositions.some((entry) => entry.stepID === previous.step_id && entry.reason.trim())
    )
      invalid("A disposition reason is required")
  }
  for (const next of value.steps)
    if (
      !source.steps.some((entry) => entry.step_id === next.step_id) &&
      (attempted.includes(next.step_id) ||
        next.status !== "pending" ||
        next.evidence?.length ||
        next.assigned_agent != null)
    )
      invalid("New steps must be pending without invented evidence or roles")
  if (value.dispositions.some((entry) => !attempted.includes(entry.stepID)))
    invalid("Disposition must refer to an attempted step")
}

export function decode(value: unknown): Response {
  if (
    !object(value) ||
    !keys(value, ["version", "originalReceipt", "current", "replayed"]) ||
    value.version !== 1 ||
    typeof value.replayed !== "boolean" ||
    !object(value.current)
  )
    invalid("Invalid plan edit response")
  const current = value.current
  if (
    !keys(current, [
      "editID",
      "revision",
      "state",
      "controlRevision",
      "planRevision",
      "confirmedDocuments",
      "totalDocuments",
      "partial",
      "safeToResume",
      "execution",
      "retry",
      "editSource",
    ]) ||
    !ref(current.editID) ||
    !count(current.revision) ||
    !count(current.controlRevision) ||
    !count(current.planRevision) ||
    !state(current.state) ||
    !count(current.confirmedDocuments) ||
    !count(current.totalDocuments) ||
    current.confirmedDocuments > current.totalDocuments ||
    current.totalDocuments > 8 ||
    typeof current.partial !== "boolean" ||
    typeof current.safeToResume !== "boolean" ||
    !["waiting_boundary", "blocked", "terminal", "paused", "running"].includes(String(current.execution)) ||
    !["same_request", "refresh", "reconcile", "none"].includes(String(current.retry))
  )
    invalid("Invalid current plan edit")
  if (current.editSource !== null) {
    const source = current.editSource
    if (
      !object(source) ||
      !keys(source, ["planDocument", "planDocHash", "sourceReceiptHash", "baselineDocsHash", "attemptedStepIDs"]) ||
      !hash(source.planDocHash) ||
      !hash(source.sourceReceiptHash) ||
      !hash(source.baselineDocsHash) ||
      !Array.isArray(source.attemptedStepIDs) ||
      source.attemptedStepIDs.length > 4096 ||
      !source.attemptedStepIDs.every((x) => text(x, 128)) ||
      !document(source.planDocument)
    )
      invalid("Invalid plan edit source")
  }
  if (value.originalReceipt !== null) {
    const receipt = value.originalReceipt
    if (
      !object(receipt) ||
      !keys(receipt, [
        "version",
        "requestID",
        "requestHash",
        "action",
        "editID",
        "goalID",
        "sessionID",
        "revision",
        "state",
        "sourcePlanRevision",
        "sourceControlRevision",
        "targetPlanRevision",
        "controlRevision",
        "sourceReceiptHash",
        "candidateHash",
        "committedReceiptHash",
        "planDocID",
        "planDocVersion",
        "planDocHash",
        "nextSeq",
        "confirmedDocuments",
        "totalDocuments",
        "projections",
        "partial",
        "execution",
        "recordedAt",
      ]) ||
      receipt.version !== 1 ||
      !ref(receipt.requestID) ||
      !hash(receipt.requestHash) ||
      !ref(receipt.editID) ||
      !text(receipt.goalID, 512) ||
      !text(receipt.sessionID, 512) ||
      !state(receipt.state) ||
      !["begin", "apply", "cancel", "reconcile"].includes(String(receipt.action)) ||
      ![
        "revision",
        "sourcePlanRevision",
        "sourceControlRevision",
        "targetPlanRevision",
        "controlRevision",
        "planDocVersion",
        "nextSeq",
        "confirmedDocuments",
        "totalDocuments",
        "recordedAt",
      ].every((key) => count(receipt[key])) ||
      !["sourceReceiptHash", "candidateHash", "committedReceiptHash", "planDocHash"].every(
        (key) => receipt[key] === null || hash(receipt[key]),
      ) ||
      !ref(receipt.planDocID) ||
      typeof receipt.partial !== "boolean" ||
      !["waiting_boundary", "paused", "blocked", "terminal"].includes(String(receipt.execution)) ||
      !Array.isArray(receipt.projections) ||
      receipt.projections.length > 8 ||
      !receipt.projections.every(
        (entry) =>
          object(entry) &&
          keys(entry, ["documentID", "state", "version", "hash"]) &&
          ref(entry.documentID) &&
          ["pending", "confirmed"].includes(String(entry.state)) &&
          (entry.version === null || count(entry.version)) &&
          (entry.hash === null || hash(entry.hash)),
      )
    )
      invalid("Invalid historical plan receipt")
  }
  if (bytes(value) > maxRecordBytes) invalid("Plan edit response exceeds client storage capacity")
  return value as Response
}

export function records(value: unknown): Draft[] {
  if (!Array.isArray(value) || value.length > maxRecords || bytes(value) > maxStoreBytes)
    invalid("Plan edit store capacity exceeded")
  for (const entry of value) {
    if (
      !object(entry) ||
      !keys(entry, [
        "version",
        "id",
        "revision",
        "scope",
        "begin",
        "editID",
        "command",
        "response",
        "candidate",
        "reason",
        "phase",
        "updatedAt",
      ]) ||
      entry.version !== 1 ||
      !ref(entry.id) ||
      !count(entry.revision) ||
      !ref(entry.editID) ||
      !count(entry.updatedAt) ||
      !["draft", "sending", "unknown", "observed", "rejected"].includes(String(entry.phase)) ||
      bytes(entry) > maxRecordBytes
    )
      invalid("Plan edit store record is invalid")
    requireScope(entry.scope)
    requireBegin(entry.begin)
    if (entry.begin.sessionID !== entry.scope.sessionID || entry.begin.goalID !== entry.scope.goalID)
      invalid("Plan edit store scope changed")
    if (entry.command !== undefined) {
      requireCommand(entry.command)
      if (
        entry.command.request.sessionID !== entry.scope.sessionID ||
        entry.command.request.goalID !== entry.scope.goalID ||
        (entry.command.action === "begin"
          ? canonical(entry.command.request) !== canonical(entry.begin)
          : entry.command.request.editID !== entry.editID)
      )
        invalid("Stored command scope changed")
    }
    if (entry.response !== undefined && decode(entry.response).current.editID !== entry.editID)
      invalid("Stored response scope changed")
    if (entry.candidate !== undefined && !isDraftCandidate(entry.candidate)) invalid("Invalid stored plan candidate")
    if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length > 4096))
      invalid("Invalid stored reason")
  }
  if (new Set(value.map((x) => x.id)).size !== value.length) invalid("Duplicate plan edit store identity")
  return value as Draft[]
}

export function upsert(values: Draft[], value: Draft, expectedRevision?: number) {
  records([value])
  const previous = values.find((entry) => entry.id === value.id)
  if (
    previous
      ? expectedRevision !== previous.revision ||
        value.revision !== previous.revision + 1 ||
        !sameScope(previous.scope, value.scope) ||
        canonical(previous.begin) !== canonical(value.begin) ||
        previous.editID !== value.editID
      : expectedRevision !== undefined || value.revision !== 0
  )
    throw new RequestError("DRAFT_CONFLICT", "Another client changed this plan edit draft", false)
  return records([...values.filter((entry) => entry.id !== value.id), value])
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (!object(value)) invalid("Only JSON can identify a plan edit")
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`
}

async function requireResponseTarget(draft: Draft, response: Response) {
  const receipt = response.originalReceipt
  if (
    response.current.editID !== draft.editID ||
    (receipt &&
      (receipt.editID !== draft.editID ||
        receipt.goalID !== draft.scope.goalID ||
        receipt.sessionID !== draft.scope.sessionID ||
        receipt.requestID !== query(draft).requestID))
  )
    invalid("Response belongs to another plan edit")
  const command = draft.command ?? { action: "begin", request: draft.begin }
  if (receipt && (receipt.action !== command.action || receipt.requestHash !== (await digest(command))))
    invalid("Historical receipt does not match the exact command")
}
function requireScope(value: unknown): asserts value is Scope {
  if (
    !object(value) ||
    !keys(value, ["server", "url", "directory", "workspace", "operator", "sessionID", "goalID"]) ||
    !["server", "url", "directory", "operator", "sessionID", "goalID"].every((key) => text(value[key], 4096)) ||
    (value.workspace !== undefined && !identity(value.workspace)) ||
    !identity(value.sessionID) ||
    !identity(value.goalID) ||
    !identity(value.operator)
  )
    invalid("Plan edit scope is incomplete")
  if (typeof value.url !== "string" || !URL.canParse(value.url)) invalid("Plan edit server URL is invalid")
  const url = new URL(value.url)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    invalid("Plan edit scope cannot persist URL credentials or query secrets")
}
function requireBegin(value: unknown): asserts value is Begin {
  if (
    !object(value) ||
    !keys(value, ["sessionID", "goalID", "expectedControlRevision", "requestID"]) ||
    !identity(value.sessionID) ||
    !identity(value.goalID) ||
    !count(value.expectedControlRevision) ||
    !ref(value.requestID)
  )
    invalid("Plan edit begin identity is invalid")
}
function requireCommand(value: unknown): asserts value is Command {
  if (!object(value) || !keys(value, ["action", "request"]) || !object(value.request))
    invalid("Plan edit command is invalid")
  if (value.action === "begin") return requireBegin(value.request)
  const request = value.request
  if (
    !keys(request, [
      "sessionID",
      "goalID",
      "editID",
      "requestID",
      "expectedEditRevision",
      "expectedControlRevision",
      ...(value.action === "apply"
        ? ["expectedPlanRevision", "expectedDocVersion", "expectedDocHash", "candidate", "reason"]
        : []),
    ])
  )
    invalid("Unexpected plan command field")
  if (
    !["apply", "cancel", "reconcile"].includes(String(value.action)) ||
    !ref(request.editID) ||
    !ref(request.requestID) ||
    !identity(request.sessionID) ||
    !identity(request.goalID) ||
    !count(request.expectedEditRevision) ||
    !count(request.expectedControlRevision)
  )
    invalid("Plan edit command target is invalid")
  if (
    value.action === "apply" &&
    (!count(request.expectedPlanRevision) ||
      !count(request.expectedDocVersion) ||
      !hash(request.expectedDocHash) ||
      !text(request.reason) ||
      !isCandidate(request.candidate))
  )
    invalid("Plan edit candidate identity is invalid")
}
function isDraftCandidate(value: unknown) {
  if (!object(value) || !Array.isArray(value.steps)) return false
  return isCandidate({
    ...value,
    steps: value.steps.map((entry) =>
      object(entry)
        ? {
            ...entry,
            title: entry.title === "" ? " " : entry.title,
            acceptance: entry.acceptance === "" ? null : entry.acceptance,
            note: entry.note === "" ? null : entry.note,
          }
        : entry,
    ),
    dispositions: Array.isArray(value.dispositions)
      ? value.dispositions.map((entry) =>
          object(entry) ? { ...entry, reason: entry.reason === "" ? " " : entry.reason } : entry,
        )
      : value.dispositions,
  })
}
function isCandidate(value: unknown): value is Candidate {
  return (
    object(value) &&
    keys(value, ["steps", "activeStepID", "dispositions"]) &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.length <= 128 &&
    value.steps.every(step) &&
    new Set(value.steps.map((x) => x.step_id)).size === value.steps.length &&
    (value.activeStepID === null ||
      (text(value.activeStepID, 128) &&
        value.steps.some((x) => x.step_id === value.activeStepID && x.status === "active"))) &&
    Array.isArray(value.dispositions) &&
    value.dispositions.length <= 128 &&
    value.dispositions.every(
      (x) => object(x) && keys(x, ["stepID", "reason"]) && text(x.stepID, 128) && text(x.reason),
    ) &&
    new Set(value.dispositions.map((x) => x.stepID)).size === value.dispositions.length
  )
}
function step(value: unknown): value is Candidate["steps"][number] {
  return (
    object(value) &&
    keys(value, ["step_id", "title", "status", "acceptance", "assigned_agent", "evidence", "note"]) &&
    text(value.step_id, 128) &&
    text(value.title) &&
    ["pending", "active", "done", "cancelled", "blocked"].includes(String(value.status)) &&
    ["acceptance", "assigned_agent", "note"].every(
      (key) =>
        value[key] === undefined || value[key] === null || text(value[key], key === "assigned_agent" ? 128 : 4096),
    ) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) && value.evidence.length <= 64 && value.evidence.every((x) => text(x))))
  )
}
function document(value: unknown) {
  return (
    object(value) &&
    ref(value.id) &&
    value.type === "plan" &&
    text(value.scope, 512) &&
    text(value.status, 128) &&
    count(value.version) &&
    (value.superseded_by === null || ref(value.superseded_by)) &&
    (value.created_round === null || count(value.created_round)) &&
    (value.domain === null || ref(value.domain)) &&
    Array.isArray(value.tags) &&
    value.tags.every((x) => typeof x === "string") &&
    typeof value.description === "string" &&
    object(value.provenance) &&
    Array.isArray(value.links) &&
    typeof value.body === "string"
  )
}
async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(canonical(value))
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("")
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 512
}
function state(value: unknown) {
  return [
    "waiting_boundary",
    "ready",
    "prepared",
    "mirror_pending",
    "committed",
    "cancelled",
    "superseded",
    "recovery_required",
  ].includes(String(value))
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown, limit = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit
}
function ref(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:~-]{1,128}$/.test(value)
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
function invalid(message: string): never {
  throw new RequestError("INVALID_CLIENT_CONTRACT", message, false)
}
