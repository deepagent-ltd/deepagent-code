export * as IMTaskWorkAdmission from "./task-work-admission"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"

/** Historical state remains readable. Old IM grants cannot admit or wake work. */
export const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const read = (requestID: string) =>
    Effect.gen(function* () {
      const value = yield* IMTaskAuthority.readAdmission(database.db, requestID)
      const [state] = value.work
        ? yield* database.db.all<{ running: number; recovery: number }>(sql`
      SELECT (execution_claim_token IS NOT NULL) running,
        (EXISTS(SELECT 1 FROM work_count_acquisition c WHERE c.work_id=${value.work.work_id} AND (c.state='unknown' OR (c.state='sending' AND c.deadline<=${Date.now()})))
        OR EXISTS(SELECT 1 FROM work_dispatch_reservation r WHERE r.work_id=${value.work.work_id} AND r.state='unknown')) recovery
      FROM session WHERE id=${value.work.session_id}`)
        : []
      return { ...value, running: !!state?.running, recoveryRequired: !!state?.recovery }
    })
  const accept = (_input: { requestID: string; operationID: string; expectedRevision: number; directory: string }):
    Effect.Effect<Effect.Success<ReturnType<typeof read>>, WorkAuthoritySchema.Error> =>
    Effect.fail(new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "Restricted IM execution is retired" }))
  return { read, accept, reconcileQueued: Effect.void, installed: false }
})
