// RI-30 packaged oracle: real-process SIGKILL (kill-9) crash semantics for V2 session execution.
//
// The module-level semantics are already green in packages/core (session-execution.test.ts:
// startup redrive wakes pending durable inputs once, inputs admitted before a durable interrupt
// are not auto-redriven, an unowned unfinished drain escalates to recovery_required). This file
// proves the same contracts end-to-end across REAL OS processes: a serve process is killed with
// SIGKILL (no finalizers, no dispose, no suspendActiveSessions) and a fresh serve process booted
// against the same durable state must classify the unfinished drain instead of replaying it.
//
// The physical-call count at the shared TestLLMServer is the oracle for "no re-execution": the
// server outlives both serve processes, so any replayed provider dispatch is counted.
//
// Packaged-only for now (same gate as packaged-fork.test.ts): these scenarios need a serve process
// backed by a FILE database, and the source entry (`bun run src/index.ts serve`) currently boots a
// file-backed DB into maintenance mode — the AppRuntime root graph opens + migrates + runtime-locks
// the DB (v2StartupRecovery → Database.defaultLayer) before Server.listen's startListener runs its
// own Database.bootstrap, whose preflight then classifies the process's OWN lock as
// another_process_active (read_only_recovery, all business routes 404, /bootstrap/status 423).
// Every scenario fails at session creation (404) until that serve-composition regression is fixed;
// the oracle assertions below are written against the healthy contract and need no change then.
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Effect, Option } from "effect"
import { cliIt, type ServeHandle } from "../../lib/cli-process"
import { pollWithTimeout } from "../../lib/effect"

type JsonResponse = {
  readonly status: number
  readonly body: unknown
}

function requestJson(base: string, requestPath: string, init: RequestInit = {}): Effect.Effect<JsonResponse> {
  return Effect.promise(async () => {
    const response = await fetch(`${base}${requestPath}`, {
      ...init,
    })
    const body: unknown = await response.json()
    return { status: response.status, body }
  })
}

function readSessionRow(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const row = database
    .query("SELECT execution_claim_token, interrupt_seq FROM session WHERE id = ?")
    .get(sessionID) as { execution_claim_token: number | null; interrupt_seq: number | null } | null
  database.close()
  return row
}

function readInputRow(databasePath: string, messageID: string) {
  const database = new Database(databasePath, { readonly: true })
  const row = database
    .query("SELECT session_id, delivery, admitted_seq, promoted_seq FROM session_input WHERE id = ?")
    .get(messageID) as {
    session_id: string
    delivery: string
    admitted_seq: number
    promoted_seq: number | null
  } | null
  database.close()
  return row
}

function readLatestProviderReceipt(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const row = database
    .query(
      `SELECT owner_token, state, error_code, terminal_at
       FROM session_v2_provider_turn_receipt
       WHERE session_id = ?
       ORDER BY request_ordinal DESC
       LIMIT 1`,
    )
    .get(sessionID) as {
    owner_token: string
    state: string
    error_code: string | null
    terminal_at: number | null
  } | null
  database.close()
  return row
}

function readLatestLiveProviderOwnerToken(databasePath: string) {
  const database = new Database(databasePath, { readonly: true })
  const row = database
    .query(
      `SELECT owner_token
       FROM session_provider_owner_lease
       WHERE released_at IS NULL
       ORDER BY registered_at DESC
       LIMIT 1`,
    )
    .get() as { owner_token: string } | null
  database.close()
  return row?.owner_token
}

const kill9 = (server: ServeHandle) =>
  Effect.gen(function* () {
    server.kill("SIGKILL")
    expect(yield* Effect.promise(() => server.exited)).toEqual(expect.any(Number))
  })

function createSession(base: string, headers: Record<string, string>) {
  return Effect.gen(function* () {
    const created = yield* requestJson(base, "/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "kill9 redrive oracle" }),
    })
    if (created.status !== 200) throw new Error(`createSession ${created.status}: ${JSON.stringify(created.body)}`)
    expect(created.status).toBe(200)
    const sessionID = (created.body as { id: string }).id
    expect(sessionID).toMatch(/^ses_/)
    return sessionID
  })
}

function promptAsync(base: string, headers: Record<string, string>, sessionID: string, text: string) {
  return Effect.gen(function* () {
    const prompt = yield* requestJson(base, `/session/${sessionID}/prompt_async`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text }],
      }),
    })
    expect(prompt.status).toBe(200)
    return (prompt.body as { messageID: string }).messageID
  })
}

