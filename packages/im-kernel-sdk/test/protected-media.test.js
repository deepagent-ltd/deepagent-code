import { afterEach, expect, test } from "bun:test";
import DeliveryClient from "../upstream/src/delivery/client";
import MediaClient from "../upstream/src/delivery/media-client";
import { mediaContent, mediaWireContent, protectedMediaInput } from "../upstream/src/delivery/media-contract";
import { encodeQuery, decodeQuery } from "../upstream/src/delivery/codec";
import { validateResult } from "../upstream/src/delivery/contract";
import Proto from "../upstream/src/socket/proto";

const servers = [];
afterEach(() => servers.splice(0).forEach(server => server.stop(true)));
const capabilities = { version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
  maxFileBytes: 10485760, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true };
const descriptor = (index = 1) => { const createdAt = Date.now(); return ({ attachmentID: String(index).repeat(64), contentRef: String(index).repeat(64),
  filename: "中文<&>.png", mime: "image/png", sizeBytes: 3, sha256: "a".repeat(64),
  createdAt, expiresAt: createdAt + 86400000 }); };
const json = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
const response = value => new Response(json(value), { headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const metadata = attachment => ({ objectID: attachment.attachmentID, uploadID: "upload-original", filename: attachment.filename,
  mime: attachment.mime, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256, state: "uploaded_unbound",
  receivedBytes: attachment.sizeBytes, receivedChunks: 1, createdAt: attachment.createdAt, expiresAt: attachment.expiresAt });
const transport = fetch => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); servers.push(server);
  const state = { generation: 1, token: "private-unit-current", user: "alice", navigator: server.url.origin };
  const io = { isConnected: () => true, deliveryMediaContext: () => state, deliveryGeneration: () => state.generation,
    getCurrentUser: () => ({ id: state.user }), sendCommand: () => Promise.resolve() };
  return { state, io, client: MediaClient(io, true) };
};

test("typed descriptors snapshot all four original objects and reject getters, excess fields, duplicates and byte overflow", () => {
  const attachments = [1, 2, 3, 4].map(descriptor);
  const content = mediaContent({ v: 1, content: "🙂<&>\u2028", attachments });
  attachments[0].filename = "later.txt";
  expect(content.attachments[0].filename).toBe("中文<&>.png");
  expect(Object.isFrozen(content.attachments[0])).toBe(true);
  expect(mediaWireContent(json(content), content.attachments[0].expiresAt)).toEqual(content);
  expect(() => mediaContent({ v: 1, content: "x", attachments: [descriptor(), descriptor()] })).toThrow();
  expect(() => mediaContent({ v: 1, content: "🙂".repeat(4096), attachments: [descriptor()] })).toThrow();
  expect(() => mediaContent({ v: 1, content: "x", attachments: [{ ...descriptor(), url: "https://invalid" }] })).toThrow();
  expect(() => mediaContent({ v: 1, content: "x", attachments: [{ ...descriptor(), mime: "image/png; charset=evil" }] })).toThrow();
  let reads = 0;
  const array = [descriptor()]; Object.defineProperty(array, "0", { get: () => { reads++; return descriptor(); } });
  expect(() => mediaContent({ v: 1, content: "x", attachments: array })).toThrow();
  expect(reads).toBe(0);
  expect(() => mediaWireContent('{"v":1,"v":1,"content":"x","attachments":[]}', Date.now())).toThrow();
  expect(() => mediaWireContent('{"v":1,"\\u0076":1,"content":"x","attachments":[]}', Date.now())).toThrow();
  expect(() => protectedMediaInput({ clientMsgId: "original", name: "dac:media.v1", conversationType: 1, conversationId: "bob",
    content, deliveryExpiresAt: content.attachments[0].expiresAt + 1 })).toThrow();
});

