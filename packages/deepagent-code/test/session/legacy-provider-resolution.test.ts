import { expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ModelV2 } from "@deepagent-code/core/model"
import { NamedError } from "@deepagent-code/core/util/error"
import { ProviderV2 } from "@deepagent-code/core/provider"
import {
  SessionHistoryStateTable,
  SessionIntentTable,
  SessionPromptEpochMessageTable,
  SessionPromptEpochRecoveryTable,
  SessionTable,
  SessionToolRequestResolutionCommandTable,
  SessionToolRequestResolutionTable,
  SessionWorldStateBaselineTable,
} from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventTable } from "@deepagent-code/core/event/sql"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { MessageV2 } from "@/session/message-v2"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { recoverProviderReceiptsOnStartup } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionToolRequestReceiptTable } from "@/session/tool-request-receipt.sql"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const layer = Layer.mergeAll(
  Session.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  SessionLegacyProviderResolution.defaultLayer,
)
const it = testEffect(layer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") }
let nextMessageTime = 1

const addUser = Effect.fn("LegacyProviderResolutionTest.addUser")(function* (
  sessionID: Parameters<Session.Interface["get"]>[0],
  text: string,
) {
  const session = yield* Session.Service
  const message = yield* session.updateMessage({
    id: MessageID.ascending(`msg_${String(nextMessageTime++).padStart(26, "0")}`),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model,
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
  return message
})

const addAssistant = Effect.fn("LegacyProviderResolutionTest.addAssistant")(function* (
  sessionID: Parameters<Session.Interface["get"]>[0],
  parentID: MessageID,
  completed = false,
) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(`msg_${String(nextMessageTime++).padStart(26, "0")}`),
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), ...(completed ? { completed: Date.now() } : {}) },
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    ...(completed ? { finish: "stop" as const } : {}),
  })
})

