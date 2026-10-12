import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { eq, sql } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { AgentV2 } from "../src/agent"
import { BrowserFileAuthority } from "../src/browser/file-authority"
import { BrowserControl } from "../src/browser/control"
import { BrowserControlTable } from "../src/browser/browser.sql"
import { LocationIdentityTable } from "../src/context-federation/sql"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { SessionProviderOwnerLeaseTable } from "../src/context-federation/session-sql"
import { PermissionSaved } from "../src/permission/saved"
import { PermissionV2 } from "../src/permission"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { SessionSchema } from "../src/session/schema"
import { WorkAuthority } from "../src/session/work-authority"
import { GoalChild } from "../src/deepagent/goal-child"
import { GoalChildPolicy } from "../src/deepagent/goal-child-policy"
import { V2ToolEffect } from "../src/session/runner/v2-tool-effect"
import { V2ProviderTurnReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { CanonicalJson } from "../src/util/canonical-json"
import { BrowserFileAuthorityFixture } from "./fixture/browser-file-authority"
import { GoalChildC1Fixture } from "./fixture/goal-child-c1"
import { WorkAuthorityFixture } from "./fixture/work-authority"

test("ordinary file authority keeps one live frame through streaming/settled and heartbeat", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    const lease = yield* fixture.capture()
    expect(lease).toBeDefined()
    if (!lease) return yield* Effect.die(new Error("ordinary fixture did not capture a file lease"))
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
    const heartbeat = yield* (yield* SessionProviderOwner.Service).heartbeat({ ownerToken: fixture.receipt.ownerToken, leaseMs: 60_000 })
    expect(heartbeat.leaseExpiresAt).toBeGreaterThan(Date.now())
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
    const settled = yield* fixture.turns.settle({ receipt: fixture.receipt, outcome: "settled", outcomeArtifact: [] })
    expect(settled.state).toBe("settled")
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
  }))), 30_000)

test("a real provider owner wall-clock expiry retires the original file authority", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    const lease = yield* fixture.capture()
    if (!lease) return yield* Effect.die(new Error("ordinary fixture did not capture a file lease"))
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
    const owner = yield* (yield* SessionProviderOwner.Service).get(fixture.receipt.ownerToken)
    if (!owner) return yield* Effect.die(new Error("original provider owner disappeared"))
    // Stall only this private test process so its real heartbeat cannot renew the original
    // lease before wall-clock expiry. No production timer or clock override is installed.
    yield* Effect.sync(() => Bun.sleepSync(Math.max(1, owner.leaseExpiresAt - Date.now() + 25)))
    expect(Date.now()).toBeGreaterThan(owner.leaseExpiresAt)
    expect(Exit.isFailure(yield* BrowserFileAuthority.requireCurrent(fixture.db, lease).pipe(Effect.exit))).toBe(true)
  })), { leaseMs: 1500 }), 30_000)

test("original receipt trigger rejects prepared JSON/hash changes while legitimate settlement preserves the lease", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    const lease = yield* fixture.capture()
    if (!lease) return yield* Effect.die(new Error("ordinary fixture did not capture a file lease"))
    const trigger = yield* fixture.db.get<{ sql: string }>(sql`SELECT sql FROM sqlite_master
      WHERE type='trigger' AND name='session_v2_provider_turn_receipt_identity_immutable'`)
    expect(trigger?.sql).toContain("OLD.prepared_turn IS NOT NULL")
    expect(trigger?.sql).toContain("OLD.prepared_turn_hash IS NOT NULL")
    expect(trigger?.sql).toContain("OLD.wire_request_hash IS NOT NULL")
    const mutations = [
      { prepared_turn: sql`${V2ProviderTurnReceiptTable.prepared_turn} || ' '` },
      { prepared_turn_hash: "c".repeat(64) },
      { wire_request_hash: "d".repeat(64) },
    ]
    for (const change of mutations) {
      expect(Exit.isFailure(yield* fixture.db.update(V2ProviderTurnReceiptTable).set(change)
        .where(eq(V2ProviderTurnReceiptTable.receipt_id, fixture.receipt.receiptId)).run().pipe(Effect.exit))).toBe(true)
      yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
    }
    yield* fixture.turns.settle({ receipt: fixture.receipt, outcome: "settled", outcomeArtifact: [] })
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
  }))), 30_000)

