import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { AbsolutePath } from "../src/schema"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { WorkSessionGuard } from "../src/session/work-session-guard"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { WorkAuthorityFixture } from "./fixture/work-authority"

type Db = Database.Interface["db"]
const result = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof WorkAuthoritySchema.Error ? error.code : Cause.pretty(exit.cause)
}
const session = (db: Db, id: string, parent?: string, metadata?: unknown) =>
  db.run(sql`
  INSERT INTO session (id,project_id,slug,directory,title,version,v2_authority,agent,parent_id,metadata,time_created,time_updated)
  VALUES (${id},'project-legacy',${id},'/tmp/legacy-guard','Legacy guard','2',1,'auto',${parent ?? null},${metadata === undefined ? null : JSON.stringify(metadata)},1,1)
`)
const facts = (db: Db) =>
  Effect.all({
    sessions: db.all("SELECT * FROM session ORDER BY id"),
    inputs: db.all("SELECT * FROM session_input ORDER BY id"),
    events: db.all("SELECT * FROM event ORDER BY sync_seq"),
    work: db.all("SELECT * FROM work_execution ORDER BY work_id"),
  })
async function isolated<A, E>(body: (db: Db) => Effect.Effect<A, E>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-legacy-core-")))
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run("PRAGMA foreign_keys = ON")
        yield* DatabaseMigration.applyOnly(db, migrations)
        yield* db.run(
          "INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES ('project-legacy','/tmp/legacy-guard','[]',1,1)",
        )
        return yield* body(db)
      }).pipe(Effect.provide(WorkAuthorityFixture.database(path.join(root, "authority.sqlite"))), Effect.scoped),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
const denied = (db: Db, id: string) =>
  Effect.gen(function* () {
    expect((yield* WorkAuthority.lookupSession(db, id)).kind).toBe("legacy_unbound")
    const before = yield* facts(db)
    expect(result(yield* WorkSessionGuard.requireOrdinary(db, id).pipe(Effect.exit))).toBe("WORK_AUTHORITY_MISSING")
    expect(result(yield* WorkSessionGuard.requireExecution(db, id).pipe(Effect.exit))).toBe("WORK_AUTHORITY_MISSING")
    expect(
      result(
        yield* WorkSessionGuard.requireCreation(db, {
          parentID: id,
          location: { directory: AbsolutePath.make("/tmp/legacy-guard") },
        }).pipe(Effect.exit),
      ),
    ).toBe("WORK_AUTHORITY_MISSING")
    expect(yield* facts(db)).toEqual(before)
  })

test("resolved event receipt and descendants are denial facts, never an execution grant", () =>
  isolated((db) =>
    Effect.gen(function* () {
      yield* session(db, "ses_event")
      yield* session(db, "ses_descendant", "ses_event")
      yield* db.run(
        sql`INSERT INTO deepagent_event_admission(event_ref,session_id,envelope_digest,status,envelope_json,admitted_at,updated_at) VALUES ('event://old','ses_event',${"a".repeat(64)},'resolved','{}',1,1)`,
      )
      yield* denied(db, "ses_event")
      yield* denied(db, "ses_descendant")
    }),
  ))

test("live IM intent Session and input links both fence unbound execution", () =>
  isolated((db) =>
    Effect.gen(function* () {
      yield* session(db, "ses_im")
      yield* session(db, "ses_im_input")
      yield* db.run(
        "INSERT INTO im_groups(id,workspace_id,type,name,created_by,created_at,updated_at) VALUES ('group-legacy','workspace-legacy','project','Legacy','server',1,1)",
      )
      yield* db.run(
        "INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,mentions,created_at,updated_at) VALUES ('message-legacy','group-legacy','server','user','text','hello','[]',1,1)",
      )
      yield* db.run(
        "INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,time_created) VALUES ('input-legacy','ses_im_input','{\"text\":\"old\"}','queue',1,1)",
      )
      yield* db.run(
        "INSERT INTO im_mention_intent(id,message_id,agent_name,directory,workspace_id,user_id,origin,session_id,input_id,status,created_at,updated_at) VALUES ('intent-legacy','message-legacy','auto','/tmp/legacy-guard','workspace-legacy','server','local','ses_im','input-legacy','pending',1,1)",
      )
      yield* denied(db, "ses_im")
      yield* denied(db, "ses_im_input")
    }),
  ))

test("completed DAG artifacts and actual ancestor linkage fence legacy children", () =>
  isolated((db) =>
    Effect.gen(function* () {
      yield* session(db, "ses_dag")
      yield* session(db, "ses_dag_child", "ses_dag")
      yield* db.run(
        "INSERT INTO deepagent_agent_execution(workspace_id,event_id,task_id,status,generation,artifacts,tokens_used,created_at,updated_at) VALUES ('workspace-legacy','event-dag','task-dag','completed',1,'[\"session:ses_dag\"]',0,1,1)",
      )
      yield* denied(db, "ses_dag")
      yield* denied(db, "ses_dag_child")
    }),
  ))

test("running DAG requires the durable execution row AND exact historical child identity", () =>
  isolated((db) =>
    Effect.gen(function* () {
      const id = `ses_v4_${Hash.sha256(CanonicalJson.stringify(["event-turn-session", "event-running", "task-running", 1])).slice(0, 40)}`
      const metadata = { eventID: "event-running", taskID: "task-running", generation: 1 }
      yield* session(db, id, undefined, metadata)
      yield* session(db, "ses_copied_metadata", undefined, metadata)
      yield* db.run(
        "INSERT INTO deepagent_agent_execution(workspace_id,event_id,task_id,status,generation,artifacts,tokens_used,created_at,updated_at) VALUES ('workspace-legacy','event-running','task-running','running',1,'[]',0,1,1)",
      )
      yield* denied(db, id)
      expect((yield* WorkAuthority.lookupSession(db, "ses_copied_metadata")).kind).toBe("ordinary")
      yield* WorkSessionGuard.requireOrdinary(db, "ses_copied_metadata")
      yield* WorkSessionGuard.requireExecution(db, "ses_copied_metadata")
    }),
  ))

test("ordinary user metadata, refused event and nonexistent lineage cannot mint or imply Work", () =>
  isolated((db) =>
    Effect.gen(function* () {
      const id = `ses_v4_${Hash.sha256(CanonicalJson.stringify(["event-turn-session", "fake", "fake", 1])).slice(0, 40)}`
      yield* session(db, id, undefined, {
        workID: "fake",
        eventID: "fake",
        taskID: "fake",
        generation: 1,
        im: { groupID: "fake", agent: "auto" },
      })
      yield* db.run(
        sql`INSERT INTO deepagent_event_admission(event_ref,session_id,envelope_digest,status,envelope_json,admitted_at,updated_at) VALUES ('event://refused',${id},${"b".repeat(64)},'refused','{}',1,1)`,
      )
      const before = yield* facts(db)
      expect((yield* WorkAuthority.lookupSession(db, id)).kind).toBe("ordinary")
      yield* WorkSessionGuard.requireOrdinary(db, id)
      yield* WorkSessionGuard.requireExecution(db, id)
      expect(yield* facts(db)).toEqual(before)
    }),
  ))
