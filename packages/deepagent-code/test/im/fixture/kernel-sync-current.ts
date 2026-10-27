import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { HttpClient } from "effect/unstable/http"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive, type IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { Log } from "@deepagent-code/core/util/log"
import { InstanceStore } from "@/project/instance-store"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelConfig } from "@/im/kernel/config"
import { IMKernelSync } from "@/im/kernel/sync"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { IMDeviceProof } from "@/im/device-proof"
import { IMDeviceTransport } from "@/im/device-transport"
import { ReaderInstanceFixture } from "../reader-instance-fixture"
import { KernelLiveFirstSeenFixture } from "./kernel-live-first-seen"
import { IMDeviceRuntimeFixture } from "../../server/im-device-runtime.fixture"

type Message = {
  effectKey: string
  messageId: string
  sequence: string
  deliveryCursor: string
  messageTime: number
  expiresAt: number
  senderId: string
  targetId: string
  conversationType: 1 | 2
  content: string
  isSend: boolean
  isRead: boolean
  messageType: "jg:text"
}
type Conversation = { key: string; type: 1 | 2; target: string; cursor: string; messages: Message[] }
const scopeKey = "a".repeat(64)
const rows = Schema.Array(
  Schema.Union([
    Schema.Struct({ visible: Schema.Struct({ projectionKey: Schema.String, projectionRevision: Schema.String }) }),
    Schema.Struct({ pending: Schema.Struct({ conversationType: Schema.Literals([1, 2]), targetId: Schema.String }) }),
  ]),
)

