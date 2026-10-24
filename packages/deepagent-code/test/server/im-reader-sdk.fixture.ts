export * as IMReaderSDKFixture from "./im-reader-sdk.fixture"

import { Effect, Layer, Stream } from "effect"
import { createHash } from "node:crypto"
import type { DeliveryConversationChange, DeliveryProjectionRequest, DeliveryReadMessage } from "@deepagent-code/im-kernel-sdk"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository } from "@deepagent-code/core/im/repository"
import type { IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { IMFacade } from "@/im/facade"
import { IMKernelSync } from "@/im/kernel/sync"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import type { InstanceContext } from "@/project/instance-context"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
interface Conversation { projectionKey: string; type: 1 | 2; target: string; name: string; revision: number; cursor: number; read: number; allowed: boolean; messages: DeliveryReadMessage[] }
export const make = (options?: { version?: 1 | 2; userID?: string }) => {
  const version = options?.version ?? 1
  const userID = options?.userID ?? "uuid-alice"
  const scopeKey = hash("controlled-sdk:appkey_1:org7:uuid-alice")
  const conversations = new Map<string, Conversation>()
  const readCutRefusal = { remaining: 0 }
  const observed = { database: undefined as Database.Interface | undefined, repository: undefined as IMRepositoryInterface | undefined, broadcaster: undefined as IMBroadcaster | undefined, engine: undefined as IMKernelSync.Interface | undefined, cursor: 0, factories: 0, active: 0, maximum: 0, marks: 0, sends: 0, platformMutations: 0, calls: [] as string[], errors: [] as string[], context: new Map<string, InstanceContext>(), lease: new Map<string, IMFacade.ReaderLease>(), sent: [] as { wireID: string; messageID: string; target: string; text: string; expiresAt: number }[] }
  const stalled: { key?: string; started: () => void; release: () => void; pending?: Promise<void> } = { started: () => {}, release: () => {} }
  const stalledMark: { key?: string; started: () => void; release: () => void; pending?: Promise<void> } = { started: () => {}, release: () => {} }
  const connection: { next?: { subscribed: () => void; state: Promise<number> } } = {}
  const conversation = (type: 1 | 2, target: string, name = target) => {
    const key = hash(`${type}:${target}`)
    const existing = conversations.get(key)
    if (existing) return existing
    const created: Conversation = { projectionKey: key, type, target, name, revision: 0, cursor: 0, read: 0, allowed: true, messages: [] }
    conversations.set(key, created)
    return created
  }
  const changed = (item: Conversation) => { item.revision++; item.cursor = ++observed.cursor }
  const publish = (type: 1 | 2, target: string, text: string, outgoing?: { messageID: string; expiresAt: number }) => {
    const item = conversation(type, target)
    const now = Date.now()
    const cursor = String(item.messages.length + 1)
    const messageID = outgoing?.messageID ?? `sdk-incoming-${item.projectionKey.slice(0, 12)}-${cursor}`
    item.messages.push({ effectKey: hash(`${scopeKey}:${item.projectionKey}:${messageID}`), messageId: messageID, sequence: cursor, deliveryCursor: cursor, messageTime: now, expiresAt: outgoing?.expiresAt ?? now + 600000, senderId: outgoing ? userID : target, targetId: target, conversationType: type, content: JSON.stringify({ content: text }), isSend: Boolean(outgoing), isRead: Boolean(outgoing) })
    changed(item)
    return item
  }
  const requireProjection = (request: DeliveryProjectionRequest) => {
    const item = conversations.get(request.projectionKey)
    if (request.scopeKey !== scopeKey || !item?.allowed) throw { kind: "denied", wireCode: 1002 }
    if (request.projectionRevision !== String(item.revision)) throw { kind: "stale", wireCode: 1002 }
    return item
  }
  const cut = (request: DeliveryProjectionRequest) => {
    const item = requireProjection(request)
    return { ...request, throughOrdinal: String(item.messages.length), targetAdmittedOrdinal: String(item.messages.length), readOrdinal: String(item.read), liveUnread: String(item.messages.filter((message) => !message.isSend && Number(message.sequence) > item.read).length), storedUnread: String(item.messages.filter((message) => !message.isSend && Number(message.sequence) > item.read).length), serverNow: Date.now(), complete: version === 1 || item.read >= item.messages.length }
  }
  const native = <A>(operation: string, run: () => PromiseLike<A>) => Effect.suspend(() => {
    observed.active++
    observed.calls.push(operation)
    observed.maximum = Math.max(observed.maximum, observed.active)
    return KernelSdk.request(operation, run).pipe(Effect.ensuring(Effect.sync(() => { observed.active-- })))
  })
  const sdk = KernelSdk.Service.of({
    rawEvents: Stream.succeed({ tag: "state_changed", state: 0 }),
    disconnect: Effect.void,
    fetchHistory: () => Effect.fail(new KernelSdk.KernelError({ operation: "fetchHistory", message: "Retired reader API was called" })),
    fetchConversations: () => Effect.fail(new KernelSdk.KernelError({ operation: "fetchConversations", message: "Retired reader API was called" })),
    getDeliveryReader: () => native("getDeliveryReader", () => Promise.resolve({ version, ...(version === 2 ? { outputProofAvailable: true } : {}), scopeKey, currentCursor: String(observed.cursor), serverNow: Date.now(), maxPageItems: 32 as const, maxChangeBytes: 65536 as const, maxMessageBytes: 4194304 as const, maxWindowPages: 100000 as const })),
    getDeliveryChanges: (input) => native("getDeliveryChanges", () => {
      if (input.scopeKey !== scopeKey) return Promise.reject({ kind: "denied" })
      const items: DeliveryConversationChange[] = Array.from(conversations.values()).filter((item) => item.revision > 0 && item.cursor > Number(input.after)).sort((a, b) => a.cursor - b.cursor).map((item) => {
        const identity = { projectionKey: item.projectionKey, revision: String(item.revision), cursor: String(item.cursor) }
        if (!item.allowed) return { ...identity, visibility: "revoked" }
        const latest = item.messages.at(-1)
        return { ...identity, visibility: "visible", conversationType: item.type, targetId: item.target, admittedOrdinal: String(item.messages.length), readOrdinal: String(item.read), liveUnread: String(item.messages.filter((message) => !message.isSend && Number(message.sequence) > item.read).length), storedUnread: String(item.messages.filter((message) => !message.isSend && Number(message.sequence) > item.read).length), nextExpiryAt: Math.min(...item.messages.map((message) => message.expiresAt)), latestMessageId: latest?.messageId ?? "", latestSequence: latest?.sequence ?? "", latestMessageTime: latest?.messageTime ?? 0 }
      })
      return Promise.resolve({ version, scopeKey, after: input.after, upper: String(observed.cursor), scanCursor: String(observed.cursor), scanProjectionKey: items.at(-1)?.projectionKey ?? "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: Date.now(), items })
    }),
    getDeliveryMessages: (input) => native("getDeliveryMessages", () => {
      const item = requireProjection(input)
      const anchor = input.anchorDeliveryCursor === undefined ? input.direction === "older" ? Infinity : 0 : Number(input.anchorDeliveryCursor)
      const items = item.messages.filter((message) => input.direction === "newer" ? Number(message.deliveryCursor) > anchor : Number(message.deliveryCursor) < anchor).sort((a, b) => input.direction === "newer" ? Number(a.deliveryCursor) - Number(b.deliveryCursor) : Number(b.deliveryCursor) - Number(a.deliveryCursor)).slice(0, input.limit).map((message) => ({ ...message, ...(version === 2 ? { messageType: "jg:text" as const } : {}), isRead: message.isSend || Number(message.sequence) <= item.read }))
      return Promise.resolve({ version, scopeKey, projectionKey: input.projectionKey, projectionRevision: input.projectionRevision, direction: input.direction, nextDeliveryCursor: items.at(-1)?.deliveryCursor ?? input.anchorDeliveryCursor ?? "0", finished: true, serverNow: Date.now(), items })
    }),
    getDeliveryOutputProof: (input) => native("getDeliveryOutputProof", () => {
      if (version !== 2 || input.scopeKey !== scopeKey) return Promise.reject({ kind: "denied" })
      const serverNow = Date.now()
      return Promise.resolve({ version: 2 as const, scopeKey, serverNow, rows: input.rows.map((row) => {
        if (row.kind === "pending") {
          if (!conversation(row.conversationType, row.conversationID).allowed) throw { kind: "denied", wireCode: 1002 }
          return row
        }
        return { kind: "visible" as const, cut: { ...cut({ ...row, version: 2, scopeKey }), serverNow } }
      }) })
    }),
    getDeliveryReadCut: (input) => native("getDeliveryReadCut", () => {
      if (readCutRefusal.remaining > 0) {
        readCutRefusal.remaining--
        return Promise.reject({ kind: "stale", wireCode: 12203 })
      }
      const result = cut(input)
      if (stalled.key !== input.projectionKey || !stalled.pending) return Promise.resolve(result)
      stalled.key = undefined
      stalled.started()
      return stalled.pending.then(() => result)
    }),
    markDeliveryRead: (input) => native("markDeliveryRead", () => {
      const item = requireProjection(input)
      observed.marks++
      item.read = Math.max(item.read, Number(input.throughOrdinal))
      changed(item)
      const result = cut({ ...input, projectionRevision: String(item.revision) })
      if (stalledMark.key !== input.projectionKey || !stalledMark.pending) return Promise.resolve(result)
      stalledMark.key = undefined
      stalledMark.started()
      return stalledMark.pending.then(() => result)
    }),
    sendMessage: (input) => native("sendMessage", () => {
      const type = input.conversationType === 1 ? 1 : 2
      const item = conversation(type, input.conversationID)
      if (!item.allowed) return Promise.reject({ kind: "denied" })
      observed.sends++
      const messageID = `sdk-ack-${input.wireID}`
      observed.sent.push({ wireID: input.wireID, messageID, target: input.conversationID, text: input.text, expiresAt: input.expiresAt })
      publish(type, input.conversationID, input.text, { messageID, expiresAt: input.expiresAt })
      return Promise.resolve({ messageID })
    }),
  })
  const buildEngine: IMFacade.EngineBuilder = (config, options) => {
    const delayed = connection.next
    connection.next = undefined
    return Layer.effect(IMKernelSync.Service, Effect.gen(function* () {
      if (config.appkey !== "appkey_1" || config.identity?.orgID !== 7 || config.userID !== userID) return yield* Effect.die("Controlled SDK credential generation mismatch")
      observed.factories++
      observed.database = yield* Database.Service
      observed.repository = yield* IMRepository
      observed.broadcaster = yield* IMBroadcasterService
      const engine = yield* IMKernelSync.Service
      const captured = IMKernelSync.Service.of({ ...engine, acquireReader: (context) => {
        observed.context.set(context.instance.directory, context.instance)
        return engine.acquireReader!(context).pipe(Effect.tap((lease) => Effect.sync(() => observed.lease.set(context.instance.directory, lease))), Effect.tapError((error) => Effect.sync(() => observed.errors.push(`${error.code}:${error.operation}`))))
      } })
      observed.engine = captured
      return captured
    })).pipe(Layer.provide(IMKernelSync.layer(config, options).pipe(
      Layer.provide(KernelClient.layer.pipe(Layer.provide(Layer.succeed(KernelSdk.Service, delayed ? {
        ...sdk,
        rawEvents: Stream.fromEffect(Effect.promise(() => { delayed.subscribed(); return delayed.state }).pipe(Effect.map((state) => ({ tag: "state_changed" as const, state })))),
      } : sdk)))),
    )))
  }
  return { observed, buildEngine, publish, conversation, cut, scopeKey, refuseReadCuts: (count: number) => { readCutRefusal.remaining = count }, delayConnection: () => {
    const control = { subscribed: () => {}, release: (_state: number) => {} }
    const subscribed = new Promise<void>((resolve) => { control.subscribed = resolve })
    const state = new Promise<number>((resolve) => { control.release = resolve })
    connection.next = { subscribed: control.subscribed, state }
    return { subscribed, release: control.release }
  }, revoke: (type: 1 | 2, target: string) => { const item = conversation(type, target); item.allowed = false; changed(item) }, stall: (projectionKey: string) => {
    stalled.key = projectionKey
    const started = new Promise<void>((resolve) => { stalled.started = resolve })
    stalled.pending = new Promise<void>((resolve) => { stalled.release = resolve })
    return { started, release: () => { stalled.release(); stalled.pending = undefined } }
  }, stallMark: (projectionKey: string) => {
    stalledMark.key = projectionKey
    const started = new Promise<void>((resolve) => { stalledMark.started = resolve })
    stalledMark.pending = new Promise<void>((resolve) => { stalledMark.release = resolve })
    return { started, release: () => { stalledMark.release(); stalledMark.pending = undefined } }
  } }
}
export type Interface = ReturnType<typeof make>
