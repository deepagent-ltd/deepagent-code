import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { SessionRestart } from "../src/session/execution/restart"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "../src/session/runner/v2-tool-effect.sql"
import { SessionProviderAttemptTable } from "../src/context-federation/session-sql"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkExecutionTable } from "../src/session/work-authority.sql"
import { capability, seedSession, services } from "./fixture/attention"
import { WorkAuthorityFixture } from "./fixture/work-authority"

// The source rows come from the actual runner, coordinator, permission, receipt and tool
// producers. Only their provider stream/tool body is controlled; no real model is called.
async function produce(root: string, name: string, pattern: string) {
  const directory = path.join(root, name)
  await mkdir(directory)
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state"].map((part) => mkdir(path.join(directory, part))),
  )
  const filename = path.join(directory, "authority.sqlite")
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "./test/session-runner.test.ts",
      "--test-name-pattern",
      pattern,
      "--timeout",
      "20000",
    ],
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(directory, "home"),
      TMPDIR: path.join(directory, "tmp"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"),
      DEEPAGENT_TEST_RUNNER_EFFECT_DB: filename,
      DEEPAGENT_TEST_RUNNER_DIRECTORY: directory,
      DEEPAGENT_TEST_RUNNER_EFFECT_PHASE: "dispatch",
      DEEPAGENT_TEST_RUNNER_PROVIDER_FAILED: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, output: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, output: "ok" })
  return filename
}

async function cold(
  source: string,
  name: string,
  accepted: boolean,
  mutate?: (db: Database.Interface["db"], sessionID: SessionSchema.ID) => Effect.Effect<unknown>,
) {
  const filename = `${source}.${name}.sqlite`
  await copyFile(source, filename)
  const database = WorkAuthorityFixture.database(filename)
  const sessionID = await Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const admission = (yield* db.select().from(V2ToolEffectAdmissionTable).all().pipe(Effect.orDie))[0]!
    const attempt = (yield* db
      .select()
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.attempt_id, admission.provider_attempt_id))
      .all()
      .pipe(Effect.orDie))[0]!
    const sessionID = SessionSchema.ID.make(admission.session_id)
    // fixture-exempt: restore the exact dead claim, modelling a crash after legal terminal
    // producers and before CAS release. No provider/effect authority row is invented.
    yield* db
      .update(SessionTable)
      .set({ execution_claim_token: attempt.execution_claim_token })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
    if (mutate) yield* mutate(db, sessionID)
    return sessionID
  }).pipe(Effect.provide(database), Effect.scoped, Effect.runPromise)

  const runs: string[] = []
  await Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const restart = yield* SessionRestart.Service
    const store = yield* SessionStore.Service
    const snapshot = () =>
      db
        .all(
          sql`
      SELECT 'receipt' AS kind, receipt_id AS id, state FROM session_v2_provider_turn_receipt
      UNION ALL SELECT 'effect', effect_id, state FROM session_v2_tool_effect
      UNION ALL SELECT 'input', id, CAST(promoted_seq AS TEXT) FROM session_input
      ORDER BY kind, id
    `,
        )
        .pipe(Effect.orDie)
    const before = yield* snapshot()
    const claim = yield* store.claimToken(sessionID)
    expect(claim).toBeDefined()
    expect(yield* store.release(sessionID, claim! + 1)).toBe(false)
    expect(yield* store.claimToken(sessionID)).toBe(claim)
    const changes = yield* db.get(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)
    const recovery = (yield* restart.pendingRecoveryFor([sessionID]))[0]!
    expect(yield* db.get(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)).toEqual(changes)
    expect(recovery.effects.length).toBeGreaterThan(0)
    expect(recovery.effects.every((effect) => effect.grantBound === false)).toBe(true)
    if (accepted) {
      expect(recovery.disposition).toBe("terminal_consistent")
      expect(recovery.effects.every((effect) => effect.classification === "terminal_consistent")).toBe(true)
      expect(yield* restart.redriveStartup).toEqual({ released: [sessionID], woken: [], blocked: [] })
      expect(yield* store.claimToken(sessionID)).toBeUndefined()
    }
    if (!accepted) {
      expect(recovery.disposition).not.toBe("terminal_consistent")
      expect(recovery.effects.some((effect) => effect.classification === "recovery_required")).toBe(true)
      expect((yield* restart.redriveStartup).released).toEqual([])
      expect(yield* store.claimToken(sessionID)).toBe(claim)
    }
    expect(yield* snapshot()).toEqual(before)
  }).pipe(
    Effect.provide(
      services(
        filename,
        (input) =>
          Effect.sync(() => {
            runs.push(input.sessionID)
          }),
        capability,
        database,
      ),
    ),
    Effect.scoped,
    Effect.runPromise,
  )
  expect(runs).toEqual([])
}

// These narrowly corrupted copies model pre-guard/historical authority conflicts. Removing
// their immutable triggers is fixture-exempt and confined to disposable copied databases;
// production insert/update guards and the genuine positive source remain unchanged.
function corrupt(table: string, statement: string) {
  return (db: Database.Interface["db"]) =>
    Effect.gen(function* () {
      const triggers = yield* db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=${table}`)
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        triggers,
        (trigger) => db.run(sql.raw(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`)).pipe(Effect.orDie),
        { discard: true },
      )
      yield* db.run(sql.raw(statement)).pipe(Effect.orDie)
    })
}

