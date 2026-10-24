import { expect, test } from "bun:test"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { IMKernelSync } from "@/im/kernel/sync"
import { InstanceRegistry } from "@/effect/instance-registry"
import { discoveryPeer } from "./fixture/kernel-discovery-peer"

const failures = [
  { code: "transport_error", retryable: true },
  { code: "im_not_found", status: 503, retryable: true },
  { code: "im_not_found", status: 500, retryable: false },
  { code: "im_not_found", retryable: false },
  { code: "im_key_invalid", status: 403, retryable: false },
  { code: "im_identity_disabled", status: 403, retryable: false },
  { code: "im_cross_org", status: 403, retryable: false },
  { code: "invalid_response", status: 400, retryable: false },
  { code: "http_error", status: 404, retryable: false },
]
const cases = [
  ["case-01", "first DM and invited group have scoped protected bodies"],
  ["case-02", "wrong organization, tuple and membership refuse before binding"],
  ["case-03", "cold group discovery inspects before the first body page"],
  ["case-04", "revoked history does not block permitted projections"],
  ["case-05", "revoked change pages continue to a later permitted projection"],
  ["case-06", "later malformed page preserves committed cursor and exact retry"],
  ["case-07", "initial mismatched organization does not commit metadata or bodies"],
  ["case-08", "bound mismatched organization preserves the original rows"],
  ...failures.flatMap((failure, index) =>
    ["discovery", "history"].map((phase, offset) => [
      `case-${String(9 + index * 2 + offset).padStart(2, "0")}`,
      `${phase} ${failure.code}/${failure.status ?? "no-status"} stays unavailable until explicit recovery`,
    ]),
  ),
  ["case-27", "changed original sender cannot replace a committed body"],
  ["case-28", "nonprogressing pages are bounded and cannot report ready"],
  ["case-29", "concurrent reader sync preserves one mapping and local membership"],
  ["legacy-closed", "retired global message stream and catch-up never create mirrors or work"],
]
const selected = process.env.DAC_CURRENT_DISCOVERY_CASE

// The original SDK owns connection-global state. Each case therefore gets one
// physical DB and one fresh process; no reset or forged SDK handles are needed.
if (!selected) {
  for (const [id, name] of cases)
    test(
      name!,
      async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-current-discovery-child-"))
        const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path], {
          cwd: path.resolve(import.meta.dir, "../.."),
          env: { ...process.env, DAC_CURRENT_DISCOVERY_CASE: id, DEEPAGENT_IM_FACADE_URL: "" },
          stdout: "pipe",
          stderr: "pipe",
        })
        const watchdog = setTimeout(() => child.kill(), 29_000)
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          if (code !== 0) {
            await Bun.write(path.join(directory, "failure.log"), `${stdout}\n${stderr}`)
            console.error({ scenario: id, diagnosticRoot: directory, code, stdout, stderr })
          }
          expect(code).toBe(0)
          expect(stderr).toContain("1 pass")
          expect(stderr).toContain("0 fail")
          await fs.rm(directory, { recursive: true, force: true })
        } finally {
          clearTimeout(watchdog)
          child.kill()
        }
      },
      30_000,
    )
}

