export * as SharedBrowserTool from "./browser-shared"

import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { BrowserHost } from "../browser/host"
import { BrowserSchema } from "../browser/schema"
import { BrowserControl } from "../browser/control"
import type { BrowserFileCapability } from "../browser/file-capability"
import { SharedBrowserSchema } from "../browser/shared-schema"
import { SharedBrowserScriptPolicy } from "../browser/shared-script-policy"
import { SharedBrowserPolicy } from "../browser/shared-policy"
import { SharedBrowserControl } from "../browser/shared-control"
import type { Location } from "../location"
import { PermissionV2 } from "../permission"
import { CurrentToolExecution } from "../session/runner/current-tool-execution"
import type { Tool } from "./tool"

export const Output = Schema.Struct({
  shared: SharedBrowserSchema.Status,
  actionID: Schema.optional(BrowserSchema.ID),
  result: Schema.optional(BrowserSchema.Result),
  png: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

type Services = {
  db: Database.Interface["db"]
  host: BrowserHost.Interface
  location: Location.Interface
  permission: PermissionV2.Interface
  files?: Pick<BrowserFileCapability.Interface, "shared">
}

/** Additional operations on the original canonical browser tool. No HTTP body or model
 * message ID can supply the CurrentToolExecution witness used to reacquire this resource. */
export const execute = Effect.fn("SharedBrowserTool.execute")(function* (
  services: Services,
  input: SharedBrowserSchema.Invoke,
  context: Tool.Context,
) {
  const host = services.host.shared
  const permission = services.permission
  if (!services.host.alive() || !host || !permission.authorizeAction || !permission.checkAction)
    return yield* BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")
  yield* CurrentToolExecution.requireCurrent(services.db, context, services.location, input)
  const resource = yield* SharedBrowserControl.get(services.db, input.resourceID)
  if (!resource) return yield* BrowserControl.failure("BROWSER_NOT_FOUND")
  if (
    resource.scope.principal !== services.host.principal ||
    resource.rootSessionID !== context.sessionID ||
    resource.scope.directory !== services.location.directory ||
    services.location.workspaceID !== undefined ||
    resource.mainIncarnation !== host.mainIncarnation
  )
    return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
  yield* BrowserControl.requireScope(services.db, resource.scope, services.location)
  if (input.operation === "status") {
    const observed = yield* host.status(resource.resourceID)
    if (
      observed.mainIncarnation !== resource.mainIncarnation ||
      observed.resourceID !== resource.resourceID ||
      observed.manualEpoch !== resource.manualEpoch ||
      observed.barrierOrder !== resource.barrierOrder
    )
      return yield* BrowserControl.failure("BROWSER_STALE_TARGET")
    return { shared: SharedBrowserControl.status(resource) } satisfies Output
  }
  // Manual ownership is already a denial, not a new approval request. The full
  // lease/current checks still run again after any later permission wait.
  if (input.operation === "execute" && (resource.state !== "agent_owned" || resource.agentAccessFenced || resource.manualEnabled))
    return yield* BrowserControl.failure("BROWSER_CANCELLED")
  // These leaves need their independent native capability bridge. A shared policy record
  // alone cannot grant old file-custody, API, clipboard or private-script authority.
  if (
    input.operation === "execute" &&
    (input.command.type.startsWith("clipboard.") ||
      input.command.type === "api.post")
  )
    return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
  if (input.operation === "execute" && input.command.type === "evaluate" &&
    !SharedBrowserScriptPolicy.allowsScript(resource.policy, input.command))
    return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
  if (input.operation === "execute" && input.command.type === "program" &&
    !SharedBrowserScriptPolicy.allowsProgram(resource.policy, input.command))
    return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
  const fileOperation = input.operation === "execute" && (input.command.type === "file.upload" || input.command.type === "file.download")
  if (input.operation === "execute" && (fileOperation || input.command.type === "files.list")) {
    if (!services.files?.shared || !host.files) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
    if (!resource.policy.filePolicy || (input.command.type === "file.upload" && !resource.policy.filePolicy.upload) ||
      (input.command.type === "file.download" && !resource.policy.filePolicy.download)) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
    if (fileOperation) {
      const active = yield* SharedBrowserControl.requireActive(services.db, resource.resourceID, resource.scope)
      if (!host.files.ready || !(yield* host.files.ready(active.resource, active.lease).pipe(
        Effect.mapError(() => BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE"))))) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
    }
  }
  const request: PermissionV2.AssertInput = {
    sessionID: context.sessionID,
    agent: context.agent,
    action: "browser",
    resources: [`${resource.resourceID}/${input.operation}/${SharedBrowserControl.hash(input)}`],
    metadata: {
      operation: input.operation,
      resourceID: resource.resourceID,
      manualEpoch: resource.manualEpoch,
      ...(input.operation === "execute" ? { command: input.command.type } : {}),
    },
    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
  }
  const permit = yield* permission.authorizeAction(request)
  const policy = input.operation === "acquire" && input.approvedOrigins
    ? SharedBrowserPolicy.agent(resource.policy, input.approvedOrigins) : resource.policy
  if (!policy) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
  const policyRequest: PermissionV2.AssertInput | undefined = !SharedBrowserPolicy.same(policy, resource.policy)
    ? { ...request, resources: [`${resource.resourceID}/origins/${resource.policyHash}/${SharedBrowserControl.hash(policy)}`],
      metadata: { ...request.metadata, operation: "expand-origins", approvedOrigins: policy.approvedOrigins,
        previousOrigins: resource.policy.approvedOrigins, policyHash: SharedBrowserControl.hash(policy) } } : undefined
  const policyPermit = policyRequest ? yield* permission.authorizeAction(policyRequest) : undefined
  const scriptRequest: PermissionV2.AssertInput | undefined = input.operation === "execute" && input.command.type === "evaluate"
    ? { ...request, action: "browser-script", metadata: { ...request.metadata, scriptContext: "snapshot-json-v1",
      scriptHash: input.command.scriptHash } } : undefined
  const scriptPermit = scriptRequest ? yield* permission.authorizeAction(scriptRequest) : undefined
  const programRequest: PermissionV2.AssertInput | undefined = input.operation === "execute" && input.command.type === "program"
    ? { ...request, action: "browser-program", metadata: { ...request.metadata, scriptContext: "snapshot-json-v1",
      scriptHash: input.command.scriptHash } } : undefined
  const programPermit = programRequest ? yield* permission.authorizeAction(programRequest) : undefined
  const fileRequest: PermissionV2.AssertInput | undefined = fileOperation ? { ...request, action: "browser-file" } : undefined
  const filePermit = fileRequest ? yield* permission.authorizeAction(fileRequest) : undefined
  const current = (reader: Pick<Database.Interface["db"], "select">) =>
    Effect.gen(function* () {
      if (!services.host.alive()) return yield* BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")
      yield* permission.checkAction!(permit, request).pipe(
        Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")),
      )
      if (policyRequest && policyPermit) yield* permission.checkAction!(policyPermit, policyRequest).pipe(
        Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")),
      )
      if (scriptRequest && scriptPermit) yield* permission.checkAction!(scriptPermit, scriptRequest).pipe(
        Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")),
      )
      if (programRequest && programPermit) yield* permission.checkAction!(programPermit, programRequest).pipe(
        Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")),
      )
      if (fileRequest && filePermit) yield* permission.checkAction!(filePermit, fileRequest).pipe(
        Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")),
      )
      yield* CurrentToolExecution.requireCurrent(reader, context, services.location, input, resource.scope)
      yield* BrowserControl.requireScope(reader, resource.scope, services.location)
    })
  yield* current(services.db)
  if (input.operation === "acquire") {
    const witness = yield* CurrentToolExecution.sharedWitness(services.db, context, services.location, input)
    const pending = yield* SharedBrowserControl.prepareAcquire(
      services.db,
      { request: input, scope: resource.scope, sidecarIncarnation: services.host.hostIncarnation, witness,
        ...(policyRequest ? { policy: { expectedHash: resource.policyHash, approvedOrigins: policy.approvedOrigins } } : {}) },
      current,
    )
    // An exact retry can read the original result, but cannot redispatch an acknowledged,
    // unknown or retired lease. New user input is required for a fresh acquisition attempt.
    if (!pending.created) return { shared: SharedBrowserControl.status(pending.resource) } satisfies Output
    const observed = yield* host
      .acquire(pending.resource, pending.lease, witness)
      .pipe(Effect.catch(() => Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN"))))
    const acquired = yield* SharedBrowserControl.observeAcquire(services.db, pending.resource, pending.lease, observed)
    yield* host.syncProjection(acquired)
    if (acquired.state !== "agent_owned") return yield* BrowserControl.failure("BROWSER_UNKNOWN")
    return { shared: SharedBrowserControl.status(acquired) } satisfies Output
  }
  const active = yield* SharedBrowserControl.requireActive(services.db, resource.resourceID, resource.scope)
  const check = (reader: Pick<Database.Interface["db"], "select">) =>
    Effect.gen(function* () {
      yield* current(reader)
      const fresh = yield* SharedBrowserControl.requireActive(reader, resource.resourceID, resource.scope)
      if (
        SharedBrowserControl.hash(fresh.resource) !== SharedBrowserControl.hash(active.resource) ||
        SharedBrowserControl.hash(fresh.lease) !== SharedBrowserControl.hash(active.lease)
      )
        return yield* BrowserControl.failure("BROWSER_STALE_TARGET")
    })
  const admission = yield* CurrentToolExecution.requireCurrent(
    services.db,
    context,
    services.location,
    input,
    resource.scope,
  )
  const record = yield* SharedBrowserControl.prepareAction(
    services.db,
    { ...active, command: input.command, admission, timeoutMs: input.timeoutMs ?? BrowserSchema.DEFAULT_TIMEOUT_MS },
    check,
  )
  const action: SharedBrowserSchema.Action = {
    actionID: record.actionID,
    resourceID: record.resourceID,
    leaseID: record.leaseID,
    leaseEpoch: record.leaseEpoch,
    manualEpoch: record.manualEpoch,
    admissionID: record.admissionID,
    providerReceiptID: record.providerReceiptID,
    providerAttemptID: record.providerAttemptID,
    toolCallID: record.toolCallID,
    rootSessionID: record.rootSessionID,
    command: record.command,
    commandHash: record.commandHash,
    deadline: record.deadline,
  }
  const unknown = SharedBrowserControl.observeAction(services.db, record, {
    outcome: "unknown",
    errorCode: "BROWSER_UNKNOWN",
  }).pipe(Effect.catch(() => Effect.void))
  const output = yield* host.execute(active.resource, active.lease, action, check(services.db)).pipe(
    Effect.onInterrupt(() => unknown.pipe(Effect.uninterruptible)),
    // Once dispatch is possible, a lost/failed reply is never an instruction to repeat it.
    Effect.catch(() => unknown.pipe(Effect.andThen(Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN"))))),
  )
  yield* SharedBrowserControl.observeAction(services.db, record, { outcome: "completed", result: output.result }).pipe(
    Effect.catch(() => unknown.pipe(Effect.andThen(Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN"))))),
  )
  if (fileOperation && services.files?.shared)
    yield* services.files.shared.finishAction(action.actionID).pipe(Effect.catch(() => Effect.void))
  return {
    shared: SharedBrowserControl.status(active.resource),
    actionID: action.actionID,
    result: output.result,
    ...(output.png === undefined ? {} : { png: output.png }),
  } satisfies Output
})
