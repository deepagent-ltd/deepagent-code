import { expect, test } from "bun:test";
import LiveRead, { LIVE_CUT, LIVE_PAGE, liveRequest, decodeLive } from "../upstream/src/delivery/live-read";
import LiveOrigin from "../upstream/src/delivery/live-origin";
import { validateResult } from "../upstream/src/delivery/contract";

function fixture() {
  const connection = { value: { socket: {}, generation: 1, receiverID: "receiver" } };
  const origin = LiveOrigin(() => connection.value);
  const runtime = LiveRead(() => connection.value, origin, (request, page) => validateResult("qry_delivery_messages", request, page));
  const request = liveRequest(LIVE_CUT, { version: 1, readerVersion: 2, subscriberID: "c".repeat(32), scopeKey: "a".repeat(64), projectionKey: "b".repeat(64), projectionRevision: "1" });
  const now = Date.now();
  const cut = { version: 1, cutID: "d".repeat(32), subscriberID: request.subscriberID, scopeKey: request.scopeKey, projectionKey: request.projectionKey, conversationScopeKey: "e".repeat(64), acceptanceRevision: "9007199254740993", receiverID: "receiver", serverNow: now, expiresAt: now + 86400000 - 3 };
  const item = { effectKey: "f".repeat(64), messageId: "new-receipt", sequence: "9007199254740994", deliveryCursor: "2", messageTime: now, expiresAt: now + 86400000, senderId: "sender", targetId: "sender", conversationType: 1, content: '{"content":"受审 UTF8 中文"}', isSend: false, isRead: false, messageType: "jg:text" };
  const page = { version: 2, scopeKey: request.scopeKey, projectionKey: request.projectionKey, projectionRevision: "2", direction: "newer", nextDeliveryCursor: "2", finished: true, serverNow: now, items: [item] };
  const proof = { effectKey: item.effectKey, conversationScopeKey: cut.conversationScopeKey, allocationRevision: "9007199254740994", contentHash: Bun.CryptoHasher.hash("sha256", item.content, "hex") };
  const query = liveRequest(LIVE_PAGE, { ...request, projectionRevision: "2", direction: "newer", anchorDeliveryCursor: "0", limit: 8, cutID: cut.cutID });
  return { connection, origin, runtime, request, cut, item, page, proof, query };
}

test("exact int64/UTF8 cut-page seals original frozen handles; clones, other runtimes and reconnect deny", async () => {
  const f = fixture();
  const cut = await f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: f.cut });
  expect(f.runtime.cut(cut)).toEqual(f.cut);
  expect(f.runtime.cut({ ...cut })).toBeUndefined();
  expect(await f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: f.cut })).toBe(cut);
  const handle = await f.runtime.accept(LIVE_PAGE, f.query, { version: 1, cutID: f.cut.cutID, page: f.page, proofs: [f.proof] });
  const current = f.runtime.page(handle);
  expect(current.page).toEqual(f.page);
  expect(current.observations).toHaveLength(1);
  expect(Object.isFrozen(current.page.items[0])).toBe(true);
  expect(f.origin.read(current.observations[0])).toMatchObject({ messageID: f.item.messageId, sequence: f.item.sequence, receiverID: "receiver", generation: 1, wireContent: f.item.content, originalDestroyTime: f.item.expiresAt });
  expect(f.runtime.page({ ...handle })).toBeUndefined();
  expect(fixture().runtime.page(handle)).toBeUndefined();
  f.connection.value = { socket: {}, generation: 2, receiverID: "receiver" };
  expect(f.runtime.cut(cut)).toBeUndefined();
  expect(f.runtime.page(handle)).toBeUndefined();
  expect(f.origin.read(current.observations[0])).toBeUndefined();
});

test("precut/foreign/digest/duplicate proofs fail; a legitimate historical page has zero observations", async () => {
  for (const change of [{ allocationRevision: "9007199254740993" }, { contentHash: "0".repeat(64) }, { conversationScopeKey: "0".repeat(64) }, { effectKey: "0".repeat(64) }]) {
    const f = fixture();
    await f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: f.cut });
    await expect(f.runtime.accept(LIVE_PAGE, f.query, { version: 1, cutID: f.cut.cutID, page: f.page, proofs: [{ ...f.proof, ...change }] })).rejects.toMatchObject({ name: "DeliveryError", kind: "invalid_response" });
  }
  const f = fixture();
  await f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: f.cut });
  await expect(f.runtime.accept(LIVE_PAGE, f.query, { version: 1, cutID: f.cut.cutID, page: f.page, proofs: [f.proof, f.proof] })).rejects.toMatchObject({ kind: "invalid_response" });
  const history = await f.runtime.accept(LIVE_PAGE, f.query, { version: 1, cutID: f.cut.cutID, page: f.page, proofs: [] });
  expect(f.runtime.page(history).observations).toHaveLength(0);
});

test("same cut cannot renew; subscriber, expiry, capacity and strict JSON are enforced", async () => {
  const f = fixture();
  await f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: f.cut });
  await expect(f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: { ...f.cut, acceptanceRevision: "9007199254740994" } })).rejects.toMatchObject({ kind: "conflict" });
  await expect(f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: { ...f.cut, subscriberID: "0".repeat(32) } })).rejects.toMatchObject({ kind: "invalid_response" });
  expect(() => liveRequest(LIVE_PAGE, { ...f.query, unexpected: true })).toThrow();
  expect(() => decodeLive(new TextEncoder().encode('{"version":1,"version":2}'))).toThrow();
  expect(() => decodeLive(new Uint8Array(4194305))).toThrow();
  f.connection.value = undefined;
  await expect(f.runtime.accept(LIVE_PAGE, f.query, { version: 1, cutID: f.cut.cutID, page: f.page, proofs: [f.proof] })).rejects.toMatchObject({ kind: "unsupported_capability" });
  const expired = fixture();
  await expect(expired.runtime.accept(LIVE_CUT, expired.request, { version: 1, cut: { ...expired.cut, expiresAt: expired.cut.serverNow } })).rejects.toMatchObject({ kind: "invalid_response" });
});

test("an asynchronous digest cannot settle against a changed original connection", async () => {
  const f = fixture();
  await f.runtime.accept(LIVE_CUT, f.request, { version: 1, cut: f.cut });
  const completing = f.runtime.accept(LIVE_PAGE, f.query, { version: 1, cutID: f.cut.cutID, page: f.page, proofs: [f.proof] });
  f.connection.value = undefined;
  await expect(completing).rejects.toMatchObject({ kind: "stale" });
});