test("independent OFF rejects media and v2 before any query or HTTP effect", async () => {
  let native = 0;
  const fixture = transport(() => { native++; return response(capabilities); });
  fixture.io.sendCommand = () => { native++; return Promise.resolve(); };
  const sdk = DeliveryClient(fixture.io, { sendMessage: () => { native++; return Promise.resolve(); } });
  await expect(sdk.getProtectedMediaCapabilities()).rejects.toMatchObject({ kind: "unsupported_capability" });
  await expect(sdk.sendProtectedMedia({})).rejects.toMatchObject({ kind: "unsupported_capability" });
  await expect(sdk.getDeliveryReadCut({ version: 2, scopeKey: "a".repeat(64), projectionKey: "b".repeat(64), projectionRevision: "1" })).rejects.toMatchObject({ kind: "unsupported_capability" });
  expect(native).toBe(0);
});

test("actual HTTP uses captured current auth, snapshots upload bytes and checks bounded authenticated Range", async () => {
  const attachment = descriptor(); const accepted = [];
  const fixture = transport(async request => {
    expect(request.headers.get("authorization")).toBe("Bearer private-unit-current");
    expect(new URL(request.url).search).toBe("");
    const path = new URL(request.url).pathname;
    if (path.endsWith("/capabilities")) return response(capabilities);
    if (path.endsWith("/objects")) { accepted.push(await request.text()); return response(metadata(attachment)); }
    if (path.endsWith("/chunks/0")) { accepted.push(Array.from(new Uint8Array(await request.arrayBuffer()))); return response(metadata(attachment)); }
    expect(request.headers.get("range")).toBe("bytes=0-2");
    return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-type": "image/png", "content-range": "bytes 0-2/3", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  });
  expect(await fixture.client.getProtectedMediaCapabilities()).toEqual(capabilities);
  const begin = { conversationType: 1, conversationID: "bob", upload: { uploadID: "upload-original", filename: attachment.filename, sizeBytes: 3, sha256: attachment.sha256 } };
  await fixture.client.beginProtectedMedia(begin);
  const bytes = new Uint8Array([1, 2, 3]); const pending = fixture.client.putProtectedMediaChunk({ objectID: attachment.attachmentID, index: 0, body: bytes }); bytes.fill(8);
  await pending;
  expect(accepted).toEqual([json(begin), [1, 2, 3]]);
  expect(Array.from(await fixture.client.readProtectedMediaRange({ attachment, start: 0, end: 2 }))).toEqual([1, 2, 3]);
});

test("10MiB capability accepts the current kernel and rejects oversized descriptors and uploads before HTTP", async () => {
  let calls = 0;
  const attachment = { ...descriptor(), sizeBytes: 10485760 };
  const fixture = transport(() => { calls++; return response(capabilities); });
  expect(await fixture.client.getProtectedMediaCapabilities()).toEqual(capabilities);
  expect(mediaContent({ v: 1, content: "current bound", attachments: [attachment] }).attachments[0].sizeBytes).toBe(10485760);
  expect(() => mediaContent({ v: 1, content: "too large", attachments: [{ ...attachment, sizeBytes: 10485761 }] })).toThrow();
  await expect(fixture.client.beginProtectedMedia({ conversationType: 1, conversationID: "bob",
    upload: { uploadID: "oversized", filename: attachment.filename, sizeBytes: 10485761, sha256: attachment.sha256 } }))
    .rejects.toMatchObject({ operation: "media_begin", kind: "invalid_request" });
  expect(calls).toBe(1);
  const stale = transport(() => response({ ...capabilities, maxFileBytes: 52428800 }));
  await expect(stale.client.getProtectedMediaCapabilities()).rejects.toMatchObject({ operation: "media_capabilities", kind: "invalid_response" });
});

test("late HTTP bytes from an old credential generation are discarded and redirects or overlength ranges are rejected", async () => {
  const attachment = descriptor(); let started; let finish;
  const arrived = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const fixture = transport(async () => { started(); await pending; return new Response(new Uint8Array([1, 2, 3]), { status: 206,
    headers: { "content-type": "image/png", "content-range": "bytes 0-2/3", "cache-control": "no-store", "x-content-type-options": "nosniff" } }); });
  const read = fixture.client.readProtectedMediaRange({ attachment, start: 0, end: 2 }); await arrived;
  fixture.state.generation++; fixture.state.token = "new-current"; finish();
  expect(await read.then(() => undefined, error => error)).toMatchObject({ kind: "disconnected" });
  const overflow = transport(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 206,
    headers: { "content-type": "image/png", "content-range": "bytes 0-2/3", "cache-control": "no-store", "x-content-type-options": "nosniff" } }));
  expect(await overflow.client.readProtectedMediaRange({ attachment, start: 0, end: 2 }).then(() => undefined, error => error)).toMatchObject({ kind: "invalid_response" });
  const redirect = transport(request => new Response(null, { status: 302, headers: { location: new URL("/elsewhere", request.url).href } }));
  expect(await redirect.client.getProtectedMediaCapabilities().then(() => undefined, error => error)).toMatchObject({ kind: "unavailable" });
});

