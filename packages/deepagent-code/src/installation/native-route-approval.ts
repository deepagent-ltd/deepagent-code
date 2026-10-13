import { Context, Effect, Option, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"
import { ProviderCredentialBinding } from "./provider-credential-binding"

/** A concrete native lowering caller is installed only alongside a reviewed provider contract.
 * It must stop at the real final seal (zero network) and return the opaque host capture. */
export class CaptureFactory extends Context.Service<
  CaptureFactory,
  {
    readonly capture: (input: {
      scope: WorkRouteApprovalSchema.Scope
      snapshot: string
      expiresAt: number
    }) => Effect.Effect<ProviderCredentialBinding.Capture, WorkRouteApprovalSchema.Error, Scope.Scope>
  }
>()("@deepagent-code/OfflineNativeRouteApproval/CaptureFactory") {}

export const approve = Effect.fn("OfflineNativeRouteApproval.approve")(function* (input: {
  targetID: string
  snapshot: string
  expiresAt: number
  requestID: string
  expectedRevision: number
  expectedOperatorRevision: number
}) {
  const db = (yield* Database.Service).db
  const operator = yield* db.transaction((tx) => LocalOperator.requireMutation(tx))
  const credentials = yield* ProviderCredentialBinding.Service
  const identity: WorkRouteApprovalSchema.CommandIdentity = {
    version: 1,
    instanceID: operator.instance_id,
    operatorID: operator.operator_id,
    targetID: input.targetID,
    action: "approve",
    snapshot: input.snapshot,
    expiresAt: input.expiresAt,
    expectedRevision: input.expectedRevision,
    expectedOperatorRevision: input.expectedOperatorRevision,
  }
  const previous = yield* WorkRouteApproval.reconcile(db, { requestID: input.requestID, identity }).pipe(
    Effect.provideService(WorkRouteApproval.Authority, credentials.authority),
  )
  if (previous) return previous
  const factory = yield* Effect.serviceOption(CaptureFactory)
  if (Option.isNone(factory)) return yield* WorkRouteApproval.failure("ROUTE_PROOF_UNAVAILABLE")
  const target = operator.policy.targets.find((entry) => entry.id === input.targetID)
  if (!target) return yield* WorkRouteApproval.failure("ROUTE_REVISION_CONFLICT")
  const capture = yield* factory.value.capture({
    snapshot: input.snapshot,
    expiresAt: input.expiresAt,
    scope: {
      instanceID: operator.instance_id,
      operatorID: operator.operator_id,
      targetID: target.id,
      securityNamespaceID: target.target.scope.securityNamespaceID,
      projectScopeKey: target.target.scope.projectScopeKey,
      locationKey: target.locationKey,
      canonicalRoot: target.target.location.directory,
      namespaceBindingHash: target.namespaceBindingHash,
    },
  })
  return yield* WorkRouteApproval.approve(db, {
    capture,
    identity,
    requestID: input.requestID,
    expectedRevision: input.expectedRevision,
    expectedOperatorRevision: input.expectedOperatorRevision,
  }).pipe(Effect.provideService(WorkRouteApproval.Authority, credentials.authority))
})

export const revoke = Effect.fn("OfflineNativeRouteApproval.revoke")(function* (input: {
  targetID: string
  requestID: string
  expectedRevision: number
  expectedOperatorRevision: number
}) {
  const db = (yield* Database.Service).db
  const operator = yield* db.transaction((tx) => LocalOperator.requireMutation(tx))
  const credentials = yield* ProviderCredentialBinding.Service
  return yield* WorkRouteApproval.revoke(db, {
    approvalID: `route_${WorkRouteApproval.hash([operator.instance_id, operator.operator_id, input.targetID])}`,
    identity: {
      version: 1,
      instanceID: operator.instance_id,
      operatorID: operator.operator_id,
      targetID: input.targetID,
      action: "revoke",
      snapshot: null,
      expiresAt: null,
      expectedRevision: input.expectedRevision,
      expectedOperatorRevision: input.expectedOperatorRevision,
    },
    requestID: input.requestID,
    expectedRevision: input.expectedRevision,
    expectedOperatorRevision: input.expectedOperatorRevision,
  }).pipe(Effect.provideService(WorkRouteApproval.Authority, credentials.authority))
})

export const history = Effect.fn("OfflineNativeRouteApproval.history")(function* (input: {
  targetID: string
  requestID: string
}) {
  const db = (yield* Database.Service).db
  const credentials = yield* ProviderCredentialBinding.Service
  return yield* WorkRouteApproval.history(db, input).pipe(
    Effect.provideService(WorkRouteApproval.Authority, credentials.authority),
  )
})

export * as OfflineNativeRouteApproval from "./native-route-approval"
