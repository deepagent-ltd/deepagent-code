import { expect, test } from "bun:test"
import { LLM } from "@deepagent-code/llm"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Cause, Effect, Exit, Fiber } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { SessionContext } from "../src/context-federation/session-context"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { SessionSchema } from "../src/session/schema"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkProviderDispatchFixture } from "./fixture/work-provider-dispatch"

for (const profile of ["event", "project"] as const)
  test(`actual prepared dispatch retains the exact signed ${profile} instructions`, async () => {
    const fixture = await WorkProviderDispatchFixture.create({ profile })
    try {
      await WorkProviderDispatchFixture.open(fixture, Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        expect(data.selected.instructions).toBe(profile === "event"
          ? WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.instructions : WorkAuthorityPolicy.PROJECT_PROFILE.instructions)
        yield* WorkProviderDispatchFixture.execute(fixture, data)
        const rows = yield* WorkProviderDispatchFixture.rows
        expect(rows.reservations).toHaveLength(1)
        expect(rows.reservations[0]).toMatchObject({ state: "settled", charged_tokens: 53, reserved_total_tokens: 73 })
        expect(rows.receipts[0]).toMatchObject({ state: "settled", wire_request_hash: data.wire.wireHash })
        expect(rows.attempts[0]).toMatchObject({ state: "settled", wire_request_hash: data.wire.wireHash })
        expect(fixture.state.bodies).toEqual([data.wire.bodyText])
        expect(fixture.state.streams).toBe(1)
      }))
    } finally {
      await fixture.close()
    }
  }, 30_000)

test("actual event prepared turn rejects borrowed project instructions before permit or transport", async () => {
  const fixture = await WorkProviderDispatchFixture.create({ profile: "event" })
  try {
    await WorkProviderDispatchFixture.open(fixture, Effect.gen(function* () {
      const data = yield* WorkProviderDispatchFixture.initialize(fixture)
      const exit = yield* (yield* V2ProviderTurn.Service).seal(data.committed.receipt,
        WorkProviderDispatchFixture.prepare(data.committed.receipt, data.selected.admission, data.wire.wireHash,
          WorkAuthorityPolicy.PROJECT_PROFILE.instructions), data.wire).pipe(
        Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
        Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"), Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "WORK_BINDING_CONFLICT" })
      const rows = yield* WorkProviderDispatchFixture.rows
      expect(rows.reservations).toHaveLength(0)
      expect(rows.receipts[0]).toMatchObject({ state: "preparing", wire_request_hash: null })
      expect(rows.attempts[0]).toMatchObject({ state: "prepared", wire_request_hash: null })
      expect(fixture.state.bodies).toHaveLength(0)
      expect(fixture.state.reads).toBe(0)
    }))
  } finally {
    await fixture.close()
  }
}, 30_000)

test("actual HTTP final seal atomically dispatches Work and settles inclusive output usage", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  try {
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        yield* WorkProviderDispatchFixture.execute(fixture, data)
        const rows = yield* WorkProviderDispatchFixture.rows
        expect(rows.reservations).toHaveLength(1)
        expect(rows.reservations[0]).toMatchObject({ state: "settled", charged_tokens: 53, reserved_total_tokens: 73 })
        expect(JSON.parse(String(rows.reservations[0]!.actual_usage))).toEqual({
          inputTokens: 41,
          completionTokens: 12,
          reasoningTokens: 5,
        })
        expect(rows.receipts[0]).toMatchObject({ state: "settled", wire_request_hash: data.wire.wireHash })
        expect(rows.attempts[0]).toMatchObject({ state: "settled", wire_request_hash: data.wire.wireHash })
        expect(fixture.state.bodies).toEqual([data.wire.bodyText])
        expect(fixture.state.streams).toBe(1)
      }),
    )
  } finally {
    await fixture.close()
  }
}, 30_000)

