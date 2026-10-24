export * as SharedBrowserUserInput from "./shared-user-input"

import { and, desc, eq, lt, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionInputTable } from "../session/sql"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import type { Prompt } from "../session/prompt"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { BrowserSchema } from "./schema"
import type { SharedBrowserHost } from "./shared-host"
import { SharedBrowserSchema } from "./shared-schema"
import { BrowserUserSelectionTable, SessionUserInputOriginTable } from "./shared.sql"
import {
  SessionActivityInputTable,
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
} from "../context-federation/session-sql"
import { V2ProviderTurnReceiptTable } from "../session/runner/v2-provider-turn.sql"
import { SharedBrowserCapacity } from "./shared-capacity"

type Reader = Pick<Database.Interface["db"], "select">
const Current = Context.Reference<object | undefined>("@deepagent-code/SharedBrowserUserInput", {
  defaultValue: () => undefined,
})
const origins = new WeakMap<object, { stamp: SharedBrowserSchema.InputStamp; active: boolean }>()
const denied = () =>
  new BrowserSchema.Error({ code: "BROWSER_AUTHORITY_REQUIRED", message: "A new trusted owner input is required" })
export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))

/** Validation must run outside SQL. Only the actual private Main registry can affirm the
 * original stamp. Model parameters and plain prompt HTTP credentials cannot enter this scope. */
export function withOrigin<A, E, R>(
  stamp: SharedBrowserSchema.InputStamp,
  host: Pick<SharedBrowserHost.Interface, "mainIncarnation" | "validateInput">,
  body: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(SharedBrowserSchema.InputStamp, { onExcessProperty: "error" })(stamp)
      if (Option.isNone(decoded) || !stamp.promptHash || host.mainIncarnation !== stamp.mainIncarnation)
        return yield* denied()
      const valid = yield* host
        .validateInput(stamp)
        .pipe(
          Effect.catchTag("Browser.Error", (error) =>
            error.code === "BROWSER_CAPACITY" ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        )
      // A full private-port queue withholds provenance only. The body is still evaluated
      // once, outside this catch, with no inherited origin capability.
      if (valid === undefined) return undefined
      if (!valid) return yield* denied()
      const handle = Object.freeze({})
      origins.set(handle, { stamp: structuredClone(stamp), active: true })
      return handle
    }),
    (handle) => body.pipe(Effect.provideService(Current, handle)),
    (handle) =>
      Effect.sync(() => {
        if (handle) origins.delete(handle)
      }),
  )
}

/** Runs only in a newly-admitted input's original EventV2 commit. An existing exact retry
 * never invokes this hook, so old rows, import and automatic resume cannot be upgraded. */
export const recordAdmission = Effect.fn("SharedBrowserUserInput.recordAdmission")(function* (
  db: Database.Interface["db"],
  input: { id: string; sessionID: string; prompt: Prompt; delivery: string; admittedSeq: number },
) {
  const current = yield* Current
  const entry = current && origins.get(current)
  if (!entry) return
  const stamp = entry.stamp
  if (
    !entry.active ||
    stamp.inputID !== input.id ||
    stamp.rootSessionID !== input.sessionID ||
    !stamp.promptHash ||
    stamp.promptHash !== hash(input.prompt) ||
    !["steer", "queue"].includes(input.delivery)
  )
    return yield* denied()
  const capacity = yield* SharedBrowserCapacity.reserve(db, "origin").pipe(
    Effect.as(true),
    Effect.catchTag("Browser.Error", (error) =>
      error.code === "BROWSER_CAPACITY" ? Effect.succeed(false) : Effect.fail(error),
    ),
  )
  // Exhausted browser metadata may withhold the new capability, but cannot withhold
  // the owner's ordinary durable chat. Its actual promotion then has no origin witness.
  if (!capacity) return
  const base = {
    ...stamp,
    promptHash: hash(input.prompt),
    delivery: input.delivery as "steer" | "queue",
    admittedSeq: input.admittedSeq,
    promotedSeq: null,
  }
  const record = { ...base, originHash: hash(base) } satisfies SharedBrowserSchema.InputOrigin
  const row = {
    input_id: input.id,
    session_id: input.sessionID,
    original_submission_id: stamp.originalSubmissionID,
    main_incarnation: stamp.mainIncarnation,
    submission_order: stamp.submissionOrder,
    admitted_seq: input.admittedSeq,
    record: CanonicalJson.stringify(record),
    record_hash: hash(record),
  }
  if (Buffer.byteLength(row.record) > 4096) return yield* denied()
  yield* db
    .insert(SessionUserInputOriginTable)
    .values(row)
    .run()
    .pipe(Effect.mapError(() => denied()))
})

