import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { MediaUploadCheckpointMigrationFixture } from "./fixture/im-media-upload-checkpoint-migration"

const selected = migrations.find((entry) => entry.id === "20261010140547_session_mcp_app_invocation")!
const prior = migrations.slice(0, migrations.indexOf(selected))
type Db = MediaUploadCheckpointMigrationFixture.Db
const initialize = (db: Db) => Effect.gen(function* () {
  yield* DatabaseMigration.applyOnly(db, [...migrations])
  yield* db.run("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('apps-project','/private/apps-module','[]',1,1)")
  yield* db.run("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_apps_module','apps-project','apps','/private/apps-module','Apps physical fixture','2',1,1)")
})
// Legal physical history only: no MCP/Native view or permission is issued by these rows.
const enqueue = (db: Db, id: string) => Effect.gen(function* () {
  const now = Date.now()
  const source = JSON.stringify({ kind: "mcp_app", sessionID: "ses_apps_module", viewID: `view-${id}`, expiresAt: now + 60000,
    original: "源🙂 é" })
  const argumentsBody = JSON.stringify({ text: "参数🙂 é" })
  yield* db.transaction((tx) => Effect.gen(function* () {
    yield* tx.run(sql`INSERT INTO session_mcp_app_invocation(invocation_id,session_id,view_id,rpc_id,admitted_seq,source_kind,source,source_hash,input_hash,arguments,arguments_bytes,created_at,expires_at)
      VALUES(${id},'ses_apps_module',${`view-${id}`},${JSON.stringify(id)},1,'mcp_app',${source},${"a".repeat(64)},${"b".repeat(64)},${argumentsBody},${Buffer.byteLength(argumentsBody)},${now},${now+60000})`)
    yield* tx.run(sql`INSERT INTO session_mcp_app_effect(invocation_id,state,revision) VALUES(${id},'queued',1)`)
  }))
})
const claim = (db: Db, id: string, at = Date.now()) => db.run(sql`UPDATE session_mcp_app_effect SET state='dispatching',revision=revision+1,
  owner_nonce='original-owner',session_claim_token=1,permission='{"type":"mcp_app"}',dispatched_at=${at},reserved_bytes=8388608 WHERE invocation_id=${id}`)
const refused = <A, E>(effect: Effect.Effect<A, E>) => Effect.gen(function* () {
  expect(Exit.isFailure(yield* effect.pipe(Effect.exit))).toBe(true)
})

test("official Apps additive migration keeps prior schema objects and cold FK-on exact reapply", async () => {
  await MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
    const before = await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
      yield* DatabaseMigration.applyOnly(db, [...prior])
      yield* db.run("CREATE TABLE apps_original_audit(id INTEGER PRIMARY KEY,value TEXT NOT NULL)")
      yield* db.run("CREATE TRIGGER apps_original_audit BEFORE DELETE ON apps_original_audit BEGIN SELECT RAISE(ABORT,'original'); END")
      yield* db.run(sql`INSERT INTO apps_original_audit(id,value) VALUES(1,${"原始正文🙂"})`)
      const original = yield* db.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='apps_original_audit' ORDER BY type")
      yield* DatabaseMigration.applyOnly(db, [selected])
      expect(yield* db.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='apps_original_audit' ORDER BY type")).toEqual(original)
      expect(yield* db.all("SELECT * FROM apps_original_audit")).toEqual([{ id: 1, value: "原始正文🙂" }])
      expect(yield* db.get("SELECT count(*) count FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('session_mcp_app_invocation','session_mcp_app_effect')")).toEqual({ count: 12 })
      return yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
    }))
    await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
      yield* DatabaseMigration.applyOnly(db, [...prior, selected])
      expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(db)).toEqual(before)
    }))
  })
})