function peer() {
  const conversations = new Map<string, Conversation>()
  const state = {
    revision: 1,
    connections: 0,
    mode: "ack" as "ack" | "reject",
    malformedAfter: "",
    nonprogressing: false,
  }
  const queries: { topic: string; request: Record<string, unknown> }[] = []
  const sent: { target: string; text: string; clientID: string; localID: string; expiresAt: number }[] = []
  const advance = () => String(++state.revision)
  const conversation = (type: 1 | 2, target: string) => {
    const key = createHash("sha256").update(`sync:${type}:${target}`).digest("hex")
    const existing = conversations.get(key)
    if (existing) return existing
    const item: Conversation = { key, type, target, cursor: advance(), messages: [] }
    conversations.set(key, item)
    return item
  }
  const cut = (item: Conversation, revision: string, serverNow: number) => ({
    version: 2,
    scopeKey,
    projectionKey: item.key,
    projectionRevision: revision,
    throughOrdinal: "0",
    targetAdmittedOrdinal: String(item.messages.length),
    readOrdinal: "0",
    liveUnread: String(item.messages.length),
    storedUnread: String(item.messages.length),
    complete: item.messages.length === 0,
    serverNow,
  })
  const response: NonNullable<Parameters<typeof KernelLiveFirstSeenFixture.make>[0]>["response"] = (
    topic,
    request,
    original,
  ) => {
    queries.push({ topic, request })
    const revision = String(state.revision)
    const serverNow = Date.now()
    if (topic === "qry_delivery_capabilities")
      return {
        name: "DeliveryCapabilities",
        value: {
          version: 1,
          profile: "mysql-receipt-v1",
          maxLifetimeMs: 259200000,
          maxContentBytes: 65536,
          eventualDelivery: false,
        },
      }
    if (topic === "qry_delivery_reader")
      return {
        name: "DeliveryReaderInfo",
        value: {
          version: 2,
          scopeKey,
          currentCursor: revision,
          serverNow,
          maxPageItems: 32,
          maxChangeBytes: 65536,
          maxMessageBytes: 4194304,
          maxWindowPages: 100000,
          outputProofAvailable: true,
        },
      }
    if (topic === "qry_delivery_output_proof")
      return {
        name: "DeliveryOutputProofResult",
        value: {
          version: 2,
          scopeKey,
          serverNow,
          rows: Schema.decodeUnknownSync(rows)(request.outputRows).map((row) => {
            if ("pending" in row) return row
            const item = conversations.get(row.visible.projectionKey)
            if (!item) throw new Error("Owned output selector has no original projection")
            return { visible: cut(item, row.visible.projectionRevision, serverNow) }
          }),
        },
      }
    if (topic === "qry_delivery_receipt")
      return { name: "DeliveryReceiptResult", value: { state: "not_found", version: 1 } }
    if (topic === "qry_delivery_changes") {
      const changed = Array.from(conversations.values()).filter(
        (item) => BigInt(item.cursor) > BigInt(String(request.after || "0")),
      )
      const offset = Number(request.pageToken || 0)
      const selected = changed.slice(offset, offset + Number(request.limit || 32))
      const complete = offset + selected.length >= changed.length
      return {
        name: "DeliveryChangesResult",
        value: {
          version: 2,
          scopeKey,
          after: request.after || "0",
          upper: revision,
          scanCursor: state.nonprogressing ? request.after || "0" : (selected.at(-1)?.cursor ?? revision),
          scanProjectionKey: state.nonprogressing ? "" : (selected.at(-1)?.key ?? ""),
          pageToken: state.nonprogressing ? "stalled" : complete ? "" : String(offset + selected.length),
          windowComplete: !state.nonprogressing && complete,
          caughtUp: !state.nonprogressing && complete,
          serverNow,
          items: state.nonprogressing
            ? []
            : selected.map((item) => {
                const latest = item.messages.at(-1)
                return {
                  visibility: "visible",
                  projectionKey: item.key,
                  revision,
                  cursor: item.cursor,
                  conversationType: item.type,
                  targetId: item.target,
                  readOrdinal: "0",
                  admittedOrdinal: String(item.messages.length),
                  liveUnread: String(item.messages.length),
                  storedUnread: String(item.messages.length),
                  latestMessageId: latest?.messageId ?? "",
                  latestSequence: latest?.sequence ?? "",
                  latestMessageTime: latest?.messageTime ?? 0,
                  nextExpiryAt: latest?.expiresAt ?? 0,
                }
              }),
        },
      }
    }
    if (topic !== "qry_delivery_messages" && topic !== "qry_delivery_read_cut") return original
    const item = conversations.get(String(request.projectionKey))
    if (!item) throw new Error("Owned message selector has no original projection")
    if (topic === "qry_delivery_read_cut")
      return { name: "DeliveryReadCutResult", value: cut(item, revision, serverNow) }
    const anchor = String(request.anchorDeliveryCursor || "0")
    const remaining = item.messages.filter((message) =>
      request.direction === "older"
        ? !request.anchorDeliveryCursor || BigInt(message.deliveryCursor) < BigInt(anchor)
        : BigInt(message.deliveryCursor) > BigInt(anchor),
    )
    const ordered = request.direction === "older" ? [...remaining].reverse() : remaining
    const selected = ordered.slice(0, Number(request.limit || 32))
    return {
      name: "DeliveryMessagesResult",
      value: {
        version: 2,
        scopeKey,
        projectionKey: item.key,
        projectionRevision: revision,
        direction: request.direction,
        nextDeliveryCursor: selected.at(-1)?.deliveryCursor ?? "",
        finished: selected.length === ordered.length,
        serverNow,
        items: selected.map((message, index) => ({
          ...message,
          ...(state.malformedAfter === anchor && request.direction === "newer" && index === 0
            ? { targetId: "foreign-conversation" }
            : {}),
        })),
      },
    }
  }
  const outbound: NonNullable<Parameters<typeof KernelLiveFirstSeenFixture.make>[0]>["outboundPublish"] = (
    request,
    message,
  ) => {
    if (!(message.msgContent instanceof Uint8Array)) throw new Error("Original outbound bytes unavailable")
    const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ content: Schema.String })))(
      new TextDecoder().decode(message.msgContent),
    )
    const expiresAt = Number(String(message.deliveryExpiresAt))
    sent.push({
      target: String(request.targetId),
      text: body.content,
      clientID: String(message.clientUid),
      localID: String(message.tid),
      expiresAt,
    })
    if (state.mode === "reject") return { code: 503 }
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "dac.delivery.request.v1",
          request.topic === "p_msg" ? 1 : 2,
          request.targetId,
          message.clientUid,
          "jg:text",
          body.content,
          10,
          expiresAt,
        ]).replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")),
      )
      .digest("hex")
    return {
      code: 0,
      msgId: `ack-${sent.length}`,
      timestamp: Date.now(),
      msgIndex: 1,
      clientMsgId: message.clientUid,
      deliveryVersion: 1,
      deliveryExpiresAt: expiresAt,
      deliveryRequestHash: requestHash,
    }
  }
  return {
    state,
    queries,
    sent,
    conversations,
    conversation,
    response,
    outbound,
    add(type: 1 | 2, target: string, id: string, input?: { sender?: string; time?: number }) {
      const item = conversation(type, target)
      const cursor = String(item.messages.length + 1)
      const now = Date.now()
      const message: Message = {
        effectKey: createHash("sha256").update(`${scopeKey}:${item.key}:${id}`).digest("hex"),
        messageId: id,
        sequence: cursor,
        deliveryCursor: cursor,
        messageTime: input?.time ?? now,
        expiresAt: now + 600000,
        senderId: input?.sender ?? target,
        targetId: target,
        conversationType: type,
        content: JSON.stringify({ content: `original ${id}` }),
        isSend: false,
        isRead: false,
        messageType: "jg:text",
      }
      item.messages.push(message)
      item.cursor = advance()
      return message
    },
  }
}