for (const mode of ["drop", "missing-usage", "invalid-usage", "overrun"] as const)
  test(`actual ${mode} keeps unknown Work charged and same/cold recovery sends nothing`, async () => {
    const fixture = await WorkProviderDispatchFixture.create()
    fixture.state.mode = mode
    try {
      const receiptID = await WorkProviderDispatchFixture.open(
        fixture,
        Effect.gen(function* () {
          const data = yield* WorkProviderDispatchFixture.initialize(fixture)
          yield* WorkProviderDispatchFixture.execute(fixture, data).pipe(Effect.exit)
          const rows = yield* WorkProviderDispatchFixture.rows
          expect(rows.reservations[0]).toMatchObject({ state: "unknown", charged_tokens: 73 })
          expect(rows.works[0]).toMatchObject({ outcome: "unknown" })
          expect(fixture.state.bodies).toHaveLength(1)
          const service = yield* V2ProviderTurn.Service
          expect(yield* service.recover()).toBe(0)
          yield* service.recoverFenced(data.committed.receipt)
          expect(
            Exit.isFailure(
              yield* WorkAuthority.requireContext((yield* Database.Service).db, {
                sessionID: data.committed.receipt.sessionId,
              }).pipe(Effect.exit),
            ),
          ).toBe(true)
          return data.committed.receipt.receiptId
        }),
      )
      await WorkProviderDispatchFixture.open(
        fixture,
        Effect.gen(function* () {
          const service = yield* V2ProviderTurn.Service
          expect(yield* service.recover()).toBe(0)
          const receipt = (yield* service.get(receiptID))!
          yield* service.recoverFenced(receipt)
          expect((yield* WorkProviderDispatchFixture.rows).reservations[0]).toMatchObject({
            state: "unknown",
            charged_tokens: 73,
          })
          expect(fixture.state.bodies).toHaveLength(1)
        }),
      )
    } finally {
      await fixture.close()
    }
  }, 30_000)

test("consumer cancellation after actual dispatch quarantines with full Work charge", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  fixture.state.mode = "wait"
  try {
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        const running = yield* WorkProviderDispatchFixture.execute(fixture, data).pipe(Effect.forkChild)
        while (fixture.state.bodies.length === 0) yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(running)
        const rows = yield* WorkProviderDispatchFixture.rows
        expect(rows.receipts[0]).toMatchObject({ state: "indeterminate_after_crash" })
        expect(rows.reservations[0]).toMatchObject({ state: "unknown", charged_tokens: 73 })
        expect(fixture.state.bodies).toHaveLength(1)
      }),
    )
  } finally {
    await fixture.close()
  }
}, 30_000)

test("canonical stale-owner same-identity refusal rolls back together then fenced recovery quarantines", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  fixture.state.mode = "drop"
  try {
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        yield* WorkProviderDispatchFixture.unfinalized(fixture, data).pipe(Effect.exit)
        expect((yield* WorkProviderDispatchFixture.rows).reservations[0]).toMatchObject({ state: "dispatching" })
        const owners = yield* SessionProviderOwner.Service
        yield* owners.release({ ownerToken: data.committed.receipt.ownerToken })
        const ownerToken = "fixture-stale-successor"
        yield* owners.register({ ownerToken, leaseMs: 30_000 })
        const next = yield* SessionRunnerCanonical.commitTurn({
          db: (yield* Database.Service).db,
          contexts: yield* SessionContext.Service,
          sessionID: SessionSchema.ID.make(data.binding.sessionID),
          admission: data.selected.admission,
          ownerToken,
          receipt: {
            sessionId: data.committed.receipt.sessionId,
            userMessageId: data.binding.inputID,
            historyPromptEpoch: 0,
            historySourceEndMessageId: data.binding.inputID,
            requestInputHash: data.committed.receipt.requestInputHash,
            providerId: data.binding.provider.providerID,
            modelId: data.binding.provider.modelID,
            protocol: data.binding.provider.protocol,
            ownerMode: "v2",
          },
        }).pipe(Effect.exit)
        expect(Exit.isFailure(next)).toBe(true)
        const rows = yield* WorkProviderDispatchFixture.rows
        expect(rows.receipts).toHaveLength(1)
        expect(rows.receipts[0]).toMatchObject({ state: "streaming" })
        expect(rows.reservations[0]).toMatchObject({ state: "dispatching", charged_tokens: 73 })
        yield* (yield* V2ProviderTurn.Service).recoverFenced(data.committed.receipt)
        expect((yield* WorkProviderDispatchFixture.rows).reservations[0]).toMatchObject({
          state: "unknown",
          charged_tokens: 73,
        })
        expect(fixture.state.bodies).toHaveLength(1)
      }),
    )
  } finally {
    await fixture.close()
  }
}, 30_000)

test("duplicate normalized terminal finish never releases reserved charge", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  try {
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        const events = yield* WorkProviderDispatchFixture.unfinalized(fixture, data)
        const service = yield* V2ProviderTurn.Service
        yield* service.settle({
          receipt: (yield* service.get(data.committed.receipt.receiptId))!,
          outcome: "settled",
          outcomeArtifact: [...events, events.at(-1)],
        })
        expect((yield* WorkProviderDispatchFixture.rows).reservations[0]).toMatchObject({
          state: "unknown",
          charged_tokens: 73,
        })
        expect(fixture.state.bodies).toHaveLength(1)
      }),
    )
  } finally {
    await fixture.close()
  }
}, 30_000)

