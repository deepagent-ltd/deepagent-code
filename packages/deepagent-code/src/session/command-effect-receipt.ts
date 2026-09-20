// P0-4: receipted command side effects. `!`-shell template blocks and the
// command.execute.before plugin trigger execute OS/plugin work BEFORE the durable
// prompt admission (the admission needs the interpolated prompt text), so each
// write-class effect runs under its own durable receipt instead: intent row first,
// execute, settle. A crash between intent and settle leaves the pending row as a
// queryable UNKNOWN outcome; retries quarantine it fail-closed (typed error, no
// blind re-execution) and only an explicit force starts a new attempt.
import { realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { and, desc, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { Hash } from "@deepagent-code/core/util/hash"
import { Data, Effect } from "effect"
import { SessionActivityOwner } from "./activity-owner"

export type Kind = "shell" | "plugin_hook"

// Fail-closed quarantine: the prior attempt began but never settled, so its OS/plugin
// outcome is unknown and re-execution is refused (it may have already run once).
export class UnknownOutcome extends Data.TaggedError("CommandEffectReceipt.UnknownOutcome")<{
  readonly operationKey: string
  readonly attempt: number
  readonly kind: Kind
  readonly payload: string
  readonly detail: string
}> {}

// Definite prior failure: the settled_error outcome is reused instead of re-executing.
export class PriorError extends Data.TaggedError("CommandEffectReceipt.PriorError")<{
  readonly operationKey: string
  readonly attempt: number
  readonly payload: string
  readonly detail: string
}> {}

export type Error = UnknownOutcome | PriorError

export const CommandSideEffectReceiptTable = sqliteTable("command_side_effect_receipt", {
  operation_key: text().notNull(),
  attempt: integer().notNull(),
  session_id: text().notNull(),
  kind: text().$type<Kind>().notNull(),
  status: text()
    .$type<"pending" | "unknown" | "settled_ok" | "settled_error">()
    .notNull(),
  effect_payload: text().notNull(),
  output: text(),
  error: text(),
  exit_code: integer(),
  owner_token: text().notNull(),
  time_created: integer().notNull(),
  time_settled: integer(),
})

// Deterministic operation identity: session + command + arguments + effect payload.
// A duplicate delivery of the same command resolves the same key and reuses the
// settled outcome; a changed template/args naturally changes the payload and key.
export const operationKey = (input: {
  readonly sessionID: string
  readonly command: string
  readonly arguments: string
  readonly kind: Kind
  readonly payload: string
}) =>
  Hash.sha256(
    ["command-side-effect:v1", input.sessionID, input.command, input.arguments, input.kind, input.payload].join("\n"),
  )

type SettledRow = Row & { readonly status: "settled_ok" | "settled_error" }

type Begin =
  | { readonly kind: "begun"; readonly attempt: number; readonly ownerToken: string }
  | { readonly kind: "reused"; readonly row: SettledRow }
  | { readonly kind: "quarantine"; readonly row: Row & { readonly status: "pending" | "unknown" } }

type Row = typeof CommandSideEffectReceiptTable.$inferSelect

const begin = Effect.fn("CommandEffectReceipt.begin")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly operationKey: string
  readonly sessionID: string
  readonly kind: Kind
  readonly payload: string
  readonly force: boolean
}) {
  const ownerToken = `${SessionActivityOwner.processOwnerToken}:${randomUUID()}`
  return yield* input.db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const latest = yield* tx
            .select()
            .from(CommandSideEffectReceiptTable)
            .where(eq(CommandSideEffectReceiptTable.operation_key, input.operationKey))
            .orderBy(desc(CommandSideEffectReceiptTable.attempt))
            .get()
            .pipe(Effect.orDie)
          // force deliberately skips the settled/pending inspection: it starts the next
          // attempt and leaves prior rows as append-only audit.
          if (!input.force) {
            if (latest?.status === "settled_ok" || latest?.status === "settled_error")
              return { kind: "reused" as const, row: latest }
            if (latest) {
              // Quarantine: an unsettled prior attempt may have executed the effect. The
              // CAS keeps the transition idempotent when a concurrent begin already claimed it.
              if (latest.status === "pending")
                yield* tx
                  .update(CommandSideEffectReceiptTable)
                  .set({ status: "unknown" })
                  .where(
                    and(
                      eq(CommandSideEffectReceiptTable.operation_key, input.operationKey),
                      eq(CommandSideEffectReceiptTable.attempt, latest.attempt),
                      eq(CommandSideEffectReceiptTable.status, "pending"),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
              return { kind: "quarantine" as const, row: latest }
            }
          }
          const inserted = yield* tx
            .insert(CommandSideEffectReceiptTable)
            .values({
              operation_key: input.operationKey,
              attempt: latest ? latest.attempt + 1 : 1,
              session_id: input.sessionID,
              kind: input.kind,
              status: "pending",
              effect_payload: input.payload,
              owner_token: ownerToken,
              time_created: Date.now(),
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (inserted) return { kind: "begun" as const, attempt: inserted.attempt, ownerToken }
          // Lost the insert race: the winner committed an intent that is unsettled by
          // construction (settles happen only after begin returns), so quarantine.
          const raced = yield* tx
            .select()
            .from(CommandSideEffectReceiptTable)
            .where(eq(CommandSideEffectReceiptTable.operation_key, input.operationKey))
            .orderBy(desc(CommandSideEffectReceiptTable.attempt))
            .get()
            .pipe(Effect.orDie)
          if (!raced || raced.status === "settled_ok" || raced.status === "settled_error")
            return yield* Effect.die("command effect begin race observed an impossible settle")
          return { kind: "quarantine" as const, row: raced }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

const settle = Effect.fn("CommandEffectReceipt.settle")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly operationKey: string
  readonly attempt: number
  readonly ownerToken: string
  readonly outcome:
    | { readonly status: "settled_ok"; readonly output: string | null; readonly exitCode?: number }
    | { readonly status: "settled_error"; readonly error: string }
}) {
  const settled = yield* input.db
    .update(CommandSideEffectReceiptTable)
    .set({
      status: input.outcome.status,
      ...(input.outcome.status === "settled_ok"
        ? { output: input.outcome.output, ...(input.outcome.exitCode === undefined ? {} : { exit_code: input.outcome.exitCode }) }
        : { error: input.outcome.error }),
      time_settled: Date.now(),
    })
    .where(
      and(
        eq(CommandSideEffectReceiptTable.operation_key, input.operationKey),
        eq(CommandSideEffectReceiptTable.attempt, input.attempt),
        eq(CommandSideEffectReceiptTable.owner_token, input.ownerToken),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  // Unreachable unless the row vanished: the delete guard forbids removal and the
  // owner token is private to this begin.
  if (!settled) return yield* Effect.die("command effect settle lost its own pending row")
})

type CrashPoint = "after_intent_insert" | "after_execute_before_settle"

// Test-only crash injection (activity-crash-test pattern): parks the fiber forever
// after the intent commit (or after execute, before settle) so a test can interrupt
// it and assert the durable state a real crash leaves behind.
const pauseAtCrashPoint = (point: CrashPoint) => {
  if (process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_POINT !== point) return Effect.void
  return Effect.promise(async () => {
    const root = process.env.DEEPAGENT_CODE_TEST_ROOT
    const marker = process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_MARKER
    if (!root || !marker) throw new Error("Command effect crash injection requires an isolated test root and marker")
    const resolvedRoot = await realpath(root)
    const resolvedMarker = path.join(await realpath(path.dirname(marker)), path.basename(marker))
    if (resolvedMarker !== resolvedRoot && !resolvedMarker.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Command effect crash marker must stay inside DEEPAGENT_CODE_TEST_ROOT")
    }
    await writeFile(resolvedMarker, `${JSON.stringify({ point, pid: process.pid, reachedAt: Date.now() })}\n`)
    await new Promise<never>(() => {})
  })
}

export const run = Effect.fn("CommandEffectReceipt.run")(function* <E, R>(input: {
  readonly db: Database.Interface["db"]
  readonly operationKey: string
  readonly sessionID: string
  readonly kind: Kind
  readonly payload: string
  readonly force?: boolean
  readonly execute: () => Effect.Effect<{ readonly output: string | null; readonly exitCode?: number }, E, R>
}) {
  const begun = yield* begin({
    db: input.db,
    operationKey: input.operationKey,
    sessionID: input.sessionID,
    kind: input.kind,
    payload: input.payload,
    force: input.force === true,
  })
  if (begun.kind === "reused") {
    if (begun.row.status === "settled_ok") return { output: begun.row.output, exitCode: begun.row.exit_code ?? null }
    return yield* new PriorError({
      operationKey: input.operationKey,
      attempt: begun.row.attempt,
      payload: input.payload,
      detail:
        `Prior execution of the ${input.kind} side effect (attempt ${begun.row.attempt}, payload: ${input.payload}) ` +
        `settled with an error and was not re-executed: ${begun.row.error ?? "unknown prior error"}. ` +
        "Re-run the command with force to start a new attempt.",
    })
  }
  if (begun.kind === "quarantine")
    return yield* new UnknownOutcome({
      operationKey: input.operationKey,
      attempt: begun.row.attempt,
      kind: input.kind,
      payload: input.payload,
      detail:
        `Prior execution of the ${input.kind} side effect (attempt ${begun.row.attempt}, payload: ${input.payload}) ` +
        "never settled, so its outcome is unknown; re-execution is refused because the OS/plugin effect may have " +
        "already run. Re-run the command with force to start a new attempt.",
    })
  yield* pauseAtCrashPoint("after_intent_insert")
  // An execute FAILURE is a definite outcome: settle it, then surface the original
  // error so the caller treats it exactly like an unguarded failure.
  const executed = yield* input.execute().pipe(
    Effect.tapError((error) =>
      settle({
        db: input.db,
        operationKey: input.operationKey,
        attempt: begun.attempt,
        ownerToken: begun.ownerToken,
        outcome: { status: "settled_error", error: error instanceof Error ? error.message : String(error) },
      }),
    ),
  )
  yield* pauseAtCrashPoint("after_execute_before_settle")
  yield* settle({
    db: input.db,
    operationKey: input.operationKey,
    attempt: begun.attempt,
    ownerToken: begun.ownerToken,
    outcome: { status: "settled_ok", output: executed.output, exitCode: executed.exitCode },
  })
  return { output: executed.output, exitCode: executed.exitCode ?? null }
})

export const latestRow = (db: Database.Interface["db"], key: string) =>
  db
    .select()
    .from(CommandSideEffectReceiptTable)
    .where(eq(CommandSideEffectReceiptTable.operation_key, key))
    .orderBy(desc(CommandSideEffectReceiptTable.attempt))
    .get()
    .pipe(Effect.orDie)

export * as CommandEffectReceipt from "./command-effect-receipt"
