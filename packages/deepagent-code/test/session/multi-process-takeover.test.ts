import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionForkIntentTable } from "@deepagent-code/core/session/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Effect, Layer } from "effect"
import { and, eq, sql } from "drizzle-orm"
import {
  acquireDurableExecutorLease,
  releaseDurableExecutorLease,
  releaseDurableExecutorReservation,
  reserveDurableExecutor,
} from "@/session/durable-executor-lock"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const roots: string[] = []

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepagent-takeover-drill-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/** A pid that cannot exist on the host, simulating a holder that died via kill -9. */
const deadPid = 999_999_999

function killHolder(lease: NonNullable<ReturnType<typeof acquireDurableExecutorLease>>, staleMs: number) {
  clearInterval(lease.heartbeat)
  const expired = new Date(Date.now() - (staleMs + 1_000))
  fs.utimesSync(lease.heartbeatPath, expired, expired)
  const metadata = JSON.parse(fs.readFileSync(lease.metadataPath, "utf-8"))
  fs.writeFileSync(lease.metadataPath, JSON.stringify({ ...metadata, pid: deadPid }))
}

describe("RISK-004 drill: durable executor lease takeover", () => {
  test("a: kill -9 holder (dead pid + missed heartbeats) is quarantined and a successor acquires", () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace)
    expect(reserveDurableExecutor(workspace)).toBe(true)

    const first = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 20,
      heartbeatMs: 60_000,
    })
    expect(first).toBeDefined()
    killHolder(first!, 20)
    releaseDurableExecutorReservation(workspace)

    expect(reserveDurableExecutor(workspace)).toBe(true)
    const successor = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 20,
      heartbeatMs: 60_000,
    })
    expect(successor).toBeDefined()
    expect(successor!.token).not.toBe(first!.token)
    expect(JSON.parse(fs.readFileSync(successor!.metadataPath, "utf-8")).token).toBe(successor!.token)
    // Quarantine removes the dead holder's directory; only the successor's lock remains.
    expect(fs.existsSync(successor!.lockPath)).toBe(true)
    expect(fs.readdirSync(path.dirname(successor!.lockPath)).filter((name) => name.includes(".stale-"))).toEqual([])

    releaseDurableExecutorLease(successor!)
  })

  test("b: expired lease held by a live pid is refused (fail-closed) and raises a structured warning", () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace)
    expect(reserveDurableExecutor(workspace)).toBe(true)

    const first = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 20,
      heartbeatMs: 60_000,
    })
    expect(first).toBeDefined()
    // Simulate a wedged holder: heartbeats stopped but the owner process (this one) is alive.
    clearInterval(first!.heartbeat)
    const expired = new Date(Date.now() - 1_000)
    fs.utimesSync(first!.heartbeatPath, expired, expired)
    releaseDurableExecutorReservation(workspace)

    const warn = spyOn(console, "warn")
    try {
      expect(reserveDurableExecutor(workspace)).toBe(true)
      const successor = acquireDurableExecutorLease({
        directory: workspace,
        mode: "durable",
        stateRoot: root,
        staleMs: 20,
        heartbeatMs: 60_000,
      })
      // Fail-closed: a live holder is never replaced, even with an expired heartbeat.
      expect(successor).toBeUndefined()
      expect(fs.existsSync(first!.lockPath)).toBe(true)
      expect(JSON.parse(fs.readFileSync(first!.metadataPath, "utf-8")).token).toBe(first!.token)
      releaseDurableExecutorReservation(workspace)

      expect(warn).toHaveBeenCalled()
      const call = warn.mock.calls.find(([message]) => String(message).includes("fail-closed"))
      expect(call).toBeDefined()
      const detail = call![1] as Record<string, unknown>
      expect(detail.workspace).toBe(workspace)
      expect(detail.pid).toBe(process.pid)
      expect(typeof detail.leaseAgeMs).toBe("number")
      expect(detail.leaseAgeMs).toBeGreaterThanOrEqual(20)
    } finally {
      warn.mockRestore()
    }

    releaseDurableExecutorLease(first!)
  })

  test("c1: a displaced holder's heartbeat stops on token mismatch without touching the successor's files", async () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace)
    expect(reserveDurableExecutor(workspace)).toBe(true)

    const lease = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 60_000,
      heartbeatMs: 25,
    })
    expect(lease).toBeDefined()
    await Bun.sleep(60)
    // A takeover replaces meta.json's token; the old holder's heartbeat must self-terminate.
    const metadata = JSON.parse(fs.readFileSync(lease!.metadataPath, "utf-8"))
    fs.writeFileSync(lease!.metadataPath, JSON.stringify({ ...metadata, token: "successor-token" }))
    const before = fs.statSync(lease!.heartbeatPath).mtimeMs
    await Bun.sleep(120)
    const after = fs.statSync(lease!.heartbeatPath).mtimeMs
    expect(after).toBe(before)

    clearInterval(lease!.heartbeat)
    releaseDurableExecutorLease(lease!)
  })

  test("c2: a displaced holder's release with a stale token never removes the successor's lock", () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace)
    expect(reserveDurableExecutor(workspace)).toBe(true)

    const first = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 20,
      heartbeatMs: 60_000,
    })!
    killHolder(first, 20)
    releaseDurableExecutorReservation(workspace)

    expect(reserveDurableExecutor(workspace)).toBe(true)
    const successor = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 20,
      heartbeatMs: 60_000,
    })!
    expect(successor.token).not.toBe(first.token)

    // The killed holder wakes up and tries to release with its old token: rejected by token check.
    releaseDurableExecutorLease(first)
    expect(fs.existsSync(successor.lockPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(successor.metadataPath, "utf-8")).token).toBe(successor.token)

    releaseDurableExecutorLease(successor)
    expect(fs.existsSync(successor.lockPath)).toBe(false)
  })
})

