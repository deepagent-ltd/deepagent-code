import { createHash } from "node:crypto"
import { makeNativeV2Peer } from "./kernel-native-v2-peer"

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
type Conversation = {
  key: string
  type: 1 | 2
  target: string
  name: string
  cursor: string
  revoked: boolean
  messages: Message[]
}

/** Original SDK protobuf transport, with current projection/page facts controlled
 * by this loopback peer. It neither emits a live capability nor creates a Host witness. */
export function discoveryPeer() {
  const conversations = new Map<string, Conversation>()
  const faults = { nonprogressing: false, malformedAfter: undefined as string | undefined, changedSender: false }
  const pages: { key: string; direction: string; anchor: string; count: number }[] = []
  const changes: string[] = []
  const native = makeNativeV2Peer({
    projectionKeys: () => Array.from(conversations.keys()),
    response(topic, request, original) {
      const revision = native.state.revision
      const upper = native.state.cursor
      if (topic === "qry_delivery_reader") return { ...original, value: { ...original.value, currentCursor: upper } }
      if (topic === "qry_delivery_changes") {
        changes.push(String(request.pageToken ?? ""))
        const remaining = Array.from(conversations.values())
          .filter((item) => BigInt(item.cursor) > BigInt(String(request.after || "0")))
          .sort((left, right) => Number(BigInt(left.cursor) - BigInt(right.cursor)))
        const offset = Number(request.pageToken || 0)
        const selected = remaining.slice(offset, offset + Number(request.limit || 32))
        const complete = offset + selected.length >= remaining.length
        const items = selected.map((item) => {
          const identity = { projectionKey: item.key, revision, cursor: item.cursor }
          if (item.revoked) return { ...identity, visibility: "revoked" }
          const latest = item.messages.at(-1)
          return {
            ...identity,
            visibility: "visible",
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
        })
        return {
          ...original,
          value: {
            version: 2,
            scopeKey: native.scopeKey,
            after: request.after || "0",
            upper,
            scanCursor: faults.nonprogressing ? request.after || "0" : (selected.at(-1)?.cursor ?? upper),
            scanProjectionKey: faults.nonprogressing ? "" : (selected.at(-1)?.key ?? ""),
            pageToken: faults.nonprogressing ? "stalled" : complete ? "" : String(offset + selected.length),
            windowComplete: !faults.nonprogressing && complete,
            caughtUp: !faults.nonprogressing && complete,
            serverNow: Date.now(),
            items: faults.nonprogressing ? [] : items,
          },
        }
      }
      if (topic !== "qry_delivery_messages" && topic !== "qry_delivery_read_cut") return original
      const item = conversations.get(String(request.projectionKey))
      if (!item) throw new Error("Original V2 projection was not selected")
      if (topic === "qry_delivery_read_cut")
        return {
          ...original,
          value: {
            ...original.value,
            projectionKey: item.key,
            throughOrdinal: String(item.messages.length),
            targetAdmittedOrdinal: String(item.messages.length),
            liveUnread: String(item.messages.length),
            storedUnread: String(item.messages.length),
          },
        }
      const anchor = String(request.anchorDeliveryCursor || "0")
      const remaining = item.messages.filter((message) =>
        request.direction === "older"
          ? !request.anchorDeliveryCursor || BigInt(message.deliveryCursor) < BigInt(anchor)
          : BigInt(message.deliveryCursor) > BigInt(anchor),
      )
      const ordered = request.direction === "older" ? [...remaining].reverse() : remaining
      const selected = ordered.slice(0, Number(request.limit || 32))
      pages.push({ key: item.key, direction: String(request.direction), anchor, count: selected.length })
      return {
        ...original,
        value: {
          version: 2,
          scopeKey: native.scopeKey,
          projectionKey: item.key,
          projectionRevision: revision,
          direction: request.direction,
          nextDeliveryCursor: selected.at(-1)?.deliveryCursor ?? "",
          finished: selected.length === ordered.length,
          serverNow: Date.now(),
          items: selected.map((message, index) => ({
            ...message,
            ...(faults.malformedAfter === anchor && request.direction === "newer" && index === 0
              ? { targetId: "foreign-conversation" }
              : {}),
            ...(faults.changedSender && index === 0
              ? {
                  ...item.messages[0],
                  sequence: message.sequence,
                  deliveryCursor: message.deliveryCursor,
                  senderId: "forged-sender",
                }
              : {}),
          })),
        },
      }
    },
  })
  const conversation = (type: 1 | 2, target: string) => {
    const key = createHash("sha256").update(`discovery:${type}:${target}`).digest("hex")
    const prior = conversations.get(key)
    if (prior) return prior
    const item: Conversation = {
      key,
      type,
      target,
      name: target,
      cursor: native.advanceRevision(),
      revoked: false,
      messages: [],
    }
    conversations.set(key, item)
    return item
  }
  return {
    ...native,
    conversations,
    faults,
    pages,
    changes,
    conversation,
    get state() {
      return native.state
    },
    add(type: 1 | 2, target: string, id: string) {
      const item = conversation(type, target)
      const cursor = String(item.messages.length + 1)
      const now = Date.now()
      item.messages.push({
        effectKey: createHash("sha256").update(`${native.scopeKey}:${item.key}:${id}`).digest("hex"),
        messageId: id,
        sequence: cursor,
        deliveryCursor: cursor,
        messageTime: now,
        expiresAt: now + 600_000,
        senderId: target,
        targetId: target,
        conversationType: type,
        content: JSON.stringify({ content: `original ${id}` }),
        isSend: false,
        isRead: false,
        messageType: "jg:text",
      })
      item.cursor = native.advanceRevision()
      return item
    },
    revoke(type: 1 | 2, target: string) {
      const item = conversation(type, target)
      item.revoked = true
      item.cursor = native.advanceRevision()
      return item
    },
  }
}
