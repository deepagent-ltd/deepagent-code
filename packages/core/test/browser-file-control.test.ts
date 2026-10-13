import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Option } from "effect"
import { BrowserFileControl } from "../src/browser/file-control"
import { BrowserControl } from "../src/browser/control"
import { BrowserSchema } from "../src/browser/schema"
import { LocationIdentityTable } from "../src/context-federation/sql"
import { SessionTable } from "../src/session/sql"
import { BrowserFileAuthorityFixture } from "./fixture/browser-file-authority"

test("Host file control keeps one captured current record, rejects copies and closes with its scope", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const handle = yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* BrowserFileControl.capture(fixture.db, fixture.captureInput.control, fixture.captureInput.host)
      for (const _ of Array.from({ length: 200 })) yield* BrowserFileControl.requireCurrent(fixture.db, handle)
      expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, { ...handle }).pipe(Effect.exit))).toBe(true)
      return handle
    }))
    expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
  })), 30_000)

test("Host file control captures the decoded DB object, not its caller's mutable scope and expiry", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.scoped(Effect.gen(function* () {
    const control = { ...fixture.captureInput.control, scope: { ...fixture.captureInput.control.scope } }
    const handle = yield* BrowserFileControl.capture(fixture.db, control, fixture.captureInput.host)
    control.expiresAt = 0
    control.scope.directory += "/caller-changed"
    expect(Exit.isSuccess(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
    yield* BrowserControl.cancel(fixture.db, fixture.captureInput.control.controlID, fixture.captureInput.control.scope,
      { requestID: "original-file-stop", expectedRevision: fixture.captureInput.control.revision })
    expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
  }))), 30_000)

const mutations = {
  "Session placement": (fixture: BrowserFileAuthorityFixture.Fixture) => fixture.db.update(SessionTable)
    .set({ directory: fixture.session.location.directory + "/changed" }).where(eq(SessionTable.id, fixture.session.id)).run(),
  "scope retirement": (fixture: BrowserFileAuthorityFixture.Fixture) => fixture.db.update(LocationIdentityTable)
    .set({ retired_at: Date.now() }).where(eq(LocationIdentityTable.location_key, fixture.captureInput.control.scope.locationKey)).run(),
  "original stop caller": (fixture: BrowserFileAuthorityFixture.Fixture) => BrowserControl.cancel(fixture.db,
    fixture.captureInput.control.controlID, fixture.captureInput.control.scope,
    { requestID: "file-control-stop", expectedRevision: fixture.captureInput.control.revision }),
  "native host closes": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.sync(() => { fixture.hostState.alive = false }),
  "native descriptor changes": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.sync(() => { fixture.hostState.matched = false }),
  "native credential changes": (fixture: BrowserFileAuthorityFixture.Fixture) => Effect.sync(() => {
    fixture.captureInput.host.credentialBinding = "b".repeat(64)
  }),
}
test.each(Object.entries(mutations))("Host file current probe refuses %s after capture", (_name, mutate) =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.scoped(Effect.gen(function* () {
    const handle = yield* BrowserFileControl.capture(fixture.db, fixture.captureInput.control, fixture.captureInput.host)
    yield* BrowserFileControl.requireCurrent(fixture.db, handle)
    yield* mutate(fixture)
    expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
  }))), 30_000)

test("Host file current probe holds one short SQL snapshot through its late native check", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.scoped(Effect.gen(function* () {
    const handle = yield* BrowserFileControl.capture(fixture.db, fixture.captureInput.control, fixture.captureInput.host)
    const independent = new Database(`${fixture.captureInput.location.directory}/authority.sqlite`)
    independent.run("PRAGMA busy_timeout=0")
    yield* Effect.addFinalizer(() => Effect.sync(() => independent.close()))
    const calls = { value: 0, blocked: 0 }
    const verify = fixture.captureInput.host.verify
    fixture.captureInput.host.verify = (control) => {
      calls.value++
      if (calls.value === 2) {
        expect(() => independent.query("UPDATE session SET directory=? WHERE id=?")
          .run(fixture.captureInput.location.directory + "/late", fixture.session.id)).toThrow(/locked|busy/i)
        calls.blocked++
      }
      return verify(control)
    }
    expect(Exit.isSuccess(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
    expect(calls.blocked).toBe(1)
    independent.query("UPDATE session SET directory=? WHERE id=?")
      .run(fixture.captureInput.location.directory + "/late", fixture.session.id)
    const refused = yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit)
    expect(Exit.isFailure(refused)).toBe(true)
    if (Exit.isFailure(refused)) expect(Option.getOrUndefined(Cause.findErrorOption(refused.cause))?.code).toBe("BROWSER_STALE_TARGET")
  }))), 30_000)

test("a real Host file control expiry during its final native check cannot extend the capture", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.scoped(Effect.gen(function* () {
    const created = yield* BrowserControl.create(fixture.db, {
      request: { requestID: "short-file-control", sessionID: fixture.session.id, origin: "http://127.0.0.1:34567",
        expiresAt: Date.now() + 1000, profile: BrowserSchema.FILE_EXCHANGE_PROFILE, postPaths: ["/upload"],
        filePolicy: { upload: true, download: true } },
      scope: fixture.captureInput.control.scope, hostID: fixture.captureInput.host.hostID,
      hostIncarnation: fixture.captureInput.host.hostIncarnation, credentialBinding: fixture.captureInput.host.credentialBinding,
    })
    const control = yield* BrowserControl.observeControl(fixture.db, created.record, "active")
    const handle = yield* BrowserFileControl.capture(fixture.db, control, fixture.captureInput.host)
    const calls = { value: 0 }
    const verify = fixture.captureInput.host.verify
    fixture.captureInput.host.verify = (input) => {
      calls.value++
      if (calls.value === 2) Bun.sleepSync(Math.max(1, control.expiresAt - Date.now() + 10))
      return verify(input)
    }
    expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
    expect(Date.now()).toBeGreaterThan(control.expiresAt)
    expect(calls.value).toBe(2)
  }))), 30_000)
