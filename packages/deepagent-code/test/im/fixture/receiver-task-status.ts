export * as ReceiverTaskStatusFixture from "./receiver-task-status"

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import type { ServerWebSocket } from "bun"
import Proto from "../../../../im-kernel-sdk/upstream/src/socket/proto"
import { SIGNAL_CMD } from "../../../../im-kernel-sdk/upstream/src/enum"

export const original = "/private/tmp/dac-task-status-notice-native-RWmRB9"
export const dbPath = path.join(original, "cancel_notice/database.sqlite")
const protocol = Proto as { lookup: (name: string) => { encode: (value: unknown) => { finish: () => Uint8Array }; decode: (value: Uint8Array) => Record<string, unknown> } }
type Peer = ServerWebSocket<{ key: Uint8Array | undefined; userID: "sender" | "receiver" }>
type Wire = { effectKey: string; messageId: string; sequence: string; deliveryCursor: string; messageTime: number; expiresAt: number;
  senderId: string; targetId: string; conversationType: 1; content: string; isSend: boolean; isRead: boolean }

/** Observation only: this connection does not initialize or migrate the original B DB. */
export function census(filename: string) {
  const db = new Database(filename, { readonly: true })
  try {
    return Object.fromEntries(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => {
      const values = db.query(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()
        .map((value) => JSON.stringify(value)).sort()
      return [row.name, { count: values.length, sha256: createHash("sha256").update(JSON.stringify(values)).digest("hex") }]
    }))
  } finally { db.close() }
}

export function source() {
  const db = new Database(dbPath, { readonly: true })
  try {
    const result = db.query<{ metadata: string; content: string; message_time: number; expires_at: number }, []>(
      "SELECT r.metadata,m.content,r.message_time,r.expires_at FROM im_kernel_reader_message r JOIN im_messages m ON m.id=r.local_message_id WHERE r.message_id='actual-kernel-work-source'").get()
    const notice = db.query<{ binding: string; state: string; kernel_message_id: string; content: string }, []>(
      "SELECT d.binding,d.state,d.kernel_message_id,m.content FROM im_kernel_delivery d JOIN im_messages m ON m.id=d.message_id WHERE d.kernel_message_id='actual-kernel-work-result-2'").get()
    assert(result && notice)
    assert.equal(notice.state, "acknowledged")
    const binding: { createdAt: number; expiresAt: number } = JSON.parse(notice.binding)
    assert(binding.expiresAt > Date.now(), "The original delivery has expired; do not replace it")
    return { result, notice, binding }
  } finally { db.close() }
}

/** A controlled protocol producer. It re-exposes one immutable historical ACK;
 * every inbound observation/reader proof is minted by the original production SDK. */