test("immutable Apps source and exact terminal result survive body retirement without hydration or deletion", async () => {
  await MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
    await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
      yield* initialize(db)
      yield* enqueue(db, "aged")
      yield* refused(db.run("UPDATE session_mcp_app_invocation SET input_hash='changed' WHERE invocation_id='aged'"))
      const at = Date.now()-86400002
      yield* claim(db, "aged", at)
      const result = JSON.stringify({ result: "原始结果🙂 é" })
      yield* db.run(sql`UPDATE session_mcp_app_effect SET state='settled',revision=revision+1,reserved_bytes=0,terminal_at=${at+1},result=${result},result_hash=${"c".repeat(64)},result_bytes=${Buffer.byteLength(result)} WHERE invocation_id='aged'`)
      yield* db.run(sql`UPDATE session_mcp_app_effect SET result=NULL,result_bytes=0,result_retired_at=${Date.now()} WHERE invocation_id='aged'`)
      yield* db.run(sql`UPDATE session_mcp_app_invocation SET arguments=NULL,arguments_bytes=0,arguments_retired_at=${Date.now()} WHERE invocation_id='aged'`)
      yield* refused(db.run("UPDATE session_mcp_app_invocation SET arguments='{}',arguments_bytes=2,arguments_retired_at=NULL WHERE invocation_id='aged'"))
      yield* refused(db.run("UPDATE session_mcp_app_effect SET result='{}',result_bytes=2,result_retired_at=NULL WHERE invocation_id='aged'"))
      yield* refused(db.run("DELETE FROM session_mcp_app_invocation WHERE invocation_id='aged'"))
      yield* refused(db.run("DELETE FROM session_mcp_app_effect WHERE invocation_id='aged'"))
      expect(yield* db.get("SELECT state,revision,result,result_hash,result_bytes,reserved_bytes FROM session_mcp_app_effect WHERE invocation_id='aged'"))
        .toEqual({ state: "settled", revision: 3, result: null, result_hash: "c".repeat(64), result_bytes: 0, reserved_bytes: 0 })
    }))
    await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
      expect(yield* db.get("SELECT arguments,arguments_bytes,source_hash,input_hash FROM session_mcp_app_invocation WHERE invocation_id='aged'"))
        .toEqual({ arguments: null, arguments_bytes: 0, source_hash: "a".repeat(64), input_hash: "b".repeat(64) })
      yield* refused(db.run("DELETE FROM session WHERE id='ses_apps_module'"))
    }))
  })
})

test("unknown Apps dispatch stays charged and terminal state or early argument retirement never becomes executable", async () => {
  await MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
    await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
      yield* initialize(db)
      yield* enqueue(db, "unknown")
      yield* claim(db, "unknown")
      yield* db.run(sql`UPDATE session_mcp_app_effect SET state='unknown',revision=revision+1,terminal_at=${Date.now()},error_code='unknown' WHERE invocation_id='unknown'`)
      yield* refused(db.run("UPDATE session_mcp_app_effect SET state='dispatching',revision=revision+1,terminal_at=NULL WHERE invocation_id='unknown'"))
      yield* refused(db.run("UPDATE session_mcp_app_effect SET reserved_bytes=0 WHERE invocation_id='unknown'"))
      yield* refused(db.run(sql`UPDATE session_mcp_app_invocation SET arguments=NULL,arguments_bytes=0,arguments_retired_at=${Date.now()+86400000} WHERE invocation_id='unknown'`))
      yield* enqueue(db, "recent")
      yield* db.run(sql`UPDATE session_mcp_app_effect SET state='cancelled_before_dispatch',revision=revision+1,terminal_at=${Date.now()} WHERE invocation_id='recent'`)
      yield* refused(db.run(sql`UPDATE session_mcp_app_invocation SET arguments=NULL,arguments_bytes=0,arguments_retired_at=${Date.now()+86400000} WHERE invocation_id='recent'`))
      expect(yield* db.get("SELECT state,reserved_bytes,result FROM session_mcp_app_effect WHERE invocation_id='unknown'"))
        .toEqual({ state: "unknown", reserved_bytes: 8388608, result: null })
    }))
  })
})

test("actual all-column UTF8 custody plus dispatch reservations enforces 64MiB with no half claim", async () => {
  await MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
    await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
      yield* initialize(db)
      yield* Effect.forEach(Array.from({ length: 8 }, (_, index) => `quota-${index}`), (id, index) => Effect.gen(function* () {
        yield* enqueue(db, id)
        if (index < 7) yield* claim(db, id)
      }), { discard: true })
      const bytes = yield* Effect.forEach(["session_mcp_app_invocation", "session_mcp_app_effect"], (table) => Effect.gen(function* () {
        const columns = yield* db.all<{ name: string; type: string }>(`PRAGMA table_info("${table}")`)
        const expression = columns.map((column) => /INT/i.test(column.type) ? `CASE WHEN "${column.name}" IS NULL THEN 0 ELSE 8 END`
          : `coalesce(length(CAST("${column.name}" AS BLOB)),0)`).join("+")
        return (yield* db.get<{ bytes: number }>(`SELECT sum(${expression}) bytes FROM "${table}"`))!.bytes
      }))
      expect(bytes.reduce((sum, value) => sum+value, 0)).toBeGreaterThan(0)
      expect(bytes.reduce((sum, value) => sum+value, 0)+7*8388608).toBeLessThan(67108864)
      expect(bytes.reduce((sum, value) => sum+value, 0)+8*8388608).toBeGreaterThan(67108864)
      yield* refused(claim(db, "quota-7"))
      expect(yield* db.get("SELECT state,revision,reserved_bytes,owner_nonce FROM session_mcp_app_effect WHERE invocation_id='quota-7'"))
        .toEqual({ state: "queued", revision: 1, reserved_bytes: 0, owner_nonce: null })
      yield* refused(enqueue(db, "quota-session-9"))
      expect(yield* db.get("SELECT count(*) count FROM session_mcp_app_invocation")).toEqual({ count: 8 })
    }))
  })
})
