export * as RemoteTaskScope from "./remote-task-scope"

import { Effect } from "effect"
import type { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { LocalOperator } from "./local-operator"

/** A current authenticated operator may select only its registered receiving targets.
 * Project parameters narrow that set; they never supply a new path or tenant authority. */
export const targets = Effect.fn("RemoteTaskScope.targets")(function* (
  tx: WorkAuthority.Transaction,
  input: { directory?: string } = {},
) {
  const operator = yield* LocalOperator.requireMutation(tx)
  yield* LocalOperator.validatePolicy(tx, operator.policy, operator.operator_id)
  return {
    principal: LocalOperator.principal(operator),
    credentialGeneration: operator.credential_generation,
    policyRevision: operator.policy_revision,
    policyHash: operator.policy_hash,
    targets: operator.policy.targets.filter((entry) =>
      (entry.target.profile.id === WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id ||
        entry.target.profile.id === WorkAuthorityPolicy.PROJECT_PROFILE.id ||
        entry.target.profile.id === WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.id) &&
      (input.directory === undefined || entry.target.location.directory === input.directory),
    ),
  }
})

/** Re-run in the source/grant transaction after any external identity observation.
 * The returned policy tuple is a fact to bind, not a serializable execution witness. */
export const resolve = Effect.fn("RemoteTaskScope.resolve")(function* (
  tx: WorkAuthority.Transaction,
  input: { targetID: string; directory?: string; expectedOperatorRevision?: number; expectedPolicyRevision?: number },
) {
  if (!input.targetID || input.targetID.length > 512 ||
    (input.expectedOperatorRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedOperatorRevision) || input.expectedOperatorRevision < 1)) ||
    (input.expectedPolicyRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 1)))
    return yield* LocalOperator.failure("LOCAL_OPERATOR_INVALID", "Remote task selection is invalid")
  const current = yield* targets(tx, input)
  if ((input.expectedOperatorRevision !== undefined && current.principal.revision !== input.expectedOperatorRevision) ||
    (input.expectedPolicyRevision !== undefined && current.policyRevision !== input.expectedPolicyRevision))
    return yield* LocalOperator.failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Remote task authority changed")
  const target = current.targets.find((entry) => entry.id === input.targetID)
  if (!target)
    return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Remote task target is outside the approved receiving scope")
  return {
    principal: current.principal,
    credentialGeneration: current.credentialGeneration,
    policyRevision: current.policyRevision,
    policyHash: current.policyHash,
    targetID: target.id,
    locationKey: target.locationKey,
    namespaceBindingHash: target.namespaceBindingHash,
    targetHash: LocalOperator.hash(target.target),
    target: target.target,
  }
})