export const get = Effect.fn("SharedBrowserUserInput.get")(function* (db: Reader, inputID: string) {
  const row = yield* db
    .select()
    .from(SessionUserInputOriginTable)
    .where(eq(SessionUserInputOriginTable.input_id, inputID))
    .get()
    .pipe(Effect.mapError(() => denied()))
  if (!row) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(SharedBrowserSchema.InputOrigin))(row.record)
  if (Option.isNone(decoded)) return yield* denied()
  const record = decoded.value
  const original: Omit<SharedBrowserSchema.InputOrigin, "originHash"> & { originHash?: string } = { ...record }
  delete original.originHash
  if (
    row.record_hash !== hash(record) ||
    record.originHash !== hash(original) ||
    record.inputID !== row.input_id ||
    record.rootSessionID !== row.session_id ||
    record.originalSubmissionID !== row.original_submission_id ||
    record.mainIncarnation !== row.main_incarnation ||
    record.submissionOrder !== row.submission_order ||
    record.admittedSeq !== row.admitted_seq
  )
    return yield* denied()
  const input = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.id, SessionMessage.ID.make(inputID)),
        eq(SessionInputTable.session_id, SessionSchema.ID.make(record.rootSessionID)),
      ),
    )
    .get()
    .pipe(Effect.mapError(() => denied()))
  if (
    !input ||
    input.admitted_seq !== record.admittedSeq ||
    input.delivery !== record.delivery ||
    hash(input.prompt) !== record.promptHash
  )
    return yield* denied()
  return { ...record, promotedSeq: input.promoted_seq }
})

/** The runner passes only its actual promotion frontier. No fallback search through history.
 * A later automatic/unattested trigger returns undefined rather than borrowing an old origin. */
export const promoted = Effect.fn("SharedBrowserUserInput.promoted")(function* (
  db: Reader,
  rootSessionID: string,
  promotedIDs: readonly string[],
) {
  const id = promotedIDs.at(-1)
  if (!id) return undefined
  const value = yield* get(db, id)
  return value?.rootSessionID === rootSessionID && value.promotedSeq !== null ? value : undefined
})

/** Binds the actual provider receipt, not just a reusable context selection. A steer may
 * reuse its activity/selection while starting a new semantic user epoch. Missing lineage
 * disables reacquire without making ordinary chat depend on browser metadata capacity. */
export const recordTurn = Effect.fn("SharedBrowserUserInput.recordTurn")(function* (
  db: Database.Interface["db"],
  input: {
    sessionID: string
    activityID: string
    selectionID: string
    receiptID: string
    projectionHash: string
    promotedInputIDs: readonly string[]
  },
) {
  yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const actual = yield* tx
            .select({
              receipt: V2ProviderTurnReceiptTable,
              attempt: SessionProviderAttemptTable,
              selection: SessionContextSelectionTable,
            })
            .from(V2ProviderTurnReceiptTable)
            .innerJoin(
              SessionProviderAttemptTable,
              eq(SessionProviderAttemptTable.attempt_id, V2ProviderTurnReceiptTable.provider_attempt_id),
            )
            .innerJoin(
              SessionContextSelectionTable,
              eq(SessionContextSelectionTable.selection_id, SessionProviderAttemptTable.selection_id),
            )
            .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptID))
            .get()
          if (
            !actual ||
            actual.receipt.session_id !== input.sessionID ||
            actual.receipt.activity_id !== input.activityID ||
            actual.attempt.session_id !== input.sessionID ||
            actual.attempt.activity_id !== input.activityID ||
            actual.selection.session_id !== input.sessionID ||
            actual.selection.activity_id !== input.activityID ||
            actual.selection.selection_id !== input.selectionID ||
            actual.selection.projection_hash !== input.projectionHash
          )
            return yield* denied()
          const old = yield* tx
            .select()
            .from(BrowserUserSelectionTable)
            .where(eq(BrowserUserSelectionTable.receipt_id, input.receiptID))
            .get()
          if (old) return
          const latest = input.promotedInputIDs.at(-1)
          const member = latest
            ? yield* tx
                .select()
                .from(SessionActivityInputTable)
                .where(
                  and(
                    eq(SessionActivityInputTable.activity_id, input.activityID),
                    eq(SessionActivityInputTable.input_id, latest),
                  ),
                )
                .get()
            : undefined
          if (latest && !member) return yield* denied()
          // Use the immediately preceding actual request, including a missing/null lineage. Never
          // skip an automatic turn to borrow an older owner's input from activity history.
          const previous = yield* tx
            .select({ epoch: BrowserUserSelectionTable })
            .from(V2ProviderTurnReceiptTable)
            .leftJoin(
              BrowserUserSelectionTable,
              eq(BrowserUserSelectionTable.receipt_id, V2ProviderTurnReceiptTable.receipt_id),
            )
            .where(
              and(
                eq(V2ProviderTurnReceiptTable.session_id, SessionSchema.ID.make(input.sessionID)),
                eq(V2ProviderTurnReceiptTable.activity_id, input.activityID),
                lt(V2ProviderTurnReceiptTable.request_ordinal, actual.receipt.request_ordinal),
              ),
            )
            .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal))
            .get()
          const source = latest
            ? yield* promoted(tx, input.sessionID, input.promotedInputIDs)
            : previous?.epoch?.input_id
              ? yield* get(tx, previous.epoch.input_id)
              : undefined
          if (!source && !previous?.epoch) return
          yield* SharedBrowserCapacity.reserve(tx, "selection")
          yield* tx
            .insert(BrowserUserSelectionTable)
            .values({
              receipt_id: input.receiptID,
              selection_id: input.selectionID,
              session_id: input.sessionID,
              activity_id: input.activityID,
              request_ordinal: actual.receipt.request_ordinal,
              projection_hash: input.projectionHash,
              input_id: source?.inputID ?? null,
              origin_hash: source?.originHash ?? null,
              promoted_seq: source?.promotedSeq ?? null,
              created_at: Date.now(),
            })
            .run()
        }),
      { behavior: "immediate" },
    )
    .pipe(
      Effect.mapError(() => denied()),
      Effect.catchTag("Browser.Error", () => Effect.void),
    )
})