export function peer(input: { aKey: string; bKey: string; history?: boolean }) {
  const captured = source()
  const originalNotice: Wire = { effectKey: createHash("sha256").update(captured.notice.kernel_message_id).digest("hex"), messageId: captured.notice.kernel_message_id,
    sequence: "2", deliveryCursor: "2", messageTime: captured.binding.createdAt, expiresAt: captured.binding.expiresAt,
    senderId: "receiver", targetId: "receiver", conversationType: 1, content: JSON.stringify({ content: captured.notice.content }), isSend: false, isRead: false }
  const actors = {
    sender: { token: "private-receiver-a-token", scope: "c".repeat(64), projection: "d".repeat(64), revision: input.history ? 2 : 1, read: 0,
      items: input.history ? [originalNotice] : [] as Wire[] },
    receiver: { token: "private-first-seen-token", scope: "a".repeat(64), projection: "b".repeat(64), revision: 2, read: 0,
      items: [{ effectKey: createHash("sha256").update("actual-kernel-work-source").digest("hex"), messageId: "actual-kernel-work-source",
        sequence: "1", deliveryCursor: "1", messageTime: captured.result.message_time, expiresAt: captured.result.expires_at,
        senderId: "sender", targetId: "sender", conversationType: 1, content: JSON.stringify({ content: captured.result.content }),
        isSend: false, isRead: false }] as Wire[] },
  }
  const peers: Peer[] = []
  const facts = { connections: [] as string[], queries: [] as { userID: string; topic: string }[], facade: [] as string[],
    publishAttempts: 0, acknowledgements: 0, livePublications: 0, markReads: 0 }
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" && !(value instanceof Uint8Array)
    ? Object.fromEntries(Object.entries(value).filter((entry) => ![0, false, "", undefined].includes(entry[1])).map((entry) => [entry[0], canonical(entry[1])])) : value
  const encode = (name: string, value: unknown) => protocol.lookup(`codec.${name}`).encode(canonical(value)).finish()
  const xor = (bytes: Uint8Array, key: Uint8Array) => Uint8Array.from(bytes, (value, index) => value ^ key[index % 8])
  const send = (peer: Peer, cmd: number, name: string, value: unknown) => {
    assert(peer.data.key)
    peer.send(encode("ImWebsocketMsg", { version: 1, cmd, qos: 1, payload: xor(encode(name, value), peer.data.key) }))
  }
  const server = Bun.serve<{ key: Uint8Array | undefined; userID: "sender" | "receiver" }>({ hostname: "127.0.0.1", port: 60338,
    async fetch(request, owner) {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith("/api/im/")) {
        const identity = request.headers.get("authorization") === `Bearer ${input.aKey}` ? "sender" :
          request.headers.get("authorization") === `Bearer ${input.bKey}` ? "receiver" : undefined
        facts.facade.push(pathname)
        if (!identity || request.method !== "POST") return Response.json({ success: false }, { status: 403 })
        if (pathname === "/api/im/exchange") return Response.json({ success: true, data: {
          kernel_token: actors[identity].token, credential_expires_at: Date.now() + 3_600_000,
          navigator_url: owner.url.origin, appkey: "private-native-kernel-work",
          identity: { uuid: identity, name: identity === "sender" ? "A sender" : "Receiver", org_id: 1, org_all_group_id: "unused" },
          ttl: { msg_life_time_ms: 86_400_000 },
        } })
        if (pathname === "/api/im/conversations/inspect") {
          const body: unknown = await request.json()
          assert(body && typeof body === "object" && "conversation_id" in body)
          const other = identity === "sender" ? "receiver" : "sender"
          if (body.conversation_id !== other) return Response.json({ success: false }, { status: 403 })
          return Response.json({ success: true, data: { conversation_type: 1, conversation_id: other, org_id: 1,
            name: identity === "sender" ? "Original B notice" : "Sender", member_uuids: ["receiver", "sender"] } })
        }
        return Response.json({ success: false }, { status: 404 })
      }
      if (pathname === "/navigator/general") {
        const identity = request.headers.get("x-token") === actors.sender.token ? "sender" : "receiver"
        return Response.json({ code: 0, data: { user_id: identity, servers: [owner.url.origin] } })
      }
      if (pathname === "/health") return Response.json({ code: 0 })
      if (pathname === "/im" && owner.upgrade(request, { data: { key: undefined, userID: "receiver" } })) return
      return new Response(null, { status: 404 })
    }, websocket: {
      message(peer, payload) {
        assert(typeof payload !== "string")
        const envelope = protocol.lookup("codec.ImWebsocketMsg").decode(new Uint8Array(payload))
        if (envelope.cmd === SIGNAL_CMD.PING) { peer.send(encode("ImWebsocketMsg", { version: 1, cmd: SIGNAL_CMD.PONG, qos: 1, payload: new Uint8Array() })); return }
        assert(envelope.payload instanceof Uint8Array)
        if (envelope.cmd === SIGNAL_CMD.CONNECT) {
          peer.data.key = Uint8Array.from([10, 8, 106, 117, 103, 57, 108, 101], (value, index) => value ^ (envelope.payload as Uint8Array)[index])
          const request = protocol.lookup("codec.ConnectMsgBody").decode(xor(envelope.payload, peer.data.key))
          assert.equal(request.protoId, "jug9le1m")
          assert(request.token === actors.sender.token || request.token === actors.receiver.token)
          peer.data.userID = request.token === actors.sender.token ? "sender" : "receiver"
          peers.push(peer); facts.connections.push(peer.data.userID)
          send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 0, userId: peer.data.userID, timestamp: Date.now() })
          return
        }
        if (envelope.cmd === SIGNAL_CMD.PUBLISH) { facts.publishAttempts++; peer.close(); return }
        if (envelope.cmd === SIGNAL_CMD.PUBLISH_ACK) { facts.acknowledgements++; return }
        if (envelope.cmd !== SIGNAL_CMD.QUERY) return
        assert(peer.data.key)
        const request = protocol.lookup("codec.QueryMsgBody").decode(xor(envelope.payload, peer.data.key))
        assert(typeof request.topic === "string")
        facts.queries.push({ userID: peer.data.userID, topic: request.topic })
        const query = request.topic.startsWith("qry_delivery_") && request.data instanceof Uint8Array ? protocol.lookup("codec.DeliveryReadQuery").decode(request.data) : {}
        const actor = actors[peer.data.userID]
        const target = peer.data.userID === "sender" ? "receiver" : "sender"
        const latest = actor.items.at(-1)
        const ordered = actor.items.filter((item) => query.direction === "older" ? !query.anchorDeliveryCursor || BigInt(item.deliveryCursor) < BigInt(String(query.anchorDeliveryCursor)) :
          BigInt(item.deliveryCursor) > BigInt(String(query.anchorDeliveryCursor || "0")))
          .sort((left, right) => query.direction === "older" ? Number(right.deliveryCursor) - Number(left.deliveryCursor) : Number(left.deliveryCursor) - Number(right.deliveryCursor))
          .slice(0, Number(query.limit || 32))
        const cut = { version: 1, scopeKey: actor.scope, projectionKey: actor.projection,
          projectionRevision: query.projectionRevision, throughOrdinal: String(actor.read), targetAdmittedOrdinal: String(actor.items.length),
          readOrdinal: String(actor.read), liveUnread: String(actor.items.length - actor.read), storedUnread: String(actor.items.length - actor.read),
          complete: actor.read >= actor.items.length, serverNow: Date.now() }
        const change = { visibility: "visible", projectionKey: actor.projection, revision: String(actor.revision), cursor: String(actor.revision),
          conversationType: 1, targetId: target, readOrdinal: String(actor.read), admittedOrdinal: String(actor.items.length),
          liveUnread: String(actor.items.length - actor.read), storedUnread: String(actor.items.length - actor.read), latestMessageId: latest?.messageId ?? "",
          latestSequence: latest?.sequence ?? "", latestMessageTime: latest?.messageTime ?? 0, nextExpiryAt: latest?.expiresAt ?? 0 }
        if (request.topic === "qry_delivery_mark_read") { actor.read = actor.items.length; facts.markReads++ }
        const result = request.topic === "qry_user_info" ? { name: "UserInfo", value: { userId: peer.data.userID, nickname: peer.data.userID } }
          : request.topic === "qry_delivery_capabilities" ? { name: "DeliveryCapabilities", value: { version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false } }
          : request.topic === "qry_delivery_reader" ? { name: "DeliveryReaderInfo", value: { version: 1, scopeKey: actor.scope, currentCursor: String(actor.revision), serverNow: Date.now(), maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 } }
          : request.topic === "qry_delivery_changes" ? { name: "DeliveryChangesResult", value: { version: 1, scopeKey: actor.scope, after: query.after || "0", upper: String(actor.revision), scanCursor: String(actor.revision), scanProjectionKey: Number(query.after || 0) < actor.revision && latest ? actor.projection : "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: Date.now(), items: Number(query.after || 0) < actor.revision && latest ? [change] : [] } }
          : request.topic === "qry_delivery_messages" ? { name: "DeliveryMessagesResult", value: { version: 1, scopeKey: actor.scope, projectionKey: actor.projection, projectionRevision: query.projectionRevision, direction: query.direction, nextDeliveryCursor: ordered.at(-1)?.deliveryCursor ?? "", finished: true, serverNow: Date.now(), items: ordered } }
          : request.topic === "qry_delivery_read_cut" || request.topic === "qry_delivery_mark_read" ? { name: "DeliveryReadCutResult", value: cut }
          : undefined
        assert(result, `Unexpected original SDK topic ${request.topic}`)
        send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: request.index, code: 0, timestamp: Date.now(), data: encode(result.name, result.value) })
      }, close() {},
    } })
  return { server, facts, publish() {
    assert.equal(actors.sender.items.length, 0, "Only the one original notice may be introduced")
    const message = originalNotice
    actors.sender.items.push(message); actors.sender.revision++
    const selected = peers.filter((peer) => peer.data.userID === "sender")
    assert.equal(selected.length, 1, "Exactly one original A SDK connection must own publication")
    send(selected[0], SIGNAL_CMD.PUBLISH, "PublishMsgBody", { topic: "msg", data: encode("DownMsg", {
      targetId: "receiver", type: 1, msgType: "jg:text", senderId: "receiver", msgId: message.messageId,
      msgIndex: Number(message.sequence), msgContent: new TextEncoder().encode(message.content), msgTime: message.messageTime,
    }) })
    facts.livePublications++
  }, async close() { peers.forEach((peer) => peer.close()); await server.stop(true) } }
}

