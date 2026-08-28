import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@deepagent-code/llm"
import { Database } from "@deepagent-code/core/database/database"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionCompaction } from "../src/session/compaction"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { PreparedProviderTurn } from "../src/session/runner/prepared-provider-turn"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

// §16.3 order 4 package B — receipt-aware compaction replay. A crash between the summary dispatch
// settling and the compaction commit used to skip compaction forever (the blanket catch mapped the
// settled same-identity receipt's UnsafeRetryError to "skip"); the session stayed uncompactable
// until the next user message changed the identity. The replay path must reuse the settled outcome
// artifact (never re-dispatch — indeterminate no-replay) and still fail closed otherwise.

const settledRow = (artifact: readonly unknown[], hash?: string) => ({
  state: "settled",
  outcome_hash: hash ?? Hash.sha256(CanonicalJson.stringify(artifact)),
  outcome_artifact: artifact,
})

test("reconstructs summary text from a settled receipt's artifact (decoded JSON shape)", () => {
  const artifact = [LLMEvent.textDelta({ id: "blk_1", text: "## Goal" }), LLMEvent.textDelta({ id: "blk_2", text: "- Keep" })]
  // Round-trip through canonical JSON exactly like the sqlite json column does on read-back.
  const decoded = JSON.parse(CanonicalJson.stringify(artifact)) as readonly unknown[]
  expect(SessionCompaction.reconstructSettledSummary(settledRow(decoded))).toEqual({
    chunks: ["## Goal", "- Keep"],
    failed: false,
  })
})

test("rebuilds the failed flag from a providerError event in the decoded artifact", () => {
  const artifact = [
    LLMEvent.textDelta({ id: "blk_1", text: "partial" }),
    LLMEvent.providerError({ message: "boom" }),
  ]
  const decoded = JSON.parse(CanonicalJson.stringify(artifact)) as readonly unknown[]
  expect(SessionCompaction.reconstructSettledSummary(settledRow(decoded))).toEqual({ chunks: ["partial"], failed: true })
})

test("fails closed when the outcome hash does not match the artifact", () => {
  const decoded = JSON.parse(CanonicalJson.stringify([LLMEvent.textDelta({ id: "blk_1", text: "x" })])) as readonly unknown[]
  expect(SessionCompaction.reconstructSettledSummary(settledRow(decoded, Hash.sha256("tampered")))).toBeUndefined()
})

test("fails closed on non-settled receipts", () => {
  const decoded = JSON.parse(CanonicalJson.stringify([LLMEvent.textDelta({ id: "blk_1", text: "x" })])) as readonly unknown[]
  for (const state of ["failed", "streaming", "indeterminate_after_crash"] as const)
    expect(SessionCompaction.reconstructSettledSummary({ ...settledRow(decoded), state })).toBeUndefined()
})

test("fails closed when the settled receipt carries no artifact", () => {
  expect(SessionCompaction.reconstructSettledSummary({ state: "settled", outcome_hash: null, outcome_artifact: null })).toBeUndefined()
})

const database = Database.layerFromPath(":memory:")
const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const ownerAuthorization = Layer.succeed(
  V2ProviderTurn.OwnerAuthorization,
  V2ProviderTurn.OwnerAuthorization.of({ authorize: () => Effect.succeed(true) }),
)
const it = testEffect(Layer.mergeAll(database, providerTurns, ownerAuthorization))

const sessionID = SessionSchema.ID.make("ses_lookup_replay")

// The replay wiring's DB half: receiptByIdentity must return exactly the row admit refused with
// UnsafeRetryError (same predicates/ordering), and nothing for any identity mismatch.
describe("V2ProviderTurn.receiptByIdentity (§16.3 order 4 package B)", () => {
  it.effect("finds the receipt by the exact identity tuple only", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: Project.ID.global,
          worktree: AbsolutePath.make("/project"),
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: sessionID,
          directory: "/project",
          title: "receipt lookup",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const lease = yield* db.select().from(SessionProviderOwnerLeaseTable).get().pipe(Effect.orDie)
      if (!lease) return yield* Effect.die("owner lease missing")
      const identity = {
        sessionId: sessionID,
        userMessageId: "msg_lookup",
        historyPromptEpoch: 3,
        requestInputHash: "hash_lookup",
      }
      yield* db
        .insert(V2ProviderTurnReceiptTable)
        .values({
          receipt_id: "v2_receipt_lookup",
          session_id: sessionID,
          request_ordinal: 1,
          activity_id: "act_lookup",
          provider_turn_seq: 1,
          user_message_id: identity.userMessageId,
          history_prompt_epoch: identity.historyPromptEpoch,
          request_input_hash: identity.requestInputHash,
          provider_id: "fake",
          model_id: "compact",
          protocol: "openai-chat",
          owner_mode: "v2",
          owner_token: lease.owner_token,
          state: "preparing",
          created_at: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      // Walk the durable state machine the insert/transition triggers enforce
      // (preparing → dispatching → streaming → settled).
      const now = Date.now()
      // The transition trigger only reads request_hash/wire_request_hash off the JSON; the full
      // PreparedProviderTurn shape is irrelevant to this lookup test.
      const preparedTurn = JSON.parse(
        '{"request_hash":"prepared_hash_lookup","wire_request_hash":"wire_hash_lookup"}',
      ) as PreparedProviderTurn.PreparedProviderTurn
      yield* db
        .update(V2ProviderTurnReceiptTable)
        .set({
          state: "dispatching",
          prepared_turn_hash: preparedTurn.request_hash,
          wire_request_hash: preparedTurn.wire_request_hash,
          prepared_turn: preparedTurn,
          dispatching_at: now,
        })
        .where(eq(V2ProviderTurnReceiptTable.receipt_id, "v2_receipt_lookup"))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(V2ProviderTurnReceiptTable)
        .set({ state: "streaming", first_event_at: now + 1 })
        .where(eq(V2ProviderTurnReceiptTable.receipt_id, "v2_receipt_lookup"))
        .run()
        .pipe(Effect.orDie)
      const artifact = [LLMEvent.textDelta({ id: "blk_lookup", text: "settled summary" })]
      yield* db
        .update(V2ProviderTurnReceiptTable)
        .set({
          state: "settled",
          outcome_hash: Hash.sha256(CanonicalJson.stringify(artifact)),
          outcome_artifact: artifact,
          terminal_at: now + 2,
        })
        .where(eq(V2ProviderTurnReceiptTable.receipt_id, "v2_receipt_lookup"))
        .run()
        .pipe(Effect.orDie)

      const found = yield* V2ProviderTurn.receiptByIdentity(db, identity).pipe(Effect.orDie)
      expect(found?.receipt_id).toBe("v2_receipt_lookup")
      expect(found?.state).toBe("settled")
      // Any component of the identity tuple diverging must miss.
      expect(
        yield* V2ProviderTurn.receiptByIdentity(db, { ...identity, historyPromptEpoch: 4 }).pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* V2ProviderTurn.receiptByIdentity(db, { ...identity, requestInputHash: "other" }).pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )
})
