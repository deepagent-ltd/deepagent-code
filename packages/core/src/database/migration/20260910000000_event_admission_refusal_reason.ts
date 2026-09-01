import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { eventAdmissionReasonMigration } from "../../deepagent/event-admission-sql"

// W5 F3 — refusal rows record WHY the last attempt was refused. The `deepagent_event_admission` ledger
// ships its DDL through `eventAdmissionMigration` (inside `20260829030000_wire_event_ledgers`), which is
// CREATE TABLE IF NOT EXISTS — ALREADY APPLIED on production DBs, so a forward-only ALTER is required.
// Guarded on `PRAGMA table_info` so a fresh DB (whose CREATE TABLE already carries the column) skips it.
export default {
  id: eventAdmissionReasonMigration.id,
  up(tx) {
    return eventAdmissionReasonMigration.up(tx)
  },
} satisfies DatabaseMigration.Migration