/** Private authenticated transport only. Both WS upgrades remain real: no
 * frames, reader proofs or connection state are synthesized by this proxy. */
export function connectSocket(url: URL, options: Bun.WebSocketOptions) {
  // This fixture runs in Bun. The package's DOM declaration omits Bun's real
  // authenticated-header/TLS constructor overload, just as in the TUI client.
  const Socket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket
  return new Socket(url, options)
}

export function proxy(input: { origin: URL; directory: string; clientAuthorization: string; upstreamAuthorization: string;
  certificate: string; certificatePath: string; keyPath: string; https: boolean; allowRead: boolean;
  record: (request: { method: string; path: string; status: number; origin?: string | null }) => void }) {
  type Relay = { upstream: WebSocket; inbound?: ServerWebSocket<Relay>; pending: string[]; ended: Promise<void> }
  const relays = new Set<Relay>()
  const server = Bun.serve<Relay>({ hostname: "127.0.0.1", port: 0,
    ...(input.https ? { tls: { cert: Bun.file(input.certificatePath), key: Bun.file(input.keyPath) } } : {}),
    async fetch(request, owner) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,HEAD,OPTIONS,POST" } })
      if (request.headers.get("authorization") !== input.clientAuthorization)
        return new Response("private authenticated transport", { status: 401 })
      const url = new URL(request.url)
      const forwarded = new URL(url.pathname + url.search, input.origin)
      const headers = { authorization: input.upstreamAuthorization, "x-deepagent-code-directory": input.directory,
        ...(request.headers.get("origin") ? { origin: request.headers.get("origin")! } : {}) }
      if (request.method === "GET" && url.pathname.startsWith("/ws/im/group/") && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        forwarded.protocol = forwarded.protocol === "https:" ? "wss:" : "ws:"
        const upstream = connectSocket(forwarded, { headers, tls: { rejectUnauthorized: true, ca: input.certificate } })
        const opened = Promise.withResolvers<void>(), ended = Promise.withResolvers<void>()
        const relay: Relay = { upstream, pending: [], ended: ended.promise }
        relays.add(relay)
        const timeout = setTimeout(() => { upstream.close(); opened.reject(new Error("Private WS upstream did not upgrade")) }, 3_000)
        upstream.onopen = () => opened.resolve()
        upstream.onerror = () => opened.reject(new Error("Private WS upstream failed"))
        upstream.onclose = () => { opened.reject(new Error("Private WS upstream closed")); relay.inbound?.close(); relays.delete(relay); ended.resolve() }
        upstream.onmessage = (event) => {
          if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 65_536) { upstream.close(1009); return }
          if (relay.inbound) { relay.inbound.send(event.data); return }
          if (relay.pending.length >= 16) { upstream.close(1009); return }
          relay.pending.push(event.data)
        }
        const accepted = await opened.promise.then(() => true, () => false).finally(() => clearTimeout(timeout))
        const status = accepted && owner.upgrade(request, { data: relay }) ? 101 : 502
        input.record({ method: "GET", path: url.pathname, status, origin: request.headers.get("origin") })
        if (status === 101) return
        upstream.close()
        return new Response("Private WS upstream unavailable", { status })
      }
      const allowed = ["GET", "HEAD"].includes(request.method) || request.method === "POST" &&
        (url.pathname === "/api/v1/im/tasks/remote-status" || input.allowRead && url.pathname.endsWith("/read"))
      if (!allowed) {
        input.record({ method: request.method, path: url.pathname, status: 405 })
        return new Response("readonly receiver fixture", { status: 405 })
      }
      const response = await fetch(forwarded, { method: request.method,
        headers: { ...Object.fromEntries(request.headers), ...headers, host: input.origin.host, connection: "close" },
        body: request.method === "POST" ? await request.text() : undefined,
        ...(forwarded.protocol === "https:" ? { tls: { rejectUnauthorized: true, ca: input.certificate } } : {}),
        signal: AbortSignal.timeout(12_000) })
      input.record({ method: request.method, path: url.pathname, status: response.status, origin: request.headers.get("origin") })
      const closedHeaders = new Headers(response.headers)
      closedHeaders.delete("content-encoding"); closedHeaders.delete("content-length")
      closedHeaders.set("access-control-allow-origin", "*")
      return new Response(await response.arrayBuffer(), { status: response.status, headers: closedHeaders })
    }, websocket: {
      open(socket) { socket.data.inbound = socket; socket.data.pending.splice(0).forEach((frame) => socket.send(frame)) },
      message(socket, message) {
        if (typeof message !== "string" || Buffer.byteLength(message) > 65_536) { socket.close(1009); return }
        if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(message)
      },
      close(socket) { socket.data.upstream.close() },
    } })
  return { server, async close() {
    const pending = [...relays]
    pending.forEach((relay) => { relay.inbound?.close(); relay.upstream.close() })
    await server.stop(true)
    await Promise.all(pending.map(async (relay) => {
      const timeout = setTimeout(() => {
        if ("terminate" in relay.upstream && typeof relay.upstream.terminate === "function") relay.upstream.terminate()
      }, 1_000)
      await relay.ended.finally(() => clearTimeout(timeout))
    }))
  } }
}

