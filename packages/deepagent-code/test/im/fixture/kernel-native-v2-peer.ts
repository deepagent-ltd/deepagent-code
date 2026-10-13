import type { ServerWebSocket } from "bun"
import { createHash } from "node:crypto"
import Proto from "../../../../im-kernel-sdk/upstream/src/socket/proto"
import { SIGNAL_CMD } from "../../../../im-kernel-sdk/upstream/src/enum"

const root = Proto as { lookup: (name: string) => { encode: (value: unknown) => { finish: () => Uint8Array }; decode: (value: Uint8Array) => Record<string, unknown> } }
type Peer = ServerWebSocket<{ key: Uint8Array | undefined; userID: string }>
type Message = { effectKey: string; messageId: string; sequence: string; deliveryCursor: string; messageTime: number; expiresAt: number; senderId: string; targetId: string; conversationType: 1 | 2; content: string; isSend: boolean; isRead: boolean; messageType: "jg:text" }
export type Options = {
  userID?: string
  token?: string
  conversationType?: 1 | 2
  targetID?: string
  queryDelayMs?: (topic: string, request: Readonly<Record<string, unknown>>) => number
  beforeQuery?: (topic: string, request: Readonly<Record<string, unknown>>) => void
  fetch?: (request: Request) => Response | Promise<Response> | undefined
  projectionKeys?: () => readonly string[]
  response?: (topic: string, request: Readonly<Record<string, unknown>>, original: { name: string; value: Record<string, unknown> }) => { name: string; value: Record<string, unknown> }
}

