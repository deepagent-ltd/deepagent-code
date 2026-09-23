import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { RecoveryDescriptor, RecoveryEvidence } from "../../contract/recovery-command"
import type { AttemptIdentity } from "./recovery-store"

// W2 — durable C1B recovery surfaces (design §W2). Each table mirrors a hand-written
// TypeScript migration (20260830000000_session_provider_recovery) — see the
// `schema-checkpoint` marker in packages/core/migration/<generated>/ that keeps the
// Drizzle snapshot aligned with the custom migration.

/** The durable five-class recovery descriptor (content-addressed, append-only). */
export const SessionProviderRecoveryDescriptorTable = sqliteTable(
  "session_provider_recovery_descriptor",
  {
    descriptor_id: text().primaryKey(),
    session_id: text().notNull(),
    activity_id: text().notNull(),
    turn_id: text().notNull(),
    kind: text().notNull(),
    payload: text({ mode: "json" }).$type<RecoveryDescriptor>().notNull(),
    content_hash: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("session_provider_recovery_descriptor_session_idx").on(table.session_id, table.created_at),
    index("session_provider_recovery_descriptor_attempt_idx").on(
      table.session_id,
      table.activity_id,
      table.turn_id,
    ),
  ],
)

/** The durable recovery-command slot: one row per content-addressed command, CAS by state. */
export const RecoveryCommandTable = sqliteTable("recovery_command", {
  command_id: text().primaryKey(),
  descriptor_id: text().references(() => SessionProviderRecoveryDescriptorTable.descriptor_id, {
    onDelete: "cascade",
  }),
  attempt: text({ mode: "json" }).$type<AttemptIdentity>().notNull(),
  state: text().notNull(),
  expected_owner_token: text(),
  result_hash: text(),
  /** Maintenance wire record: the actor that issued the command (nullable for core writes). */
  actor_type: text(),
  actor_id: text(),
  /**
   * The committed exit-vocabulary entry (contract `RecoveryCommandKind`) this row executes.
   * NULL = the pre-vocabulary rows, whose only executor exit was `abandon_exact`.
   */
  command_kind: text(),
  /** The typed `RecoveryEvidence` JSON a `confirm_settled` row carries (NULL otherwise). */
  evidence: text({ mode: "json" }).$type<RecoveryEvidence>(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})

/** The durable evidence-export receipt (manifest hash + lifecycle state + sealed body). */
export const RecoveryEvidenceExportTable = sqliteTable("recovery_evidence_export", {
  export_id: text().primaryKey(),
  descriptor_id: text().references(() => SessionProviderRecoveryDescriptorTable.descriptor_id, {
    onDelete: "set null",
  }),
  manifest_hash: text().notNull(),
  state: text().notNull(),
  created_at: integer().notNull(),
  /** JSON: the sealed export body ({ manifest, artifact } or the maintenance record). */
  payload: text().notNull(),
})