const mutations = {
  "Session permission revoke": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.gen(function* () {
    yield* (yield* SessionV2.Service).setPermissions({ sessionID: fixture.session.id,
      permissions: [{ action: "browser-file", resource: "*", effect: "deny" }] })
  }),
  "saved permission epoch": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.gen(function* () {
    yield* (yield* PermissionSaved.Service).add({ projectID: fixture.session.projectID, action: "browser-file", resources: ["changed"] })
  }),
  "Session claim release": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.gen(function* () {
    expect(yield* (yield* SessionStore.Service).release(fixture.session.id, fixture.claim)).toBe(true)
  }),
  "placement change": (fixture: BrowserFileAuthorityFixture.Fixture) => fixture.db.update(SessionTable)
    .set({ directory: fixture.session.location.directory + "/changed" }).where(eq(SessionTable.id, fixture.session.id)).run(),
  "scope retirement": (fixture: BrowserFileAuthorityFixture.Fixture) => fixture.db.update(LocationIdentityTable).set({ retired_at: Date.now() })
    .where(eq(LocationIdentityTable.location_key, fixture.captureInput.control.scope.locationKey)).run(),
  "raw Control change": (fixture: BrowserFileAuthorityFixture.Fixture) => fixture.db.update(BrowserControlTable)
    .set({ record: CanonicalJson.stringify({ ...fixture.captureInput.control, epoch: fixture.captureInput.control.epoch + 1 }) })
    .where(eq(BrowserControlTable.control_id, fixture.captureInput.control.controlID)).run(),
  "Control sidecar change": (fixture: BrowserFileAuthorityFixture.Fixture) => fixture.db.update(BrowserControlTable)
    .set({ revision: fixture.captureInput.control.revision + 1 }).where(eq(BrowserControlTable.control_id, fixture.captureInput.control.controlID)).run(),
  "original cancel caller": (fixture: BrowserFileAuthorityFixture.Fixture) => BrowserControl.cancel(fixture.db,
    fixture.captureInput.control.controlID, fixture.captureInput.control.scope,
    { requestID: "fixture-cancel", expectedRevision: fixture.captureInput.control.revision }),
  "terminal effect appears": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.gen(function* () {
    yield* (yield* V2ToolEffect.Service).record({ ...fixture.admission, state: "settled", outcomeHash: "b".repeat(64), now: Date.now() })
  }),
  "Agent generation": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.gen(function* () {
    const update = yield* (yield* AgentV2.Service).transform()
    yield* update((editor) => editor.update(fixture.captureInput.context.agent, (agent) => { agent.permissions = [] }))
  }),
  "Permit scope release": (fixture: BrowserFileAuthorityFixture.Fixture) => Scope.close(fixture.authorizationScope, Exit.void),
  "host closed": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.sync(() => { fixture.hostState.alive = false }),
  "native descriptor changed": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.sync(() => { fixture.hostState.matched = false }),
}
test.each(Object.entries(mutations))("ordinary file probe refuses %s after original capture", (_name, mutate) =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    const lease = yield* fixture.capture()
    expect(lease).toBeDefined()
    if (!lease) return yield* Effect.die(new Error("ordinary fixture did not capture a file lease"))
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
    yield* mutate(fixture)
    expect(Exit.isFailure(yield* BrowserFileAuthority.requireCurrent(fixture.db, lease).pipe(Effect.exit))).toBe(true)
  }))), 30_000)

