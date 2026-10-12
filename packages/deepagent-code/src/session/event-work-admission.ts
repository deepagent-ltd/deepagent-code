export * as EventWorkRuntime from "./event-work-admission"

import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Option } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventWorkAdmission } from "@deepagent-code/core/deepagent/event-work-admission"
import { EventWorkRule } from "@deepagent-code/core/deepagent/event-work-rule"
import { EventWorkRuleSchema } from "@deepagent-code/core/deepagent/event-work-rule.schema"
import { EventWorkReceiptTable } from "@deepagent-code/core/deepagent/event-work-rule.sql"
import { EventWorkSource } from "@deepagent-code/core/deepagent/event-work-source"
import { EventWorkDagPolicy } from "@deepagent-code/core/deepagent/event-work-dag.policy"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { eventWorkEnvelopeDigest, type EventWorkEnvelope } from "@deepagent-code/core/contract/event-envelope"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { WorkAdmission } from "@deepagent-code/core/session/work-admission"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Service } from "@/installation/work-execution-profile"

/** The original Root services only. No private runner/provider/client or Session-specific layer. */
export const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const sessions = yield* SessionV2.Service
  const execution = yield* SessionExecution.Service
  const events = yield* EventV2Bridge.Service
  const installed = yield* Effect.serviceOption(Service)
  const withCurrent = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
    if (Option.isNone(installed)) return yield* EventWorkSource.failure("EVENT_WORK_UNAVAILABLE")
    const runtime = yield* installed.value.eventWorkAuthority
    return yield* effect.pipe(Effect.provideService(LocalOperator.Runtime, runtime),
      Effect.provideService(WorkAuthority.Verifier, installed.value.verifier))
  })
  const lookup = (eventID: string) => withCurrent(database.db.transaction((tx) => Effect.gen(function* () {
    const row = yield* tx.select({ receipt_id: EventWorkReceiptTable.receipt_id }).from(EventWorkReceiptTable)
      .where(eq(EventWorkReceiptTable.event_id, eventID)).get()
    if (!row) return yield* EventWorkSource.failure("EVENT_WORK_LEGACY")
    return yield* EventWorkAdmission.requireSource(tx, row.receipt_id)
  })))
  const admit = (eventID: string, replay?: { envelope: EventWorkEnvelope; sessionID: string }) => Effect.gen(function* () {
    if (Option.isNone(installed)) return yield* EventWorkSource.failure("EVENT_WORK_UNAVAILABLE")
    const value = yield* lookup(eventID)
    // A controller is escrow and lineage only. Neither the single lane nor an old spool
    // receipt may wake it as an agent; its reviewed nodes use the original DAG runtime.
    if (EventWorkDagPolicy.profileMatches(value.binding.profile)) return yield* EventWorkSource.failure("EVENT_WORK_AUTH_REQUIRED")
    const envelope = EventWorkAdmission.envelopeFor(value.receipt, value.rule)
    if (replay && (replay.sessionID !== value.receipt.sessionID || eventWorkEnvelopeDigest(replay.envelope) !== eventWorkEnvelopeDigest(envelope)))
      return yield* EventWorkSource.failure("EVENT_WORK_CONFLICT")
    const port = installed.value
    yield* EventAdmission.admit(database.db, { envelope, sessionID: value.receipt.sessionID,
      messageID: value.receipt.inputID, delivery: "queue", resume: false, now: value.receipt.createdAt,
      adapter: { admit: () => Effect.gen(function* () {
        const reserved = yield* withCurrent(database.db.transaction((tx) => EventWorkAdmission.reserveInTransaction(tx, value.receipt.receiptID),
          { behavior: "immediate" }))
        if (reserved.work.admission_state === "ready") return { messageID: reserved.receipt.inputID }
        yield* port.profile.prepareSource?.(reserved.work) ?? Effect.void
        const admitted = yield* withCurrent(WorkAdmission.admitWithState({ binding: reserved.binding,
          auditedText: reserved.receipt.auditedText }).pipe(Effect.provideService(Database.Service, database),
          Effect.provideService(SessionV2.Service, sessions), Effect.provideService(EventV2.Service, events)))
        if (admitted.becameReady) yield* execution.wake(SessionSchema.ID.make(reserved.work.session_id))
        return { messageID: reserved.receipt.inputID }
      }) } })
    // C5 resolved is only an admission fact. It cannot adopt an older ordinary/unbound Session.
    yield* withCurrent(database.db.transaction((tx) => Effect.gen(function* () {
      const current = yield* EventWorkAdmission.requireSource(tx, value.receipt.receiptID)
      const work = yield* WorkAuthority.get(tx, current.receipt.workID)
      if (current.phase !== "ready" || !work || work.admission_state !== "ready" ||
        work.binding_hash !== current.bindingHash || work.input_id !== current.receipt.inputID)
        return yield* EventWorkSource.failure("EVENT_WORK_LEGACY")
    })))
    return { messageID: value.receipt.inputID }
  })
  /** Reuses the existing bounded spool cadence. Only original after-enable occurrences are
   * captured. Known receipts/unknown Work are never re-keyed or sent through an ordinary adapter. */
  const reconcile = Effect.gen(function* () {
    if (Option.isNone(installed) || !EventAdmission.isEventV2AdmissionEnabled()) return
    // Session.directory uses the platform storage codec; the immutable rule JSON
    // retains its original friendly path. Match that exact Windows encoding only.
    const candidates = yield* database.db.all<{ session_id: string; activity_id: string }>(sql`SELECT DISTINCT a.session_id,a.activity_id
      FROM session_activity a JOIN event_work_rule r ON r.source_session_id=a.session_id AND r.state='enabled'
      JOIN session s ON s.id=a.session_id JOIN session_message m ON m.id=a.final_message_id AND m.session_id=s.id
      WHERE a.state='settled' AND a.ordinal>json_extract(r.record,'$.enabledAfterOrdinal')
      AND json_extract(r.record,'$.expiresAt')>${Date.now()}
      AND a.settled_at+json_extract(r.record,'$.target.durationMs')>${Date.now()}
      AND s.parent_id IS NULL AND s.workspace_id IS NULL AND s.v2_authority=1
      AND s.directory=${process.platform === "win32"
        ? sql`replace(json_extract(r.record,'$.target.location.directory'),${"\\"},'/')`
        : sql`json_extract(r.record,'$.target.location.directory')`}
      AND s.project_id=json_extract(r.record,'$.target.projectScope.projectID')
      AND m.type='assistant' AND json_valid(m.data) AND json_extract(m.data,'$.finish')='stop' AND json_extract(m.data,'$.error') IS NULL
      AND EXISTS(SELECT 1 FROM session_v2_provider_turn_receipt p WHERE p.session_id=s.id AND p.activity_id=a.activity_id)
      AND NOT EXISTS(SELECT 1 FROM session_v2_provider_turn_receipt p LEFT JOIN session_provider_attempt v ON v.attempt_id=p.provider_attempt_id
        WHERE p.session_id=s.id AND p.activity_id=a.activity_id AND (p.state<>'settled' OR p.owner_mode<>'v2' OR p.error_code IS NOT NULL
          OR v.state IS NOT 'settled' OR v.error_code IS NOT NULL OR p.wire_request_hash IS NULL OR p.wire_request_hash IS NOT v.wire_request_hash))
      AND NOT EXISTS(SELECT 1 FROM session_v2_tool_effect_admission d JOIN session_v2_provider_turn_receipt p ON p.receipt_id=d.receipt_id
        LEFT JOIN session_v2_tool_effect f ON f.receipt_id=d.receipt_id AND f.tool_call_id=d.tool_call_id
        WHERE p.session_id=s.id AND p.activity_id=a.activity_id AND (f.state IS NOT 'settled' OR f.error_code IS NOT NULL OR f.grant_state IS 'unknown'))
      AND NOT EXISTS(SELECT 1 FROM event_work_receipt e WHERE e.rule_id=r.rule_id AND json_extract(e.record,'$.source.activityID')=a.activity_id)
      ORDER BY a.settled_at,a.activity_id LIMIT 32`)
    for (const candidate of candidates) yield* database.db.transaction((tx) => EventWorkRule.observeInTransaction(tx,
      { sessionID: candidate.session_id, activityID: candidate.activity_id }), { behavior: "immediate" })
    const pending = yield* database.db.all<{ event_id: string }>(sql`SELECT e.event_id FROM event_work_receipt e
      JOIN event_work_rule r ON r.rule_id=e.rule_id AND r.instance_id=e.instance_id AND r.state='enabled'
      WHERE e.phase IN ('observed','reserved') AND json_extract(e.record,'$.deadline')>${Date.now()}
      AND json_extract(e.record,'$.epoch')=r.epoch
      AND json_extract(r.record,'$.origin.execution.kind') IS NOT 'dag'
      ORDER BY e.created_at,e.receipt_id LIMIT 32`)
    for (const row of pending) yield* admit(row.event_id).pipe(Effect.catch((error) => Effect.logWarning("Event Work remains unadmitted", {
      eventID: row.event_id, code: error instanceof EventWorkRuleSchema.Error ? error.code : "EVENT_WORK_UNAVAILABLE" })))
    // Only a ready, still-unpromoted queue input with zero execution/count/tool facts can
    // repair the advisory-wake crash gap. Unknown/dispatched work is never restarted here.
    const missed = yield* database.db.all<{ receipt_id: string; session_id: string }>(sql`SELECT r.receipt_id,r.session_id
      FROM event_work_receipt r JOIN work_execution w ON w.work_id=r.work_id JOIN session_input i ON i.id=r.input_id AND i.session_id=r.session_id
      JOIN session s ON s.id=r.session_id
      WHERE r.phase='ready' AND w.admission_state='ready' AND w.control_state='active' AND w.outcome='pending'
      AND w.execution_role<>'dag_controller'
      AND i.promoted_seq IS NULL AND NOT EXISTS(SELECT 1 FROM session_provider_attempt a WHERE a.session_id=r.session_id)
      AND s.execution_claim_token IS NULL AND NOT EXISTS(SELECT 1 FROM session_activity a WHERE a.session_id=r.session_id)
      AND NOT EXISTS(SELECT 1 FROM work_count_acquisition c WHERE c.work_id=r.work_id)
      AND NOT EXISTS(SELECT 1 FROM work_dispatch_reservation p WHERE p.work_id=r.work_id)
      AND NOT EXISTS(SELECT 1 FROM session_v2_tool_effect_admission t WHERE t.session_id=r.session_id)
      ORDER BY r.created_at,r.receipt_id LIMIT 32`)
    for (const row of missed) yield* withCurrent(database.db.transaction((tx) => EventWorkAdmission.requireSource(tx, row.receipt_id)))
      .pipe(Effect.andThen(() => execution.wake(SessionSchema.ID.make(row.session_id))),
        Effect.catch(() => Effect.logWarning("Event Work advisory wake remains unavailable", { code: "EVENT_WORK_UNAVAILABLE" })))
  })
  const pendingDags = withCurrent(Effect.gen(function* () {
    const rows = yield* database.db.all<{ event_id: string }>(sql`SELECT e.event_id FROM event_work_receipt e
      JOIN event_work_rule r ON r.rule_id=e.rule_id AND r.instance_id=e.instance_id
      LEFT JOIN event_work_controller c ON c.receipt_id=e.receipt_id
      LEFT JOIN work_execution w ON w.work_id=e.work_id
      WHERE r.state='enabled' AND json_extract(r.record,'$.origin.execution.kind')='dag'
        AND e.phase IN ('observed','reserved','ready') AND json_extract(e.record,'$.deadline')>${Date.now()}
        AND json_extract(e.record,'$.epoch')=r.epoch AND (c.controller_id IS NULL OR c.state IN ('pending','running'))
        AND (w.work_id IS NULL OR (w.control_state='active' AND w.outcome='pending' AND w.execution_role='dag_controller'))
        AND NOT EXISTS(SELECT 1 FROM work_execution n WHERE n.root_work_id=e.work_id AND n.outcome='unknown')
        AND NOT EXISTS(SELECT 1 FROM work_dispatch_reservation d WHERE d.root_work_id=e.work_id AND d.state IN ('unknown','dispatching'))
        AND NOT EXISTS(SELECT 1 FROM work_count_acquisition a JOIN work_execution n ON n.work_id=a.work_id
          WHERE n.root_work_id=e.work_id AND a.state IN ('unknown','sending'))
        AND NOT EXISTS(SELECT 1 FROM work_command_intent d WHERE d.root_work_id=e.work_id AND d.state IN ('unknown','dispatching'))
        AND NOT EXISTS(SELECT 1 FROM work_write_stage s WHERE s.root_work_id=e.work_id AND s.state='publication_unknown')
      ORDER BY e.created_at,e.receipt_id LIMIT 32`)
    const events: DeepAgentEvent.Event[] = []
    for (const row of rows) {
      const original = yield* lookup(row.event_id).pipe(Effect.exit)
      if (original._tag === "Failure" && Cause.hasInterrupts(original.cause)) return yield* Effect.interrupt
      if (original._tag !== "Success" || !("execution" in original.value.rule.origin) ||
        original.value.rule.origin.execution.kind !== "dag" || !EventWorkDagPolicy.profileMatches(original.value.binding.profile)) continue
      const value = original.value
      // This exact persisted receipt supplies the event ID and data; it is never a generic
      // publish, new source witness, new generation or caller-provided execution grant.
      events.push({ id: DeepAgentEvent.ID.make(value.receipt.eventID), type: EventWorkRule.EVENT_TYPE, source: "system",
        workspaceID: value.binding.scope.workspaceID, projectID: value.receipt.source.projectID,
        actorID: value.rule.operatorID, correlationID: value.receipt.occurrenceKey, idempotencyKey: value.receipt.occurrenceKey,
        priority: "normal", createdAt: value.receipt.createdAt, payload: value.receipt.source })
    }
    return events
  }))
  const control = (input: Parameters<typeof EventWorkRule.command>[1]) => withCurrent(Effect.gen(function* () {
    const result = yield* EventWorkRule.command(database.db, input)
    for (const id of result.interruptedSessionIDs) yield* execution.interrupt(SessionSchema.ID.make(id))
    return result
  }))
  return { lookup, admit, reconcile, pendingDags, control }
})
export type Port = Effect.Success<typeof make>
