import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkCountAcquisition } from "../src/session/work-count-acquisition"
import { WorkCountAcquisitionSchema } from "../src/session/work-count-acquisition.schema"
import { EventInvestigationFixture } from "./fixture/event-investigation"
import { WorkAuthorityFixture } from "./fixture/work-authority"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return typeof error === "object" && error !== null && "code" in error ? error.code : String(error)
}

test("actual count prepare rejects turn 9 before source/route disclosure or any acquisition row", async () => {
  const directory = await mkdtemp("/tmp/dac-investigation-count-")
  const captured = new WeakSet<WorkCountAcquisitionSchema.ProjectBinding>()
  const state = { source: 0, route: 0 }
  const verifier = Layer.effect(WorkAuthority.Verifier, Effect.gen(function* () {
    const base = yield* WorkAuthority.Verifier
    return { authorizeSource: (tx: WorkAuthority.Transaction, binding: Parameters<typeof base.authorizeSource>[1]) =>
      base.authorizeSource(tx, binding).pipe(Effect.tap(() => Effect.sync(() => state.source++))),
    resolveRoute: (tx: WorkAuthority.Transaction, binding: Parameters<typeof base.resolveRoute>[1]) =>
      base.resolveRoute(tx, binding).pipe(Effect.tap(() => Effect.sync(() => state.route++))) }
  })).pipe(Layer.provide(WorkAuthorityFixture.verifier))
  // Controlled capture boundary, not signed Native availability or model execution proof.
  const count = Layer.succeed(WorkCountAcquisition.Authority, {
    requireCapture: () => Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")),
    authenticate: () => Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")),
    verify: () => Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")),
    requireProjectCapture: (binding) => captured.has(binding) ? Effect.void : Effect.fail(WorkCountAcquisition.failure("COUNT_UNAVAILABLE")),
  })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      const binding = { ...EventInvestigationFixture.binding(), deadline: Date.now() + 60_000 }
      const work = yield* db.transaction((tx) => WorkAuthority.reserveInTransaction(tx, { binding }), { behavior: "immediate" })
      yield* WorkAuthorityFixture.materialize(binding)
      yield* db.run(sql`UPDATE session_input SET promoted_seq=2 WHERE id=${binding.inputID}`)
      const tuple: WorkCountAcquisitionSchema.ProjectBinding = {
        workID: work.work_id, rootWorkID: work.root_work_id, inputID: work.input_id, sessionID: work.session_id,
        bindingHash: work.binding_hash, controlRevision: work.control_revision,
        sourceAuthorityID: work.authority_id, sourceRevision: work.source_revision, sourceRecordHash: work.source_record_hash,
        providerReceiptID: `receipt-${work.work_id}`, providerAttemptID: binding.attemptKey,
        sessionClaimToken: 7, providerOwnerToken: `owner-${work.work_id}`,
        approvalID: "route-one", approvalRevision: 1, approvalEvidenceHash: "d".repeat(64),
        configurationStamp: "c".repeat(64), credentialFingerprint: "e".repeat(64), credentialGeneration: 1,
        inputTupleHash: "f".repeat(64), countBodyHash: "1".repeat(64), generationBodyHash: "2".repeat(64),
        wireHash: "3".repeat(64), nonsecretHeadersHash: "4".repeat(64), sealedRequestHash: "5".repeat(64),
        turn: { key: "6".repeat(64), activityID: `activity-${work.work_id}`, providerTurnSeq: 9,
          contextSelectionID: `selection-${work.work_id}`, contextProjectionHash: "e".repeat(64),
          historyPromptEpoch: 1, historySourceEndMessageID: null },
        predecessor: null, toolAdvertisementHash: "7".repeat(64),
        inputProjectionVersion: "openai-responses-project-input.v1", inputProjectionHash: "8".repeat(64),
      }
      const ninth = { ...tuple, sealedRequestHash: WorkCountAcquisition.sealedRequestHash(tuple) }
      captured.add(ninth)
      state.source = 0; state.route = 0
      const input = { acquisitionID: "ninth", ownerToken: "counter-owner", bootID: "counter-boot", deadline: Date.now() + 5_000 }
      expect(code(yield* WorkCountAcquisition.prepareTurn(db, { ...input, binding: ninth }).pipe(Effect.exit))).toBe("COUNT_REJECTED")
      expect(state).toEqual({ source: 0, route: 0 })
      expect(code(yield* WorkCountAcquisition.prepareTurn(db, { ...input, binding: { ...ninth } }).pipe(Effect.exit))).toBe("COUNT_UNAVAILABLE")
      const eighth = { ...ninth, turn: { ...ninth.turn, providerTurnSeq: 8 } }
      captured.add(eighth)
      // Eighth passes the new ordinal boundary, then is denied by absent route approval.
      // This test does not manufacture its seven predecessor turns or claim admission success.
      expect(code(yield* WorkCountAcquisition.prepareTurn(db, { ...input, binding: eighth }).pipe(Effect.exit))).not.toBe("COUNT_REJECTED")
      expect(state).toEqual({ source: 1, route: 1 })
      expect(yield* db.all("SELECT count(*) count FROM work_count_acquisition")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT count(*) count FROM work_dispatch_reservation")).toEqual([{ count: 0 }])
      expect(yield* db.all("SELECT state FROM session_provider_attempt")).toEqual([{ state: "prepared" }])
    }).pipe(Effect.provide(Layer.mergeAll(WorkAuthorityFixture.database(join(directory, "private.sqlite")), verifier, count)), Effect.scoped))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