it.instance(
  "forks the safe prefix and resolves an ambiguous legacy provider turn exactly once",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const recovery = yield* SessionLegacyProviderResolution.Service
      yield* TestInstance
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({ title: "recovery baseline parent" })
      const source = yield* sessions.fork({
        sessionID: parent.id,
        intentID: "recovery-baseline-source",
      })
      const safeUser = yield* addUser(source.id, "completed before provider crash")
      const safeAssistant = yield* addAssistant(source.id, safeUser.id, true)
      const failedUser = yield* addUser(source.id, "failed safely before provider crash")
      const failedAssistant = yield* addAssistant(source.id, failedUser.id)
      yield* sessions.updateMessage({
        ...failedAssistant,
        time: { ...failedAssistant.time, completed: Date.now() },
        error: new NamedError.Unknown({ message: "known terminal provider failure" }).toObject(),
      })
      const user = yield* addUser(source.id, "dispatch then crash")
      const assistant = yield* addAssistant(source.id, user.id)
      const unsafeTail = yield* addUser(source.id, "physical tail after ambiguous provider turn")
      const authority = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      if (!authority.worldStateBaselineHash) return yield* Effect.die("expected frozen source World State baseline")
      const baselineHash = authority.worldStateBaselineHash
      const requestHash = "final-request-hash"
      const receiptID = "receipt-ambiguous-provider-turn"
      const now = Date.now()

      yield* db
        .insert(SessionToolRequestReceiptTable)
        .values({
          receipt_id: receiptID,
          request_ordinal: 1,
          session_id: source.id,
          user_message_id: user.id,
          assistant_message_id: assistant.id,
          provider_attempt_id: null,
          provider_id: model.providerID,
          model_id: model.modelID,
          protocol: "chat",
          registry_tool_ids: [],
          permission_filtered_tool_ids: [],
          final_offered_tool_ids: [],
          call_ids: [],
          prompt_epoch: authority.epoch,
          prompt_window_id: authority.window.windowID,
          effective_history_hash: authority.effectiveHistoryHash,
          request_input_hash: "input-request-hash",
          final_request_hash: requestHash,
          provider_state: "indeterminate_after_crash",
          adapter_prepared_at: now,
          dispatching_at: now,
          terminal_at: now,
          owner_token: "stale-process",
          request_state: "dispatched",
          request_error_code: "provider_started_outcome_unknown_after_process_restart",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionToolRequestReceiptTable)
        .values({
          receipt_id: "legacy-stale-indeterminate-without-prompt-authority",
          request_ordinal: 2,
          session_id: source.id,
          user_message_id: safeUser.id,
          assistant_message_id: safeAssistant.id,
          provider_attempt_id: null,
          provider_id: model.providerID,
          model_id: model.modelID,
          protocol: "chat",
          registry_tool_ids: [],
          permission_filtered_tool_ids: [],
          final_offered_tool_ids: [],
          call_ids: [],
          provider_state: "indeterminate_after_crash",
          terminal_at: now,
          request_state: "dispatched",
          request_error_code: "legacy_migration_without_prompt_authority",
          created_at: now - 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionPromptEpochTable)
        .set({ authority_state: "recovery_required", recovery_reason: "provider outcome is unknown after restart" })
        .where(
          and(eq(SessionPromptEpochTable.session_id, source.id), eq(SessionPromptEpochTable.epoch, authority.epoch)),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionHistoryStateTable)
        .set({
          state: "recovery_required",
          reason: "provider outcome is unknown after restart",
          time_updated: now,
        })
        .where(eq(SessionHistoryStateTable.session_id, source.id))
        .run()
        .pipe(Effect.orDie)

      const safeCutoff = yield* MessageV2.promptHistoryCutoffProjectionEffect({
        sessionID: source.id,
        cutoffMessageID: user.id,
      })
      expect(
        safeCutoff.messages.map((message) => [
          message.info.id,
          message.info.role,
          message.info.role === "assistant" ? message.info.parentID : undefined,
        ]),
      ).toEqual([
        [safeUser.id, "user", undefined],
        [safeAssistant.id, "assistant", safeUser.id],
        [failedUser.id, "user", undefined],
        [failedAssistant.id, "assistant", failedUser.id],
      ])

      const fork = yield* sessions.fork({
        sessionID: source.id,
        messageID: user.id,
        intentID: "fork-before-ambiguous-provider-turn",
      })
      expect((yield* sessions.messages({ sessionID: fork.id })).map((message) => message.info.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
      const ambiguousFork = yield* sessions
        .fork({
          sessionID: source.id,
          messageID: assistant.id,
          intentID: "fork-at-ambiguous-provider-turn",
        })
        .pipe(Effect.flip)
      expect(ambiguousFork).toMatchObject({
        _tag: "Session.ForkConflict",
        reason: expect.stringContaining("fork cutoff is outside the recoverable history prefix"),
      })
      const tailFork = yield* sessions
        .fork({
          sessionID: source.id,
          messageID: unsafeTail.id,
          intentID: "fork-after-ambiguous-provider-turn",
        })
        .pipe(Effect.flip)
      expect(tailFork).toMatchObject({
        _tag: "Session.ForkConflict",
        reason: expect.stringContaining("fork cutoff is outside the recoverable history prefix"),
      })

      const [descriptor] = yield* recovery.describe(source.id)
      expect(descriptor).toMatchObject({
        receiptID,
        sessionID: source.id,
        providerState: "indeterminate_after_crash",
        promptEpoch: authority.epoch,
        requestHash,
        sessionMutationEpoch: 0,
        continuationRecoverySupported: true,
        workspaceRecoverySupported: true,
        sourceWorldStateBaselineStatus: "available",
        worldStateBaselineHash: baselineHash,
      })
      if (!descriptor) return
      const command = {
        sessionID: source.id,
        commandID: "resolve-ambiguous-provider-turn",
        receiptID,
        decision: "abandoned" as const,
        expected: {
          providerState: "indeterminate_after_crash" as const,
          promptEpoch: descriptor.promptEpoch,
          sessionMutationEpoch: descriptor.sessionMutationEpoch,
          requestHash: descriptor.requestHash,
          historyHash: descriptor.historyHash,
          worldStateBaselineHash: descriptor.worldStateBaselineHash!,
        },
        actorID: "test-user",
      }
      const sourceBaseline = yield* db
        .select()
        .from(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(sourceBaseline.length).toBeGreaterThan(0)
      const assertRecoveryUnchanged = Effect.fnUntraced(function* () {
        expect(
          yield* db
            .select()
            .from(SessionToolRequestResolutionCommandTable)
            .where(eq(SessionToolRequestResolutionCommandTable.session_id, source.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* db
            .select()
            .from(SessionToolRequestResolutionTable)
            .where(eq(SessionToolRequestResolutionTable.session_id, source.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* db
            .select({ epoch: SessionPromptEpochTable.epoch, state: SessionPromptEpochTable.state })
            .from(SessionPromptEpochTable)
            .where(eq(SessionPromptEpochTable.session_id, source.id))
            .orderBy(SessionPromptEpochTable.epoch)
            .all()
            .pipe(Effect.orDie),
        ).toEqual([{ epoch: authority.epoch, state: "active" }])
        expect(
          yield* db
            .select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, source.id))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ mutationEpoch: 0 })
        expect(
          yield* db
            .select({ state: SessionHistoryStateTable.state })
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, source.id))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ state: "recovery_required" })
      })

      yield* db
        .delete(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      const missingBaseline = yield* recovery
        .resolve({ ...command, commandID: "resolve-missing-world-state-baseline" })
        .pipe(Effect.flip)
      expect(missingBaseline).toMatchObject({ code: "source_world_state_baseline_missing" })
      yield* assertRecoveryUnchanged()
      yield* db.insert(SessionWorldStateBaselineTable).values(sourceBaseline).run().pipe(Effect.orDie)

      yield* db
        .delete(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionWorldStateBaselineTable)
        .values(
          sourceBaseline.map((row, index) =>
            index === 0 ? { ...row, fragment: `${row.fragment}\ninvalid recovery baseline` } : row,
          ),
        )
        .run()
        .pipe(Effect.orDie)
      const invalidBaseline = yield* recovery
        .resolve({ ...command, commandID: "resolve-invalid-world-state-baseline" })
        .pipe(Effect.flip)
      expect(invalidBaseline).toMatchObject({ code: "source_world_state_baseline_invalid" })
      yield* assertRecoveryUnchanged()
      yield* db
        .delete(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db.insert(SessionWorldStateBaselineTable).values(sourceBaseline).run().pipe(Effect.orDie)

      const first = yield* recovery.resolve(command)
      const retry = yield* recovery.resolve(command)
      expect(retry).toEqual(first)
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, source.id),
              eq(EventTable.type, `${SessionLegacyProviderResolution.Event.Completed.type}.1`),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      const commandConflict = yield* recovery
        .resolve({ ...command, reason: "same command ID with different input" })
        .pipe(Effect.flip)
      expect(commandConflict).toBeInstanceOf(SessionLegacyProviderResolution.Conflict)
      if (!(commandConflict instanceof SessionLegacyProviderResolution.Conflict)) return
      expect(commandConflict.code).toBe("command_id_conflict")
      expect(first).toMatchObject({
        decision: "abandoned",
        sourcePromptEpoch: authority.epoch,
        successorPromptEpoch: authority.epoch + 1,
        sourceMutationEpoch: 0,
        successorMutationEpoch: 1,
      })
      expect(yield* recovery.describe(source.id)).toEqual([])

      const projection = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      expect(projection.epoch).toBe(authority.epoch + 1)
      expect(projection.messages.map((message) => message.info.id)).toEqual([
        safeUser.id,
        safeAssistant.id,
        failedUser.id,
        failedAssistant.id,
      ])
      expect(projection.recoveryResolutionID).toBe(first.resolutionID)
      expect(
        yield* db
          .select({
            state: SessionPromptEpochTable.state,
            authorityState: SessionPromptEpochTable.authority_state,
            recoveryReason: SessionPromptEpochTable.recovery_reason,
          })
          .from(SessionPromptEpochTable)
          .where(
            and(eq(SessionPromptEpochTable.session_id, source.id), eq(SessionPromptEpochTable.epoch, authority.epoch)),
          )
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        state: "retired",
        authorityState: "recovery_required",
        recoveryReason: "provider outcome is unknown after restart",
      })
      expect(
        yield* db
          .select({ messageID: SessionPromptEpochMessageTable.message_id })
          .from(SessionPromptEpochMessageTable)
          .where(
            and(
              eq(SessionPromptEpochMessageTable.session_id, source.id),
              eq(SessionPromptEpochMessageTable.prompt_epoch, authority.epoch + 1),
            ),
          )
          .orderBy(SessionPromptEpochMessageTable.ordinal)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { messageID: safeUser.id },
        { messageID: safeAssistant.id },
        { messageID: failedUser.id },
        { messageID: failedAssistant.id },
      ])
      const successor = yield* db
        .select({ baselineHash: SessionPromptEpochTable.world_state_baseline_hash })
        .from(SessionPromptEpochTable)
        .where(
          and(
            eq(SessionPromptEpochTable.session_id, source.id),
            eq(SessionPromptEpochTable.epoch, authority.epoch + 1),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const baseline = yield* db
        .select({ provenance: SessionWorldStateBaselineTable.provenance })
        .from(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch + 1),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(successor?.baselineHash).toStartWith("wsb1_")
      expect(baseline.length).toBeGreaterThan(0)
      expect(new Set(baseline.map((row) => row.provenance))).toEqual(new Set(["recovery_copied"]))
      expect(
        yield* db
          .select()
          .from(SessionPromptEpochRecoveryTable)
          .where(eq(SessionPromptEpochRecoveryTable.resolution_id, first.resolutionID))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
      expect(
        yield* db
          .select()
          .from(SessionToolRequestResolutionTable)
          .where(eq(SessionToolRequestResolutionTable.resolution_id, first.resolutionID))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
      expect(
        yield* db
          .select({ mutationEpoch: SessionTable.mutation_epoch })
          .from(SessionTable)
          .where(eq(SessionTable.id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ mutationEpoch: 1 })

      yield* recoverProviderReceiptsOnStartup()
      expect(
        yield* db
          .select({ state: SessionHistoryStateTable.state })
          .from(SessionHistoryStateTable)
          .where(eq(SessionHistoryStateTable.session_id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "ready" })

      const continued = yield* addUser(source.id, "continue after explicit abandon")
      expect(
        (yield* MessageV2.promptHistoryProjectionEffect(source.id)).messages.map((message) => message.info.id),
      ).toEqual([safeUser.id, safeAssistant.id, failedUser.id, failedAssistant.id])
      const admittedAt = Date.now()
      yield* db
        .insert(SessionIntentTable)
        .values({
          intent_id: "continue-after-explicit-abandon",
          session_id: source.id,
          source: "composer",
          state: "admitted",
          selected_variant: "original",
          selected_payload_hash: "test",
          delivery: "turn",
          admitted_message_id: continued.id,
          execution_mode: "legacy",
          execution_state: "legacy",
          mutation_epoch: first.successorMutationEpoch,
          version: 1,
          time_created: admittedAt,
          time_selected: admittedAt,
          time_admitted: admittedAt,
          time_updated: admittedAt,
        })
        .run()
        .pipe(Effect.orDie)
      const continuedProjection = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      expect(continuedProjection.messages.map((message) => message.info.id)).toEqual([
        safeUser.id,
        safeAssistant.id,
        failedUser.id,
        failedAssistant.id,
        continued.id,
      ])
      yield* sessions.remove(source.id)
      yield* sessions.remove(parent.id)
      expect(
        yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  { git: true },
  30_000,
)
