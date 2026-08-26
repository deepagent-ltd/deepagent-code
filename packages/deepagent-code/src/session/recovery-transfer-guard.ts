import { Database } from "@deepagent-code/core/database/database"
import {
  SessionHistoryStateTable,
  SessionToolRequestResolutionTable,
} from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { CompactionRunTable } from "./compaction-sql"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"
import { SessionID } from "./schema"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"

export const authorityID = Effect.fn("SessionRecoveryTransferGuard.authorityID")(function* (
  db: Database.Interface["db"],
  sessionID: SessionID,
) {
  const resolution = yield* db
    .select({ id: SessionToolRequestResolutionTable.resolution_id })
    .from(SessionToolRequestResolutionTable)
    .where(eq(SessionToolRequestResolutionTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (resolution) return resolution.id

  const receipt = yield* db
    .select({ id: SessionToolRequestReceiptTable.receipt_id })
    .from(SessionToolRequestReceiptTable)
    .where(
      and(
        eq(SessionToolRequestReceiptTable.session_id, sessionID),
        eq(SessionToolRequestReceiptTable.provider_state, "indeterminate_after_crash"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (receipt) return receipt.id

  const epoch = yield* db
    .select({ epoch: SessionPromptEpochTable.epoch })
    .from(SessionPromptEpochTable)
    .where(
      and(
        eq(SessionPromptEpochTable.session_id, sessionID),
        eq(SessionPromptEpochTable.authority_state, "recovery_required"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (epoch) return `prompt-epoch:${epoch.epoch}`

  const history = yield* db
    .select({ state: SessionHistoryStateTable.state })
    .from(SessionHistoryStateTable)
    .where(
      and(eq(SessionHistoryStateTable.session_id, sessionID), eq(SessionHistoryStateTable.state, "recovery_required")),
    )
    .get()
    .pipe(Effect.orDie)
  if (history) return "session-history"

  const continuation = yield* db
    .select({ id: CompactionRunTable.run_id })
    .from(CompactionRunTable)
    .where(
      and(
        eq(CompactionRunTable.session_id, sessionID),
        eq(CompactionRunTable.continuation_state, "indeterminate"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  return continuation?.id
})

export * as SessionRecoveryTransferGuard from "./recovery-transfer-guard"
