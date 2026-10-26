export * as KernelLiveFirstSeenFixture from "./kernel-live-first-seen"

import type { ServerWebSocket, TLSOptions } from "bun"
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto"
import assert from "node:assert/strict"
import { Schema } from "effect"
import { IMDeviceProof } from "../../../src/im/device-proof"
import Proto from "../../../../im-kernel-sdk/upstream/src/socket/proto"
import { SIGNAL_CMD } from "../../../../im-kernel-sdk/upstream/src/enum"

const root = Proto as { lookup: (name: string) => { encode: (value: unknown) => { finish: () => Uint8Array }; decode: (value: Uint8Array) => Record<string, unknown> } }
type Peer = ServerWebSocket<{ key: Uint8Array | undefined; userID: string; challenge?: IMDeviceProof.SocketChallenge }>
export function make(options: { outboundPublish?: (request: Record<string, unknown>, message: Record<string, unknown>) => Record<string, unknown>;
  tls?: TLSOptions;
  device?: { publicJwk: IMDeviceProof.PublicJwk; appkey: string; token: string };
  receiverBaseline?: (topic: string, request: Record<string, unknown>, receiverID: string) => Record<string, unknown>;
  afterOutboundPublish?: (close: () => void) => "drop_ack" | undefined;
  secondIdentity?: { token: string; userID: string };
  fetch?: (request: Request) => Response | Promise<Response> | undefined;
  queryDelayMs?: (topic: string) => number;
  response?: (topic: string, request: Record<string, unknown>, original: { name: string; value: Record<string, unknown> } | undefined, userID: string) => { name: string; value: Record<string, unknown> } | undefined } = {}) {
  const peers: Peer[] = []
  const topics: string[] = []
  const messages: { effectKey: string; messageId: string; sequence: string; deliveryCursor: string; messageTime: number; expiresAt: number; senderId: string; targetId: string; conversationType: 1; content: string; isSend: boolean; isRead: boolean }[] = []
  const scopeKey = "a".repeat(64)
  const projectionKey = "b".repeat(64)
  const state = { revision: 1, disconnected: 0, slow: false }
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" && !(value instanceof Uint8Array) ? Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== 0 && entry[1] !== false && entry[1] !== "" && entry[1] !== undefined).map((entry) => [entry[0], canonical(entry[1])])) : value
  const encode = (name: string, value: unknown) => root.lookup(`codec.${name}`).encode(canonical(value)).finish()
  const xor = (bytes: Uint8Array, key: Uint8Array) => Uint8Array.from(bytes, (value, index) => value ^ key[index % 8])
  const send = (peer: Peer, cmd: number, name: string, value: unknown) => peer.send(encode("ImWebsocketMsg", { version: 1, cmd, qos: 1, payload: xor(encode(name, value), peer.data.key!) }))
  const server = Bun.serve<{ key: Uint8Array | undefined; userID: string; challenge?: IMDeviceProof.SocketChallenge }>({ hostname: "127.0.0.1", port: 0, tls: options.tls,
    fetch(request, owner) {
      const supplied = options.fetch?.(request)
      if (supplied) return supplied
      const pathname = new URL(request.url).pathname
      if (pathname === "/navigator/general") return Response.json({ code: 0, data: { user_id: request.headers.get("x-token") === options.secondIdentity?.token ? options.secondIdentity.userID : "receiver", servers: [owner.url.origin] } }, { headers: { "cache-control": "no-store" } })
      if (pathname === "/health") return Response.json({ code: 0 })
      if (pathname === "/im" && owner.upgrade(request, { data: { key: undefined, userID: "receiver" } })) return
      return new Response(null, { status: 404 })
    }, websocket: {
      message(peer, payload) {
        if (typeof payload === "string") throw new Error("Expected actual protobuf WS bytes")
        const envelope = root.lookup("codec.ImWebsocketMsg").decode(new Uint8Array(payload))
        if (envelope.cmd === SIGNAL_CMD.PING) {
          peer.send(encode("ImWebsocketMsg", { version: 1, cmd: SIGNAL_CMD.PONG, qos: 1, payload: new Uint8Array() }))
          return
        }
        if (!(envelope.payload instanceof Uint8Array)) throw new Error("Missing protobuf payload")
        if (envelope.cmd === SIGNAL_CMD.CONNECT) {
          const payloadBytes = envelope.payload
          const known = [10, 8, 106, 117, 103, 57, 108, 101]
          peer.data.key = Uint8Array.from(known, (value, index) => value ^ payloadBytes[index])
          const request = root.lookup("codec.ConnectMsgBody").decode(xor(envelope.payload, peer.data.key))
          if (request.protoId !== "jug9le1m" || (request.token !== (options.device?.token ?? "private-first-seen-token") && request.token !== options.secondIdentity?.token)) throw new Error("Unexpected original SDK CONNECT")
          if (options.device) {
            const ext = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ profile: Schema.Literal(IMDeviceProof.socketProfile), proof: Schema.optional(Schema.String) })))(request.ext)
            if (!ext.proof) {
              assert(!peer.data.challenge, "Original device challenge is single use")
              const challenge = { profile: IMDeviceProof.socketProfile, nonce: randomBytes(32).toString("base64url"), socketSession: randomBytes(24).toString("hex"),
                audience: server.url.origin.replace(/^https:/, "wss:") + "/im", appkey: options.device.appkey,
                credentialDigest: createHash("sha256").update(String(request.token)).digest("hex"), expiresAt: Date.now() + 10000 } satisfies IMDeviceProof.SocketChallenge
              peer.data.challenge = challenge
              send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 11024, ext: JSON.stringify(challenge), timestamp: Date.now() })
              return
            }
            const challenge = peer.data.challenge
            assert(challenge && challenge.expiresAt > Date.now(), "The original live challenge must exist")
            const parts = ext.proof.split(".")
            assert.equal(parts.length, 3)
            const header = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ typ: Schema.Literal("dac-im-connect-proof+jwt"), alg: Schema.Literal("ES256"), jwk: Schema.Unknown })))(Buffer.from(parts[0]!, "base64url").toString())
            assert.deepEqual(IMDeviceProof.publicJwk(header.jwk), options.device.publicJwk)
            assert(verify("sha256", Buffer.from(parts[0] + "." + parts[1]), { key: createPublicKey({ format: "jwk", key: options.device.publicJwk }), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url")))
            const claims = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ v: Schema.Literal(1), purpose: Schema.Literal("im-connect"), aud: Schema.String,
              appkey: Schema.String, nonce: Schema.String, sid: Schema.String, ath: Schema.String, entitlementID: Schema.String, bindingVersion: Schema.Literal(1), iat: Schema.Number, exp: Schema.Number, jti: Schema.String })))(Buffer.from(parts[1]!, "base64url").toString())
            assert.equal(claims.aud, challenge.audience); assert.equal(claims.appkey, challenge.appkey); assert.equal(claims.nonce, challenge.nonce); assert.equal(claims.sid, challenge.socketSession)
            assert.equal(claims.ath, IMDeviceProof.credentialHash(String(request.token))); assert.equal(claims.entitlementID, "e".repeat(32)); assert(claims.exp > Date.now() / 1000 && claims.exp - claims.iat <= 10)
            delete peer.data.challenge
          }
          peer.data.userID = options.secondIdentity && request.token === options.secondIdentity.token ? options.secondIdentity.userID : "receiver"
          peers.push(peer)
          send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 0, userId: peer.data.userID, timestamp: Date.now(),
            ...(options.receiverBaseline ? { ext: '{"dacDeliveryLiveRead":2}' } : {}) })
          return
        }
        if (envelope.cmd === SIGNAL_CMD.PUBLISH && options.outboundPublish) {
          const request = root.lookup("codec.PublishMsgBody").decode(xor(envelope.payload, peer.data.key!))
          if (!(request.data instanceof Uint8Array)) throw new Error("Missing original outbound protobuf bytes")
          const message = root.lookup("codec.UpMsg").decode(request.data)
          const acknowledgement = options.outboundPublish(request, message)
          if (options.afterOutboundPublish?.(() => peer.close()) === "drop_ack") return
          send(peer, SIGNAL_CMD.PUBLISH_ACK, "PublishAckMsgBody", { index: request.index, ...acknowledgement })
          return
        }
        if (envelope.cmd !== SIGNAL_CMD.QUERY) return
        const request = root.lookup("codec.QueryMsgBody").decode(xor(envelope.payload, peer.data.key!))
        if (typeof request.topic !== "string") throw new Error("Missing native query topic")
        topics.push(request.topic)
        if (options.receiverBaseline && request.topic.startsWith("qry_delivery_live_")) {
          if (!(request.data instanceof Uint8Array)) throw new Error("Missing original private query bytes")
          const input = JSON.parse(new TextDecoder().decode(request.data)) as Record<string, unknown>
          const response = options.receiverBaseline(request.topic, input, peer.data.userID)
          send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: request.index, code: 0, timestamp: Date.now(),
            data: new TextEncoder().encode(JSON.stringify(response)) })
          return
        }
        const native = request.topic.startsWith("qry_delivery_") && request.data instanceof Uint8Array ? root.lookup(request.topic === "qry_delivery_receipt" ? "codec.DeliveryReceiptQuery" : "codec.DeliveryReadQuery").decode(request.data) : {}
        const latest = messages.at(-1)
        const revision = String(state.revision)
        const change = { visibility: "visible", projectionKey, revision, cursor: revision, conversationType: 1, targetId: "sender", readOrdinal: "0", admittedOrdinal: String(messages.length), liveUnread: String(messages.length), storedUnread: String(messages.length), latestMessageId: latest?.messageId ?? "", latestSequence: latest?.sequence ?? "", latestMessageTime: latest?.messageTime ?? 0, nextExpiryAt: latest?.expiresAt ?? 0 }
        const selected = messages.filter((item) => native.direction === "older" ? native.anchorDeliveryCursor === undefined || native.anchorDeliveryCursor === "" || BigInt(item.deliveryCursor) < BigInt(String(native.anchorDeliveryCursor)) : BigInt(item.deliveryCursor) > BigInt(String(native.anchorDeliveryCursor || "0")))
        const ordered = (native.direction === "older" ? [...selected].reverse() : selected).slice(0, Number(native.limit || 32))
        const original = request.topic === "qry_user_info" ? { name: "UserInfo", value: { userId: peer.data.userID, nickname: peer.data.userID === "receiver" ? "Receiver" : peer.data.userID } }
          : request.topic === "qry_delivery_reader" ? { name: "DeliveryReaderInfo", value: { version: options.receiverBaseline ? 2 : 1, scopeKey, currentCursor: revision, serverNow: Date.now(), maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 } }
          : request.topic === "qry_delivery_changes" ? { name: "DeliveryChangesResult", value: { version: options.receiverBaseline ? 2 : 1, scopeKey, after: native.after || "0", upper: revision, scanCursor: revision, scanProjectionKey: Number(native.after || 0) < state.revision ? projectionKey : "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: Date.now(), items: Number(native.after || 0) < state.revision && (!options.receiverBaseline || messages.length) ? [change] : [] } }
          : request.topic === "qry_delivery_messages" ? { name: "DeliveryMessagesResult", value: { version: options.receiverBaseline ? 2 : 1, scopeKey, projectionKey, projectionRevision: native.projectionRevision, direction: native.direction, nextDeliveryCursor: ordered.at(-1)?.deliveryCursor ?? "", finished: true, serverNow: Date.now(), items: options.receiverBaseline ? ordered.map((item) => ({ ...item, messageType: "jg:text" })) : ordered } }
          : undefined
        const response = options.response ? options.response(request.topic, native, original, peer.data.userID) : original
        if (!response) throw new Error(`Unexpected native protocol request ${request.topic}`)
        const finish = () => send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: request.index, code: 0, timestamp: Date.now(), data: encode(response.name, response.value) })
        const delay = options.queryDelayMs?.(request.topic) ?? 0
        if (delay > 0) { setTimeout(finish, delay); return }
        if (state.slow && request.topic === "qry_delivery_messages") { state.slow = false; setTimeout(finish, 1100); return }
        finish()
      }, close() { state.disconnected++ },
    } })
  return { server, topics, messages, state, disconnect() { peers.forEach((peer) => peer.close()) }, add(id: string, options: { publish?: boolean; mismatch?: boolean; hasReference?: boolean } = {}) {
    const message = { effectKey: createHash("sha256").update(id).digest("hex"), messageId: id, sequence: String(messages.length + 1), deliveryCursor: String(messages.length + 1), messageTime: Date.now(), expiresAt: Date.now() + 86_400_000, senderId: "sender", targetId: "sender", conversationType: 1 as const, content: JSON.stringify({ content: `native ${id} 中文` }), isSend: false, isRead: false }
    messages.push(message)
    state.revision++
    if (options.publish !== false) this.publish(message, options)
    return message
  }, publish(message: typeof messages[number], options: { mismatch?: boolean; hasReference?: boolean } = {}) {
    peers.at(-1)?.send(encode("ImWebsocketMsg", { version: 1, cmd: SIGNAL_CMD.PUBLISH, qos: 1, payload: xor(encode("PublishMsgBody", { topic: "msg", data: encode("DownMsg", { targetId: message.targetId, type: message.conversationType, msgType: "jg:text", senderId: message.senderId, msgId: message.messageId, msgIndex: Number(message.sequence), msgContent: new TextEncoder().encode(options.mismatch ? '{"content":"WS differs from native"}' : message.content), msgTime: message.messageTime, ...(options.hasReference ? { referMsg: { msgId: "original" } } : {}) }) }), peers.at(-1)!.data.key!) }))
  } }
}
