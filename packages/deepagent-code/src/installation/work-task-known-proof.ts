export * as NativeTaskKnownProof from "./work-task-known-proof"

import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect, Layer, Option, Schema } from "effect"
import { WorkChildAuthority } from "@deepagent-code/core/session/work-child-authority"
import { WorkTaskKnownProof } from "@deepagent-code/core/session/work-task-known-proof"
import { WorkTaskKnownProofSchema } from "@deepagent-code/core/session/work-task-known-proof.schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { LocalTaskAuthority } from "../im/local-task-authority"

const DOMAIN = "dac-work-native-task-outcome.v2"
/** A separate installation-key purpose. Its only sealing input is the original canonical
 * opaque Task settlement; caller JSON and historical Task output cannot mint a new MAC. */
export const layer = Layer.effect(WorkTaskKnownProof.Authority, Effect.gen(function* () {
  const installation = yield* LocalTaskAuthority.readInstallation.pipe(
    Effect.mapError(() => WorkTaskKnownProof.failure("TASK_PROOF_UNAVAILABLE")),
  )
  const secret = Buffer.from(installation.secret, "hex")
  const lifetime = { active: true }
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false; secret.fill(0) }))
  const mac = (record: WorkTaskKnownProofSchema.Record) => createHmac("sha256", secret)
    .update(`${DOMAIN}\0`).update(CanonicalJson.stringify([installation.instanceID, record])).digest("hex")
  const valid = (record: WorkTaskKnownProofSchema.Record) => lifetime.active && record.instanceID === installation.instanceID &&
    Option.isSome(Schema.decodeUnknownOption(WorkTaskKnownProofSchema.Record, { onExcessProperty: "error" })(record)) &&
    Buffer.byteLength(CanonicalJson.stringify(record)) <= WorkTaskKnownProofSchema.MAX_RECORD_BYTES
  return WorkTaskKnownProof.Authority.of({
    instanceID: installation.instanceID,
    seal: (tx, token, effectID) => Effect.gen(function* () {
      if (!lifetime.active) return yield* WorkTaskKnownProof.failure("TASK_PROOF_UNAVAILABLE")
      const record = yield* WorkChildAuthority.inspectSettlementProof(tx, token, effectID, installation.instanceID)
        .pipe(Effect.mapError(() => WorkTaskKnownProof.failure("TASK_PROOF_UNKNOWN")))
      if (!valid(record)) return yield* WorkTaskKnownProof.failure("TASK_PROOF_CAPACITY")
      return { record, mac: mac(record) }
    }),
    verify: (record, value) => Effect.gen(function* () {
      if (!valid(record) || !Schema.is(WorkTaskKnownProofSchema.Digest)(value) ||
        !timingSafeEqual(Buffer.from(mac(record), "hex"), Buffer.from(value, "hex")))
        return yield* WorkTaskKnownProof.failure("TASK_PROOF_INVALID")
    }),
  })
}))
