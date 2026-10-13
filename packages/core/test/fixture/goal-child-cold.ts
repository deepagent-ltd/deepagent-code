export * as GoalChildColdFixture from "./goal-child-cold"

import fs from "node:fs/promises"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { Database } from "../../src/database/database"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalChildSchema } from "../../src/deepagent/goal-child.schema"
import { SessionV2 } from "../../src/session"
import { SessionSchema } from "../../src/session/schema"
import { SessionExecution } from "../../src/session/execution"
import { SessionStore } from "../../src/session/store"
import { GoalChildFixture } from "./goal-child"

export const inspect = (filename: string, sessionID: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const file = yield* Effect.promise(async () => {
      const canonicalPath = await fs.realpath(filename)
      const stat = await fs.stat(canonicalPath)
      return { path: canonicalPath, dev: stat.dev, inode: stat.ino }
    })
    return {
      file,
      unit: yield* db.all(
        sql`SELECT unit_id,goal_id,permit_id,role_key,parent_session_id,child_session_id,binding_hash,state,creation_receipt,inputs,created_at,updated_at FROM goal_child_unit WHERE child_session_id=${sessionID}`,
      ),
      session: yield* db.all(
        sql`SELECT id,parent_id,project_id,directory,workspace_id,agent,model,permission,execution_claim_token FROM session WHERE id=${sessionID}`,
      ),
      input: yield* db.all(
        sql`SELECT id,session_id,admitted_seq,promoted_seq,delivery,prompt FROM session_input WHERE session_id=${sessionID}`,
      ),
      events: yield* db.all("SELECT aggregate_id,seq,type,data FROM event ORDER BY sync_seq"),
      activities: yield* db.all("SELECT * FROM session_activity ORDER BY activity_id"),
      providerAttempts: yield* db.all("SELECT * FROM session_provider_attempt ORDER BY attempt_id"),
      providerReceipts: yield* db.all("SELECT * FROM session_v2_provider_turn_receipt ORDER BY receipt_id"),
      toolAdmissions: yield* db.all("SELECT * FROM session_v2_tool_effect_admission ORDER BY admission_id"),
      toolEffects: yield* db.all("SELECT * FROM session_v2_tool_effect ORDER BY effect_id"),
    }
  })

export async function run(filename: string, id: string) {
  const state = { locations: 0, runs: 0, shells: 0 }
  return await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionSchema.ID.make(id)
      const before = yield* inspect(filename, sessionID)
      const store = yield* SessionStore.Service
      const sessions = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const rows = yield* GoalChild.owner(db, sessionID)
      if (!rows) return yield* Effect.die("Cold fixture is missing its reserved Goal child")
      const admission = yield* GoalChild.admit(db, sessions, {
        permitID: rows.permit_id,
        permitToken: rows.binding.permitToken,
        roleKey: rows.role_key,
        agent: rows.binding.agent,
        mode: rows.binding.mode,
        steeringHash: rows.binding.steeringHash,
        promptPolicyHash: rows.binding.promptPolicyHash,
        stage: rows.inputs[0].stage,
        text: rows.inputs[0].text,
      }).pipe(Effect.exit)
      const admissionError = Exit.isFailure(admission) ? Cause.squash(admission.cause) : undefined
      const codes: string[] = []
      for (const operation of [
        store.requireExecution(sessionID),
        execution.resume(sessionID),
        execution.wake(sessionID).pipe(Effect.andThen(execution.awaitIdle(sessionID))),
        sessions.resume(sessionID),
      ]) {
        const exit = yield* operation.pipe(Effect.exit)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        codes.push(
          error instanceof GoalChildSchema.Error
            ? error.code
            : Exit.isSuccess(exit)
              ? "advisory_scheduled"
              : "unexpected",
        )
      }
      const after = yield* inspect(filename, sessionID)
      return {
        pid: process.pid,
        before,
        after,
        factsUnchanged: JSON.stringify(before) === JSON.stringify(after),
        coldAdmission: admissionError instanceof GoalChildSchema.Error ? admissionError.code : "unexpected",
        codes,
        unitID: rows?.unit_id,
        claim: (yield* store.claimToken(sessionID)) ?? null,
        eventsUnchanged: JSON.stringify(before.events) === JSON.stringify(after.events),
        state,
      }
    }).pipe(Effect.provide(GoalChildFixture.layer(filename, state)), Effect.scoped),
  )
}

if (import.meta.main) {
  const result = await run(process.argv[2]!, process.argv[3]!)
  process.stdout.write("GOAL_CHILD_COLD_RESULT " + JSON.stringify(result) + "\n")
}
