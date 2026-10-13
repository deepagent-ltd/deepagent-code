import { deliveryError, snapshot, keys, hash, text, utf8, time } from "./values";

export const MEDIA_TYPE = "dac:media.v1";
export const MEDIA_BYTES = 16384;
export const FILE_BYTES = 10485760;
export const CHUNK_BYTES = 262144;
export const MEDIA_LIFETIME = 86400000;
export const mediaMIME = value => typeof value === "string" && value.length <= 127 &&
  /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+(?:; charset=utf-8)?$/.test(value);

// Fixed property order is shared with the producer. A descriptor is a retained
// object fact, never an authorization to read that object later.
export function mediaAttachment(input) {
  const value = snapshot(input);
  if (!keys(value, ["attachmentID", "contentRef", "filename", "mime", "sizeBytes", "sha256", "createdAt", "expiresAt"]) ||
      !hash(value.attachmentID) || value.contentRef !== value.attachmentID || !text(value.filename, 255) ||
      /[/\\]/.test(value.filename) || !mediaMIME(value.mime) || !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 0 || value.sizeBytes > FILE_BYTES || !hash(value.sha256) || !time(value.createdAt, true) ||
      !time(value.expiresAt, true) || value.expiresAt !== value.createdAt + MEDIA_LIFETIME)
    throw deliveryError("media", "invalid_request");
  return Object.freeze({ attachmentID: value.attachmentID, contentRef: value.contentRef, filename: value.filename,
    mime: value.mime, sizeBytes: value.sizeBytes, sha256: value.sha256, createdAt: value.createdAt, expiresAt: value.expiresAt });
}

export function mediaContent(input) {
  const value = snapshot(input);
  if (!keys(value, ["v", "content", "attachments"]) || value.v !== 1 || !utf8(value.content, MEDIA_BYTES, true) ||
      !Array.isArray(value.attachments) || Object.getPrototypeOf(value.attachments) !== Array.prototype ||
      value.attachments.length < 1 || value.attachments.length > 4)
    throw deliveryError("media", "invalid_request");
  const entries = Object.getOwnPropertyDescriptors(value.attachments);
  if (Reflect.ownKeys(entries).length !== value.attachments.length + 1 ||
      Array.from({ length: value.attachments.length }, (_, index) => entries[index]).some(entry => !entry || !("value" in entry)))
    throw deliveryError("media", "invalid_request");
  const attachments = Object.freeze(Array.from({ length: value.attachments.length }, (_, index) => mediaAttachment(entries[index].value)));
  if (new Set(attachments.map(item => item.attachmentID)).size !== attachments.length)
    throw deliveryError("media", "invalid_request");
  const result = Object.freeze({ v: 1, content: value.content, attachments });
  if (new TextEncoder().encode(JSON.stringify(result)).length > MEDIA_BYTES)
    throw deliveryError("media", "invalid_request");
  return result;
}

export function protectedMediaInput(input) {
  const value = snapshot(input);
  if (!keys(value, ["tid", "clientMsgId", "name", "conversationType", "conversationId", "content", "deliveryExpiresAt"]) ||
      (value.tid !== undefined && !text(value.tid, 2048)) || value.name !== MEDIA_TYPE ||
      ![1, 2].includes(value.conversationType) || !text(value.conversationId, 45) || !text(value.clientMsgId, 2048))
    throw deliveryError("media", "invalid_request");
  const content = mediaContent(value.content);
  const expiry = Math.min(...content.attachments.map(item => item.expiresAt));
  if (!time(value.deliveryExpiresAt, true) || value.deliveryExpiresAt !== expiry || expiry <= Date.now())
    throw deliveryError("media", "invalid_request");
  return Object.freeze({ ...(value.tid === undefined ? {} : { tid: value.tid }), clientMsgId: value.clientMsgId,
    name: MEDIA_TYPE, conversationType: value.conversationType, conversationId: value.conversationId,
    content, deliveryExpiresAt: expiry });
}

export function mediaBeginInput(input) {
  const value = snapshot(input);
  const upload = snapshot(value?.upload);
  if (!keys(value, ["conversationType", "conversationID", "upload"]) || ![1, 2].includes(value.conversationType) ||
      !text(value.conversationID, 45) || !keys(upload, ["uploadID", "filename", "sizeBytes", "sha256"]) ||
      !text(upload.uploadID, 128) || !text(upload.filename, 255) || /[/\\]/.test(upload.filename) ||
      !Number.isSafeInteger(upload.sizeBytes) || upload.sizeBytes < 0 || upload.sizeBytes > FILE_BYTES || !hash(upload.sha256))
    throw deliveryError("media_begin", "invalid_request");
  return Object.freeze({ conversationType: value.conversationType, conversationID: value.conversationID,
    upload: Object.freeze({ uploadID: upload.uploadID, filename: upload.filename, sizeBytes: upload.sizeBytes, sha256: upload.sha256 }) });
}

