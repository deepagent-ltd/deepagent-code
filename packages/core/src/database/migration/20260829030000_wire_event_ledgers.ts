import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { eventOutboxMigration } from "../../deepagent/event-outbox-sql"
import { eventConsumerMigrations } from "../../deepagent/event-consumer-sql"
import { eventAdmissionMigration } from "../../deepagent/event-admission-sql"
import { eventSpoolMigration } from "../../deepagent/event-spool-sql"
import { taskDagRefMigration } from "../../deepagent/task-dag-ref-sql"
import { imSingleWriteMigration } from "../../deepagent/im-single-write-sql"
import { consumerReceiptMigration } from "../../deepagent/consumer-receipt-sql"

// Main-agent wiring (worklist §2: event-hotspot ledgers; shared migration registry = main agent).
// The event layer owns its schemas in `deepagent/*-sql.ts` as Drizzle table objects + idempotent
// Migration objects (single source of truth for the event runtime AND its tests); this body is the
// production chain entry that applies them once, in dependency order (publisher -> consumer ->
// admission -> spool -> refs -> IM -> consumer receipts). Every inner `up` is CREATE IF NOT EXISTS
// idempotent, so a re-run (e.g. after a mid-transaction rollback at an upgrade-run boundary) is safe.
const eventLedgers: readonly DatabaseMigration.Migration[] = [
  eventOutboxMigration,
  ...eventConsumerMigrations,
  eventAdmissionMigration,
  eventSpoolMigration,
  taskDagRefMigration,
  imSingleWriteMigration,
  consumerReceiptMigration,
]

export default {
  id: "20260829030000_wire_event_ledgers",
  up(tx) {
    return Effect.gen(function* () {
      for (const ledger of eventLedgers) yield* ledger.up(tx)
    })
  },
} satisfies DatabaseMigration.Migration
