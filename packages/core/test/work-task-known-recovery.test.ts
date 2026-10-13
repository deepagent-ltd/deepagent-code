import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Scope } from "effect"
import { Database } from "../src/database/database"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkChildAuthority } from "../src/session/work-child-authority"
import { WorkKnownRecoveryV2 } from "../src/session/work-known-recovery-v2"
import { WorkTaskKnownProof } from "../src/session/work-task-known-proof"
import { WorkAuthorityFixture } from "./fixture/work-authority"

test("cold task proof reads, cloned settlement and serialized continuation cannot release a real claim", async () => {
  const root = await fs.mkdtemp("/tmp/dac-task-known-proof-unavailable-")
  const binding = WorkAuthorityFixture.binding("task-known-no-authority")
  const run = <A,E>(effect: Effect.Effect<A,E,Database.Service | Scope.Scope>) => Effect.runPromise(effect.pipe(
    Effect.provide(WorkAuthorityFixture.verifier), Effect.provide(WorkAuthorityFixture.database(path.join(root,"database.sqlite"))), Effect.scoped))
  const census = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return { claims: yield* db.all("SELECT id,execution_claim_token FROM session"),
      input: yield* db.all("SELECT id,promoted_seq FROM session_input"),
      work: yield* db.all("SELECT work_id,binding_hash,outcome FROM work_execution"),
      proof: yield* db.all("SELECT proof_id,state FROM work_task_known_proof"),
      recoveries: yield* db.all("SELECT recovery_id FROM work_known_recovery_v2"),
      resumes: yield* db.all("SELECT recovery_id FROM work_known_recovery_resume_v2"),
      provider: yield* db.all("SELECT receipt_id,state FROM session_v2_provider_turn_receipt") }
  })
  try {
    const before = await run(Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      yield* WorkAuthority.reserve((yield* Database.Service).db,{binding,now:WorkAuthorityFixture.NOW})
      yield* WorkAuthorityFixture.materialize(binding)
      return yield* census
    }))
    expect(before.claims).toEqual([{id:binding.sessionID,execution_claim_token:7}])
    for (const cold of [false,true]) await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect(yield* WorkTaskKnownProof.read(db,"unregistered-admission")).toBeUndefined()
      const cloned = yield* db.transaction((tx) => WorkChildAuthority.inspectSettlementProof(tx,
        Object.freeze({}) as WorkTaskKnownProof.Settlement,"tool_fake","instance_fake")).pipe(Effect.exit)
      expect(Exit.isFailure(cloned)).toBe(true)
      if (Exit.isFailure(cloned)) expect(Cause.squash(cloned.cause)).toMatchObject({code:"WORK_RECOVERY_REQUIRED"})
      const recovered = yield* WorkKnownRecoveryV2.recover(db,{workID:binding.workID,sessionID:binding.sessionID,
        requestID:cold?"cold":"live",expectedClaimToken:7,expectedControlRevision:1,action:"recover_only"}).pipe(Effect.exit)
      expect(Exit.isFailure(recovered)).toBe(true)
      if (Exit.isFailure(recovered)) expect(Cause.squash(recovered.cause)).toMatchObject({code:"RECOVERY_UNAVAILABLE"})
      const resumed = yield* WorkKnownRecoveryV2.withContinuation({recoveryID:"wrecover2_copy",workID:binding.workID,
        sessionID:binding.sessionID,requestID:"copy",action:"recover_only",oldClaimToken:7,controlRevision:1,
        createdAt:1,replayed:false,continuation:"not_started"},Effect.die("copied continuation executed")).pipe(Effect.exit)
      expect(Exit.isFailure(resumed)).toBe(true)
      if (Exit.isFailure(resumed)) expect(Cause.squash(resumed.cause)).toMatchObject({code:"RECOVERY_UNAVAILABLE"})
      expect(yield* census).toEqual(before)
    }))
  } finally { await fs.rm(root,{recursive:true,force:true}) }
},30000)
