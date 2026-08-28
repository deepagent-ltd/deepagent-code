import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811193000_released_knowledge_turn_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* addBindingColumns(tx, "session_tool_request_receipt")
      yield* addBindingColumns(tx, "session_context_selection")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN released_knowledge_security_namespace_id TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN released_knowledge_project_scope_key TEXT")
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN released_knowledge_selected_refs TEXT
        CHECK (released_knowledge_selected_refs IS NULL OR (
          json_valid(released_knowledge_selected_refs) = 1 AND
          json_type(released_knowledge_selected_refs) = 'array'
        ))
      `)
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN released_knowledge_selected_refs_fingerprint TEXT
        CHECK (released_knowledge_selected_refs_fingerprint IS NULL OR (
          length(released_knowledge_selected_refs_fingerprint) = 64 AND
          released_knowledge_selected_refs_fingerprint NOT GLOB '*[^0-9a-f]*'
        ))
      `)
      yield* tx.run("ALTER TABLE session_context_selection ADD COLUMN security_namespace_id TEXT")
      yield* tx.run("ALTER TABLE session_context_selection ADD COLUMN project_scope_key TEXT")
      yield* tx.run("DROP TRIGGER session_context_selection_immutable")
      yield* tx.run(`
        UPDATE session_tool_request_receipt
        SET released_knowledge_binding_state = 'legacy_unbound'
        WHERE released_knowledge_binding_state IS NULL
      `)
      yield* tx.run(`
        UPDATE session_context_selection
        SET released_knowledge_binding_state = 'legacy_unbound'
        WHERE released_knowledge_binding_state IS NULL
      `)
      yield* tx.run(`
        UPDATE session_activity
        SET state = 'interrupted', settled_at = created_at
        WHERE state = 'active'
          AND EXISTS (
            SELECT 1
            FROM session_context_selection selection
            WHERE selection.activity_id = session_activity.activity_id
              AND selection.released_knowledge_binding_state = 'legacy_unbound'
          )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_context_selection_immutable
        BEFORE UPDATE ON session_context_selection
        BEGIN
          SELECT RAISE(ABORT, 'session_context_selection is immutable');
        END
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_released_snapshot_idx
        ON session_tool_request_receipt (released_knowledge_snapshot_id, released_knowledge_generation)
        WHERE released_knowledge_snapshot_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE INDEX session_context_selection_released_snapshot_idx
        ON session_context_selection (released_knowledge_snapshot_id, released_knowledge_generation)
        WHERE released_knowledge_snapshot_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_released_knowledge_immutable
        BEFORE UPDATE ON session_tool_request_receipt
        WHEN NEW.released_knowledge_security_namespace_id IS NOT OLD.released_knowledge_security_namespace_id
          OR NEW.released_knowledge_project_scope_key IS NOT OLD.released_knowledge_project_scope_key
          OR NEW.released_knowledge_binding_state IS NOT OLD.released_knowledge_binding_state
          OR NEW.released_knowledge_snapshot_id IS NOT OLD.released_knowledge_snapshot_id
          OR NEW.released_knowledge_generation IS NOT OLD.released_knowledge_generation
          OR NEW.released_knowledge_membership_hash IS NOT OLD.released_knowledge_membership_hash
          OR NEW.released_knowledge_manifest_hash IS NOT OLD.released_knowledge_manifest_hash
          OR NEW.released_knowledge_exact_refs IS NOT OLD.released_knowledge_exact_refs
          OR NEW.released_knowledge_exact_refs_fingerprint IS NOT OLD.released_knowledge_exact_refs_fingerprint
        BEGIN
          SELECT RAISE(ABORT, 'released knowledge receipt binding is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_released_knowledge_selected_refs_seal
        BEFORE UPDATE OF released_knowledge_selected_refs, released_knowledge_selected_refs_fingerprint
        ON session_tool_request_receipt
        WHEN (
          NEW.released_knowledge_selected_refs IS NOT OLD.released_knowledge_selected_refs OR
          NEW.released_knowledge_selected_refs_fingerprint IS NOT OLD.released_knowledge_selected_refs_fingerprint
        ) AND NOT (
          OLD.provider_state = 'preparing' AND
          NEW.provider_state = 'preparing' AND
          OLD.released_knowledge_selected_refs IS NULL AND
          OLD.released_knowledge_selected_refs_fingerprint IS NULL AND
          NOT ${invalidSelectedRefs("NEW")}
        )
        BEGIN
          SELECT RAISE(ABORT, 'released knowledge selected refs may only be sealed once while preparing');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_authority_insert_guard
        BEFORE INSERT ON session_tool_request_receipt
        WHEN ${invalidReceiptAuthority("NEW", true)}
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt requires durable context and released knowledge authority');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_released_knowledge_dispatch_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state IN ('prepared', 'dispatching') AND ${invalidReceiptAuthority("NEW", false)}
        BEGIN
          SELECT RAISE(ABORT, 'provider preparation and dispatch require released knowledge authority');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_context_selection_released_knowledge_insert_guard
        BEFORE INSERT ON session_context_selection
        WHEN ${invalidSelectionAuthority("NEW")}
        BEGIN
          SELECT RAISE(ABORT, 'context selection requires released knowledge authority');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration

function addBindingColumns(tx: Parameters<DatabaseMigration.Migration["up"]>[0], table: string) {
  return Effect.gen(function* () {
    yield* tx.run(`
      ALTER TABLE ${table} ADD COLUMN released_knowledge_binding_state TEXT
      CHECK (released_knowledge_binding_state IS NULL OR released_knowledge_binding_state IN ('legacy_unbound', 'bound', 'unavailable'))
    `)
    yield* tx.run(`
      ALTER TABLE ${table} ADD COLUMN released_knowledge_snapshot_id TEXT
      REFERENCES released_knowledge_snapshot(snapshot_id)
    `)
    yield* tx.run(`
      ALTER TABLE ${table} ADD COLUMN released_knowledge_generation INTEGER
      CHECK (released_knowledge_generation IS NULL OR released_knowledge_generation > 0)
    `)
    yield* tx.run(`
      ALTER TABLE ${table} ADD COLUMN released_knowledge_membership_hash TEXT
      CHECK (released_knowledge_membership_hash IS NULL OR (
        length(released_knowledge_membership_hash) = 64 AND
        released_knowledge_membership_hash NOT GLOB '*[^0-9a-f]*'
      ))
    `)
    yield* tx.run(`
      ALTER TABLE ${table} ADD COLUMN released_knowledge_manifest_hash TEXT
      CHECK (released_knowledge_manifest_hash IS NULL OR (
        length(released_knowledge_manifest_hash) = 64 AND
        released_knowledge_manifest_hash NOT GLOB '*[^0-9a-f]*'
      ))
    `)
    yield* tx.run(`
      ALTER TABLE ${table} ADD COLUMN released_knowledge_exact_refs TEXT
      CHECK (released_knowledge_exact_refs IS NULL OR (
        json_valid(released_knowledge_exact_refs) = 1 AND
        json_type(released_knowledge_exact_refs) = 'array'
      ))
    `)
    yield* tx.run(`
      ALTER TABLE ${table} ADD COLUMN released_knowledge_exact_refs_fingerprint TEXT
      CHECK (released_knowledge_exact_refs_fingerprint IS NULL OR (
        length(released_knowledge_exact_refs_fingerprint) = 64 AND
        released_knowledge_exact_refs_fingerprint NOT GLOB '*[^0-9a-f]*'
      ))
    `)
  })
}

function invalidReceiptAuthority(row: string, insert: boolean) {
  return `(
    ${invalidReceiptScope(row)} OR
    ${invalidBinding(
      row,
      `${row}.released_knowledge_security_namespace_id`,
      `${row}.released_knowledge_project_scope_key`,
    )} OR
    ${invalidReceiptLinks(row)} OR
    ${
      insert
        ? `(
            ${row}.provider_state <> 'preparing' OR
            ${row}.released_knowledge_selected_refs IS NOT NULL OR
            ${row}.released_knowledge_selected_refs_fingerprint IS NOT NULL
          )`
        : `(${invalidContextActivation(row)} OR ${invalidSelectedRefs(row)})`
    }
  )`
}

function invalidReceiptScope(row: string) {
  return `(
    ${row}.released_knowledge_security_namespace_id IS NULL OR
    ${row}.released_knowledge_project_scope_key IS NULL OR
    NOT EXISTS (
      SELECT 1
      FROM context_project_scope_identity project
      WHERE project.security_namespace_id = ${row}.released_knowledge_security_namespace_id
        AND project.project_scope_key = ${row}.released_knowledge_project_scope_key
        AND project.retired_at IS NULL
    )
  )`
}

function invalidSelectionAuthority(row: string) {
  return `(
    ${row}.security_namespace_id IS NULL OR
    ${row}.project_scope_key IS NULL OR
    NOT EXISTS (
      SELECT 1
      FROM context_location_identity location
      WHERE location.security_namespace_id = ${row}.security_namespace_id
        AND location.project_scope_key = ${row}.project_scope_key
        AND location.location_key = ${row}.location_key
        AND location.retired_at IS NULL
    ) OR
    ${invalidBinding(row, `${row}.security_namespace_id`, `${row}.project_scope_key`)}
  )`
}

function invalidReceiptLinks(row: string) {
  return `(
    (${row}.context_selection_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM session_context_selection selection
      WHERE selection.selection_id = ${row}.context_selection_id
        AND selection.session_id = ${row}.session_id
        AND selection.security_namespace_id IS ${row}.released_knowledge_security_namespace_id
        AND selection.project_scope_key IS ${row}.released_knowledge_project_scope_key
        AND selection.released_knowledge_binding_state IS ${row}.released_knowledge_binding_state
        AND selection.released_knowledge_snapshot_id IS ${row}.released_knowledge_snapshot_id
        AND selection.released_knowledge_generation IS ${row}.released_knowledge_generation
        AND selection.released_knowledge_membership_hash IS ${row}.released_knowledge_membership_hash
        AND selection.released_knowledge_manifest_hash IS ${row}.released_knowledge_manifest_hash
        AND selection.released_knowledge_exact_refs IS ${row}.released_knowledge_exact_refs
        AND selection.released_knowledge_exact_refs_fingerprint IS ${row}.released_knowledge_exact_refs_fingerprint
    )) OR
    (${row}.provider_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM session_provider_attempt attempt
      WHERE attempt.attempt_id = ${row}.provider_attempt_id
        AND attempt.session_id = ${row}.session_id
        AND attempt.selection_id IS ${row}.context_selection_id
    ))
  )`
}

function invalidContextActivation(row: string) {
  return `(
    ${row}.final_request_hash IS NULL OR
    ${row}.adapter_prepared_at IS NULL OR
    ${row}.prompt_epoch IS NULL OR
    ${row}.prompt_window_id IS NULL OR
    ${row}.effective_history_hash IS NULL OR
    ${row}.context_eligibility IS NULL OR
    json_valid(${row}.context_eligibility) != 1 OR
    ${row}.context_readiness IS NULL OR
    json_valid(${row}.context_readiness) != 1 OR
    ${row}.context_activation IS NULL OR
    json_valid(${row}.context_activation) != 1 OR
    ${row}.context_activation_fingerprint IS NULL OR
    length(${row}.context_activation_fingerprint) != 64 OR
    ${row}.context_activation_fingerprint GLOB '*[^0-9a-f]*'
  )`
}

function invalidBinding(row: string, securityNamespaceId: string, projectScopeKey: string) {
  return `(
    ${row}.released_knowledge_binding_state IS NULL OR
    ${row}.released_knowledge_binding_state = 'legacy_unbound' OR
    ${row}.released_knowledge_exact_refs IS NULL OR
    ${row}.released_knowledge_exact_refs_fingerprint IS NULL OR
    (${row}.released_knowledge_binding_state = 'unavailable' AND (
      ${row}.released_knowledge_snapshot_id IS NOT NULL OR
      ${row}.released_knowledge_generation IS NOT NULL OR
      ${row}.released_knowledge_membership_hash IS NOT NULL OR
      ${row}.released_knowledge_manifest_hash IS NOT NULL OR
      ${row}.released_knowledge_exact_refs <> '[]' OR
      ${row}.released_knowledge_exact_refs_fingerprint <> '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    )) OR
    (${row}.released_knowledge_binding_state = 'bound' AND (
      ${row}.released_knowledge_snapshot_id IS NULL OR
      ${row}.released_knowledge_generation IS NULL OR
      ${row}.released_knowledge_membership_hash IS NULL OR
      ${row}.released_knowledge_manifest_hash IS NULL OR
      ${row}.released_knowledge_exact_refs_fingerprint <> ${row}.released_knowledge_membership_hash OR
      NOT EXISTS (
        SELECT 1
        FROM released_knowledge_snapshot snapshot
        WHERE snapshot.snapshot_id = ${row}.released_knowledge_snapshot_id
          AND snapshot.security_namespace_id = ${securityNamespaceId}
          AND snapshot.project_scope_key = ${projectScopeKey}
          AND snapshot.published_generation = ${row}.released_knowledge_generation
          AND snapshot.verdict = 'passed'
          AND snapshot.finalized_at IS NOT NULL
          AND snapshot.document_count = json_array_length(${row}.released_knowledge_exact_refs)
      ) OR
      EXISTS (
        SELECT 1
        FROM json_each(${row}.released_knowledge_exact_refs) exact_ref
        WHERE json_type(exact_ref.value) <> 'object'
          OR (SELECT count(*) FROM json_each(exact_ref.value)) <> 6
          OR EXISTS (
            SELECT 1
            FROM json_each(exact_ref.value) field
            WHERE field.key NOT IN ('sourceStore', 'id', 'version', 'hash', 'type', 'scope')
          )
          OR NOT EXISTS (
            SELECT 1
            FROM released_knowledge_snapshot_document document
            WHERE document.snapshot_id = ${row}.released_knowledge_snapshot_id
              AND document.ordinal = CAST(exact_ref.key AS INTEGER)
              AND document.source_store = json_extract(exact_ref.value, '$.sourceStore')
              AND document.doc_id = json_extract(exact_ref.value, '$.id')
              AND document.doc_version = json_extract(exact_ref.value, '$.version')
              AND document.doc_hash = json_extract(exact_ref.value, '$.hash')
              AND document.doc_type = json_extract(exact_ref.value, '$.type')
              AND document.doc_scope = json_extract(exact_ref.value, '$.scope')
          )
      )
    ))
  )`
}

function invalidSelectedRefs(row: string) {
  return `(
    ${row}.released_knowledge_selected_refs IS NULL OR
    ${row}.released_knowledge_selected_refs_fingerprint IS NULL OR
    length(${row}.released_knowledge_selected_refs_fingerprint) <> 64 OR
    ${row}.released_knowledge_selected_refs_fingerprint GLOB '*[^0-9a-f]*' OR
    (${row}.released_knowledge_binding_state = 'unavailable' AND (
      ${row}.released_knowledge_selected_refs <> '[]' OR
      ${row}.released_knowledge_selected_refs_fingerprint <> '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    )) OR
    (${row}.released_knowledge_binding_state = 'bound' AND (
      EXISTS (
        SELECT 1
        FROM json_each(${row}.released_knowledge_selected_refs) selected_ref
        WHERE json_type(selected_ref.value) <> 'object'
          OR (SELECT count(*) FROM json_each(selected_ref.value)) <> 6
          OR EXISTS (
            SELECT 1
            FROM json_each(selected_ref.value) field
            WHERE field.key NOT IN ('sourceStore', 'id', 'version', 'hash', 'type', 'scope')
          )
          OR NOT EXISTS (
            SELECT 1
            FROM released_knowledge_snapshot_document document
            WHERE document.snapshot_id = ${row}.released_knowledge_snapshot_id
              AND document.source_store = json_extract(selected_ref.value, '$.sourceStore')
              AND document.doc_id = json_extract(selected_ref.value, '$.id')
              AND document.doc_version = json_extract(selected_ref.value, '$.version')
              AND document.doc_hash = json_extract(selected_ref.value, '$.hash')
              AND document.doc_type = json_extract(selected_ref.value, '$.type')
              AND document.doc_scope = json_extract(selected_ref.value, '$.scope')
          )
      ) OR
      EXISTS (
        SELECT 1
        FROM json_each(${row}.released_knowledge_selected_refs) current_ref
        JOIN json_each(${row}.released_knowledge_selected_refs) previous_ref
          ON CAST(previous_ref.key AS INTEGER) = CAST(current_ref.key AS INTEGER) - 1
        WHERE json_extract(previous_ref.value, '$.sourceStore') > json_extract(current_ref.value, '$.sourceStore')
          OR (
            json_extract(previous_ref.value, '$.sourceStore') = json_extract(current_ref.value, '$.sourceStore') AND
            json_extract(previous_ref.value, '$.id') >= json_extract(current_ref.value, '$.id')
          )
      )
    ))
  )`
}