test("SIGKILL after real HTTP streaming preserves charge through cold file DB recovery and exact retry", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  fixture.state.mode = "wait"
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "test/fixture/work-provider-dispatch-process.ts",
      fixture.root,
      fixture.candidate.binding.provider.endpoint,
    ],
    {
      cwd: import.meta.dir + "/..",
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  const db = await sqliteFile(fixture.filename)
  try {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const row = db.query<{ state: string }, []>("SELECT state FROM session_v2_provider_turn_receipt").get()
      if (row?.state === "streaming") break
      await Bun.sleep(10)
    }
    expect(db.query<{ state: string }, []>("SELECT state FROM session_v2_provider_turn_receipt").get()?.state).toBe(
      "streaming",
    )
    expect(fixture.state.bodies).toHaveLength(1)
    child.kill("SIGKILL")
    await child.exited
    await Bun.sleep(1_100)
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const rows = yield* WorkProviderDispatchFixture.rows
        expect(rows.receipts[0]).toMatchObject({ state: "indeterminate_after_crash" })
        expect(rows.attempts[0]).toMatchObject({ state: "indeterminate_after_crash" })
        expect(rows.reservations[0]).toMatchObject({ state: "unknown", charged_tokens: 73 })
        const service = yield* V2ProviderTurn.Service
        const receipt = (yield* service.get(String(rows.receipts[0]!.receipt_id)))!
        expect(yield* service.recover()).toBe(0)
        yield* service.recoverFenced(receipt)
        expect(
          Exit.isFailure(
            yield* WorkAuthority.requireContext((yield* Database.Service).db, { sessionID: receipt.sessionId }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe(true)
        expect(fixture.state.bodies).toHaveLength(1)
      }),
    )
  } catch (error) {
    child.kill("SIGKILL")
    console.info("WORK_DISPATCH_CHILD", await output, await errors)
    throw error
  } finally {
    child.kill("SIGKILL")
    await child.exited
    db.close()
    await fixture.close()
  }
}, 30_000)

async function sqliteFile(filename: string) {
  const { Database } = await import("bun:sqlite")
  return new Database(filename, { readonly: true })
}

test("live fenced recovery synchronizes the Work reservation exactly once", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  fixture.state.mode = "drop"
  try {
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        yield* WorkProviderDispatchFixture.unfinalized(fixture, data).pipe(Effect.exit)
        yield* (yield* SessionProviderOwner.Service).release({ ownerToken: data.committed.receipt.ownerToken })
        const service = yield* V2ProviderTurn.Service
        const recovered = yield* service.recoverFenced(data.committed.receipt)
        expect(recovered.state).toBe("indeterminate_after_crash")
        yield* service.recoverFenced(data.committed.receipt)
        expect((yield* WorkProviderDispatchFixture.rows).reservations[0]).toMatchObject({
          state: "unknown",
          charged_tokens: 73,
        })
        expect(fixture.state.bodies).toHaveLength(1)
      }),
    )
  } finally {
    await fixture.close()
  }
}, 30_000)

for (const variant of ["source", "cap", "runtime", "count", "rollback"] as const)
  test(`final seal refuses ${variant} before any physical generation`, async () => {
    const fixture = await WorkProviderDispatchFixture.create()
    try {
      await WorkProviderDispatchFixture.open(
        fixture,
        Effect.gen(function* () {
          const data = yield* WorkProviderDispatchFixture.initialize(fixture)
          const db = (yield* Database.Service).db
          if (variant === "source") yield* db.run("UPDATE test_work_source SET enabled=0")
          if (variant === "count") yield* db.run("DELETE FROM test_dispatch_evidence WHERE id='count'")
          // This fails AFTER the Work reserve/authorize operation, proving both are rolled back with
          // the real receipt CAS rather than surviving in an independently committed transaction.
          if (variant === "rollback")
            yield* db.run(
              "CREATE TRIGGER reject_dispatch BEFORE UPDATE OF state ON session_v2_provider_turn_receipt WHEN NEW.state='dispatching' AND EXISTS(SELECT 1 FROM work_dispatch_reservation WHERE receipt_id=NEW.receipt_id AND state='dispatching') BEGIN SELECT RAISE(ABORT, 'fixture_receipt_cas_failure'); END",
            )
          const exit = yield* WorkProviderDispatchFixture.execute(
            fixture,
            data,
            variant === "cap"
              ? LLM.updateRequest(fixture.candidate.request, { http: { body: { max_output_tokens: 65 } } })
              : fixture.candidate.request,
          ).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          const rows = yield* WorkProviderDispatchFixture.rows
          expect(rows.reservations).toHaveLength(0)
          expect(rows.receipts[0]!.dispatching_at).toBeNull()
          expect(rows.attempts[0]!.wire_request_hash).toBeNull()
          expect(fixture.state.bodies).toHaveLength(0)
          if (variant === "source") expect(fixture.state.reads).toBe(0)
          if (variant === "rollback" && Exit.isFailure(exit)) {
            expect(fixture.state.reads).toBe(1)
          }
        }),
        { runtime: variant !== "runtime" },
      )
    } finally {
      await fixture.close()
    }
  }, 30_000)

