import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813041400_context_activation_semantic_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_request_receipt_context_activation_semantic_guard")
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_context_activation_semantic_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state IN ('prepared', 'dispatching') AND ${invalidActivation("NEW")}
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt context activation semantics are invalid');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration

function invalidActivation(row: string) {
  const activation = `${row}.context_activation`
  const eligibility = `${row}.context_eligibility`
  const readiness = `${row}.context_readiness`
  return `(
    json_extract(${activation}, '$.schemaVersion') IS NOT 1 OR
    COALESCE(json_type(${activation}, '$.recordedAt'), 'missing') NOT IN ('integer', 'real') OR
    COALESCE(json_type(${activation}, '$.readinessAgeMs'), 'missing') NOT IN ('integer', 'real') OR
    COALESCE(json_type(${activation}, '$.readinessExpiresInMs'), 'missing') NOT IN ('integer', 'real') OR
    COALESCE(json_type(${readiness}, '$.observedAt'), 'missing') NOT IN ('integer', 'real') OR
    COALESCE(json_type(${readiness}, '$.expiresAt'), 'missing') NOT IN ('integer', 'real') OR
    json_extract(${activation}, '$.readinessAgeMs') != MAX(
      0,
      json_extract(${activation}, '$.recordedAt') - json_extract(${readiness}, '$.observedAt')
    ) OR
    json_extract(${activation}, '$.readinessExpiresInMs') !=
      json_extract(${readiness}, '$.expiresAt') - json_extract(${activation}, '$.recordedAt') OR
    COALESCE(json_extract(${activation}, '$.outcome'), '') NOT IN
      ('active', 'shadow_only', 'fallback', 'not_requested') OR
    json_type(${activation}, '$.enabledCapabilities') IS NOT 'array' OR
    json_type(${activation}, '$.fallbackReasons') IS NOT 'array' OR
    EXISTS (
      SELECT 1
      FROM json_each(${activation}, '$.enabledCapabilities') capability
      WHERE capability.type != 'text' OR capability.value NOT IN
        ('context_projection_v2', 'context_query_tools_v2')
    ) OR
    (SELECT count(*) FROM json_each(${activation}, '$.enabledCapabilities')) !=
      (SELECT count(DISTINCT capability.value)
       FROM json_each(${activation}, '$.enabledCapabilities') capability) OR
    EXISTS (
      SELECT 1
      FROM json_each(${activation}, '$.fallbackReasons') reason
      WHERE reason.type != 'text' OR reason.value = ''
    ) OR
    (json_array_length(json_extract(${activation}, '$.enabledCapabilities')) > 0) !=
      (json_extract(${activation}, '$.outcome') = 'active') OR
    (EXISTS (
      SELECT 1 FROM json_each(${activation}, '$.enabledCapabilities')
      WHERE value = 'context_projection_v2'
    ) AND json_extract(${activation}, '$.decision.enabled.contextProjectionV2') IS NOT 1) OR
    (EXISTS (
      SELECT 1 FROM json_each(${activation}, '$.enabledCapabilities')
      WHERE value = 'context_query_tools_v2'
    ) AND json_extract(${activation}, '$.decision.enabled.contextQueryToolsV2') IS NOT 1) OR
    json_extract(${activation}, '$.decision.requested') IS NOT json_extract(${eligibility}, '$.requested') OR
    json_extract(${activation}, '$.decision.project') IS NOT json_extract(${eligibility}, '$.project') OR
    (json_extract(${activation}, '$.decision.enabled.contextProjectionV2') = 1 AND
      json_extract(${eligibility}, '$.enabled.contextProjectionV2') IS NOT 1) OR
    (json_extract(${activation}, '$.decision.enabled.contextQueryToolsV2') = 1 AND
      json_extract(${eligibility}, '$.enabled.contextQueryToolsV2') IS NOT 1) OR
    (json_extract(${activation}, '$.decision.enabled.coreV2ExecutionOwner') = 1 AND
      json_extract(${eligibility}, '$.enabled.coreV2ExecutionOwner') IS NOT 1) OR
    (json_extract(${readiness}, '$.expiresAt') <= json_extract(${activation}, '$.recordedAt') AND (
      json_array_length(json_extract(${activation}, '$.enabledCapabilities')) != 0 OR
      json_extract(${activation}, '$.decision.enabled.contextProjectionV2') IS NOT 0 OR
      json_extract(${activation}, '$.decision.enabled.contextQueryToolsV2') IS NOT 0 OR
      json_extract(${activation}, '$.decision.enabled.coreV2ExecutionOwner') IS NOT 0
    )) OR
    (${row}.context_selection_id IS NULL AND json_type(${activation}, '$.selection') IS NOT NULL) OR
    (${row}.context_selection_id IS NOT NULL AND (
      json_extract(${activation}, '$.selection.selectionId') IS NOT ${row}.context_selection_id OR
      NOT EXISTS (
        SELECT 1
        FROM session_context_selection selection
        WHERE selection.selection_id = ${row}.context_selection_id
          AND selection.session_id = ${row}.session_id
          AND selection.projection_hash = json_extract(${activation}, '$.selection.projectionHash')
      )
    ))
  )`
}