test("actual protobuf query and strict decode preserve reader-v1 shape and require explicit v2 media type", () => {
  expect(Array.from(encodeQuery("qry_delivery_reader", { version: 1 }))).toEqual([8, 1]);
  expect(Array.from(encodeQuery("qry_delivery_reader", { version: 2 }))).toEqual([8, 2]);
  const request = { version: 1, scopeKey: "a".repeat(64), projectionKey: "b".repeat(64), projectionRevision: "1", direction: "newer", limit: 32 };
  const item = { effectKey: "c".repeat(64), messageId: "original", sequence: "1", deliveryCursor: "1", messageTime: Date.now(), expiresAt: Date.now() + 10000,
    senderId: "alice", targetId: "bob", conversationType: 1, content: '{"content":"old text"}', isSend: false, isRead: false };
  const value = { version: 1, scopeKey: request.scopeKey, projectionKey: request.projectionKey, projectionRevision: "1", direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: Date.now(), items: [item] };
  const type = Proto.lookup("codec.DeliveryMessagesResult");
  const decoded = decodeQuery("qry_delivery_messages", type.encode(type.create({ ...value, items: [Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== false))] })).finish());
  expect(validateResult("qry_delivery_messages", request, decoded).items[0]).toEqual(item);
  expect(() => validateResult("qry_delivery_messages", { ...request, version: 2 }, { ...value, version: 2 })).toThrow();
  const attachment = descriptor(); const media = { ...item, messageType: "dac:media.v1", content: json({ v: 1, content: "file", attachments: [attachment] }), expiresAt: attachment.expiresAt };
  const v2 = { ...value, version: 2, items: [media] };
  expect(validateResult("qry_delivery_messages", { ...request, version: 2 }, decodeQuery("qry_delivery_messages", type.encode(type.create({ ...v2, items: [Object.fromEntries(Object.entries(media).filter(([, entry]) => entry !== false))] })).finish())).items[0].messageType).toBe("dac:media.v1");
  expect(() => validateResult("qry_delivery_messages", request, { ...value, items: [media] })).toThrow();
});

test("zero-byte content still makes one authenticated HTTP read with exact empty response and original SHA", async () => {
  const attachment = { ...descriptor(), sizeBytes: 0, mime: "application/octet-stream",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  let reads = 0;
  const fixture = transport(request => {
    reads++;
    expect(request.headers.get("range")).toBeNull();
    expect(request.headers.get("authorization")).toBe("Bearer private-unit-current");
    return new Response(null, { status: 200, headers: { "content-length": "0", "content-type": "application/octet-stream",
      "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  });
  expect(await fixture.client.readProtectedMediaRange({ attachment, start: 0, end: 0 })).toHaveLength(0);
  expect(reads).toBe(1);
  expect(await fixture.client.readProtectedMediaRange({ attachment: { ...attachment, sha256: "b".repeat(64) }, start: 0, end: 0 }).then(() => undefined, error => error))
    .toMatchObject({ kind: "invalid_request" });
  expect(reads).toBe(1);
});