test("file authority cannot survive its canonical handle, be copied, or replace a cold frame", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const lease = yield* fixture.frame(Effect.gen(function* () {
      const captured = yield* fixture.capture()
      if (!captured) return yield* Effect.die(new Error("ordinary fixture did not capture a file lease"))
      expect(Exit.isFailure(yield* BrowserFileAuthority.requireCurrent(fixture.db, { ...captured }).pipe(Effect.exit))).toBe(true)
      return captured
    }))
    expect(Exit.isFailure(yield* BrowserFileAuthority.requireCurrent(fixture.db, lease).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* fixture.capture().pipe(Effect.exit))).toBe(true)
  })), 30_000)

test("missing optional capture capability keeps the original full-current path", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    expect(yield* BrowserFileAuthority.capture(fixture.db, { ...fixture.captureInput,
      permission: { ...fixture.captureInput.permission, captureFileActions: undefined } })).toBeUndefined()
    yield* fixture.captureInput.permission.checkAction!(fixture.captureInput.browser.permit, fixture.captureInput.browser.input)
    yield* fixture.captureInput.permission.checkAction!(fixture.captureInput.file.permit, fixture.captureInput.file.input)
  }))), 30_000)

test("a genuinely admitted Goal child retains the full owned-policy path and cannot mint an ordinary lease", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const setup = yield* GoalChildC1Fixture.prepare(fixture.captureInput.location.directory)
    const policy = yield* GoalChildPolicy.prepare(fixture.db, yield* AgentV2.Service,
      { permitID: setup.permit.permit_id, roleKey: setup.admission.roleKey, agent: "worker", mode: "plain" })
    const child = yield* GoalChild.admitV2(fixture.db, yield* SessionV2.Service, { ...setup.admission, policy })
    const sessionID = SessionSchema.ID.make(child.unit.child_session_id)
    expect(yield* BrowserFileAuthority.capture(fixture.db, { ...fixture.captureInput,
      context: { ...fixture.captureInput.context, sessionID } })).toBeUndefined()
    expect(Exit.isFailure(yield* fixture.captureInput.permission.assert({ ...fixture.captureInput.file.input, sessionID }).pipe(Effect.exit))).toBe(true)
  })), 30_000)

test("permission full-check and raw capture share one SQLite snapshot; a later external revoke is denied", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    const independent = new Database(`${fixture.captureInput.location.directory}/authority.sqlite`)
    independent.run("PRAGMA busy_timeout=0")
    yield* Effect.addFinalizer(() => Effect.sync(() => independent.close()))
    const original = fixture.captureInput.permission.captureFileActions!
    let blocked = 0
    const lease = yield* BrowserFileAuthority.capture(fixture.db, { ...fixture.captureInput, permission: {
      ...fixture.captureInput.permission,
      captureFileActions: (browser, file) => original(browser, file).pipe(Effect.tap(() => Effect.gen(function* () {
        const attempted = yield* Effect.try({ try: () => independent.query("UPDATE session SET permission=? WHERE id=?")
          .run(JSON.stringify([{ action: "browser-file", resource: "*", effect: "deny" }]), fixture.session.id), catch: (error) => error }).pipe(Effect.exit)
        expect(Exit.isFailure(attempted)).toBe(true)
        if (Exit.isFailure(attempted)) expect(Cause.pretty(attempted.cause)).toMatch(/locked|busy/i)
        blocked++
      }))),
    } })
    expect(blocked).toBe(1)
    if (!lease) return yield* Effect.die(new Error("ordinary fixture did not capture a file lease"))
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
    independent.query("UPDATE session SET permission=? WHERE id=?")
      .run(JSON.stringify([{ action: "browser-file", resource: "*", effect: "deny" }]), fixture.session.id)
    expect(Exit.isFailure(yield* BrowserFileAuthority.requireCurrent(fixture.db, lease).pipe(Effect.exit))).toBe(true)
  }))), 30_000)