async function currentDiscovery(id: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-current-discovery-reader-")))
  const native = discoveryPeer()
  const finished = { success: false }
  const control: { mismatch: string; failure?: IMKernelExchange.ExchangeError } = { mismatch: "" }
  const inspections: IMKernelExchange.InspectConversationInput[] = []
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const client = yield* KernelClient.Service
        for (const round of Array.from({ length: 500 }, (_, index) => index)) {
          if ((yield* SubscriptionRef.get(client.state)) === "connected") break
          if (round === 499) return yield* Effect.die("ORIGINAL_SDK_CONNECTION_BOUND_REACHED")
          yield* Effect.sleep("10 millis")
        }
        expect(yield* SubscriptionRef.get(client.state)).toBe("connected")
        const reader = yield* IMKernelReader.make(native.config, {
          workspaceID: directory,
          inspectConversation: (input) =>
            Effect.suspend(() => {
              inspections.push(input)
              if (id === "case-03")
                expect(
                  native.pages.some(
                    (page) => page.key === native.conversation(input.conversationType, input.conversationID).key,
                  ),
                ).toBe(false)
              if (control.failure) return Effect.fail(control.failure)
              return Effect.succeed({
                conversation_type: input.conversationType,
                conversation_id: control.mismatch === "tuple" ? "foreign-conversation" : input.conversationID,
                org_id: control.mismatch === "org" ? 99 : 1,
                name: input.conversationID,
                member_uuids:
                  control.mismatch === "member" ? [input.conversationID] : ["receiver", input.conversationID],
              })
            }),
        })
        const bodies = () =>
          db.all<{ message_id: string; immutable_hash: string; content: string; sender_id: string }>(sql`
        SELECT r.message_id,r.immutable_hash,m.content,r.sender_id FROM im_kernel_reader_message r
        JOIN im_messages m ON m.id=r.local_message_id ORDER BY r.message_id`)
        const status = () => SubscriptionRef.get(reader.state)
        const ready = Effect.gen(function* () {
          yield* reader.sync
          if ((yield* status()).state !== "ready")
            console.error({
              scenario: id,
              status: yield* status(),
              requests: native.requests.slice(-6),
              pages: native.pages.slice(-6),
            })
          expect(yield* status()).toMatchObject({ state: "ready", legacyMirrorUnavailable: true })
        })

        if (id === "case-01" || id === "case-03") {
          native.add(1, "bob", "first-dm")
          const group = native.add(2, "invited-group", "offline-group")
          expect(yield* bodies()).toEqual([])
          yield* ready
          expect((yield* bodies()).map((row) => [row.message_id, row.content])).toEqual([
            ["first-dm", JSON.stringify({ content: "original first-dm" })],
            ["offline-group", JSON.stringify({ content: "original offline-group" })],
          ])
          expect(inspections.map((input) => input.conversationID).sort()).toEqual(["bob", "invited-group"])
          expect(yield* KernelReader.projection(reader.runtime, group.key)).toMatchObject({
            target_id: "invited-group",
            history_complete: 1,
          })
          expect(yield* db.get(sql`SELECT count(*) n FROM im_groups WHERE workspace_id=${directory}`)).toEqual({ n: 2 })
        }
        if (id === "case-02") {
          for (const mismatch of ["org", "tuple", "member"]) {
            native.add(1, "bob", `denied-${mismatch}`)
            control.mismatch = mismatch
            yield* reader.sync
            expect(yield* status()).toMatchObject({ state: "unavailable", code: "reader_scope_mismatch" })
            expect(yield* bodies()).toEqual([])
            expect(yield* db.get(sql`SELECT count(*) n FROM im_groups`)).toEqual({ n: 0 })
          }
          control.mismatch = ""
          yield* ready
          expect(yield* bodies()).toHaveLength(3)
        }
        if (id === "case-04" || id === "case-05") {
          const revoked = id === "case-05" ? 33 : 1
          for (const index of Array.from({ length: revoked }, (_, index) => index)) {
            native.add(2, `revoked-${index}`, `forbidden-${index}`)
            native.revoke(2, `revoked-${index}`)
          }
          native.add(1, "permitted", "permitted-after-revocations")
          yield* ready
          expect((yield* bodies()).map((row) => row.message_id)).toEqual(["permitted-after-revocations"])
          expect(
            yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_projection WHERE visibility='revoked'`),
          ).toEqual({ n: revoked })
          if (revoked > 32) expect(native.changes).toContain("32")
        }
        if (id === "case-06") {
          for (const index of Array.from({ length: 225 }, (_, index) => index))
            native.add(2, "checkpoint", `checkpoint-${String(index).padStart(3, "0")}`)
          native.faults.malformedAfter = "32"
          yield* reader.sync
          expect(yield* status()).toMatchObject({ state: "unavailable" })
          const committed = yield* bodies()
          expect(committed).toHaveLength(32)
          const checkpoint = yield* KernelReader.projection(reader.runtime, native.conversation(2, "checkpoint").key)
          expect(checkpoint?.newer_after).toBe("32")
          expect(committed.map((row) => row.message_id)).not.toContain("checkpoint-032")
          native.faults.malformedAfter = undefined
          yield* reader.sync
          expect((yield* bodies()).slice(0, 32)).toEqual(committed)
          expect(yield* bodies()).toHaveLength(160)
          expect(yield* status()).toMatchObject({ state: "partial" })
          for (const round of Array.from({ length: 8 }, (_, index) => index)) {
            if ((yield* status()).state === "ready") break
            const before = yield* KernelReader.projection(reader.runtime, native.conversation(2, "checkpoint").key)
            yield* reader.sync
            expect(["partial", "ready"]).toContain((yield* status()).state)
            const after = yield* KernelReader.projection(reader.runtime, native.conversation(2, "checkpoint").key)
            expect([before?.newer_after, before?.older_before, before?.history_complete]).not.toEqual([
              after?.newer_after,
              after?.older_before,
              after?.history_complete,
            ])
            expect(round).toBeLessThan(7)
          }
          expect(yield* status()).toMatchObject({ state: "ready" })
          expect((yield* bodies()).slice(0, 32)).toEqual(committed)
          expect(
            yield* db.get(sql`SELECT count(*) n,count(DISTINCT local_message_id) bodies FROM im_kernel_reader_message`),
          ).toEqual({ n: 225, bodies: 225 })
        }
        if (id === "case-07" || id === "case-08" || /^case-(09|1[0-9]|2[0-6])$/.test(id)) {
          const history = id === "case-08" || Number(id.slice(5)) % 2 === 0
          native.add(2, "protected", "original")
          if (history) yield* ready
          const original = yield* bodies()
          const before = yield* KernelReader.scope(reader.runtime)
          native.add(2, "protected", "must-wait")
          if (id === "case-07" || id === "case-08") control.mismatch = "org"
          if (Number(id.slice(5)) >= 9)
            control.failure = new IMKernelExchange.ExchangeError({
              ...failures[Math.floor((Number(id.slice(5)) - 9) / 2)]!,
              message: "Original explicit inspection failure",
            })
          yield* reader.sync
          expect(yield* status()).toMatchObject({
            state: "unavailable",
            code: control.mismatch ? "reader_scope_mismatch" : "reader_unavailable",
          })
          expect(yield* bodies()).toEqual(original)
          expect((yield* KernelReader.scope(reader.runtime))?.completed_after).toBe(before?.completed_after ?? "0")
          control.mismatch = ""
          control.failure = undefined
          yield* ready
          expect((yield* bodies()).map((row) => row.message_id)).toEqual(["must-wait", "original"])
        }
        if (id === "case-27") {
          const projection = native.add(1, "bob", "immutable-original")
          yield* ready
          const original = yield* bodies()
          native.faults.changedSender = true
          // Replay the actual SDK's historical page through its production
          // consumer. Only senderId changes; every original receipt byte stays.
          const page = yield* client.getDeliveryMessages({
            version: 2,
            scopeKey: native.scopeKey,
            projectionKey: projection.key,
            projectionRevision: native.state.revision,
            direction: "older",
            limit: 32,
          })
          expect(page.items).toHaveLength(1)
          expect(page.items[0]?.senderId).toBe("forged-sender")
          expect({ ...page.items[0], senderId: "bob" }).toEqual(projection.messages[0])
          expect(yield* KernelReader.applyMessages(reader.runtime, page).pipe(Effect.flip)).toMatchObject({
            code: "reader_mapping_conflict",
            operation: "message-retry",
          })
          expect(yield* bodies()).toEqual(original)
        }
        if (id === "case-28") {
          native.faults.nonprogressing = true
          yield* reader.sync
          expect((yield* status()).state).not.toBe("ready")
          expect(native.requests.length).toBeGreaterThan(1)
          expect(native.requests.length).toBeLessThanOrEqual(128)
          expect(yield* bodies()).toEqual([])
          expect((yield* KernelReader.scope(reader.runtime))?.completed_after).toBe("0")
        }
        if (id === "case-29") {
          yield* ready
          const groups = yield* Effect.all(
            Array.from({ length: 8 }, () =>
              reader.pending({ conversationType: 2, conversationID: "atomic", name: "Atomic" }),
            ),
            { concurrency: 8 },
          )
          expect(new Set(groups).size).toBe(1)
          expect(yield* db.get(sql`SELECT count(*) n FROM im_groups WHERE workspace_id=${directory}`)).toEqual({ n: 1 })
          const projection = native.add(2, "atomic", "single-body")
          yield* Effect.all(
            Array.from({ length: 8 }, () => reader.sync),
            { concurrency: 8 },
          )
          expect(yield* status()).toMatchObject({ state: "ready" })
          expect(yield* bodies()).toHaveLength(1)
          const stored = yield* KernelReader.projection(reader.runtime, projection.key)
          expect(stored?.local_group_id).toBe(groups[0])
          expect(
            yield* db.get(
              sql`SELECT count(*) n FROM im_kernel_reader_projection WHERE projection_key=${projection.key}`,
            ),
          ).toEqual({ n: 1 })
          expect(
            yield* db.get(
              sql`SELECT count(*) n FROM im_members WHERE group_id=${stored!.local_group_id} AND member_id='server'`,
            ),
          ).toEqual({ n: 1 })
        }
        expect(native.errors).toEqual([])
        expect(native.requests.every((request) => request.requestVersion === 2)).toBe(true)
        expect(yield* db.get(sql`SELECT count(*) n FROM im_messages WHERE kernel_msg_id IS NOT NULL`)).toEqual({ n: 0 })
        expect(yield* db.get(sql`SELECT count(*) n FROM session_input`)).toEqual({ n: 0 })
        expect(yield* db.get(sql`SELECT count(*) n FROM im_mention_intent`)).toEqual({ n: 0 })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Database.layerFromPath(path.join(directory, "reader.sqlite")),
            IMBroadcasterLive,
            KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(native.config))),
          ),
        ),
        Effect.scoped,
      ),
    )
    finished.success = true
  } finally {
    await native.stop()
    if (finished.success) await fs.rm(directory, { recursive: true, force: true })
    if (!finished.success) console.error({ scenario: id, readerDiagnosticRoot: directory })
  }
}

async function legacyClosed() {
  const observed = { history: 0, conversations: 0 }
  const config = {
    userID: "receiver",
    appkey: "retired-discovery",
    navigator: "http://127.0.0.1:9",
    token: "private-fixture",
    identity: { uuid: "receiver", name: "Receiver", orgID: 1, orgAllGroupID: "unused" },
  }
  const client = Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
      return Layer.mock(KernelClient.Service, {
        state,
        messages: Stream.succeed({
          messageID: "legacy-untrusted",
          conversationType: 1,
          conversationID: "bob",
          senderID: "bob",
          text: "must not land",
          msgTime: Date.now(),
        }),
        fetchHistory: () =>
          Effect.sync(() => {
            observed.history++
            throw new Error("RETIRED_HISTORY_CALLED")
          }),
        fetchConversations: () =>
          Effect.sync(() => {
            observed.conversations++
            throw new Error("RETIRED_DISCOVERY_CALLED")
          }),
        disconnect: Effect.void,
      })
    }),
  )
  const database = Database.layerFromPath(":memory:")
  const engine = IMKernelSync.layer(config, { workspaceID: "retired" }).pipe(
    Layer.provide(
      Layer.mergeAll(
        database,
        client,
        IMBroadcasterLive,
        InstanceRegistry.layer,
        IMRepositoryLive.pipe(Layer.provide(database)),
      ),
    ),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* IMKernelSync.Service).catchUp
      const db = (yield* Database.Service).db
      expect(observed).toEqual({ history: 0, conversations: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM im_groups`)).toEqual({ n: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM im_messages`)).toEqual({ n: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM session_input`)).toEqual({ n: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM im_mention_intent`)).toEqual({ n: 0 })
    }).pipe(Effect.provide(Layer.merge(database, engine)), Effect.scoped),
  )
}

if (selected) {
  const entry = cases.find(([id]) => id === selected)
  if (!entry) throw new Error("UNKNOWN_CURRENT_DISCOVERY_CASE")
  test(entry[1]!, () => (selected === "legacy-closed" ? legacyClosed() : currentDiscovery(selected)), 30_000)
}