// This loopback peer implements only V2 protobuf reader queries. It does not
// negotiate receiver/live capability or manufacture SDK-owned opaque handles.
export function makeNativeV2Peer(options: Options = {}) {
  const userID = options.userID ?? "receiver"
  const token = options.token ?? "private-native-v2-peer-token"
  const conversationType = options.conversationType ?? 1
  const targetID = options.targetID ?? "sender"
  const scopeKey = createHash("sha256").update(`native-v2-peer:receiver:${userID}`).digest("hex")
  const projectionKey = createHash("sha256").update(`native-v2-peer:projection:${conversationType}:${targetID}`).digest("hex")
  const messages: Message[] = []
  const peers = new Set<Peer>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const current = { revision: 1, cursor: 1, readOrdinal: "0", connections: 0, disconnected: 0, stopping: false }
  const requests: { topic: string; requestVersion: number; requestRevision: string; serverRevision: string; ackCode: number; direction: string; after: string }[] = []
  const errors: ("unexpected_frame" | "unexpected_topic" | "invalid_connect" | "invalid_query" | "invalid_delay")[] = []
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" && !(value instanceof Uint8Array)
    ? Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== 0 && entry[1] !== false && entry[1] !== "" && entry[1] !== undefined).map((entry) => [entry[0], canonical(entry[1])])) : value
  const encode = (name: string, value: unknown) => root.lookup(`codec.${name}`).encode(canonical(value)).finish()
  const xor = (bytes: Uint8Array, key: Uint8Array) => Uint8Array.from(bytes, (value, index) => value ^ key[index % 8])
  const send = (peer: Peer, command: number, name: string, value: unknown) => {
    if (!peer.data.key || current.stopping) return
    peer.send(encode("ImWebsocketMsg", { version: 1, cmd: command, qos: 1, payload: xor(encode(name, value), peer.data.key) }))
  }
  const rejectFrame = (peer: Peer, code: typeof errors[number]) => { errors.push(code); peer.close(1002, "PRIVATE_NATIVE_V2_PEER_REJECTED") }
  const advanceRevision = () => { current.revision++; current.cursor++; return String(current.revision) }
  const server = Bun.serve<{ key: Uint8Array | undefined; userID: string }>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, owner) {
      const supplied = options.fetch?.(request)
      if (supplied) return supplied
      const pathname = new URL(request.url).pathname
      if (pathname === "/navigator/general") return Response.json({ code: 0, data: { user_id: userID, servers: [owner.url.origin] } })
      if (pathname === "/health") return Response.json({ code: 0 })
      if (pathname === "/im" && owner.upgrade(request, { data: { key: undefined, userID } })) return
      return new Response(null, { status: 404 })
    },
    websocket: {
      message(peer, payload) {
        if (typeof payload === "string") { rejectFrame(peer, "unexpected_frame"); return }
        const envelope = root.lookup("codec.ImWebsocketMsg").decode(new Uint8Array(payload))
        if (envelope.cmd === SIGNAL_CMD.PING) {
          peer.send(encode("ImWebsocketMsg", { version: 1, cmd: SIGNAL_CMD.PONG, qos: 1, payload: new Uint8Array() }))
          return
        }
        if (!(envelope.payload instanceof Uint8Array)) { rejectFrame(peer, "unexpected_frame"); return }
        if (envelope.cmd === SIGNAL_CMD.CONNECT) {
          const bytes = envelope.payload
          peer.data.key = Uint8Array.from([10, 8, 106, 117, 103, 57, 108, 101], (value, index) => value ^ bytes[index])
          const request = root.lookup("codec.ConnectMsgBody").decode(xor(bytes, peer.data.key))
          if (request.protoId !== "jug9le1m" || request.token !== token) { rejectFrame(peer, "invalid_connect"); return }
          peer.data.userID = userID
          peers.add(peer)
          current.connections++
          // No dacDeliveryLiveRead extension: no unsupported live producer is
          // advertised. config.protectedMedia selects the SDK's existing V2 mode.
          send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 0, userId: userID, timestamp: Date.now() })
          return
        }
        if (envelope.cmd === SIGNAL_CMD.DISCONNECT) { peer.close(1000, "PRIVATE_NATIVE_V2_PEER_CLOSED"); return }
        if (envelope.cmd !== SIGNAL_CMD.QUERY || !peer.data.key || !peers.has(peer)) { rejectFrame(peer, "unexpected_frame"); return }
        const query = root.lookup("codec.QueryMsgBody").decode(xor(envelope.payload, peer.data.key))
        if (typeof query.topic !== "string") { rejectFrame(peer, "invalid_query"); return }
        const topic = query.topic
        if (topic === "qry_user_info") {
          send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: query.index, code: 0, timestamp: Date.now(), data: encode("UserInfo", { userId: userID, nickname: userID }) })
          return
        }
        if (!(query.data instanceof Uint8Array)) { rejectFrame(peer, "invalid_query"); return }
        const request = root.lookup("codec.DeliveryReadQuery").decode(query.data)
        const selected = Object.freeze({ ...request })
        options.beforeQuery?.(topic, selected)
        const finish = () => {
          const revision = String(current.revision)
          const cursor = String(current.cursor)
          const now = Date.now()
          const records = messages.filter((message) => message.expiresAt > now)
          const latest = records.at(-1)
          const admitted = records.at(-1)?.sequence ?? "0"
          const unread = String(records.filter((message) => BigInt(message.sequence) > BigInt(current.readOrdinal) && !message.isSend).length)
          const recognized = ["qry_delivery_reader", "qry_delivery_changes", "qry_delivery_messages", "qry_delivery_read_cut"].includes(topic)
          const scopeMismatch = topic !== "qry_delivery_reader" && request.scopeKey !== scopeKey
          const projectionMismatch = ["qry_delivery_messages", "qry_delivery_read_cut"].includes(topic) && ![projectionKey, ...(options.projectionKeys?.() ?? [])].includes(String(request.projectionKey))
          const stale = ["qry_delivery_messages", "qry_delivery_read_cut"].includes(topic) && request.projectionRevision !== revision
          const code = !recognized ? 12202 : request.version !== 2 ? 12206 : scopeMismatch || projectionMismatch ? 11005 : stale ? 12203 : 0
          requests.push({ topic, requestVersion: Number(request.version), requestRevision: String(request.projectionRevision ?? ""), serverRevision: revision, ackCode: code, direction: String(request.direction ?? ""), after: String(request.after ?? "") })
          if (code) {
            if (!recognized) errors.push("unexpected_topic")
            send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: query.index, code, timestamp: now })
            return
          }
          const change = { projectionKey, revision, cursor, visibility: "visible", liveUnread: unread, storedUnread: unread, admittedOrdinal: admitted, readOrdinal: current.readOrdinal,
            nextExpiryAt: records.length ? Math.min(...records.map((message) => message.expiresAt)) : 0, latestMessageId: latest?.messageId ?? "", latestSequence: latest?.sequence ?? "", latestMessageTime: latest?.messageTime ?? 0, conversationType, targetId: targetID }
          const hasChanges = BigInt(String(request.after || "0")) < BigInt(cursor)
          const anchor = typeof request.anchorDeliveryCursor === "string" && request.anchorDeliveryCursor !== "" ? request.anchorDeliveryCursor : undefined
          const candidates = records.filter((message) => anchor === undefined || (request.direction === "older" ? BigInt(message.deliveryCursor) < BigInt(anchor) : BigInt(message.deliveryCursor) > BigInt(anchor)))
          const ordered = request.direction === "older" ? [...candidates].reverse() : candidates
          const page = ordered.slice(0, Number(request.limit || 32))
          const response = topic === "qry_delivery_reader"
            ? { name: "DeliveryReaderInfo", value: { version: 2, scopeKey, currentCursor: cursor, serverNow: now, maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 } }
            : topic === "qry_delivery_changes"
              ? { name: "DeliveryChangesResult", value: { version: 2, scopeKey, after: request.after || "0", upper: cursor, scanCursor: cursor, scanProjectionKey: hasChanges ? projectionKey : "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: hasChanges ? [change] : [] } }
              : topic === "qry_delivery_messages"
                ? { name: "DeliveryMessagesResult", value: { version: 2, scopeKey, projectionKey, projectionRevision: revision, direction: request.direction, nextDeliveryCursor: page.at(-1)?.deliveryCursor ?? "", finished: page.length === ordered.length, serverNow: now, items: page.map((message) => ({ ...message, isRead: message.isSend || BigInt(message.sequence) <= BigInt(current.readOrdinal) })) } }
                : { name: "DeliveryReadCutResult", value: { version: 2, scopeKey, projectionKey, projectionRevision: revision, throughOrdinal: admitted, targetAdmittedOrdinal: admitted, readOrdinal: current.readOrdinal, liveUnread: unread, storedUnread: unread, serverNow: now, complete: BigInt(current.readOrdinal) >= BigInt(admitted) } }
          const supplied = options.response?.(topic, selected, response) ?? response
          send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: query.index, code: 0, timestamp: now, data: encode(supplied.name, supplied.value) })
        }
        const delay = options.queryDelayMs?.(topic, selected) ?? 0
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > 15_000) { rejectFrame(peer, "invalid_delay"); return }
        if (!delay) { finish(); return }
        const timer = setTimeout(() => { timers.delete(timer); finish() }, delay)
        timers.add(timer)
      },
      close(peer) { peers.delete(peer); current.disconnected++ },
    },
  })
  return {
    server, scopeKey, projectionKey, requests, errors, topics: () => requests.map((request) => request.topic),
    // This uses the original SDK's protectedMedia reader-version selector only.
    // No media/send endpoint or live capability is implemented by this peer.
    config: { appkey: `private-native-v2-peer-${server.port}`, navigator: server.url.origin, token, userID, protectedMedia: true,
      identity: { uuid: userID, orgID: 1, name: userID, orgAllGroupID: "unused" } },
    get state() { return Object.freeze({ revision: String(current.revision), cursor: String(current.cursor), readOrdinal: current.readOrdinal, messages: messages.length, connections: current.connections, disconnected: current.disconnected }) },
    advanceRevision,
    addMessage(id: string, input: { content?: string; expiresAt?: number } = {}) {
      if (!id || messages.some((message) => message.messageId === id) || messages.length >= 32) throw new Error("PRIVATE_NATIVE_V2_MESSAGE_INPUT_REJECTED")
      const now = Date.now()
      const expiresAt = input.expiresAt ?? now + 600_000
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 86_400_000) throw new Error("PRIVATE_NATIVE_V2_MESSAGE_INPUT_REJECTED")
      const message: Message = { effectKey: createHash("sha256").update(`${scopeKey}:${projectionKey}:${id}`).digest("hex"), messageId: id,
        sequence: String(messages.length + 1), deliveryCursor: String(messages.length + 1), messageTime: now, expiresAt, senderId: targetID, targetId: targetID, conversationType,
        content: JSON.stringify({ content: input.content ?? `native V2 ${id}` }), isSend: false, isRead: false, messageType: "jg:text" }
      messages.push(message)
      advanceRevision()
      return Object.freeze({ ...message })
    },
    async stop() {
      current.stopping = true
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
      peers.forEach((peer) => peer.close(1000, "PRIVATE_NATIVE_V2_PEER_CLOSED"))
      await server.stop(false)
    },
  }
}
