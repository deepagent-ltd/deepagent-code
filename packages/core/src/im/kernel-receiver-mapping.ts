export * as KernelReceiverMapping from "./kernel-receiver-mapping"

import { Effect } from "effect"
import type { WorkAuthority } from "../session/work-authority"
import type { KernelDeliverySchema } from "./kernel-delivery.schema"
import { LocalOperator } from "./local-operator"

/** Reads explicit policy only. A mapping is not a message receipt or an execution grant. */
export const requireCurrent = Effect.fn("KernelReceiverMapping.requireCurrent")(function* (
  tx: WorkAuthority.Transaction,
  input: {
    targetID: string
    workspaceID: string
    localUserID: string
    source: Pick<KernelDeliverySchema.Source, "realm" | "appkey" | "orgID" | "senderID">
    now?: number
  },
) {
  const operator = yield* LocalOperator.requireCurrent(tx)
  yield* LocalOperator.validatePolicy(tx, operator.policy, operator.operator_id)
  const registered = operator.policy.targets.find((target) => target.id === input.targetID)
  if (!registered || registered.target.scope.workspaceID !== input.workspaceID)
    return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Kernel receiver target is outside the enrolled workspace")
  const mapping = operator.policy.kernelReceivers?.find((receiver) =>
    receiver.targetID === input.targetID && receiver.localUserID === input.localUserID &&
    receiver.realmID === input.source.realm && receiver.appkeyID === input.source.appkey &&
    receiver.orgID === input.source.orgID && receiver.receiverID === input.source.senderID)
  const now = input.now ?? Date.now()
  if (!mapping || !Number.isSafeInteger(now) || mapping.issuedAt > now || mapping.expiresAt <= now)
    return yield* LocalOperator.failure("LOCAL_TASK_SOURCE_UNAVAILABLE", "Current explicit kernel receiver mapping is unavailable or expired")
  return {
    mapping,
    registered,
    principal: LocalOperator.principal(operator),
    revision: operator.policy_revision,
    credentialGeneration: operator.credential_generation,
    recordHash: LocalOperator.hash({
      version: "kernel-receiver-mapping.v1",
      mapping,
      principal: LocalOperator.principal(operator),
      policyRevision: operator.policy_revision,
      credentialGeneration: operator.credential_generation,
      namespaceBindingHash: registered.namespaceBindingHash,
      targetHash: LocalOperator.hash(registered.target),
    }),
  }
})
