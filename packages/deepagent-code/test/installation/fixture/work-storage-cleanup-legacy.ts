import { Effect, Exit, Cause } from "effect"
import { LocalTaskAuthority } from "../../../src/im/local-task-authority"
import { ServerAuth } from "../../../src/server/auth"
import { NativeWorkStorageCleanup } from "../../../src/installation/work-storage-cleanup"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { Database } from "@deepagent-code/core/database/database"

const filename = process.env.DAC_STORAGE_LEGACY_DB!
const result = await Effect.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const config = yield* ServerAuth.Config
  const configured = yield* LocalTaskAuthority.configured(config)
  const witness = yield* LocalTaskAuthority.authenticatePassword(db,configured.runtime,config.username,configured.password)
  const [record] = yield* db.all<{ admissionID: string; revision: number; recoveryID: string }>(`SELECT
    c.admission_id admissionID,c.revision,r.recovery_id recoveryID FROM work_command_intent c
    INNER JOIN work_known_recovery r ON r.work_id=c.work_id WHERE c.state='settled' AND c.released_at IS NULL`)
  if (!record) throw new Error("The actual historical known command is missing")
  return yield* LocalTaskAuthority.provide({ runtime: configured.runtime,witness },
    NativeWorkStorageCleanup.refuseUncapturedCommand({ recoveryID: record.recoveryID,admissionID: record.admissionID,
      requestID: "legacy-command-readonly",expectedCustodyRevision: record.revision })).pipe(Effect.exit)
}).pipe(Effect.provide(WorkAuthorityFixture.database(filename)),Effect.provide(ServerAuth.Config.defaultLayer),Effect.scoped))
if (Exit.isSuccess(result)) throw new Error("Historical missing input manifest must never authorize cleanup")
const error = Cause.squash(result.cause)
process.stdout.write(JSON.stringify({ code: typeof error==="object" && error!==null && "code" in error ? error.code : "unexpected",
  layer: "real enrolled operator + original recovery MAC + actual historical DB; read-only classification",providerCalls: 0,nativeStorageOperations: 0 }))
