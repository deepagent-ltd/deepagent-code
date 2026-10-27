import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { LocalOperator } from "../src/im/local-operator"
import { WorkCountAcquisition } from "../src/session/work-count-acquisition"
import { WorkCountAcquisitionSchema } from "../src/session/work-count-acquisition.schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { WorkRouteApprovalFixture } from "./fixture/work-route-approval"

test("project count data cannot silently upgrade the actual v1 file-DB slot or its MAC", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "dac-count-successor-"))
  const proof = WorkRouteApprovalFixture.authority()
  const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Effect.runPromise(effect.pipe(
    Effect.provide(Layer.mergeAll(WorkAuthorityFixture.database(path.join(root, "file.sqlite")),
      proof.route, proof.count, WorkAuthorityFixture.verifier)),
    Effect.provideService(LocalOperator.Runtime, WorkRouteApprovalFixture.runtime), Effect.scoped,
  ))
  try {
    const original = await run(Effect.gen(function* () {
      yield* WorkRouteApprovalFixture.initialize
      yield* WorkRouteApprovalFixture.approve(proof.capture())
      const binding = yield* WorkRouteApprovalFixture.work
      const db = (yield* Database.Service).db
      const legacy = yield* WorkCountAcquisition.prepare(db, { acquisitionID: "legacy-slot", binding,
        ownerToken: "count-owner", bootID: "count-boot", deadline: 2_000, now: 1_000 })
      const [turn] = yield* db.all<{
        activity_id: string; provider_turn_seq: number; selection_id: string; projection_hash: string;
        history_prompt_epoch: number; history_source_end_message_id: string | null;
      }>(sql`SELECT a.activity_id,a.provider_turn_seq,a.selection_id,a.projection_hash,
        r.history_prompt_epoch,r.history_source_end_message_id FROM session_provider_attempt a
        JOIN session_v2_provider_turn_receipt r ON r.provider_attempt_id=a.attempt_id
        WHERE a.attempt_id=${binding.providerAttemptID} AND r.receipt_id=${binding.providerReceiptID}`)
      if (!turn) throw new Error("actual fixture turn is missing")
      const project: WorkCountAcquisitionSchema.ProjectRecord = { ...legacy, version: 2, binding: {
        ...binding, rootWorkID: binding.workID,
        turn: {
          key: Hash.sha256(CanonicalJson.stringify(["work-count-slot.v2", binding.workID, binding.sessionID,
            turn.activity_id, turn.provider_turn_seq])),
          activityID: turn.activity_id, providerTurnSeq: turn.provider_turn_seq,
          contextSelectionID: turn.selection_id, contextProjectionHash: turn.projection_hash,
          historyPromptEpoch: turn.history_prompt_epoch, historySourceEndMessageID: turn.history_source_end_message_id,
        },
        predecessor: null, toolAdvertisementHash: Hash.sha256("[]"),
        inputProjectionVersion: "openai-responses-project-input.v1", inputProjectionHash: binding.inputTupleHash,
      } }
      const decode = Schema.decodeUnknownOption(WorkCountAcquisitionSchema.ProjectRecord, { onExcessProperty: "error" })
      expect(Option.isSome(decode(project))).toBe(true)
      expect(Option.isNone(Schema.decodeUnknownOption(WorkCountAcquisitionSchema.Record,
        { onExcessProperty: "error" })(project))).toBe(true)
      expect(Option.isNone(decode(legacy))).toBe(true)
      for (const patch of [
        { providerTurnSeq: 0 }, { providerTurnSeq: 1.5 }, { providerTurnSeq: Number.MAX_SAFE_INTEGER + 1 },
        { key: "A".repeat(64) }, { activityID: "中".repeat(171) }, { contextSelectionID: "" },
        { historyPromptEpoch: -1 }, { historySourceEndMessageID: undefined }, { authorized: true },
      ]) expect(Option.isNone(decode({ ...project, binding: { ...project.binding,
        turn: { ...project.binding.turn, ...patch } } }))).toBe(true)
      for (const patch of [
        { rootWorkID: undefined }, { inputProjectionVersion: "text-v1" }, { toolAdvertisementHash: "bad" },
        { predecessor: {} }, { predecessor: { acquisitionID: "old", receiptID: "receipt" } },
        { predecessor: { acquisitionID: "old", receiptID: "receipt", outcomeHash: "e".repeat(64),
          toolTerminalHash: "f".repeat(64), success: true } },
      ]) expect(Option.isNone(decode({ ...project, binding: { ...project.binding, ...patch } }))).toBe(true)

      const before = yield* db.all("SELECT * FROM work_count_acquisition")
      // This is a compatibility guard, not project execution proof: until the new store is
      // installed, a shape-valid v2 binding cannot gain a disclosure slot through the v1 API.
      const denied = yield* WorkCountAcquisition.prepare(db, { acquisitionID: "new-slot",
        binding: project.binding, ownerToken: "new-owner", bootID: "new-boot", deadline: 2_000, now: 1_000,
      }).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.squash(denied.cause)).toMatchObject({ code: "COUNT_INVALID_RECORD" })
      expect(yield* db.all("SELECT * FROM work_count_acquisition")).toEqual(before)
      expect(yield* db.all("SELECT count(*) count FROM work_dispatch_reservation")).toEqual([{ count: 0 }])
      return { legacy, before }
    }))
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect(yield* WorkCountAcquisition.get(db, original.legacy.binding.workID)).toEqual(original.legacy)
      expect(yield* db.all("SELECT * FROM work_count_acquisition")).toEqual(original.before)
    }))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
