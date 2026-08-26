import { Database } from "@deepagent-code/core/database/database"
import {
  MessageTable,
  PartTable,
  TaskRunTable,
  TaskStructuredOutputEvidencePartTable,
  TaskStructuredOutputEvidenceTable,
  TaskStructuredFinalizerResponseTable,
} from "@deepagent-code/core/session/sql"
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Run, StructuredOutputReceipt } from "@/tool/task-run"
import { extractStructuredText, validateStructuredOutput } from "@/tool/task-structured-output"

type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
const degradedRawResultMaxChars = 80_000

export function boundDegradedRawResult(raw: string) {
  return Array.from(raw).slice(0, degradedRawResultMaxChars).join("")
}

export function makeDegradedStructuredOutput(
  raw: string,
  receipt: Extract<StructuredOutputReceipt, { readonly transport: "degraded_text" }>,
) {
  return JSON.stringify({
    _degraded: true,
    _reason: receipt.reason,
    _attempts: receipt.attempt,
    _raw: boundDegradedRawResult(raw),
  })
}

export function persistStructuredOutputEvidenceInTransaction(
  tx: Transaction,
  input: {
    readonly runID: string
    readonly childSessionID: string
    readonly ownerToken: string
    readonly claimGeneration: number
    readonly expectedVersion: number
    readonly terminalState: "completed" | "failed"
    readonly attempts: number
    readonly contract: NonNullable<NonNullable<Run["executionSpec"]>["structuredOutput"]>
    readonly rawResultMessageID?: string
    readonly structuredResultMessageID?: string
    readonly output?: string
    readonly structuredOutputReceipt?: StructuredOutputReceipt
    readonly failureCode?: string
    readonly now: number
  },
) {
  return Effect.gen(function* () {
    if (!input.rawResultMessageID)
      return yield* Effect.die("structured task settlement is missing raw research evidence")
    if (input.terminalState === "completed" && (!input.output || !input.structuredOutputReceipt)) {
      return yield* Effect.die("structured task completion is missing output or receipt")
    }
    if (input.terminalState === "failed" && !input.failureCode) {
      return yield* Effect.die("structured task failure is missing its durable failure code")
    }

    const raw = yield* readMessageMaterial(tx, input.childSessionID, input.rawResultMessageID)
    const result = input.structuredResultMessageID
      ? yield* readMessageMaterial(tx, input.childSessionID, input.structuredResultMessageID)
      : undefined
    const contractJson = JSON.stringify(input.contract)
    const rawMessageJson = JSON.stringify(raw.message.data)
    const rawPartsJson = JSON.stringify(raw.parts)
    const resultMessageJson = result ? JSON.stringify(result.message.data) : undefined
    const resultPartsJson = result ? JSON.stringify(result.parts) : undefined

    const existing = yield* tx
      .select()
      .from(TaskStructuredOutputEvidenceTable)
      .where(eq(TaskStructuredOutputEvidenceTable.run_id, input.runID))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (
        existing.child_session_id !== input.childSessionID ||
        existing.owner_token !== input.ownerToken ||
        existing.claim_generation !== input.claimGeneration ||
        existing.expected_version > input.expectedVersion ||
        existing.terminal_state !== input.terminalState ||
        existing.attempts !== input.attempts ||
        existing.contract_json !== contractJson ||
        existing.raw_result_message_id !== input.rawResultMessageID ||
        existing.raw_message_json !== rawMessageJson ||
        existing.raw_parts_json !== rawPartsJson ||
        (existing.result_message_id ?? undefined) !== input.structuredResultMessageID ||
        (existing.result_message_json ?? undefined) !== resultMessageJson ||
        (existing.result_parts_json ?? undefined) !== resultPartsJson ||
        (existing.output ?? undefined) !== input.output ||
        JSON.stringify(existing.structured_output_receipt) !== JSON.stringify(input.structuredOutputReceipt) ||
        (existing.failure_code ?? undefined) !== input.failureCode
      ) {
        return yield* Effect.die("structured task completion conflicts with its sealed material evidence")
      }
      return
    }

    if (
      input.terminalState === "completed" &&
      input.structuredOutputReceipt?.transport !== "degraded_text" &&
      input.structuredResultMessageID
    ) {
      const prepared = yield* tx
        .select()
        .from(TaskStructuredFinalizerResponseTable)
        .where(
          and(
            eq(TaskStructuredFinalizerResponseTable.run_id, input.runID),
            eq(TaskStructuredFinalizerResponseTable.attempt, input.structuredOutputReceipt?.attempt ?? 0),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (
        !prepared ||
        prepared.child_session_id !== input.childSessionID ||
        prepared.owner_token !== input.ownerToken ||
        prepared.claim_generation !== input.claimGeneration ||
        prepared.expected_version > input.expectedVersion ||
        prepared.source_message_id !== input.rawResultMessageID ||
        prepared.response_message_id !== input.structuredResultMessageID ||
        prepared.response_message_json !== resultMessageJson
      ) {
        return yield* Effect.die("structured task completion is missing its exact prepared response authority")
      }
    }

    yield* tx
      .insert(TaskStructuredOutputEvidenceTable)
      .values({
        run_id: input.runID,
        child_session_id: SessionID.make(input.childSessionID),
        owner_token: input.ownerToken,
        claim_generation: input.claimGeneration,
        expected_version: input.expectedVersion,
        terminal_state: input.terminalState,
        attempts: input.attempts,
        contract_json: contractJson,
        raw_result_message_id: MessageID.make(input.rawResultMessageID),
        raw_message_json: rawMessageJson,
        raw_parts_json: rawPartsJson,
        result_message_id: input.structuredResultMessageID ? MessageID.make(input.structuredResultMessageID) : null,
        result_message_json: resultMessageJson,
        result_parts_json: resultPartsJson,
        output: input.output,
        structured_output_receipt: input.structuredOutputReceipt,
        failure_code: input.failureCode,
        created_at: input.now,
      })
      .run()
      .pipe(Effect.orDie)

    const parts = [
      ...raw.parts.map((part, ordinal) => ({ role: "raw" as const, part, ordinal })),
      ...(result?.parts.map((part, ordinal) => ({ role: "result" as const, part, ordinal })) ?? []),
    ]
    if (parts.length === 0) return
    yield* tx
      .insert(TaskStructuredOutputEvidencePartTable)
      .values(
        parts.map((item) => ({
          run_id: input.runID,
          role: item.role,
          ordinal: item.ordinal,
          part_id: PartID.make(item.part.id),
          message_id: MessageID.make(item.part.messageID),
          session_id: SessionID.make(item.part.sessionID),
          part_json: JSON.stringify(item.part.data),
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

function readMessageMaterial(tx: Transaction, childSessionID: string, messageID: string) {
  return Effect.gen(function* () {
    const message = yield* tx
      .select({ id: MessageTable.id, sessionID: MessageTable.session_id, data: MessageTable.data })
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.id, MessageID.make(messageID)),
          eq(MessageTable.session_id, SessionID.make(childSessionID)),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!message || message.data.role !== "assistant") {
      return yield* Effect.die(`structured task evidence message is missing or invalid: ${messageID}`)
    }
    const parts = yield* tx
      .select({
        id: PartTable.id,
        messageID: PartTable.message_id,
        sessionID: PartTable.session_id,
        data: PartTable.data,
      })
      .from(PartTable)
      .where(
        and(
          eq(PartTable.message_id, MessageID.make(messageID)),
          eq(PartTable.session_id, SessionID.make(childSessionID)),
        ),
      )
      .orderBy(asc(PartTable.id))
      .all()
      .pipe(Effect.orDie)
    return { message, parts }
  })
}

export function isStructuredOutputContract(
  input: unknown,
): input is NonNullable<NonNullable<Run["executionSpec"]>["structuredOutput"]> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export function persistStructuredFinalizerResponse(input: {
  readonly runID: string
  readonly childSessionID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly attempt: 1 | 2
  readonly sourceMessageID: MessageID
  readonly responseMessageID: MessageID
  readonly contract: NonNullable<NonNullable<Run["executionSpec"]>["structuredOutput"]>
  readonly receipt: StructuredOutputReceipt
  readonly output: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select({
                version: TaskRunTable.version,
                attempts: TaskRunTable.attempts,
                rawResultMessageID: TaskRunTable.raw_result_message_id,
                executionSpec: TaskRunTable.execution_spec,
              })
              .from(TaskRunTable)
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.child_session_id, SessionID.make(input.childSessionID)),
                  eq(TaskRunTable.state, "finalizing"),
                  eq(TaskRunTable.control_state, "open"),
                  eq(TaskRunTable.execution_owner, input.ownerToken),
                  eq(TaskRunTable.claim_generation, input.claimGeneration),
                  isNull(TaskRunTable.interrupt_requested_at),
                  gt(TaskRunTable.lease_expires_at, now),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (
              !current ||
              current.attempts !== input.attempt ||
              current.rawResultMessageID !== input.sourceMessageID ||
              JSON.stringify(current.executionSpec?.structuredOutput) !== JSON.stringify(input.contract) ||
              input.receipt.attempt !== input.attempt ||
              input.receipt.transport === "degraded_text"
            ) {
              return yield* Effect.die("structured finalizer response lost its durable run fence")
            }
            const material = yield* readMessageMaterial(tx, input.childSessionID, input.responseMessageID)
            const message = material.message.data as SessionV1.Info
            const parts = material.parts.map((part) => part.data as SessionV1.Part)
            const structured = message.role === "assistant" ? message.structured : undefined
            const candidate =
              structured === undefined && input.receipt.transport === "text_fallback"
                ? extractStructuredText(
                    parts
                      .flatMap((part) =>
                        part.type === "text" && part.synthetic !== true && part.ignored !== true ? [part.text] : [],
                      )
                      .join("\n"),
                  )
                : structured
            if (
              message.role !== "assistant" ||
              message.error ||
              !message.parentID ||
              candidate === undefined ||
              validateStructuredOutput(input.contract.schema, candidate) ||
              JSON.stringify(candidate) !== input.output ||
              (input.receipt.transport === "structured") !== (structured !== undefined)
            ) {
              return yield* Effect.die("structured finalizer response does not match the validated completion")
            }
            yield* tx
              .insert(TaskStructuredFinalizerResponseTable)
              .values({
                run_id: input.runID,
                attempt: input.attempt,
                child_session_id: SessionID.make(input.childSessionID),
                owner_token: input.ownerToken,
                claim_generation: input.claimGeneration,
                expected_version: current.version,
                source_message_id: input.sourceMessageID,
                request_message_id: MessageID.make(message.parentID),
                response_message_id: input.responseMessageID,
                response_message_json: JSON.stringify(message),
                created_at: now,
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            const prepared = yield* tx
              .select()
              .from(TaskStructuredFinalizerResponseTable)
              .where(
                and(
                  eq(TaskStructuredFinalizerResponseTable.run_id, input.runID),
                  eq(TaskStructuredFinalizerResponseTable.attempt, input.attempt),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (
              !prepared ||
              prepared.child_session_id !== input.childSessionID ||
              prepared.owner_token !== input.ownerToken ||
              prepared.claim_generation !== input.claimGeneration ||
              prepared.expected_version !== current.version ||
              prepared.source_message_id !== input.sourceMessageID ||
              prepared.request_message_id !== message.parentID ||
              prepared.response_message_id !== input.responseMessageID ||
              prepared.response_message_json !== JSON.stringify(message)
            ) {
              return yield* Effect.die("structured finalizer response authority conflicts with the exact response")
            }
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

export function persistDegradedStructuredOutput(input: {
  readonly runID: string
  readonly childSessionID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly sourceMessageID: MessageID
  readonly contract: NonNullable<NonNullable<Run["executionSpec"]>["structuredOutput"]>
  readonly receipt: Extract<StructuredOutputReceipt, { readonly transport: "degraded_text" }>
  readonly output: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select({
                version: TaskRunTable.version,
                attempts: TaskRunTable.attempts,
                rawResultMessageID: TaskRunTable.raw_result_message_id,
                executionSpec: TaskRunTable.execution_spec,
              })
              .from(TaskRunTable)
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.child_session_id, SessionID.make(input.childSessionID)),
                  eq(TaskRunTable.state, "finalizing"),
                  eq(TaskRunTable.control_state, "open"),
                  eq(TaskRunTable.execution_owner, input.ownerToken),
                  eq(TaskRunTable.claim_generation, input.claimGeneration),
                  isNull(TaskRunTable.interrupt_requested_at),
                  gt(TaskRunTable.lease_expires_at, now),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (
              !current ||
              current.attempts !== input.receipt.attempt ||
              current.rawResultMessageID !== input.sourceMessageID ||
              JSON.stringify(current.executionSpec?.structuredOutput) !== JSON.stringify(input.contract)
            ) {
              return yield* Effect.die("degraded structured output lost its durable run fence")
            }
            const raw = yield* readMessageMaterial(tx, input.childSessionID, input.sourceMessageID)
            const text = raw.parts
              .flatMap((part) => {
                const data = part.data as SessionV1.Part
                return data.type === "text" && data.synthetic !== true && data.ignored !== true ? [data.text] : []
              })
              .join("\n")
              .trim()
            if (input.output !== makeDegradedStructuredOutput(text, input.receipt)) {
              return yield* Effect.die("degraded structured output does not match its bounded raw research material")
            }
            yield* persistStructuredOutputEvidenceInTransaction(tx, {
              runID: input.runID,
              childSessionID: input.childSessionID,
              ownerToken: input.ownerToken,
              claimGeneration: input.claimGeneration,
              expectedVersion: current.version,
              terminalState: "completed",
              attempts: input.receipt.attempt,
              contract: input.contract,
              rawResultMessageID: input.sourceMessageID,
              output: input.output,
              structuredOutputReceipt: input.receipt,
              now,
            })
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

export function recoverStructuredOutputCompletionInTransaction(
  tx: Transaction,
  input: {
    readonly runID: string
    readonly childSessionID: string
    readonly ownerToken: string
    readonly claimGeneration: number
    readonly expectedVersion: number
    readonly attempt: number
    readonly rawResultMessageID?: string
    readonly contract: NonNullable<NonNullable<Run["executionSpec"]>["structuredOutput"]>
    readonly now: number
  },
) {
  return Effect.gen(function* () {
    if (!input.rawResultMessageID) return undefined
    const sealed = yield* tx
      .select()
      .from(TaskStructuredOutputEvidenceTable)
      .where(eq(TaskStructuredOutputEvidenceTable.run_id, input.runID))
      .get()
      .pipe(Effect.orDie)
    if (sealed?.structured_output_receipt?.transport === "degraded_text") {
      const raw = yield* readMessageMaterial(tx, input.childSessionID, input.rawResultMessageID)
      const text = raw.parts
        .flatMap((part) => {
          const data = part.data as SessionV1.Part
          return data.type === "text" && data.synthetic !== true && data.ignored !== true ? [data.text] : []
        })
        .join("\n")
        .trim()
      if (
        sealed.child_session_id !== input.childSessionID ||
        sealed.owner_token !== input.ownerToken ||
        sealed.claim_generation !== input.claimGeneration ||
        sealed.expected_version > input.expectedVersion ||
        sealed.terminal_state !== "completed" ||
        sealed.attempts !== input.attempt ||
        sealed.contract_json !== JSON.stringify(input.contract) ||
        sealed.raw_result_message_id !== input.rawResultMessageID ||
        sealed.raw_message_json !== JSON.stringify(raw.message.data) ||
        sealed.raw_parts_json !== JSON.stringify(raw.parts) ||
        sealed.result_message_id !== null ||
        sealed.output !== makeDegradedStructuredOutput(text, sealed.structured_output_receipt)
      )
        return undefined
      return {
        output: sealed.output,
        structuredOutputReceipt: sealed.structured_output_receipt,
        structuredResultMessageID: undefined,
      }
    }
    const prepared = yield* tx
      .select()
      .from(TaskStructuredFinalizerResponseTable)
      .where(
        and(
          eq(TaskStructuredFinalizerResponseTable.run_id, input.runID),
          eq(TaskStructuredFinalizerResponseTable.attempt, input.attempt),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (
      prepared &&
      (prepared.child_session_id !== input.childSessionID ||
        prepared.owner_token !== input.ownerToken ||
        prepared.claim_generation !== input.claimGeneration ||
        prepared.expected_version > input.expectedVersion ||
        prepared.source_message_id !== input.rawResultMessageID)
    )
      return undefined
    const discovered = prepared
      ? {
          requestMessageID: prepared.request_message_id,
          responseMessageID: prepared.response_message_id,
          responseMessageJson: prepared.response_message_json,
        }
      : yield* tx.get<{
          readonly requestMessageID: string
          readonly responseMessageID: string
          readonly responseMessageJson: string
        }>(sql`
          SELECT
            request.id AS requestMessageID,
            response.id AS responseMessageID,
            response.data AS responseMessageJson
          FROM message response
          JOIN message request
            ON request.id = json_extract(response.data, '$.parentID')
           AND request.session_id = response.session_id
          WHERE response.session_id = ${input.childSessionID}
            AND json_valid(response.data) = 1
            AND json_extract(response.data, '$.role') = 'assistant'
            AND json_extract(response.data, '$.error') IS NULL
            AND json_valid(request.data) = 1
            AND json_extract(request.data, '$.role') = 'user'
            AND json_extract(request.data, '$.metadata.deepagent.structured_finalizer.run_id') = ${input.runID}
            AND json_extract(request.data, '$.metadata.deepagent.structured_finalizer.attempt') = ${input.attempt}
            AND json_extract(request.data, '$.metadata.deepagent.structured_finalizer.source_message_id') = ${input.rawResultMessageID}
          ORDER BY response.time_created DESC, response.id DESC
          LIMIT 1
        `)
    if (!discovered) return undefined
    const result = yield* readMessageMaterial(tx, input.childSessionID, discovered.responseMessageID)
    const message = result.message.data as SessionV1.Info
    const parts = result.parts.map((part) => part.data as SessionV1.Part)
    if (JSON.stringify(message) !== discovered.responseMessageJson || message.role !== "assistant" || message.error)
      return undefined
    const structured = message.structured
    const candidate =
      structured === undefined && input.attempt === 2 && input.contract.allowTextFallback
        ? extractStructuredText(
            parts
              .flatMap((part) =>
                part.type === "text" && part.synthetic !== true && part.ignored !== true ? [part.text] : [],
              )
              .join("\n"),
          )
        : structured
    if (candidate === undefined || validateStructuredOutput(input.contract.schema, candidate)) return undefined
    yield* tx
      .insert(TaskStructuredFinalizerResponseTable)
      .values({
        run_id: input.runID,
        attempt: input.attempt,
        child_session_id: SessionID.make(input.childSessionID),
        owner_token: input.ownerToken,
        claim_generation: input.claimGeneration,
        expected_version: input.expectedVersion,
        source_message_id: MessageID.make(input.rawResultMessageID),
        request_message_id: MessageID.make(discovered.requestMessageID),
        response_message_id: MessageID.make(discovered.responseMessageID),
        response_message_json: discovered.responseMessageJson,
        created_at: input.now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const response = yield* tx
      .select()
      .from(TaskStructuredFinalizerResponseTable)
      .where(
        and(
          eq(TaskStructuredFinalizerResponseTable.run_id, input.runID),
          eq(TaskStructuredFinalizerResponseTable.attempt, input.attempt),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!response) return undefined
    if (
      response.child_session_id !== input.childSessionID ||
      response.owner_token !== input.ownerToken ||
      response.claim_generation !== input.claimGeneration ||
      response.expected_version > input.expectedVersion ||
      response.source_message_id !== input.rawResultMessageID ||
      response.request_message_id !== discovered.requestMessageID ||
      response.response_message_id !== discovered.responseMessageID ||
      response.response_message_json !== discovered.responseMessageJson
    )
      return undefined
    const output = JSON.stringify(candidate)
    const structuredOutputReceipt = {
      attempt: input.attempt,
      transport: structured === undefined ? ("text_fallback" as const) : ("structured" as const),
    } satisfies StructuredOutputReceipt
    yield* persistStructuredOutputEvidenceInTransaction(tx, {
      ...input,
      terminalState: "completed",
      attempts: input.attempt,
      rawResultMessageID: input.rawResultMessageID,
      structuredResultMessageID: response.response_message_id,
      output,
      structuredOutputReceipt,
    })
    return { output, structuredOutputReceipt, structuredResultMessageID: response.response_message_id }
  })
}
