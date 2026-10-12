export * as LocalTaskAuth from "./local-task-auth"

import { Context, Effect, Layer } from "effect"
import { IMTaskAuthority } from "./task-authority"
import { IMTaskAuthoritySchema } from "./task-authority.schema"
import { LocalOperator } from "./local-operator"
import type { LocalOperatorSchema } from "./local-operator.schema"
import { LocalOrigin } from "./local-origin"
import { LocalTaskPolicy } from "./local-task-policy"
import { KernelReceiverMapping } from "./kernel-receiver-mapping"
import type { WorkAuthority } from "../session/work-authority"

/** Host-only current reader verifier. No HTTP field or persisted metadata installs this seam. */
export const KernelSource = Context.Reference<{
  readonly verify: (tx: WorkAuthority.Transaction, messageID: string) => Effect.Effect<IMTaskAuthoritySchema.SourceProof | undefined, LocalOperatorSchema.Error>
} | undefined>("@deepagent-code/LocalTaskAuth/KernelSource", { defaultValue: () => undefined })

export const verifySource = Effect.fn("LocalTaskAuth.verifySource")(function* (tx: WorkAuthority.Transaction, messageID: string) {
  const kernel = yield* KernelSource
  const proof = kernel ? yield* kernel.verify(tx, messageID) : undefined
  return proof ?? (yield* LocalOrigin.verify(tx, messageID))
})

const mapped = (error: LocalOperatorSchema.Error) =>
  new IMTaskAuthoritySchema.Error({
    code:
      error.code === "LOCAL_OPERATOR_UNAVAILABLE" ||
      error.code === "LOCAL_OPERATOR_CONFIG_MISMATCH" ||
      error.code === "LOCAL_OPERATOR_INSTALLATION_MISMATCH"
        ? "IM_TASK_AUTHORITY_UNAVAILABLE"
        : error.code === "LOCAL_TASK_SOURCE_UNAVAILABLE"
          ? "IM_TASK_SOURCE_UNAVAILABLE"
          : "IM_TASK_FORBIDDEN",
    message: "Authenticated local task authority is unavailable, changed or denied",
  })

// This service has no identity by itself. Every method requires the host's private Runtime;
// mutations additionally require its independently authenticated request witness.
export const layer = Layer.succeed(IMTaskAuthority.Authority, {
  authenticateMutation: (tx) =>
    LocalOperator.requireMutation(tx).pipe(Effect.map(LocalOperator.principal), Effect.mapError(mapped)),
  verifyOperator: (tx, principal) => LocalOperator.verifyOperator(tx, principal).pipe(Effect.mapError(mapped)),
  verifySource: (tx, messageID) => verifySource(tx, messageID).pipe(Effect.mapError(mapped)),
  authorizeTarget: (tx, principal, target, source) =>
    Effect.gen(function* () {
      yield* LocalOperator.verifyOperator(tx, principal)
      const proof = yield* verifySource(tx, source.message_id)
      if (proof.reader) {
        const mapping = yield* KernelReceiverMapping.requireCurrent(tx, {
          targetID: proof.reader.targetID, workspaceID: proof.reader.workspaceID, localUserID: proof.reader.localUserID,
          source: { realm: proof.realmID ?? "", appkey: proof.appkeyID ?? "", orgID: Number(proof.orgID), senderID: proof.receiverID },
        })
        if (proof.origin !== "kernel_live" || mapping.recordHash !== proof.reader.mappingHash ||
          LocalOperator.hash(proof) !== LocalOperator.hash(source.proof) ||
          LocalOperator.hash(target) !== LocalOperator.hash(mapping.registered.target) ||
          LocalOperator.hash(principal) !== LocalOperator.hash(mapping.principal))
          return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Kernel source or reviewed receiver target changed")
        return { revision: mapping.revision, recordHash: mapping.recordHash, targetHash: LocalOperator.hash(target) }
      }
      if (
        proof.origin !== "local" ||
        proof.conversationType !== "local" ||
        LocalOperator.hash(proof) !== LocalOperator.hash(source.proof)
      )
        return yield* LocalOperator.failure(
          "LOCAL_TASK_SOURCE_UNAVAILABLE",
          "Task source is not the verified local origin",
        )
      const conversation = yield* LocalTaskPolicy.requireConversation(tx, proof.conversationID)
      if (
        LocalOperator.hash(target) !== conversation.target_hash ||
        target.scope.actorID !== principal.actorID ||
        conversation.instance_id !== principal.instanceID
      )
        return yield* LocalOperator.failure(
          "LOCAL_TASK_SCOPE_DENIED",
          "Target differs from the source conversation policy",
        )
      return {
        revision: conversation.revision,
        recordHash: LocalOperator.hash({
          instanceID: conversation.instance_id,
          operatorID: conversation.operator_id,
          operatorRevision: conversation.operator_revision,
          groupID: conversation.group_id,
          revision: conversation.revision,
          targetID: conversation.target_id,
          targetHash: conversation.target_hash,
          locationKey: conversation.location_key,
          namespaceBindingHash: conversation.namespace_binding_hash,
        }),
        targetHash: conversation.target_hash,
      }
    }).pipe(Effect.mapError(mapped)),
})