if (["a", "b"].includes(process.env.DAC_RECEIVER_TASK_ROLE ?? "")) {
  const { Effect, Exit, Cause } = await import("effect")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Server } = await import("@/server/server")
  const { LocalTaskAuthority } = await import("@/im/local-task-authority")
  const output = process.env.DAC_RECEIVER_TASK_READY
  assert(output)
  const stopped = Promise.withResolvers<void>()
  process.on("SIGTERM", () => stopped.resolve())
  process.on("SIGINT", () => stopped.resolve())
  const exit = await AppRuntime.runPromiseExit(Effect.gen(function* () {
    const installation = yield* (process.env.DAC_RECEIVER_TASK_ROLE === "b" ? LocalTaskAuthority.readInstallation : LocalTaskAuthority.initializeInstallation())
    const tls = process.env.DAC_RECEIVER_TASK_ROLE === "b" || process.env.DAC_RECEIVER_TASK_HTTPS === "1" ? {
      cert: yield* Effect.promise(() => fs.readFile(process.env.DAC_NOTICE_CA!, "utf8")),
      key: yield* Effect.promise(() => fs.readFile(process.env.DAC_NOTICE_KEY!, "utf8")),
    } : undefined
    const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: Number(process.env.DAC_RECEIVER_TASK_PORT ?? 0), tls,
      cors: process.env.DAC_RECEIVER_TASK_CORS ? [process.env.DAC_RECEIVER_TASK_CORS] : undefined })),
      (listener) => Effect.promise(() => listener.stop(true)))
    yield* Effect.promise(() => fs.writeFile(output, JSON.stringify({ url: listener.url.href, instanceID: installation.instanceID }), { mode: 0o600 }))
    yield* Effect.promise(() => stopped.promise)
  }).pipe(Effect.scoped))
  await AppRuntime.dispose()
  if (Exit.isFailure(exit)) { process.stderr.write(Cause.pretty(exit.cause)); process.exitCode = 1 }
}