export type State = {
  directory: string
  database: Database.Interface
  repo: IMRepositoryInterface
  sync: IMKernelSync.Interface
  lease: IMKernelSync.ReaderLease
  client: KernelClient.Interface
  store: InstanceStore.Interface
  config: KernelConfig.Info
  remote: ReturnType<typeof peer>
  native: ReturnType<typeof KernelLiveFirstSeenFixture.make>
  broadcasts: { groupID: string; type: string }[]
  inspected: IMKernelExchange.InspectConversationInput[]
  legacy: { reads: number }
  reopen: Effect.Effect<IMKernelSync.ReaderLease, unknown, Scope.Scope>
}

export const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (const attempt of Array.from({ length: 500 }, (_, index) => index)) {
      const value = yield* effect
      if (value !== undefined) return value
      if (attempt === 499) return yield* Effect.die(new Error("Owned current sync observation timed out"))
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error("Unreachable current sync observation"))
  })

export const bodies = (state: State) =>
  state.database.db.all<{
    message_id: string
    immutable_hash: string
    content: string
    sender_id: string
    local_message_id: string
    message_time: number
    local_group_id: string
  }>(sql`SELECT r.message_id,r.immutable_hash,m.content,r.sender_id,r.local_message_id,r.message_time,p.local_group_id
  FROM im_kernel_reader_message r JOIN im_messages m ON m.id=r.local_message_id
  JOIN im_kernel_reader_projection p ON p.reader_key=r.reader_key AND p.binding_key=r.binding_key ORDER BY r.delivery_cursor`)

export const ready = (state: Pick<State, "lease">) =>
  Effect.gen(function* () {
    for (const round of Array.from({ length: 12 }, (_, index) => index)) {
      yield* state.lease.engine.catchUp
      const current = yield* SubscriptionRef.get(state.lease.reader.state)
      if (current.state === "ready") return
      if (current.state === "unavailable")
        return yield* Effect.die(new Error(`Original reader refused ${current.code}`))
      expect(round).toBeLessThan(11)
    }
  })

