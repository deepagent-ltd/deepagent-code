import { afterEach, expect, test } from "bun:test";
import MediaClient, { mediaCapability, mediaTransferCapability } from "../upstream/src/delivery/media-client";
import { mediaUploadProgress } from "../upstream/src/delivery/media-contract";

const servers = [];
afterEach(() => servers.splice(0).forEach(server => server.stop(true)));
const transfer = { version: 1, protocol: "dac-media-resumable-v1", chunkBytes: 262144, maxChunks: 200, maxFileBytes: 52428800 };
const progress = () => {
  const createdAt = Date.now();
  return { version: 1, protocol: "dac-media-resumable-v1", chunkBytes: 262144, checkpointRevision: 3,
    object: { objectID: "a".repeat(64), uploadID: "original-upload", filename: "original.bin", mime: "", sizeBytes: 786449,
      sha256: "b".repeat(64), state: "uploading", receivedBytes: 524288, receivedChunks: 2, createdAt, expiresAt: createdAt + 86400000 },
    committedIndices: [0, 2] };
};
const response = value => new Response(JSON.stringify(value), { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

test("resume checkpoint snapshots sparse committed chunks and rejects holes, duplicates, bad counts and closed objects", () => {
  const input = progress();
  const decoded = mediaUploadProgress(input);
  input.committedIndices[0] = 1;
  input.object.filename = "later.bin";
  expect(decoded.committedIndices).toEqual([0, 2]);
  expect(decoded.object.filename).toBe("original.bin");
  expect(Object.isFrozen(decoded.committedIndices)).toBe(true);
  for (const indices of [[2, 0], [0, 0], [0, 4], [0, 2, 3], [0, , 2]])
    expect(() => mediaUploadProgress({ ...progress(), committedIndices: indices })).toThrow();
  const original = progress();
  for (const object of [{ ...original.object, receivedBytes: 524287 }, { ...original.object, receivedChunks: 1 },
    { ...original.object, state: "uploaded_unbound" }]) expect(() => mediaUploadProgress({ ...original, object })).toThrow();
  expect(() => mediaUploadProgress({ ...progress(), checkpointRevision: 0 })).toThrow();
  expect(() => mediaUploadProgress({ ...progress(), checkpointRevision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  let reads = 0;
  const indices = [0, 2];
  Object.defineProperty(indices, "1", { get() { reads++; return 2; } });
  expect(() => mediaUploadProgress({ ...progress(), committedIndices: indices })).toThrow();
  expect(reads).toBe(0);
  const last = progress();
  last.committedIndices = [1, 3];
  last.object.receivedBytes = 262144 + 17;
  expect(mediaUploadProgress(last).committedIndices).toEqual([1, 3]);
});

test("transfer negotiation is independent of the unchanged strict media capability", () => {
  expect(mediaTransferCapability(transfer)).toEqual(transfer);
  expect(() => mediaTransferCapability({ ...transfer, chunkBytes: 1048576 })).toThrow();
  expect(() => mediaTransferCapability({ ...transfer, lease: "not-authority" })).toThrow();
  const old = { version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
    maxFileBytes: 52428800, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true };
  expect(mediaCapability(old)).toEqual(old);
  expect(() => mediaCapability({ ...old, protocol: transfer.protocol })).toThrow();
});

test("original MediaClient sends bounded authenticated progress GETs and rejects old-generation replies", async () => {
  const wire = [];
  const checkpoint = progress();
  let release;
  let arrived;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { arrived = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer private-resume-token");
    expect(await request.text()).toBe("");
    const path = new URL(request.url).pathname;
    wire.push(path);
    if (path.endsWith("/transfer/capabilities")) return response(transfer);
    if (wire.length === 3) { arrived(); await held; }
    return response(checkpoint);
  } });
  servers.push(server);
  const state = { generation: 1, user: "private-resume-user", token: "private-resume-token", navigator: server.url.origin };
  const io = { isConnected: () => true, deliveryMediaContext: () => state };
  const client = MediaClient(io, true);
  expect(await client.getProtectedMediaTransferCapabilities()).toEqual(transfer);
  expect(await client.getProtectedMediaUploadProgress({ objectID: checkpoint.object.objectID })).toEqual(checkpoint);
  const late = client.getProtectedMediaUploadProgress({ objectID: checkpoint.object.objectID });
  await started;
  state.generation++;
  release();
  expect(await late.then(() => undefined, error => error)).toMatchObject({ kind: "disconnected" });
  expect(wire).toEqual(["/navigator/protected-media/v1/transfer/capabilities",
    `/navigator/protected-media/v1/objects/${checkpoint.object.objectID}/upload-progress`,
    `/navigator/protected-media/v1/objects/${checkpoint.object.objectID}/upload-progress`]);
  const disabled = MediaClient(io, false);
  await expect(disabled.getProtectedMediaTransferCapabilities()).rejects.toMatchObject({ kind: "unsupported_capability" });
  await expect(disabled.getProtectedMediaUploadProgress({ objectID: checkpoint.object.objectID })).rejects.toMatchObject({ kind: "unsupported_capability" });
  expect(wire).toHaveLength(3);
});

test("the reviewed generated protected facade exposes both new operations without enabling legacy APIs", async () => {
  await import("../../deepagent-code/src/im/kernel/shims");
  const bundle = await import("../lib/index.js");
  const client = bundle.default.init({ appkey: "private-resume-facade", protectedDeliveryReader: true, protectedMedia: true });
  try {
    await expect(client.getProtectedMediaTransferCapabilities()).rejects.toMatchObject({ operation: "media_transfer_capabilities", kind: "disconnected" });
    await expect(client.getProtectedMediaUploadProgress({ objectID: "a".repeat(64) })).rejects.toMatchObject({ operation: "media_upload_progress", kind: "disconnected" });
    expect(() => client.sendMessage({})).toThrow();
  } finally {
    await client.disconnect();
  }
});