function restricted(ancestor: boolean) {
  return (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
    Effect.gen(function* () {
      const target = ancestor ? yield* seedSession({ db }, "restricted_ancestor") : sessionID
      const binding = { ...WorkAuthorityFixture.binding("terminal-denial"), sessionID: target }
      // fixture-exempt: a durable historical Work binding tests the classifier's authoritative
      // marker, not admission or execution. Its grantless tool is intentionally inadmissible.
      yield* db
        .insert(WorkExecutionTable)
        .values({
          work_id: binding.workID,
          root_work_id: binding.rootWorkID,
          session_id: target,
          input_id: binding.inputID,
          source_kind: binding.source.kind,
          authority_id: binding.source.authorityID,
          source_request_id: binding.source.requestID,
          source_revision: 1,
          source_record_hash: "f".repeat(64),
          route_evidence_hash: binding.provider.evidenceHash,
          binding_hash: WorkAuthorityPolicy.fingerprint(binding),
          binding,
          security_namespace_id: binding.scope.securityNamespaceID,
          agent_id: binding.agentID,
          admission_state: "reserved",
          control_state: "active",
          outcome: "pending",
          control_revision: 1,
          control_receipts: [],
          loopback_http: false,
          created_at: 1,
          updated_at: 1,
        })
        .run()
        .pipe(Effect.orDie)
      if (ancestor)
        yield* db
          .update(SessionTable)
          .set({ parent_id: target })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      expect((yield* WorkAuthority.lookupSession(db, sessionID)).kind).toBe(ancestor ? "legacy_unbound" : "bound")
    })
}

test("cold recovery accepts ordinary exact terminal authority without a Work grant, including permission cancellation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "restart-ordinary-terminal-"))
  try {
    const settled = await produce(root, "settled", "stops a third identical tool call before execution")
    const cancelled = await produce(
      root,
      "cancelled",
      "continues after cancelling the original builtin bash permission before any command effect",
    )
    await Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect((yield* db.select().from(V2ToolEffectTable).all().pipe(Effect.orDie)).map((row) => row.state)).toEqual([
        "settled",
        "settled",
      ])
    }).pipe(Effect.provide(WorkAuthorityFixture.database(settled)), Effect.scoped, Effect.runPromise)
    await Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect(
        (yield* db.select().from(V2ToolEffectTable).all().pipe(Effect.orDie)).map((row) => [row.state, row.error_code]),
      ).toEqual([["failed", "tool_permission_cancelled"]])
    }).pipe(Effect.provide(WorkAuthorityFixture.database(cancelled)), Effect.scoped, Effect.runPromise)
    expect(await Bun.file(path.join(root, "cancelled", "command-effect.txt")).exists()).toBe(false)
    await cold(settled, "ordinary", true)
    await cold(cancelled, "permission-cancelled", true)
    await cold(settled, "work-bound", false, restricted(false))
    await cold(settled, "legacy-lineage", false, restricted(true))
    for (const [name, statement] of [
      ["tool-name", "UPDATE session_v2_tool_effect SET tool_name='foreign-tool'"],
      ["effect-kind", "UPDATE session_v2_tool_effect SET effect_kind='read_only'"],
      ["attempt", "UPDATE session_v2_tool_effect SET provider_attempt_id='foreign-attempt'"],
      ["owner", "UPDATE session_v2_tool_effect SET owner_token='foreign-owner'"],
      ["session", "UPDATE session_v2_tool_effect SET session_id='foreign-session'"],
    ])
      await cold(settled, name!, false, corrupt("session_v2_tool_effect", statement!))
    await cold(
      settled,
      "admission-only",
      false,
      corrupt("session_v2_tool_effect", "DELETE FROM session_v2_tool_effect"),
    )
    await cold(
      settled,
      "nonterminal-attempt",
      false,
      corrupt("session_provider_attempt", "UPDATE session_provider_attempt SET state='prepared'"),
    )
    await cold(
      settled,
      "receipt-owner-conflict",
      false,
      corrupt(
        "session_v2_provider_turn_receipt",
        "UPDATE session_v2_provider_turn_receipt SET owner_token='foreign-owner'",
      ),
    )
    await cold(
      settled,
      "attempt-session-conflict",
      false,
      corrupt("session_provider_attempt", "UPDATE session_provider_attempt SET session_id='foreign-session'"),
    )
    await cold(settled, "foreign-nonterminal", false, (db) =>
      Effect.gen(function* () {
        yield* corrupt(
          "session_provider_attempt",
          "UPDATE session_provider_attempt SET state='streaming', execution_claim_token=execution_claim_token+1",
        )(db)
        yield* corrupt(
          "session_v2_provider_turn_receipt",
          "UPDATE session_v2_provider_turn_receipt SET state='streaming'",
        )(db)
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test("cold recovery keeps a genuinely dispatched unknown tool quarantined without replay or claim release", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "restart-ordinary-unknown-"))
  try {
    const filename = await produce(root, "unknown", "quarantines an unknown tool outcome without replaying its body")
    expect(await Bun.file(`${filename}.dispatch.json`).json()).toMatchObject({
      providerCalls: 1,
      toolBodies: 1,
      pending: 1,
    })
    await cold(filename, "unknown", false)
    expect(await Bun.file(`${filename}.body`).text()).toBe("dispatched\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