for (const field of ["method", "url", "bodyText", "retry"] as const)
  test(`missing or unsafe ${field} refuses before permit and receipt changes`, async () => {
    const fixture = await WorkProviderDispatchFixture.create()
    try {
      await WorkProviderDispatchFixture.open(
        fixture,
        Effect.gen(function* () {
          const data = yield* WorkProviderDispatchFixture.initialize(fixture)
          const wire = field === "retry" ? data.wire : { ...data.wire, [field]: undefined }
          const exit = yield* (yield* V2ProviderTurn.Service)
            .seal(
              data.committed.receipt,
              WorkProviderDispatchFixture.prepare(data.committed.receipt, data.selected.admission, data.wire.wireHash),
              wire,
            )
            .pipe(
              Effect.provideService(RequestExecutor.CurrentRetryLimit, field === "retry" ? 1 : 0),
              Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
              Effect.exit,
            )
          expect(Exit.isFailure(exit)).toBe(true)
          const rows = yield* WorkProviderDispatchFixture.rows
          expect(rows.reservations).toHaveLength(0)
          expect(rows.receipts[0]).toMatchObject({ state: "preparing", dispatching_at: null })
          expect(rows.attempts[0]).toMatchObject({ state: "prepared", wire_request_hash: null })
          expect(fixture.state.bodies).toHaveLength(0)
        }),
      )
    } finally {
      await fixture.close()
    }
  }, 30_000)

test("terminal descriptor failure rolls back Work settlement and both receipt/attempt states", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  try {
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        const events = yield* WorkProviderDispatchFixture.unfinalized(fixture, data)
        const db = (yield* Database.Service).db
        yield* db.run(
          "CREATE TRIGGER reject_terminal BEFORE INSERT ON session_provider_recovery_descriptor WHEN EXISTS(SELECT 1 FROM work_dispatch_reservation WHERE state='settled') BEGIN SELECT RAISE(ABORT, 'fixture_terminal_failure'); END",
        )
        const service = yield* V2ProviderTurn.Service
        const receipt = (yield* service.get(data.committed.receipt.receiptId))!
        const exit = yield* service.settle({ receipt, outcome: "settled", outcomeArtifact: events }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("fixture_terminal_failure")
        const rows = yield* WorkProviderDispatchFixture.rows
        expect(rows.receipts[0]).toMatchObject({ state: "streaming" })
        expect(rows.attempts[0]).toMatchObject({ state: "streaming" })
        expect(rows.reservations[0]).toMatchObject({ state: "dispatching", charged_tokens: 73, actual_usage: null })
        yield* db.run("DROP TRIGGER reject_terminal")
        yield* service.quarantine(receipt)
        expect((yield* WorkProviderDispatchFixture.rows).reservations[0]).toMatchObject({
          state: "unknown",
          charged_tokens: 73,
        })
        expect(fixture.state.bodies).toHaveLength(1)
      }),
    )
  } finally {
    await fixture.close()
  }
}, 30_000)

test("a direct seal without manual redirect policy cannot consume a Work permit", async () => {
  const fixture = await WorkProviderDispatchFixture.create()
  try {
    await WorkProviderDispatchFixture.open(
      fixture,
      Effect.gen(function* () {
        const data = yield* WorkProviderDispatchFixture.initialize(fixture)
        const service = yield* V2ProviderTurn.Service
        const exit = yield* service
          .seal(
            data.committed.receipt,
            WorkProviderDispatchFixture.prepare(data.committed.receipt, data.selected.admission, data.wire.wireHash),
            data.wire,
          )
          .pipe(Effect.provideService(RequestExecutor.CurrentRetryLimit, 0), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* WorkProviderDispatchFixture.rows).reservations).toHaveLength(0)
        expect(fixture.state.bodies).toHaveLength(0)
      }),
    )
  } finally {
    await fixture.close()
  }
}, 30_000)
