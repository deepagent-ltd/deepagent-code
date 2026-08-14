import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskNotificationOutboxTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { acknowledgeDelivery, renewProcessingLease, type OutboxItem } from "../../src/session/task-delivery"
import { prepare } from "../../src/session/task-input"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import {
  admitTaskRun,
  claimTaskProvisioning,
  markTaskFinalizing,
  settleTaskRun,
  startTaskRun,
} from "../../src/tool/task-run"
import { repairDurableSettledRunProjections } from "../../src/tool/task"
import { persistStructuredFinalizerResponse } from "../../src/tool/task-structured-output-evidence"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)
const directory = "/wave3_durability"
const parentSessionID = SessionID.make("ses_wave3_parent")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: parentSessionID,
      project_id: ProjectV2.ID.global,
      slug: "wave3-parent",
      directory,
      title: "parent",
      version: "test",
      agent: "build",
      model: { providerID: "test-provider", id: "test-model" },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("wave-3 durable control-plane regressions", () => {
  it.effect("materializes the same schema-valid child input envelope on exact retry", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admitTaskRun({
        parentSessionID,
        parentMessageID: MessageID.ascending("msg_wave3_parent_input"),
        toolCallID: "call_wave3_prepare",
        request: { description: "inspect exact projection" },
        deliveryMode: "foreground",
        now: 1_000,
        executionSpec: {
          prompt: { text: "Inspect the durable input." },
          agent: "researcher",
          model: { providerID: "test-provider", modelID: "test-model", variant: "precise" },
          tools: { read: true, edit: false },
          permission: [],
        },
      })

      const first = yield* prepare(admission.run)
      const retry = yield* prepare(admission.run)
      const decoded = Schema.decodeUnknownSync(SessionV1.User)({
        id: first.messageID,
        sessionID: SessionID.make(first.sessionID),
        ...first.messageData,
      })

      expect(first.messageID === admission.run.childMessageID).toBe(true)
      expect(retry.messageID).toBe(first.messageID)
      expect(retry.parts[0]?.partID === first.parts[0]?.partID).toBe(true)
      expect(retry.materializedHash).toBe(first.materializedHash)
      expect(decoded.agent).toBe("researcher")
      expect(String(decoded.model.providerID)).toBe("test-provider")
      expect(String(decoded.model.modelID)).toBe("test-model")
      expect(decoded.model.variant).toBe("precise")
      expect(decoded.tools).toEqual({ read: true, edit: false })
    }),
  )

  it.effect("renews and acknowledges a processing item only through its live owner fence", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admitTaskRun({
        parentSessionID,
        parentMessageID: MessageID.ascending("msg_wave3_delivery_parent"),
        toolCallID: "call_wave3_delivery",
        request: { description: "deliver result" },
        deliveryMode: "background",
        now: 1_000,
      })
      const payload = { agent: "researcher", text: "Background task completed." }
      const item = {
        id: `task-notify:${admission.run.runID}`,
        runID: admission.run.runID,
        correlationID: `task-notify:${admission.run.runID}`,
        messageID: MessageID.ascending("msg_wave3_notification"),
        parentSessionID,
        directory,
        payload,
        payloadHash: Hash.sha256(JSON.stringify(payload)),
        attempts: 1,
        timeCreated: 1_000,
      } satisfies OutboxItem
      const { db } = yield* Database.Service
      yield* db
        .insert(TaskNotificationOutboxTable)
        .values({
          id: item.id,
          run_id: item.runID,
          message_id: item.messageID,
          parent_session_id: item.parentSessionID,
          directory: item.directory,
          payload: item.payload,
          status: "processing",
          attempts: item.attempts,
          available_at: 1_000,
          lease_owner: "wave3-owner",
          lease_expires_at: 1_200,
          event_kind: "terminal",
          correlation_id: item.correlationID,
          payload_hash: item.payloadHash,
          parent_input_message_id: item.messageID,
          response_started_at: 1_050,
          time_created: item.timeCreated,
          time_updated: 1_050,
        })
        .run()
        .pipe(Effect.orDie)

      yield* renewProcessingLease({
        item,
        ownerToken: "wave3-owner",
        leaseMs: 300,
        now: 1_100,
      })
      const renewed = yield* db
        .select({ leaseExpiresAt: TaskNotificationOutboxTable.lease_expires_at })
        .from(TaskNotificationOutboxTable)
        .where(eq(TaskNotificationOutboxTable.id, item.id))
        .get()
        .pipe(Effect.orDie)
      expect(renewed?.leaseExpiresAt).toBe(1_400)

      const staleOwner = yield* renewProcessingLease({
        item,
        ownerToken: "replacement-owner",
        leaseMs: 300,
        now: 1_150,
      }).pipe(
        Effect.as("renewed" as const),
        Effect.catchTag("TaskDelivery.Conflict", () => Effect.succeed("fenced" as const)),
      )
      expect(staleOwner).toBe("fenced")
      expect(
        yield* acknowledgeDelivery({
          item,
          ownerToken: "wave3-owner",
          responseMessageID: MessageID.ascending("msg_wave3_response"),
          now: 1_401,
        }),
      ).toBe(false)
      expect(
        yield* acknowledgeDelivery({
          item,
          ownerToken: "wave3-owner",
          responseMessageID: MessageID.ascending("msg_wave3_response"),
          now: 1_200,
        }),
      ).toBe(true)
    }),
  )

  for (const fixture of [
    {
      label: "structured",
      reason: "structured_output_valid",
      receipt: { attempt: 1, transport: "structured" } as const,
      structuredResultMessageID: MessageID.ascending("msg_wave3_structured_result"),
    },
    {
      label: "text fallback",
      reason: "structured_output_text_fallback",
      receipt: { attempt: 2, transport: "text_fallback" } as const,
      structuredResultMessageID: MessageID.ascending("msg_wave3_text_result"),
    },
    {
      label: "degraded text",
      reason: "structured_output_degraded_text",
      receipt: { attempt: 2, transport: "degraded_text", reason: "structured_output_invalid" } as const,
      structuredResultMessageID: undefined,
    },
  ] as const) {
    it.effect(`projects a durable ${fixture.label} receipt after a crash before session metadata`, () =>
      Effect.gen(function* () {
        yield* setup
        const time = Date.now()
        const admission = yield* admitTaskRun({
          parentSessionID,
          parentMessageID: MessageID.ascending(`msg_wave3_projection_parent_${fixture.receipt.transport}`),
          toolCallID: `call_wave3_projection_${fixture.receipt.transport}`,
          request: { description: "project terminal state" },
          deliveryMode: "foreground",
          executionSpec: {
            prompt: { text: "project terminal state" },
            agent: "researcher",
            model: { providerID: "test-provider", modelID: "test-model" },
            structuredOutput: {
              schema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
                additionalProperties: false,
              },
              allowTextFallback: true,
              receiptVersion: 1,
              maxAttempts: 2,
            },
          },
          now: time,
        })
        const { db } = yield* Database.Service
        const claimed = yield* claimTaskProvisioning({ run: admission.run, owner: "wave3-owner", now: time + 10 })
        const running = yield* startTaskRun(claimed!, "wave3-owner", time + 20)
        const rawMessageID = MessageID.ascending(`msg_wave3_raw_${fixture.receipt.transport}`)
        yield* db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (
          ${admission.run.childSessionID}, ${ProjectV2.ID.global},
          ${`wave3-${fixture.receipt.transport}`}, ${directory}, 'child', 'test', ${time}, ${time}
        )
      `)
        yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (${rawMessageID}, ${admission.run.childSessionID}, ${time + 30}, ${time + 30}, '{"role":"assistant"}')
      `)
        yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (
          ${`prt_wave3_raw_${fixture.receipt.transport}`}, ${rawMessageID}, ${admission.run.childSessionID},
          ${time + 30}, ${time + 30}, '{"type":"text","text":"persisted research"}'
        )
      `)
        if (fixture.structuredResultMessageID) {
          yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (
            ${fixture.structuredResultMessageID}, ${admission.run.childSessionID},
            ${time + 40}, ${time + 40}, '{"role":"assistant"}'
          )
        `)
          yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            ${`prt_wave3_result_${fixture.receipt.transport}`}, ${fixture.structuredResultMessageID},
            ${admission.run.childSessionID}, ${time + 40}, ${time + 40},
            '{"type":"text","text":"{\\"result\\":\\"ok\\"}"}'
          )
        `)
        }
        yield* markTaskFinalizing(running!, "wave3-owner", fixture.receipt.attempt, rawMessageID, time + 100)
        if (fixture.structuredResultMessageID) {
          const requestMessageID = MessageID.ascending(`msg_wave3_request_${fixture.receipt.transport}`)
          yield* db.run(sql`
            INSERT INTO message (id, session_id, time_created, time_updated, data)
            VALUES (
              ${requestMessageID}, ${admission.run.childSessionID}, ${time + 35}, ${time + 35},
              ${JSON.stringify({
                role: "user",
                metadata: {
                  deepagent: {
                    structured_finalizer: {
                      run_id: admission.run.runID,
                      attempt: fixture.receipt.attempt,
                      source_message_id: rawMessageID,
                    },
                  },
                },
              })}
            )
          `)
          yield* db.run(sql`
            UPDATE message
            SET data = ${JSON.stringify(
              fixture.receipt.transport === "structured"
                ? { role: "assistant", parentID: requestMessageID, structured: { result: "ok" } }
                : { role: "assistant", parentID: requestMessageID },
            )}
            WHERE id = ${fixture.structuredResultMessageID}
          `)
          yield* persistStructuredFinalizerResponse({
            runID: admission.run.runID,
            childSessionID: admission.run.childSessionID,
            ownerToken: "wave3-owner",
            claimGeneration: running!.claimGeneration,
            attempt: fixture.receipt.attempt,
            sourceMessageID: rawMessageID,
            responseMessageID: fixture.structuredResultMessageID,
            contract: admission.run.executionSpec!.structuredOutput!,
            receipt: fixture.receipt,
            output: '{"result":"ok"}',
            now: time + 200,
          })
        }
        const settled = yield* settleTaskRun({
          run: running!,
          owner: "wave3-owner",
          state: "completed",
          reason: fixture.reason,
          output:
            fixture.receipt.transport === "degraded_text"
              ? JSON.stringify({
                  _degraded: true,
                  _reason: fixture.receipt.reason,
                  _attempts: fixture.receipt.attempt,
                  _raw: "persisted research",
                })
              : '{"result":"ok"}',
          structuredResultMessageID: fixture.structuredResultMessageID,
          structuredOutputReceipt: fixture.receipt,
          now: time + 500,
        })
        expect(settled.won).toBe(true)
        expect(settled.run.structuredOutputReceipt).toEqual(fixture.receipt)

        const holder: { info: Session.Info } = {
          info: {
            id: admission.run.childSessionID,
            slug: "wave3-child",
            projectID: ProjectV2.ID.global,
            directory,
            parentID: parentSessionID,
            title: "child",
            version: "test",
            metadata: {
              deepagent: {
                subagent: {
                  finished: false,
                  state: "researching",
                  phase: "research",
                  run_id: admission.run.runID,
                  generation: admission.run.generation,
                },
              },
            },
            time: { created: time, updated: time },
          },
        }
        const sessions = {
          get: () => Effect.succeed(holder.info),
          setMetadata: (input: { readonly metadata: Session.Info["metadata"] }) =>
            Effect.sync(() => {
              holder.info = { ...holder.info, metadata: input.metadata }
            }),
        } as unknown as Session.Interface

        expect(yield* repairDurableSettledRunProjections(sessions, { directory })).toBe(1)
        expect(yield* repairDurableSettledRunProjections(sessions, { directory })).toBe(0)

        expect(holder.info.metadata?.deepagent).toEqual({
          subagent: {
            finished: true,
            state: "completed",
            phase: "settled",
            run_id: admission.run.runID,
            generation: admission.run.generation,
            settled_at: time + 500,
            reason: fixture.reason,
            attempts: fixture.receipt.attempt,
            raw_result_ref: rawMessageID,
            structured_output: fixture.receipt,
          },
        })
      }),
    )
  }
})