export const witness = Effect.fn("SharedBrowserUserInput.witness")(function* (db: Reader, providerReceiptID: string) {
  const row = yield* db
    .select({
      receipt: V2ProviderTurnReceiptTable,
      selection: SessionContextSelectionTable,
      epoch: BrowserUserSelectionTable,
    })
    .from(V2ProviderTurnReceiptTable)
    .innerJoin(
      SessionContextSelectionTable,
      eq(
        SessionContextSelectionTable.selection_id,
        sql<string>`json_extract(${V2ProviderTurnReceiptTable.prepared_turn}, '$.context_selection_id')`,
      ),
    )
    .innerJoin(
      BrowserUserSelectionTable,
      eq(BrowserUserSelectionTable.receipt_id, V2ProviderTurnReceiptTable.receipt_id),
    )
    .where(eq(V2ProviderTurnReceiptTable.receipt_id, providerReceiptID))
    .get()
    .pipe(Effect.mapError(() => denied()))
  if (!row?.epoch.input_id) return undefined
  const origin = yield* get(db, row.epoch.input_id)
  if (
    !origin ||
    origin.promotedSeq === null ||
    origin.rootSessionID !== row.receipt.session_id ||
    row.selection.session_id !== origin.rootSessionID ||
    row.epoch.session_id !== origin.rootSessionID ||
    row.selection.activity_id !== row.epoch.activity_id ||
    row.selection.activity_id !== row.receipt.activity_id ||
    row.epoch.origin_hash !== origin.originHash ||
    row.epoch.promoted_seq !== origin.promotedSeq ||
    row.epoch.projection_hash !== row.selection.projection_hash ||
    row.epoch.selection_id !== row.selection.selection_id ||
    row.epoch.request_ordinal !== row.receipt.request_ordinal ||
    row.receipt.prepared_turn?.context_selection_id !== row.selection.selection_id ||
    row.receipt.prepared_turn.context_projection_hash !== row.selection.projection_hash ||
    Hash.sha256(row.selection.projection) !== row.selection.projection_hash
  )
    return yield* denied()
  return {
    inputID: origin.inputID,
    rootSessionID: origin.rootSessionID,
    mainIncarnation: origin.mainIncarnation,
    submissionOrder: origin.submissionOrder,
    admittedSeq: origin.admittedSeq,
    promotedSeq: origin.promotedSeq,
    originHash: origin.originHash,
    providerReceiptID,
    selectionID: row.selection.selection_id,
    projectionHash: row.selection.projection_hash,
  } satisfies SharedBrowserSchema.UserWitness
})