export async function run(name: string, body: (state: State) => Effect.Effect<void, unknown, Scope.Scope>) {
  const directory = process.env.DAC_CURRENT_SYNC_ROOT!
  if (!path.basename(directory).startsWith("dac-current-sync-") || (await fs.realpath(directory)) !== directory)
    throw new Error("Current sync fixture requires its original owned directory")
  const orgID = name.startsWith("org-") ? 7 : 1
  const remote = peer()
  const native: { value?: ReturnType<typeof KernelLiveFirstSeenFixture.make> } = {}
  const address = { origin: "" }
  const inspected: IMKernelExchange.InspectConversationInput[] = []
  const broadcasts: { groupID: string; type: string }[] = []
  const legacy = { reads: 0 }
  const diagnostic = { connection: "unobserved", requests: [] as string[], httpSigns: 0, socketSigns: 0 }
  const stage = { value: "device" }
  await Effect.runPromise(
    Effect.gen(function* () {
      const certificatePath = path.join(directory, "tls", "ca.pem")
      expect(process.env.NODE_EXTRA_CA_CERTS).toBe(certificatePath)
      const platform = yield* IMDeviceRuntimeFixture.make({
        directory: path.join(directory, "platform"),
        uuid: "receiver",
        certificate: {
          ca: yield* Effect.promise(() => Bun.file(certificatePath).text()),
          keyPath: path.join(directory, "tls", "ca-key.pem"),
          certificatePath,
        },
        protectedPath: (pathname) => pathname.startsWith("/navigator/"),
        listen: (transport) => {
          native.value = KernelLiveFirstSeenFixture.make({
            tls: transport.tls,
            device: {
              publicJwk: transport.identity.publicJwk,
              appkey: "current-sync-owned",
              token: "daim2.current-sync-owned",
            },
            response: remote.response,
            outboundPublish: remote.outbound,
            fetch(request) {
              const pathname = new URL(request.url).pathname
              if (pathname === "/im") remote.state.connections++
              return pathname === "/health" || pathname === "/im" ? undefined : transport.fetch(request)
            },
          })
          return native.value.server
        },
        async fetch(request, identity): Promise<Response> {
          const pathname = new URL(request.url).pathname
          diagnostic.requests.push(pathname)
          if (pathname === "/navigator/general")
            return Response.json(
              { code: 0, data: { user_id: "receiver", servers: [address.origin] } },
              { headers: { "cache-control": "no-store" } },
            )
          const ok = (data: unknown) => Response.json({ success: true, data })
          if (pathname === "/api/im/login")
            return ok({
              profile: "dac-im-device-v1",
              entitlementID: "e".repeat(32),
              deviceJkt: identity.jkt,
              bindingVersion: 1,
              identity: { uuid: "receiver", name: "Receiver", org_id: orgID, org_all_group_id: `org${orgID}` },
              kernel: {
                token: "daim2.current-sync-owned",
                navigator: address.origin,
                appkey: "current-sync-owned",
                user_id: "receiver",
                socket_audience: address.origin.replace(/^https:/, "wss:") + "/im",
                credential_expires_at: Math.floor(Date.now() / 1000) + 3600,
                credential_generation: 1,
                device_profile: "dac-im-device-v1",
              },
            })
          if (pathname === "/api/im/conversations/inspect") {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                conversation_type: Schema.Literals([1, 2]),
                conversation_id: Schema.String,
                sender_uuid: Schema.optional(Schema.String),
              }),
            )(await request.json())
            inspected.push({
              conversationType: input.conversation_type,
              conversationID: input.conversation_id,
              senderID: input.sender_uuid,
            })
            return ok({
              ...input,
              org_id: orgID,
              name: input.conversation_type === 2 ? "全员群" : input.conversation_id,
              member_uuids: ["receiver", "sender", "member-bob"],
            })
          }
          return new Response(null, { status: 404 })
        },
      })
      address.origin = platform.url
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(platform.httpLayer))
      const transport = IMDeviceTransport.make({ store: platform.store, http })
      const credential = `iml2.${"a".repeat(64)}`
      const source: KernelConfig.FacadeSource = {
        facadeURL: platform.url,
        key: credential,
        device: {
          profile: IMDeviceProof.profile,
          publicJwk: platform.publicIdentity.publicJwk,
          entitlementID: "e".repeat(32),
          deviceJkt: platform.publicIdentity.jkt,
          bindingVersion: 1,
          uuid: "receiver",
          headers: (request) =>
            transport.headers({
              ...request,
              realm: platform.url,
              purpose: "login",
              credential,
              requestHash: IMDeviceProof.digest([
                "dac.im.login.v2",
                platform.url,
                IMDeviceProof.sha256(credential),
                platform.publicIdentity.jkt,
              ]),
            }),
        },
      }
      const connection = IMKernelExchange.toKernelConfig(
        yield* IMKernelExchange.exchange(source).pipe(Effect.provide(platform.httpLayer)),
      )
      expect(connection.identity?.orgID).toBe(orgID)
      const config: KernelConfig.Info = {
        ...connection,
        protectedMedia: true,
        protectedDeviceAuth: {
          profile: IMDeviceProof.profile,
          publicJwk: platform.publicIdentity.publicJwk,
          jkt: platform.publicIdentity.jkt,
          entitlementID: "e".repeat(32),
          bindingVersion: 1,
          socketAudience: platform.url.replace(/^https:/, "wss:") + "/im",
          signConnect: (challenge, input) => {
            diagnostic.socketSigns++
            return Effect.runPromise(
              platform.store.socket(challenge, {
                audience: input.audience,
                appkey: connection.appkey,
                token: input.token,
                entitlementID: "e".repeat(32),
                bindingVersion: 1,
              }),
            )
          },
          signHttp: (request) => {
            diagnostic.httpSigns++
            return Effect.runPromise(
              transport.headers({
                realm: platform.url,
                kernelRealm: platform.url,
                method: request.method,
                url: request.url,
                purpose: "kernel-http",
                credential: request.credential,
                requestHash: IMDeviceProof.digest([
                  "dac.im.kernel-http.v1",
                  platform.url,
                  IMDeviceProof.sha256(connection.token),
                  platform.publicIdentity.jkt,
                ]),
              }),
            )
          },
        },
      }
      const database = Database.layerFromPath(path.join(directory, "current.sqlite"))
      const repository = IMRepositoryLive.pipe(Layer.provide(database))
      const sdk = KernelSdk.liveFromConfig(config)
      const actualClient = KernelClient.layer.pipe(Layer.provide(sdk))
      // Only the retired stream is hostile. Every current reader query, opaque
      // link and SDK send still comes from the original SDK transport.
      const client = Layer.effect(
        KernelClient.Service,
        Effect.gen(function* () {
          const original = yield* KernelClient.Service
          return KernelClient.Service.of({
            ...original,
            messages: Stream.fromIterable([
              {
                messageID: "legacy-own",
                conversationType: 1,
                conversationID: "sender",
                senderID: "receiver",
                text: "legacy own",
                msgTime: Date.now(),
              },
              {
                messageID: "legacy-unbound",
                conversationType: 1,
                conversationID: "stranger",
                senderID: "stranger",
                text: "legacy unbound",
                msgTime: Date.now(),
              },
              {
                messageID: "legacy-system",
                conversationType: 7,
                conversationID: "system",
                senderID: "system",
                text: "legacy system",
                msgTime: Date.now(),
              },
            ]).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  legacy.reads++
                }),
              ),
            ),
          })
        }),
      ).pipe(Layer.provide(actualClient))
      const services = Layer.mergeAll(
        database,
        repository,
        client,
        ReaderInstanceFixture.layer,
        ReaderInstanceFixture.registry,
        Layer.succeed(IMBroadcasterService, {
          broadcast: (groupID, event) => {
            broadcasts.push({ groupID, type: event.type })
          },
          sendToUser: () => {},
          register: () => true,
          unregister: () => {},
          getConnectionCount: () => 0,
          getUserConnectionCount: () => 0,
        }),
      )
      const engine = IMKernelSync.layer(config, {
        inspectConversation: (input) =>
          IMKernelExchange.inspectConversation({ ...source, ...input }).pipe(Effect.provide(platform.httpLayer)),
      }).pipe(Layer.provide(services))
      yield* Effect.gen(function* () {
        const client = yield* KernelClient.Service
        stage.value = "connection"
        yield* wait(
          SubscriptionRef.get(client.state).pipe(
            Effect.map((value) => {
              diagnostic.connection = value
              return value === "connected" ? true : undefined
            }),
          ),
        )
        const sync = yield* IMKernelSync.Service
        const store = yield* InstanceStore.Service
        const workspace = path.join(directory, "workspace")
        yield* Effect.promise(() => fs.mkdir(workspace, { mode: 0o700 }))
        const instance = yield* store.load({ directory: workspace })
        const acquire = (current: typeof instance) =>
          sync.acquireReader!({
            instance: current,
            workspaceID: current.directory,
            userID: "server",
            instanceCurrent: store.peek(current.directory).pipe(Effect.map((value) => value === current)),
          })
        stage.value = "reader"
        const lease = yield* acquire(instance)
        const state: State = {
          directory,
          config,
          database: yield* Database.Service,
          repo: yield* IMRepository,
          sync,
          lease,
          client,
          store,
          remote,
          native: native.value!,
          broadcasts,
          inspected,
          legacy,
          reopen: Effect.gen(function* () {
            yield* store.dispose(instance)
            return yield* acquire(yield* store.load({ directory: workspace }))
          }),
        }
        stage.value = name
        yield* body(state)
        expect(platform.observations.proofs).toBeGreaterThan(0)
        expect(platform.observations.challenges).toBeGreaterThan(0)
        expect(yield* state.database.db.get(sql`SELECT count(*) n FROM session_input`)).toEqual({ n: 0 })
        expect(yield* state.database.db.get(sql`SELECT count(*) n FROM session_provider_attempt`)).toEqual({ n: 0 })
        expect(yield* state.database.db.get(sql`SELECT count(*) n FROM im_mention_intent`)).toEqual({ n: 0 })
      }).pipe(Effect.provide(Layer.mergeAll(services, engine)))
    }).pipe(
      Effect.onError(() =>
        Effect.promise(async () => {
          const log = Log.file()
          if (
            log &&
            process.env.DEEPAGENT_CODE_TEST_HOME &&
            log.startsWith(process.env.DEEPAGENT_CODE_TEST_HOME + path.sep)
          )
            await Bun.write(path.join(directory, "private-runtime.log"), await Bun.file(log).text())
          console.error({
            case: name,
            stage: stage.value,
            root: directory,
            diagnostic,
            connections: remote.state.connections,
            queryTopics: remote.queries.slice(-8).map((query) => query.topic),
            sends: remote.sent.length,
          })
        }),
      ),
      Effect.scoped,
    ),
  )
}

