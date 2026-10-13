export * as EventWorkSource from "./event-work-source"

import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { WorkAuthority } from "../session/work-authority"
import { SessionTable } from "../session/sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { EventWorkRuleSchema } from "./event-work-rule.schema"

export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
export const failure = (code: EventWorkRuleSchema.Error["code"] = "EVENT_WORK_SOURCE_CHANGED") =>
  new EventWorkRuleSchema.Error({ code, message: "Original event Work source, rule or current execution authority is unavailable or changed" })
export function decode<A>(schema: Schema.Decoder<A>, input: unknown) {
  const value = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  return Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(failure("EVENT_WORK_INVALID"))
}

/** A terminal activity is a persisted fact, not an execution grant. Provider/tool outcomes
 * are joined to the original activity; idle timestamps and legacy assistant projections
 * cannot supply this witness. All materialized sets have explicit caps. */
export const read = Effect.fn("EventWorkSource.read")(function* (tx: WorkAuthority.Transaction,
  rule: EventWorkRuleSchema.Rule, activityID: string) {
  const source = yield* tx.get<{
    session_id: string; activity_id: string; ordinal: number; trigger_input_id: string; project_id: string;
    directory: string; final_message_id: string; final_data: string; settled_at: number;
  }>(sql`SELECT a.session_id,a.activity_id,a.ordinal,a.trigger_input_id,s.project_id,s.directory,
    a.final_message_id,m.data final_data,a.settled_at FROM session_activity a
    JOIN session s ON s.id=a.session_id JOIN session_message m ON m.id=a.final_message_id AND m.session_id=s.id
    JOIN session_input i ON i.id=a.trigger_input_id AND i.session_id=s.id
    WHERE a.activity_id=${activityID} AND a.session_id=${rule.origin.sourceSessionID}
      AND s.parent_id IS NULL AND s.workspace_id IS NULL AND s.v2_authority=1
      AND s.directory=${SessionTable.directory.mapToDriverValue(rule.target.location.directory)}
      AND s.project_id=${rule.target.projectScope.projectID}
      AND NOT EXISTS(SELECT 1 FROM work_execution w WHERE w.session_id=s.id)
      AND a.state='settled' AND a.settled_at IS NOT NULL AND a.final_message_id IS NOT NULL
      AND a.ordinal>${rule.enabledAfterOrdinal} AND i.promoted_seq IS NOT NULL
      AND m.type='assistant' AND m.seq>i.promoted_seq
      AND length(CAST(m.data AS BLOB)) BETWEEN 2 AND 65536 AND json_valid(m.data)
      AND json_extract(m.data,'$.finish')='stop' AND json_extract(m.data,'$.error') IS NULL`)
  if (!source) return yield* failure()
  if ((yield* WorkAuthority.lookupSession(tx, source.session_id)).kind !== "ordinary") return yield* failure()
  const providers = yield* tx.all<{
    receipt_id: string; provider_attempt_id: string; wire_request_hash: string; outcome_hash: string;
    provider_id: string; model_id: string; protocol: string; terminal_at: number;
  }>(sql`SELECT r.receipt_id,r.provider_attempt_id,r.wire_request_hash,r.outcome_hash,r.provider_id,r.model_id,r.protocol,r.terminal_at
    FROM session_v2_provider_turn_receipt r JOIN session_provider_attempt p ON p.attempt_id=r.provider_attempt_id
    WHERE r.session_id=${source.session_id} AND r.activity_id=${source.activity_id}
      AND p.session_id=r.session_id AND p.activity_id=r.activity_id AND p.state='settled' AND p.error_code IS NULL
      AND r.owner_mode='v2' AND r.state='settled' AND r.error_code IS NULL AND r.terminal_at IS NOT NULL AND r.outcome_hash IS NOT NULL
      AND r.wire_request_hash IS NOT NULL AND r.wire_request_hash=p.wire_request_hash
    ORDER BY r.provider_turn_seq,r.receipt_id LIMIT 129`)
  const count = yield* tx.get<{ receipts: number; attempts: number }>(sql`SELECT
    (SELECT count(*) FROM session_v2_provider_turn_receipt WHERE session_id=${source.session_id} AND activity_id=${source.activity_id}) receipts,
    (SELECT count(*) FROM session_provider_attempt WHERE session_id=${source.session_id} AND activity_id=${source.activity_id}) attempts`)
  if (!count || providers.length === 0 || providers.length > 128 || count.receipts !== providers.length || count.attempts !== providers.length)
    return yield* failure()
  const effects = yield* tx.all<{ effect_id: string; receipt_id: string; tool_call_id: string; outcome_hash: string;
    admission_id: string; tool_name: string; state: string; error_code: string | null; grant_state: string | null;
  }>(sql`SELECT e.effect_id,e.receipt_id,e.tool_call_id,e.outcome_hash,d.admission_id,e.tool_name,e.state,e.error_code,e.grant_state
    FROM session_v2_tool_effect_admission d JOIN session_v2_provider_turn_receipt r ON r.receipt_id=d.receipt_id
    LEFT JOIN session_v2_tool_effect e ON e.receipt_id=d.receipt_id AND e.tool_call_id=d.tool_call_id
      AND e.session_id=d.session_id AND e.provider_attempt_id=d.provider_attempt_id
      AND e.owner_token=d.owner_token AND e.tool_name=d.tool_name AND e.effect_kind=d.effect_kind
    WHERE r.session_id=${source.session_id} AND r.activity_id=${source.activity_id}
      AND d.session_id=r.session_id AND d.provider_attempt_id=r.provider_attempt_id AND d.owner_token=r.owner_token
    ORDER BY r.provider_turn_seq,d.tool_call_id LIMIT 513`)
  const effectCount = yield* tx.get<{ admissions: number; effects: number }>(sql`SELECT
    (SELECT count(*) FROM session_v2_tool_effect_admission d JOIN session_v2_provider_turn_receipt r ON r.receipt_id=d.receipt_id
      WHERE r.session_id=${source.session_id} AND r.activity_id=${source.activity_id}) admissions,
    (SELECT count(*) FROM session_v2_tool_effect e JOIN session_v2_provider_turn_receipt r ON r.receipt_id=e.receipt_id
      WHERE r.session_id=${source.session_id} AND r.activity_id=${source.activity_id}) effects`)
  if (!effectCount || effectCount.admissions !== effects.length || effectCount.effects !== effects.length ||
    effects.length > 512 || effects.some((entry) => !entry.effect_id || !entry.outcome_hash || entry.state !== "settled" || entry.error_code !== null ||
    (entry.grant_state !== null && entry.grant_state !== "settled"))) return yield* failure()
  return yield* decode(EventWorkRuleSchema.Source, {
    version: 1, kind: "ordinary_session_activity_terminal_v1", sessionID: source.session_id,
    activityID: source.activity_id, activityOrdinal: source.ordinal, triggerInputID: source.trigger_input_id,
    projectID: source.project_id, directory: SessionTable.directory.mapFromDriverValue(source.directory), finalMessageID: source.final_message_id,
    finalMessageHash: Hash.sha256(source.final_data), receiptChainHash: hash(providers), effectChainHash: hash(effects), settledAt: source.settled_at,
  })
})

export const identities = (ruleID: string, source: EventWorkRuleSchema.Source) => {
  const key = hash(["event-work-occurrence.v1", ruleID, source.sessionID, source.activityID, source.activityOrdinal])
  return { occurrenceKey: key, receiptID: `evwork_${key}`, eventID: `dae_evwork_${key}`,
    workID: `work_ev_${key.slice(0, 40)}`, sessionID: `ses_ev_${key.slice(0, 40)}`, inputID: `msg_ev_${key.slice(0, 40)}` }
}
