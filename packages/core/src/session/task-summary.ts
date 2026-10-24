export * as TaskSummary from "./task-summary"

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { GoalChild } from "../deepagent/goal-child"
import { GoalChildUnitTable } from "../deepagent/goal-child.sql"
import { GoalControl } from "../deepagent/goal-control"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { SessionMessageTable, SessionTable, TaskNotificationOutboxTable, TaskRunTable } from "./sql"
import { TaskSummarySchema } from "./task-summary.schema"
import { V2StructuredOutputEvidenceTable } from "./runner/v2-structured-output-evidence.sql"

type Reader = Parameters<typeof GoalChild.read>[0]
const LIMIT = 100
const visibleContent = Schema.Struct({ content: Schema.Array(Schema.Unknown) })
const textPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const toolPart = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.String,
  state: Schema.Struct({ status: Schema.Literals(["pending", "running", "completed", "error"]) }),
})

/** Read facts from the original ledger, never bootstrap a Location or wake a Session.
 * Scope comes from the authenticated Host, not from child ids supplied by a client. */
export const read = Effect.fn("TaskSummary.read")(function* (
  db: Reader,
  input: { parentSessionID: string; projectID: string; directory: string; workspaceID?: string; cursor?: string },
) {
  const parentID = SessionSchema.ID.make(input.parentSessionID)
  const parent = yield* db.select().from(SessionTable).where(eq(SessionTable.id, parentID)).get().pipe(Effect.orDie)
  if (!parent) return yield* new TaskSummarySchema.Unavailable({ reason: "not_found" })
  if (
    parent.project_id !== input.projectID ||
    parent.directory !== input.directory ||
    (parent.workspace_id ?? undefined) !== input.workspaceID
  )
    return yield* new TaskSummarySchema.Unavailable({ reason: "scope_changed" })

  // Include admitted runs whose child Session has not been materialized yet. Cursor ordering is
  // by stable child identity; generation changes cannot duplicate a child across pages.
  const identities = yield* db
    .all<{ id: string }>(
      sql`
    SELECT id FROM (
      SELECT id FROM session WHERE parent_id=${parentID}
      UNION SELECT child_session_id AS id FROM task_run WHERE parent_session_id=${parentID}
    ) WHERE id>${input.cursor ?? ""} ORDER BY id LIMIT ${LIMIT + 1}
  `,
    )
    .pipe(Effect.orDie)
  const ids = identities.slice(0, LIMIT).map((row) => SessionSchema.ID.make(row.id))
  if (ids.length === 0)
    return {
      parentSessionID: parentID,
      observedAt: Date.now(),
      items: [],
      hasMore: false,
      nextCursor: null,
    } satisfies TaskSummarySchema.Summary
  const children = yield* db.select().from(SessionTable).where(inArray(SessionTable.id, ids)).all().pipe(Effect.orDie)
  const runs = yield* db
    .select()
    .from(TaskRunTable)
    .where(
      and(
        eq(TaskRunTable.parent_session_id, parentID),
        inArray(TaskRunTable.child_session_id, ids),
        sql`NOT EXISTS (SELECT 1 FROM task_run newer WHERE newer.parent_session_id=${parentID}
      AND newer.child_session_id=task_run.child_session_id AND newer.generation>task_run.generation)`,
      ),
    )
    .orderBy(desc(TaskRunTable.generation), asc(TaskRunTable.run_id))
    .all()
    .pipe(Effect.orDie)
  const notifications =
    runs.length === 0
      ? []
      : yield* db
          .select({
            runID: TaskNotificationOutboxTable.run_id,
            state: TaskNotificationOutboxTable.status,
            updatedAt: TaskNotificationOutboxTable.time_updated,
            deliveredAt: TaskNotificationOutboxTable.time_delivered,
          })
          .from(TaskNotificationOutboxTable)
          .where(
            and(
              eq(TaskNotificationOutboxTable.parent_session_id, parentID),
              inArray(
                TaskNotificationOutboxTable.run_id,
                runs.map((run) => run.run_id),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)
  const evidence =
    runs.length === 0
      ? []
      : yield* db
          .select({
            runID: V2StructuredOutputEvidenceTable.run_id,
            childID: V2StructuredOutputEvidenceTable.child_session_id,
            messageID: V2StructuredOutputEvidenceTable.output_message_id,
          })
          .from(V2StructuredOutputEvidenceTable)
          .where(
            and(
              eq(V2StructuredOutputEvidenceTable.session_id, parentID),
              eq(V2StructuredOutputEvidenceTable.validation_outcome, "validated"),
              inArray(
                V2StructuredOutputEvidenceTable.run_id,
                runs.map((run) => run.run_id),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)
  const goalUnits = yield* db
    .select({
      unitID: GoalChildUnitTable.unit_id,
      childID: GoalChildUnitTable.child_session_id,
    })
    .from(GoalChildUnitTable)
    .where(and(eq(GoalChildUnitTable.parent_session_id, parentID), inArray(GoalChildUnitTable.child_session_id, ids)))
    .all()
    .pipe(Effect.orDie)
  const items = yield* Effect.forEach(ids, (childID) =>
    Effect.gen(function* () {
      const child = children.find((row) => row.id === childID)
      const run = runs.find((row) => row.child_session_id === childID)
      // A corrupt/cross-project relationship is not authority to expose another Session's text.
      if (
        child &&
        (child.parent_id !== parentID ||
          child.project_id !== parent.project_id ||
          child.workspace_id !== parent.workspace_id ||
          child.directory !== (run?.workspace_mode === "worktree" ? run.worktree_directory : parent.directory))
      )
        return undefined
      if (!child && !run) return undefined
      const initial = run?.child_message_id
        ? yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, SessionMessage.ID.make(run.child_message_id)),
                eq(SessionMessageTable.session_id, childID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      const messages =
        child && (!run || initial)
          ? yield* db
              .select({
                id: SessionMessageTable.id,
                data: SessionMessageTable.data,
              })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, childID),
                  eq(SessionMessageTable.type, "assistant"),
                  initial ? sql`${SessionMessageTable.seq}>=${initial.seq}` : undefined,
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(8)
              .all()
              .pipe(Effect.orDie)
          : []
      const progress =
        messages.flatMap((message) => {
          const content = Option.getOrUndefined(Schema.decodeUnknownOption(visibleContent)(message.data))
          if (!content) return []
          const text = content.content
            .flatMap((part) => {
              const value = Option.getOrUndefined(Schema.decodeUnknownOption(textPart)(part))
              return value ? [value.text] : []
            })
            .join("\n")
            .trim()
          const tool =
            content.content
              .flatMap((part) => {
                const value = Option.getOrUndefined(Schema.decodeUnknownOption(toolPart)(part))
                return value ? [{ name: value.name.slice(0, 128), status: value.state.status }] : []
              })
              .at(-1) ?? null
          return text || tool ? [{ messageID: message.id, text: Array.from(text).slice(0, 1200).join(""), tool }] : []
        })[0] ?? null
      const goalUnitID = !run ? goalUnits.find((item) => item.childID === childID)?.unitID : undefined
      const goalUnit = goalUnitID
        ? yield* GoalChild.read(db, goalUnitID).pipe(
            Effect.catchTag("GoalChild.Error", () => Effect.succeed(undefined)),
          )
        : undefined
      const goalResult =
        child &&
        goalUnit?.state === "result_recorded" &&
        goalUnit.binding.version !== 1 &&
        goalUnit.binding.parentSessionID === parentID &&
        goalUnit.binding.childSessionID === childID &&
        goalUnit.binding.projectID === parent.project_id &&
        goalUnit.binding.directory === parent.directory &&
        (goalUnit.binding.workspaceID ?? null) === parent.workspace_id &&
        goalUnit.creation_receipt &&
        goalUnit.inputs.length > 0 &&
        goalUnit.inputs.every(
          (input) =>
            input.execution?.state === "settled" &&
            input.admittedSeq !== null &&
            input.activityID !== null &&
            input.resultRef !== null &&
            input.resultHash !== null,
        )
          ? goalUnit.inputs.at(-1)
          : undefined
      const terminalGoalResult =
        goalResult &&
        (goalUnit?.binding.mode === "plain"
          ? goalResult.stage === "plain"
          : goalResult.stage === "finalizer.1" || goalResult.stage === "finalizer.2")
          ? goalResult
          : undefined
      const candidateMessageID =
        evidence.find((row) => row.runID === run?.run_id && row.childID === childID)?.messageID ??
        run?.raw_result_message_id ??
        terminalGoalResult?.resultRef ??
        null
      const message = candidateMessageID
        ? yield* db
            .select({ data: SessionMessageTable.data })
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, SessionMessage.ID.make(candidateMessageID)),
                eq(SessionMessageTable.session_id, childID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      const goalMessage =
        message && terminalGoalResult
          ? Option.getOrUndefined(
              Schema.decodeUnknownOption(SessionMessage.Assistant)({
                ...message.data,
                id: candidateMessageID,
                type: "assistant",
              }),
            )
          : undefined
      const goalText = goalMessage?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      const recordedGoalResult =
        goalMessage?.finish === "stop" &&
        !goalMessage.error &&
        goalText !== undefined &&
        GoalControl.fingerprint({ text: goalText }) === terminalGoalResult?.resultHash
      const messageID = run || recordedGoalResult ? candidateMessageID : null
      const resultContent =
        message && (run || recordedGoalResult)
          ? Option.getOrUndefined(
              Schema.decodeUnknownOption(
                Schema.Struct({
                  content: Schema.Array(Schema.Unknown),
                  structured: Schema.optional(Schema.Unknown),
                }),
              )(message.data),
            )
          : undefined
      const result =
        (!run && recordedGoalResult
          ? goalText?.trim()
          : resultContent?.structured !== undefined
            ? JSON.stringify(resultContent.structured)
            : resultContent?.content
                .flatMap((part) => {
                  const value = Option.getOrUndefined(Schema.decodeUnknownOption(textPart)(part))
                  return value ? [value.text] : []
                })
                .join("\n")
                .trim()) ||
        run?.output?.trim() ||
        ""
      const text = Array.from(result).slice(0, 8000).join("")
      const notification = run ? notifications.find((row) => row.runID === run.run_id) : undefined
      const agent = typeof run?.execution_spec?.agent === "string" ? run.execution_spec.agent : (child?.agent ?? null)
      return {
        childSessionID: childID,
        title: (child?.title ?? "").slice(0, 512),
        agent: agent?.slice(0, 128) ?? null,
        state: run?.state ?? "unknown",
        runID: run?.run_id ?? null,
        generation: run?.generation ?? null,
        controlState: run?.control_state ?? null,
        createdAt: run?.time_created ?? child!.time_created,
        updatedAt: run?.time_updated ?? child!.time_updated,
        settledAt: run?.time_settled ?? null,
        progress,
        result: {
          state: result ? "available" : !run || messageID ? "unknown" : "not_available",
          text: text || null,
          messageID,
          truncated: text.length < result.length,
        },
        notification: {
          state: notification?.state ?? "not_established",
          updatedAt: notification?.updatedAt ?? null,
          deliveredAt: notification?.deliveredAt ?? null,
        },
      } satisfies TaskSummarySchema.Item
    }),
  )
  return {
    parentSessionID: parentID,
    observedAt: Date.now(),
    items: items.filter((item) => item !== undefined),
    hasMore: identities.length > LIMIT,
    nextCursor: identities.length > LIMIT ? ids.at(-1)! : null,
  } satisfies TaskSummarySchema.Summary
})
