export * as ProtectedReaderProtocolFixture from "./protected-reader-protocol"

import { KernelLiveFirstSeenFixture } from "./kernel-live-first-seen"

/** Real local HTTP/WS protocol peer. Faults alter returned native facts rather
 * than manufacturing a Host witness or replacing the production decoder. */
export function make() {
  const state = { members: ["receiver", "sender"], tupleMismatch: false, expiry: false }
  const inspected: unknown[] = []
  const queries: { topic: string; request: Record<string, unknown> }[] = []
  const native = KernelLiveFirstSeenFixture.make({
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/im/conversations/inspect") return
      return request.json().then((body: unknown) => {
        if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer private-witness-key")
          return Response.json({ success: false, code: "denied" }, { status: 403 })
        inspected.push(body)
        return Response.json({
          success: true,
          data: {
            conversation_type: 1,
            conversation_id: "sender",
            org_id: 1,
            name: "Sender",
            member_uuids: state.members,
          },
        })
      })
    },
    response(topic, request, original) {
      queries.push({ topic, request })
      if (topic === "qry_delivery_read_cut")
        return {
          name: "DeliveryReadCutResult",
          value: {
            version: 1,
            scopeKey: request.scopeKey,
            projectionKey: request.projectionKey,
            projectionRevision: request.projectionRevision,
            throughOrdinal: "0",
            targetAdmittedOrdinal: String(native.messages.length),
            readOrdinal: "0",
            liveUnread: String(native.messages.length),
            storedUnread: String(native.messages.length),
            complete: native.messages.length === 0,
            serverNow: Date.now(),
          },
        }
      if (topic !== "qry_delivery_messages" || request.limit !== 1 || !original) return original
      const items = original.value.items
      if (!Array.isArray(items)) throw new Error("Expected original native messages")
      return {
        ...original,
        value: {
          ...original.value,
          ...(state.expiry ? { serverNow: native.messages[0].expiresAt - 1 } : {}),
          items: items.map((item: Record<string, unknown>) =>
            state.tupleMismatch ? { ...item, content: '{"content":"native changed"}' } : item,
          ),
        },
      }
    },
  })
  return { ...native, faults: state, inspected, queries }
}
