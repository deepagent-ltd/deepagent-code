import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { randomBytes } from "node:crypto"
import { Database } from "@deepagent-code/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@deepagent-code/core/session/sql"
import {
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { SessionActivityProgressTable, SessionLegacyActivityTable } from "../activity-sql"
import { SessionToolRequestReceiptTable } from "../tool-request-receipt.sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { exportSessionSnapshot, importSessionSnapshot, SNAPSHOT_FORMAT, type SessionSnapshot } from "../snapshot"
import { tmpdir } from "node:os"
import { join } from "node:path"

const EMPTY_REFS_FINGERPRINT = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
const randomHex = (n: number) => randomBytes(n).toString("hex")

function withDb(dbPath: string, program: Effect.Effect<any, any, any>): Promise<any> {
  const database = Database.layerFromPath(dbPath)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Effect.runPromise(program.pipe(Effect.provide(database as any)) as any)
}

const PROJECT_ID = "proj_snap"
const DIRECTORY = "/tmp/snap-proj"
const NS_ID = "ns_seed"
const SCOPE_KEY = "scope_seed"
const OWNER_TOKEN = "owner_seed_token"

/** Seed authority rows (owner lease + security namespace + scope identity) for receipt triggers. */
function seedAuthority(db: any) {
  return Effect.gen(function* () {
    const now = Date.now()
    yield* db
      .insert(SecurityNamespaceTable)
      .values([{ id: NS_ID, kind: "implicit_local", binding_hash: randomHex(32), created_at: now, retired_at: null }] as never)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values(
        [
          {
            security_namespace_id: NS_ID,
            project_scope_key: SCOPE_KEY,
            project_kind: "registered_root",
            project_identity_hash: randomHex(32),
            created_at: now,
            retired_at: null,
          },
        ] as never,
      )
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionProviderOwnerLeaseTable)
      .values(
        [
          {
            owner_token: OWNER_TOKEN,
            registered_at: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
            heartbeat_at: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
            lease_expires_at: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 3600000`,
            released_at: null,
          },
        ] as never,
      )
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

/** Seed session row + 2 messages + 4 parts. */
function seedConversation(db: any, sessionID: string) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values([{ id: PROJECT_ID, worktree: DIRECTORY, sandboxes: [] }] as never)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values(
        [
          {
            id: sessionID,
            project_id: PROJECT_ID,
            slug: "snap",
            directory: DIRECTORY,
            title: "快照测试会话",
            version: "test",
            model: { id: "deepseek-chat", providerID: "deepseek" },
            time_created: 1_782_870_400_000,
            time_updated: 1_782_870_410_000,
          },
        ] as never,
      )
      .run()
      .pipe(Effect.orDie)
    const userMsg = `${sessionID}_msg_user`
    const asstMsg = `${sessionID}_msg_asst`
    yield* db
      .insert(MessageTable)
      .values([
        { id: userMsg, session_id: sessionID, time_created: 1_782_870_401_000, time_updated: 1_782_870_401_000, data: { role: "user" } },
        {
          id: asstMsg,
          session_id: sessionID,
          time_created: 1_782_870_402_000,
          time_updated: 1_782_870_405_000,
          data: { role: "assistant", model: { providerID: "deepseek", modelID: "deepseek-chat" } },
        },
      ] as never)
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values([
        { id: `${sessionID}_p_u`, message_id: userMsg, session_id: sessionID, time_created: 1_782_870_401_000, time_updated: 1_782_870_401_000, data: { type: "text", text: "hello world" } },
        { id: `${sessionID}_p_r`, message_id: asstMsg, session_id: sessionID, time_created: 1_782_870_402_000, time_updated: 1_782_870_402_000, data: { type: "reasoning", text: "thinking" } },
        { id: `${sessionID}_p_t`, message_id: asstMsg, session_id: sessionID, time_created: 1_782_870_403_000, time_updated: 1_782_870_403_000, data: { type: "text", text: "print('hi')" } },
        { id: `${sessionID}_p_tool`, message_id: asstMsg, session_id: sessionID, time_created: 1_782_870_404_000, time_updated: 1_782_870_404_000, data: { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: "hi" } } },
      ] as never)
      .run()
      .pipe(Effect.orDie)
    return { userMsg, asstMsg }
  })
}

/**
 * Seed one activity + one progress revision honoring the state-machine triggers:
 * insert activity(active) -> synthetic receipt (satisfying receipt triggers) -> progress ->
 * (optionally) terminalize. FK off only for the placeholder trigger_admission_id.
 */
function seedActivity(db: any, sessionID: string, asstMsg: string, userMsg: string, opts: { leaveActive?: boolean } = {}) {
  const activityID = `${sessionID}_act`
  const receiptID = `${sessionID}_rcpt`
  return Effect.acquireUseRelease(
    db.run("PRAGMA foreign_keys = OFF").pipe(Effect.orDie),
    () =>
      Effect.gen(function* () {
        yield* db
          .insert(SessionLegacyActivityTable)
          .values(
            [
              {
                activity_id: activityID,
                session_id: sessionID,
                ordinal: 0,
                trigger_admission_id: `${sessionID}_adm`,
                owner_token: OWNER_TOKEN,
                state: "active",
                terminal_reason: null,
                created_at: 1_782_870_401_000,
                settled_at: null,
              },
            ] as never,
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionToolRequestReceiptTable)
          .values(
            [
              {
                receipt_id: receiptID,
                request_ordinal: 1,
                session_id: sessionID,
                user_message_id: userMsg,
                assistant_message_id: asstMsg,
                provider_id: "deepseek",
                model_id: "deepseek-chat",
                registry_tool_ids: [],
                permission_filtered_tool_ids: [],
                final_offered_tool_ids: [],
                call_ids: [],
                provider_state: "preparing",
                request_state: "prepared",
                owner_token: OWNER_TOKEN,
                released_knowledge_security_namespace_id: NS_ID,
                released_knowledge_project_scope_key: SCOPE_KEY,
                released_knowledge_binding_state: "unavailable",
                released_knowledge_exact_refs: [],
                released_knowledge_exact_refs_fingerprint: EMPTY_REFS_FINGERPRINT,
                created_at: 1_782_870_402_000,
              },
            ] as never,
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionActivityProgressTable)
          .values(
            [
              {
                activity_id: activityID,
                revision: 0,
                assistant_message_id: asstMsg,
                text_part_id: null,
                provider_receipt_id: receiptID,
                input_membership_ordinal: 0,
                state: "final",
                created_at: 1_782_870_402_000,
                settled_at: 1_782_870_405_000,
              },
            ] as never,
          )
          .run()
          .pipe(Effect.orDie)
        if (!opts.leaveActive) {
          yield* db
            .update(SessionLegacyActivityTable)
            .set({ state: "settled", settled_at: 1_782_870_405_000, terminal_reason: "stop" } as never)
            .where(eq(SessionLegacyActivityTable.activity_id, activityID as never))
            .run()
            .pipe(Effect.orDie)
        }
        return activityID
      }),
    () => db.run("PRAGMA foreign_keys = ON").pipe(Effect.orDie),
  )
}

const messagesOf = (db: any, sessionID: string) =>
  db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID as never))
    .orderBy(asc(MessageTable.time_created))
    .all()
    .pipe(Effect.orDie)
const partsOf = (db: any, sessionID: string) =>
  db.select().from(PartTable).where(eq(PartTable.session_id, sessionID as never)).all().pipe(Effect.orDie)
const sessionRow = (db: any, sessionID: string) =>
  db.select().from(SessionTable).where(eq(SessionTable.id, sessionID as never)).get().pipe(Effect.orDie)
const activitiesOf = (db: any, sessionID: string) =>
  db
    .select()
    .from(SessionLegacyActivityTable)
    .where(eq(SessionLegacyActivityTable.session_id, sessionID as never))
    .all()
    .pipe(Effect.orDie)
const progressOf = (db: any, activityID: string) =>
  db
    .select()
    .from(SessionActivityProgressTable)
    .where(eq(SessionActivityProgressTable.activity_id, activityID as never))
    .all()
    .pipe(Effect.orDie)

describe("session snapshot export/import (complete scene + continue)", () => {
  it("round-trips conversation + activity markers with fresh IDs and consistent ownership", async () => {
    const dbPath = join(tmpdir(), `snap-rt-${Date.now()}.sqlite`)
    await withDb(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const srcID = "ses_src_rt"
        yield* seedAuthority(db)
        const { userMsg, asstMsg } = yield* seedConversation(db, srcID)
        const srcActivityID = yield* seedActivity(db, srcID, asstMsg, userMsg)

        const snapshot = yield* exportSessionSnapshot(srcID)
        expect(snapshot.format).toBe(SNAPSHOT_FORMAT)
        expect(snapshot.messages.length).toBe(2)
        expect(snapshot.parts.length).toBe(4)
        expect(snapshot.activities.length).toBe(1)
        expect(snapshot.progress.length).toBe(1)

        const parsed = JSON.parse(JSON.stringify(snapshot))
        const imported = yield* importSessionSnapshot({ snapshot: parsed, projectID: PROJECT_ID, directory: DIRECTORY })
        const newID = imported.sessionID
        expect(newID).not.toBe(srcID)

        // conversation reconstructed with fresh IDs
        const msgs = yield* messagesOf(db, newID)
        expect(msgs.length).toBe(2)
        expect(msgs[0].data.role).toBe("user")
        expect(msgs[1].data.role).toBe("assistant")
        expect(msgs[1].id).not.toBe(asstMsg)
        const parts = yield* partsOf(db, newID)
        expect(parts.length).toBe(4)

        // activity + progress reconstructed with a fresh activity_id, terminal state preserved
        const acts = yield* activitiesOf(db, newID)
        expect(acts.length).toBe(1)
        expect(acts[0].activity_id).not.toBe(srcActivityID)
        expect(acts[0].state).toBe("settled")
        const prog = yield* progressOf(db, acts[0].activity_id)
        expect(prog.length).toBe(1)
        // progress.assistant_message_id remapped to the NEW assistant message
        expect(prog[0].assistant_message_id).toBe(msgs[1].id)
        // ownership consistency required by message-v2.ts:419
        expect(acts[0].session_id).toBe(msgs[1].session_id)
        // no active activity remains -> continuable
        expect(acts.some((a: any) => a.state === "active")).toBe(false)
      }),
    )
  })

  it("guarantees continue: a mid-run (active) source is terminalized, no active activity remains", async () => {
    const dbPath = join(tmpdir(), `snap-cont-${Date.now()}.sqlite`)
    await withDb(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const srcID = "ses_src_midrun"
        yield* seedAuthority(db)
        const { userMsg, asstMsg } = yield* seedConversation(db, srcID)
        yield* seedActivity(db, srcID, asstMsg, userMsg, { leaveActive: true })
        const srcActs = yield* activitiesOf(db, srcID)
        expect(srcActs.some((a: any) => a.state === "active")).toBe(true)

        const snapshot = yield* exportSessionSnapshot(srcID)
        const imported = yield* importSessionSnapshot({ snapshot, projectID: PROJECT_ID, directory: DIRECTORY })
        const newID = imported.sessionID

        const session = yield* sessionRow(db, newID)
        expect(session).toBeTruthy()
        const acts = yield* activitiesOf(db, newID)
        expect(acts.length).toBe(1)
        // the active source activity is terminalized -> no active activity -> continuable
        expect(acts.some((a: any) => a.state === "active")).toBe(false)
        expect(acts[0].state).toBe("interrupted")
        expect(acts[0].terminal_reason).toBe("imported_snapshot")
        const msgs = yield* messagesOf(db, newID)
        expect(msgs.length).toBe(2)
      }),
    )
  })

  it("rejects an invalid format/version", async () => {
    const dbPath = join(tmpdir(), `snap-bad-${Date.now()}.sqlite`)
    const snapshot = (await withDb(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const srcID = "ses_src_bad"
        yield* seedAuthority(db)
        const { userMsg, asstMsg } = yield* seedConversation(db, srcID)
        yield* seedActivity(db, srcID, asstMsg, userMsg)
        return yield* exportSessionSnapshot(srcID)
      }),
    )) as SessionSnapshot

    const badFormat = importSessionSnapshot({
      snapshot: { ...snapshot, format: "other" as never },
      projectID: PROJECT_ID,
      directory: DIRECTORY,
    })
    await expect(withDb(dbPath, badFormat)).rejects.toBeTruthy()
    const badVersion = importSessionSnapshot({
      snapshot: { ...snapshot, format_version: 99 },
      projectID: PROJECT_ID,
      directory: DIRECTORY,
    })
    await expect(withDb(dbPath, badVersion)).rejects.toBeTruthy()
  })
})