const it = testEffect(
  Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const addUser = Effect.fn("MultiProcessTakeover.addUser")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
  return message.id
})

const addAssistant = Effect.fn("MultiProcessTakeover.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  text: string,
) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "test",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
  return message.id
})

describe("RISK-004 drill: fork delivery claim lease", () => {
  it.instance("reclaims an expired fork delivery claim and fences the stale owner's writes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({})
      const user = yield* addUser(parent.id, "takeover drill user")
      yield* addAssistant(parent.id, user, "takeover drill assistant")
      const intentID = "fork-takeover-lease-reclaim"
      const staleOwner = "fork-delivery:stale-owner"
      const triggerName = "test_fork_claim_lease_expiry"

      // Crash the first claimant mid-delivery: every cursor commit aborts.
      yield* db.run(sql`
        CREATE TRIGGER ${sql.raw(triggerName)}
        BEFORE UPDATE OF event_cursor ON session_fork_intent
        WHEN NEW.intent_id = '${sql.raw(intentID)}'
        BEGIN
          SELECT RAISE(ABORT, 'test_fork_delivery_crash');
        END
      `)
      const crashed = yield* sessions.fork({ sessionID: parent.id, intentID }).pipe(Effect.exit)
      expect(crashed._tag).toBe("Failure")
      yield* db.run(sql`DROP TRIGGER ${sql.raw(triggerName)}`)

      const crashedIntent = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, intentID))
        .get()
        .pipe(Effect.orDie)
      expect(crashedIntent?.state).toBe("committed")
      expect(crashedIntent?.delivery_owner).toBeNull()

      // Reconstruct the moment a claimant holds the claim but dies: publishing with a lease.
      const setPublishing = (leaseExpiresAt: number) =>
        db
          .update(SessionForkIntentTable)
          .set({ state: "publishing", delivery_owner: staleOwner, lease_expires_at: leaseExpiresAt, time_updated: Date.now() })
          .where(eq(SessionForkIntentTable.intent_id, intentID))
          .run()
          .pipe(Effect.orDie)

      // A live lease is never stolen: recoverForks leaves the claim untouched.
      yield* setPublishing(Date.now() + 60_000)
      yield* sessions.recoverForks()
      const live = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, intentID))
        .get()
        .pipe(Effect.orDie)
      expect(live?.state).toBe("publishing")
      expect(live?.delivery_owner).toBe(staleOwner)

      // Once the lease expires, a new claimant reclaims and completes delivery.
      yield* setPublishing(Date.now() - 1_000)
      yield* sessions.recoverForks()
      const reclaimed = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, intentID))
        .get()
        .pipe(Effect.orDie)
      expect(reclaimed?.state).toBe("complete")
      expect(reclaimed?.delivery_owner).toBeNull()
      expect(reclaimed?.lease_expires_at).toBeNull()
      expect(reclaimed?.event_cursor).toBe(reclaimed?.event_count)
      expect(reclaimed?.delivery_attempts).toBeGreaterThanOrEqual(2)

      // The stale owner's cursor-advance predicate (intent + owner + state + cursor) matches nothing.
      const staleWrite = yield* db
        .update(SessionForkIntentTable)
        .set({ time_updated: Date.now() })
        .where(
          and(
            eq(SessionForkIntentTable.intent_id, intentID),
            eq(SessionForkIntentTable.delivery_owner, staleOwner),
            eq(SessionForkIntentTable.state, "publishing"),
          ),
        )
        .returning({ intent_id: SessionForkIntentTable.intent_id })
        .get()
        .pipe(Effect.orDie)
      expect(staleWrite).toBeUndefined()

      const child = yield* sessions.get(reclaimed!.target_session_id)
      yield* sessions.remove(child.id)
      yield* sessions.remove(parent.id)
    }),
  )
})