export function cases(
  file: string,
  entries: readonly { id: string; name: string; run: (state: State) => Effect.Effect<void, unknown, Scope.Scope> }[],
) {
  const selected = process.env.DAC_CURRENT_SYNC_CASE
  if (selected) {
    const entry = entries.find((entry) => entry.id === selected)
    if (!entry) throw new Error("Unknown current sync case")
    test(entry.name, () => run(entry.id, entry.run), 30000)
    return
  }
  for (const entry of entries)
    test(
      entry.name,
      async () => {
        const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-current-sync-")))
        const { certificate } = await import("../../installation/fixture/event-investigation-installation")
        await certificate(path.join(directory, "tls"))
        const child = Bun.spawn(
          [
            process.execPath,
            "test",
            "--preload",
            path.resolve(import.meta.dir, "../../fixture/cli-secret-store.ts"),
            "--timeout",
            "30000",
            file,
          ],
          {
            cwd: path.resolve(import.meta.dir, "../../.."),
            env: {
              ...process.env,
              DAC_CURRENT_SYNC_CASE: entry.id,
              DAC_CURRENT_SYNC_ROOT: directory,
              NODE_EXTRA_CA_CERTS: path.join(directory, "tls", "ca.pem"),
              DEEPAGENT_IM_FACADE_URL: "",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const watchdog = setTimeout(() => child.kill("SIGKILL"), 29000)
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          if (code !== 0) {
            await Bun.write(path.join(directory, "failure.log"), `${stdout}\n${stderr}`)
            console.error({ scenario: entry.id, diagnosticRoot: directory, code, stdout, stderr })
          }
          expect(code).toBe(0)
          expect(stderr).toContain("1 pass")
          expect(stderr).toContain("0 fail")
          await fs.rm(directory, { recursive: true, force: true })
        } finally {
          clearTimeout(watchdog)
          if (child.exitCode === null) child.kill("SIGKILL")
          await child.exited
        }
      },
      30000,
    )
}