test("a genuine Work reservation retains the full owned-policy path before Session materialization", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    // Reuse the existing Work fixture's fixed SQL-backed source/route verifier. Only its
    // private fixture tables are initialized; production authority is created by reserve.
    yield* WorkAuthorityFixture.initialize()
    const binding = { ...WorkAuthorityFixture.binding("file-authority-fallback"), deadline: Date.now() + 60_000 }
    const reserved = yield* WorkAuthority.reserve(fixture.db, { binding }).pipe(Effect.provide(WorkAuthorityFixture.verifier))
    const sessionID = SessionSchema.ID.make(reserved.session_id)
    expect(yield* BrowserFileAuthority.capture(fixture.db, { ...fixture.captureInput,
      context: { ...fixture.captureInput.context, sessionID } })).toBeUndefined()
    expect(Exit.isFailure(yield* fixture.captureInput.permission.assert({ ...fixture.captureInput.file.input, sessionID }).pipe(Effect.exit))).toBe(true)
  })), 30_000)

test("real foreign Location Permission layers cannot replace same-layer file authority", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    const same = yield* fixture.capture()
    if (!same) return yield* Effect.die(new Error("same-layer file lease was not captured"))
    yield* BrowserFileAuthority.requireCurrent(fixture.db, same)
    const foreignContext = yield* Layer.buildWithScope(PermissionV2.layer.pipe(Layer.provide(
      Layer.succeed(Location.Service, { ...fixture.captureInput.location,
        directory: AbsolutePath.make(fixture.captureInput.location.directory + "/other-location") }),
    ), Layer.fresh), yield* Effect.scope)
    const foreign = Context.get(foreignContext, PermissionV2.Service)
    expect(foreign).not.toBe(fixture.captureInput.permission)
    const browser = { input: fixture.captureInput.browser.input, permit: yield* foreign.authorizeAction!(fixture.captureInput.browser.input) }
    const file = { input: fixture.captureInput.file.input, permit: yield* foreign.authorizeAction!(fixture.captureInput.file.input) }
    yield* foreign.checkAction!(browser.permit, browser.input)
    yield* foreign.checkAction!(file.permit, file.input)
    expect(Exit.isFailure(yield* BrowserFileAuthority.capture(fixture.db,
      { ...fixture.captureInput, permission: foreign, browser, file }).pipe(Effect.exit))).toBe(true)
    yield* BrowserFileAuthority.requireCurrent(fixture.db, same)
  }))), 30_000)

test("the per-leaf negative classification/probe transaction blocks an independent late revoke and closes before file work", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => fixture.frame(Effect.gen(function* () {
    const lease = yield* fixture.capture()
    if (!lease) return yield* Effect.die(new Error("ordinary fixture did not capture a file lease"))
    const independent = new Database(`${fixture.captureInput.location.directory}/authority.sqlite`)
    independent.run("PRAGMA busy_timeout=0")
    yield* Effect.addFinalizer(() => Effect.sync(() => independent.close()))
    const observed = { calls: 0, lateWrite: "unattempted" }
    const verify = fixture.captureInput.host.verify
    fixture.captureInput.host.verify = (control) => {
      observed.calls++
      if (observed.calls === 2) {
        // This original descriptor guard is called after the joined SQL probe. The
        // wrapper delegates unchanged; only the independent private SQLite write is observed.
        try {
          independent.query("UPDATE session SET permission=? WHERE id=?")
            .run(JSON.stringify([{ action: "browser-file", resource: "*", effect: "deny" }]), fixture.session.id)
          observed.lateWrite = "committed"
        } catch (error) {
          observed.lateWrite = error instanceof Error ? error.message : String(error)
        }
      }
      return verify.call(fixture.captureInput.host, control)
    }
    yield* BrowserFileAuthority.requireCurrent(fixture.db, lease)
    expect(observed.calls).toBe(2)
    expect(observed.lateWrite).toMatch(/locked|busy/i)
    // No DB transaction crosses the return into real file work: a fresh independent
    // write succeeds now and the next original current boundary refuses the lease.
    independent.query("UPDATE session SET permission=? WHERE id=?")
      .run(JSON.stringify([{ action: "browser-file", resource: "*", effect: "deny" }]), fixture.session.id)
    expect(Exit.isFailure(yield* BrowserFileAuthority.requireCurrent(fixture.db, lease).pipe(Effect.exit))).toBe(true)
  }))), 30_000)