export function mediaMetadata(input) {
  const value = snapshot(input);
  if (!keys(value, ["objectID", "uploadID", "filename", "mime", "sizeBytes", "sha256", "state", "receivedBytes", "receivedChunks", "createdAt", "expiresAt"]) ||
      !hash(value.objectID) || !text(value.uploadID, 128) || !text(value.filename, 255) || /[/\\]/.test(value.filename) ||
      !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || value.sizeBytes > FILE_BYTES || !hash(value.sha256) ||
      !["uploading", "uploaded_unbound", "bound", "cancelled", "expired", "unknown"].includes(value.state) ||
      !Number.isSafeInteger(value.receivedBytes) || value.receivedBytes < 0 || value.receivedBytes > value.sizeBytes ||
      !Number.isSafeInteger(value.receivedChunks) || value.receivedChunks < 0 || value.receivedChunks > Math.ceil(value.sizeBytes / CHUNK_BYTES) ||
      !time(value.createdAt, true) || !time(value.expiresAt, true) || value.expiresAt !== value.createdAt + MEDIA_LIFETIME ||
      !utf8(value.mime, 127, true) || /[\u0000-\u001f\u007f]/.test(value.mime) ||
      (["uploaded_unbound", "bound"].includes(value.state) && (!mediaMIME(value.mime) || value.receivedBytes !== value.sizeBytes ||
        value.receivedChunks !== Math.ceil(value.sizeBytes / CHUNK_BYTES))))
    throw deliveryError("media", "invalid_response");
  return Object.freeze(value);
}

// Progress describes committed chunks, never a permission or a contiguous prefix.
export function mediaUploadProgress(input) {
  const value = snapshot(input);
  if (!keys(value, ["version", "protocol", "object", "chunkBytes", "checkpointRevision", "committedIndices"]) ||
      value.version !== 1 || value.protocol !== "dac-media-resumable-v1" || value.chunkBytes !== CHUNK_BYTES ||
      !time(value.checkpointRevision, true) || !Array.isArray(value.committedIndices) ||
      Object.getPrototypeOf(value.committedIndices) !== Array.prototype || value.committedIndices.length > FILE_BYTES / CHUNK_BYTES)
    throw deliveryError("media_upload_progress", "invalid_response");
  const object = mediaMetadata(value.object);
  const entries = Object.getOwnPropertyDescriptors(value.committedIndices);
  if (object.state !== "uploading" || Reflect.ownKeys(entries).length !== value.committedIndices.length + 1 ||
      Array.from({ length: value.committedIndices.length }, (_, index) => entries[index]).some(entry => !entry || !("value" in entry)))
    throw deliveryError("media_upload_progress", "invalid_response");
  const indices = Array.from({ length: value.committedIndices.length }, (_, index) => entries[index].value);
  if (indices.some((index, position) => !Number.isSafeInteger(index) || index < 0 ||
      index >= Math.ceil(object.sizeBytes / CHUNK_BYTES) || position > 0 && index <= indices[position - 1]) ||
      indices.length !== object.receivedChunks ||
      indices.reduce((bytes, index) => bytes + Math.min(CHUNK_BYTES, object.sizeBytes - index * CHUNK_BYTES), 0) !== object.receivedBytes)
    throw deliveryError("media_upload_progress", "invalid_response");
  return Object.freeze({ version: 1, protocol: "dac-media-resumable-v1", object, chunkBytes: CHUNK_BYTES,
    checkpointRevision: value.checkpointRevision, committedIndices: Object.freeze(indices) });
}

// Reject duplicate decoded keys before JSON.parse can discard them. The scan
// stays bounded by the wire body and the descriptor's shallow nesting limit.
export function strictBodyJSON(raw, limit) {
  if (!utf8(raw, limit)) throw deliveryError("messages", "invalid_response");
  let offset = 0;
  const space = () => { while (/[\t\n\r ]/.test(raw[offset] || "x")) offset++; };
  const string = () => {
    const token = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(raw.slice(offset));
    if (!token) throw deliveryError("messages", "invalid_response");
    offset += token[0].length;
    return JSON.parse(token[0]);
  };
  const value = depth => {
    if (depth > 4) throw deliveryError("messages", "invalid_response");
    space();
    if (raw[offset] === '"') { string(); return; }
    if (raw[offset] === "{" || raw[offset] === "[") {
      const object = raw[offset++] === "{";
      const close = object ? "}" : "]";
      const seen = new Set();
      space();
      if (raw[offset] === close) { offset++; return; }
      while (true) {
        space();
        if (object) {
          const key = string();
          if (seen.has(key)) throw deliveryError("messages", "invalid_response");
          seen.add(key); space();
          if (raw[offset++] !== ":") throw deliveryError("messages", "invalid_response");
        }
        value(depth + 1); space();
        if (raw[offset] === close) { offset++; return; }
        if (raw[offset++] !== ",") throw deliveryError("messages", "invalid_response");
      }
    }
    const scalar = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(offset));
    if (!scalar) throw deliveryError("messages", "invalid_response");
    offset += scalar[0].length;
  };
  value(0); space();
  if (offset !== raw.length) throw deliveryError("messages", "invalid_response");
  return JSON.parse(raw);
}

export function mediaWireContent(raw, expiry) {
  const value = mediaContent(strictBodyJSON(raw, MEDIA_BYTES));
  if (Math.min(...value.attachments.map(item => item.expiresAt)) !== expiry)
    throw deliveryError("messages", "invalid_response");
  return value;
}