// Every scenario needs the same durable home: a named DB (read back via sqlite for the durable
// projection assertions) and a git workspace pinned by the directory header, mirroring
// packaged-fork.test.ts. Returns the pieces the four tests share.
function kill9Setup(home: string, databaseName: string) {
  return Effect.gen(function* () {
    const workspace = path.join(home, "workspace")
    const init = yield* Effect.promise(() => Bun.spawn(["git", "init", "--quiet", workspace]).exited)
    expect(init).toBe(0)
    return {
      databasePath: path.join(home, ".deepagent", "code", databaseName),
      serverOptions: { hostname: "127.0.0.1", env: { DEEPAGENT_CODE_DB: databaseName } },
      headers: {
        "content-type": "application/json",
        "x-deepagent-code-directory": workspace,
      },
    }
  })
}

const packagedBinary = process.env.DEEPAGENT_CODE_TEST_BINARY

if (!packagedBinary) {
  test.skip("kill-9 redrive oracle requires DEEPAGENT_CODE_TEST_BINARY", () => {})
} else {
cliIt.live(
  "kill-9 mid-stream: the dead owner's dispatched turn is fenced, never re-executed, and surfaces recovery_required",
  ({ deepagentCode, llm, home }) =>
    Effect.gen(function* () {
      const { databasePath, serverOptions, headers } = yield* kill9Setup(home, "kill9-owner-identity.db")

      yield* llm.hang
      const first = yield* deepagentCode.serve(serverOptions)
      const sessionID = yield* createSession(first.url, headers)
      yield* promptAsync(first.url, headers, sessionID, "kill9 owner identity turn")
      // The provider turn is now dispatched and hanging mid-stream; the process killed below never
      // settles it. The physical call count at this point is exactly 1.
      yield* llm.wait(1)
      yield* kill9(first)

      // A ready server has already run SessionRestart.redriveStartup (v2StartupRecovery is part of
      // the server layer graph), so the restart classification has happened by this point.
      const second = yield* deepagentCode.serve(serverOptions)
      const health = yield* requestJson(second.url, "/global/health")
      expect(health.status).toBe(200)

      // Owner identity: the restarted process classified the dead owner's unfinished drain and
      // left it fenced instead of re-dispatching it.
      expect(yield* llm.calls).toBe(1)
      const status = yield* requestJson(second.url, "/session/status", { headers })
      expect(status.status).toBe(200)
      expect(status.body).toHaveProperty(sessionID, {
        type: "recovery_required",
        message: "Execution stopped with an unresolved durable claim; inspect recovery before resuming",
      })
      // The durable claim from the dead process is still in place: startup redrive refused to
      // exact-release a drain whose outcome is unknown.
      expect(readSessionRow(databasePath, sessionID)?.execution_claim_token).not.toBeNull()
      second.kill()
      expect(yield* Effect.promise(() => second.exited)).toEqual(expect.any(Number))
    }),
  { timeout: 120_000 },
)

cliIt.live(
  "kill-9 before wake: an input admitted before a durable interrupt is not auto-redriven by the restarted process",
  ({ deepagentCode, llm, home }) =>
    Effect.gen(function* () {
      const { databasePath, serverOptions, headers } = yield* kill9Setup(home, "kill9-admit-before-wake.db")

      yield* llm.hang
      const first = yield* deepagentCode.serve(serverOptions)
      const sessionID = yield* createSession(first.url, headers)
      yield* promptAsync(first.url, headers, sessionID, "kill9 interrupt barrier first turn")
      yield* llm.wait(1)
      // B is admitted (durable) while A's turn is in flight, so it stays unpromoted. prompt_async
      // returns only after the durable admission boundary, so B's admitted_seq < the interrupt's.
      const pendingID = yield* promptAsync(first.url, headers, sessionID, "kill9 interrupt barrier pending input")
      // The durable user interrupt bumps session.interrupt_seq past B's admitted_seq and stops the
      // ownership chain. abort's response follows the interrupt settlement, so the claim is already
      // released and the interrupt barrier is durable when this returns.
      const aborted = yield* requestJson(first.url, `/session/${sessionID}/abort`, { method: "POST", headers })
      expect(aborted.status).toBe(200)
      // B's forked drain coalesced behind A's chain and the interrupt dropped it: B must still be
      // admitted-only when the kill lands, never executed by the first process.
      const pending = readInputRow(databasePath, pendingID)
      expect(pending?.promoted_seq).toBeNull()
      yield* kill9(first)

      const second = yield* deepagentCode.serve(serverOptions)
      const health = yield* requestJson(second.url, "/global/health")
      expect(health.status).toBe(200)

      // The durable interrupt barrier (interrupt_seq >= B's admitted_seq) suppressed the startup
      // wake: B is still pending, still unexecuted, and no second physical call ever happened.
      expect(yield* llm.calls).toBe(1)
      const session = readSessionRow(databasePath, sessionID)
      expect(session?.execution_claim_token).toBeNull()
      expect(session?.interrupt_seq).not.toBeNull()
      expect(pending?.admitted_seq).toBeLessThanOrEqual(session?.interrupt_seq ?? -1)
      expect(readInputRow(databasePath, pendingID)?.promoted_seq).toBeNull()
      // The session is NOT fenced (its claim was released by the interrupt before the kill), so
      // the suppression came from the interrupt barrier alone — not from recovery fencing.
      const status = yield* requestJson(second.url, "/session/status", { headers })
      expect(status.status).toBe(200)
      expect(status.body).not.toHaveProperty(sessionID)
      second.kill()
      expect(yield* Effect.promise(() => second.exited)).toEqual(expect.any(Number))
    }),
  { timeout: 120_000 },
)

cliIt.live(
  "kill-9 after dispatch: restart neither replays the dispatched turn nor drains new admissions on the fenced session",
  ({ deepagentCode, llm, home }) =>
    Effect.gen(function* () {
      const { databasePath, serverOptions, headers } = yield* kill9Setup(home, "kill9-post-dispatch.db")

      yield* llm.hang
      const first = yield* deepagentCode.serve(serverOptions)
      const sessionID = yield* createSession(first.url, headers)
      yield* promptAsync(first.url, headers, sessionID, "kill9 post dispatch turn")
      yield* llm.wait(1)
      yield* kill9(first)

      const second = yield* deepagentCode.serve(serverOptions)
      const health = yield* requestJson(second.url, "/global/health")
      expect(health.status).toBe(200)
      // Startup redrive classified the dispatched turn as unsafe to replay and stayed fenced.
      expect(yield* llm.calls).toBe(1)

      // A fresh admission on the fenced session is durably admitted (admission is independent of
      // execution) but its drain must lose the claim CAS: no replay of the old turn, no execution
      // of the new one. A replay would surface as a second physical call within the forked drain's
      // scheduling window; the window elapsing with no call IS the oracle.
      const followupID = yield* promptAsync(second.url, headers, sessionID, "kill9 post dispatch followup")
      const replayed = yield* Effect.option(
        pollWithTimeout(
          Effect.map(llm.calls, (calls) => (calls > 1 ? (true as const) : undefined)),
          "replay probe window elapsed",
          "3 seconds",
        ),
      )
      expect(Option.isNone(replayed)).toBe(true)
      expect(readInputRow(databasePath, followupID)?.promoted_seq).toBeNull()
      const status = yield* requestJson(second.url, "/session/status", { headers })
      expect(status.body).toHaveProperty(sessionID)
      second.kill()
      expect(yield* Effect.promise(() => second.exited)).toEqual(expect.any(Number))
    }),
  { timeout: 120_000 },
)

cliIt.live(
  "kill-9 on an idle process: the restarted process takes over the same session and keeps serving turns",
  ({ deepagentCode, llm, home }) =>
    Effect.gen(function* () {
      const { databasePath, serverOptions, headers } = yield* kill9Setup(home, "kill9-takeover.db")

      yield* llm.text("before kill-9")
      const first = yield* deepagentCode.serve(serverOptions)
      const sessionID = yield* createSession(first.url, headers)
      const beforeTurn = yield* requestJson(first.url, `/session/${sessionID}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "kill9 takeover first turn" }],
        }),
      })
      expect(beforeTurn.status).toBe(200)
      yield* llm.wait(1)
      // The turn settled, so the process is idle with no claim; kill-9 here skips every finalizer
      // the graceful path would have run.
      yield* kill9(first)

      yield* llm.text("after restart")
      const second = yield* deepagentCode.serve(serverOptions)
      const health = yield* requestJson(second.url, "/global/health")
      expect(health.status).toBe(200)
      const afterTurn = yield* requestJson(second.url, `/session/${sessionID}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "kill9 takeover restart turn" }],
        }),
      })
      expect(afterTurn.status).toBe(200)
      yield* llm.wait(2)

      const messages = yield* requestJson(second.url, `/session/${sessionID}/message`, { headers })
      expect(messages.status).toBe(200)
      const transcript = JSON.stringify(messages.body)
      expect(transcript).toContain("before kill-9")
      expect(transcript).toContain("after restart")
      // Healthy takeover: nothing fenced, nothing suspended, and the durable session row is clean.
      const status = yield* requestJson(second.url, "/session/status", { headers })
      expect(status.body).not.toHaveProperty(sessionID)
      expect(readSessionRow(databasePath, sessionID)?.execution_claim_token).toBeNull()
      second.kill()
      expect(yield* Effect.promise(() => second.exited)).toEqual(expect.any(Number))
    }),
  { timeout: 120_000 },
)

  if (process.platform !== "win32")
    cliIt.live(
      "SIGSTOP past the owner lease: successor quarantines once and late provider completion cannot fake success",
      ({ deepagentCode, llm, home }) =>
        Effect.gen(function* () {
          const { databasePath, serverOptions, headers } = yield* kill9Setup(home, "stall-owner-rotation.db")
          const heldProvider = Promise.withResolvers<void>()

          // The server sends the response head, then holds the tail. This proves a physical dispatch
          // reached the provider before SIGSTOP while leaving the turn live long enough for the owner
          // lease to expire deterministically.
          yield* llm.hold("late provider completion", heldProvider.promise)
          const server = yield* deepagentCode.serve({
            ...serverOptions,
            env: { ...serverOptions.env, DEEPAGENT_CODE_V2_OWNER_LEASE_MS: "1000" },
          })
          expect(server.pid).toBeGreaterThan(0)
          const sessionID = yield* createSession(server.url, headers)
          yield* promptAsync(server.url, headers, sessionID, "stall the live provider owner")
          yield* llm.wait(1)
          yield* pollWithTimeout(
            Effect.sync(() => {
              const receipt = readLatestProviderReceipt(databasePath, sessionID)
              return receipt?.state === "dispatching" || receipt?.state === "streaming" ? receipt : undefined
            }),
            "provider receipt did not reach a dispatched state before SIGSTOP",
            "10 seconds",
          )

          server.pause()
          yield* Effect.sleep("2500 millis")
          expect(yield* llm.calls).toBe(1)
          server.resume()

          const recovered = yield* pollWithTimeout(
            Effect.sync(() => {
              const receipt = readLatestProviderReceipt(databasePath, sessionID)
              return receipt?.state === "indeterminate_after_crash" ? receipt : undefined
            }),
            "stalled provider receipt did not reach its conservative terminal state",
            "15 seconds",
          )
          expect(recovered).toMatchObject({
            state: "indeterminate_after_crash",
            error_code: "owner_lost_after_dispatch",
          })
          expect(recovered.terminal_at).toEqual(expect.any(Number))
          expect(readLatestLiveProviderOwnerToken(databasePath)).not.toBe(recovered.owner_token)
          expect(readLatestLiveProviderOwnerToken(databasePath)).toContain(":gen-1:")
          expect(yield* llm.calls).toBe(1)

          // Let the already-dispatched provider request finish. The old stream may unwind locally,
          // but it must neither dispatch again nor rewrite the successor's conservative receipt into
          // a false durable success.
          yield* Effect.sync(() => heldProvider.resolve())
          yield* pollWithTimeout(
            Effect.map(requestJson(server.url, "/session/status", { headers }), (status) => {
              if (status.status !== 200) return
              return Object.prototype.hasOwnProperty.call(status.body, sessionID) ? undefined : true
            }),
            "provider stream did not finish after the held response was released",
            "15 seconds",
          )
          expect(yield* llm.calls).toBe(1)
          expect(readLatestProviderReceipt(databasePath, sessionID)).toMatchObject({
            state: "indeterminate_after_crash",
            error_code: "owner_lost_after_dispatch",
          })
          server.kill()
          expect(yield* Effect.promise(() => server.exited)).toEqual(expect.any(Number))
        }),
      { timeout: 120_000 },
    )
}
