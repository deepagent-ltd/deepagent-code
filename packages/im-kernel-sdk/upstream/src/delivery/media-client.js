import { deliveryError, snapshot, keys, hash, time } from "./values";
import { mediaAttachment, mediaBeginInput, mediaMetadata, mediaUploadProgress, MEDIA_TYPE, FILE_BYTES, CHUNK_BYTES, MEDIA_LIFETIME } from "./media-contract";

export function mediaCapability(input) {
  const value = snapshot(input);
  if (!keys(value, ["version", "profile", "capability", "readerVersion", "maxFileBytes", "maxAttachments", "chunkBytes", "ttlMillis", "authenticatedContent"]) ||
      value.version !== 1 || value.profile !== "mysql-protected-media-v1" || value.capability !== MEDIA_TYPE || value.readerVersion !== 2 ||
      value.maxFileBytes !== FILE_BYTES || value.maxAttachments !== 4 || value.chunkBytes !== CHUNK_BYTES ||
      value.ttlMillis !== MEDIA_LIFETIME || value.authenticatedContent !== true)
    throw deliveryError("media_capabilities", "invalid_response");
  return Object.freeze(value);
}

export function mediaTransferCapability(input) {
  const value = snapshot(input);
  if (!keys(value, ["version", "protocol", "chunkBytes", "maxChunks", "maxFileBytes"]) ||
      value.version !== 1 || value.protocol !== "dac-media-resumable-v1" || value.chunkBytes !== CHUNK_BYTES ||
      value.maxChunks !== FILE_BYTES / CHUNK_BYTES || value.maxFileBytes !== FILE_BYTES)
    throw deliveryError("media_transfer_capabilities", "invalid_response");
  return Object.freeze(value);
}

// The IO owns both values: an actual successful Navigator response and the
// current socket credential generation. No caller supplies a URL or bearer.
export default function MediaClient(io, enabled) {
  const current = operation => {
    if (!enabled) throw deliveryError(operation, "unsupported_capability");
    const value = io.deliveryMediaContext();
    if (!io.isConnected() || !value) throw deliveryError(operation, "disconnected");
    const url = new URL(value.navigator);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol) ||
        url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw deliveryError(operation, "unavailable");
    return Object.freeze({ ...value, navigator: url.href.replace(/\/$/, "") });
  };
  const check = (source, operation, expiry) => {
    const value = current(operation);
    if (source.generation !== value.generation || source.user !== value.user || source.token !== value.token || source.navigator !== value.navigator)
      throw deliveryError(operation, "disconnected");
    if (expiry !== undefined && expiry <= Date.now()) throw deliveryError(operation, "expired");
  };
  const request = async (operation, path, options = {}) => {
    const source = current(operation);
    let dispatched = false;
    check(source, operation, options.expiry);
    if (options.signal?.aborted) throw deliveryError(operation, "cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const release = io.onDeliveryInvalidation?.(abort);
    const aborted = () => {
      if (dispatched && (options.method || "GET") !== "GET") return deliveryError(operation, "unknown");
      if (options.signal?.aborted) return deliveryError(operation, "cancelled");
      const value = io.deliveryMediaContext();
      if (!io.isConnected() || !value || source.generation !== value.generation) return deliveryError(operation, "disconnected");
      return deliveryError(operation, options.expiry !== undefined && options.expiry <= Date.now() ? "expired" : "transport_timeout");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, Math.min(10000, options.expiry === undefined ? 10000 : Math.max(1, options.expiry - Date.now())));
    const interrupted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(aborted()), { once: true }));
    let reader;
    try {
      const url = `${source.navigator}/navigator/protected-media/v1${path}`;
      const headers = await Promise.race([io.deviceHttpHeaders({ method: options.method || "GET", url, credential: source.token, currentSourceEpoch: source.generation })
        .catch(() => { throw deliveryError(operation, "unavailable"); }), interrupted]);
      check(source, operation, options.expiry);
      if (controller.signal.aborted) throw aborted();
      dispatched = true;
      const response = await Promise.race([fetch(url, {
        method: options.method || "GET", redirect: "error", cache: "no-store", credentials: "omit",
        headers: { ...(options.headers || {}), ...headers },
        ...(options.body === undefined ? {} : { body: options.body }), signal: controller.signal,
      }), interrupted]);
      check(source, operation, options.expiry);
      if (response.status !== (options.range ? 206 : 200)) {
        await response.body?.cancel();
        throw deliveryError(operation, ({ 403: "denied", 404: "not_found", 409: "conflict", 410: "expired", 413: "capacity" })[response.status] || "unavailable");
      }
      const limit = options.empty ? 0 : options.range ? options.range.end - options.range.start + 1 : 4096;
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > limit ||
          options.range && Number(declared) !== limit) || options.empty && declared !== "0" || !response.body && !options.empty || response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("x-content-type-options") !== "nosniff" || options.range &&
          (response.headers.get("content-range") !== `bytes ${options.range.start}-${options.range.end}/${options.range.sizeBytes}` ||
           response.headers.get("content-type") !== options.range.mime) || options.empty && response.headers.get("content-type") !== options.empty.mime) {
        await response.body?.cancel();
        throw deliveryError(operation, "invalid_response");
      }
      reader = response.body?.getReader();
      const bytes = new Uint8Array(limit);
      let size = 0;
      while (reader) {
        const part = await new Promise((resolve, reject) => {
          const fail = () => reject(aborted());
          if (controller.signal.aborted) return fail();
          controller.signal.addEventListener("abort", fail, { once: true });
          reader.read().then(result => { controller.signal.removeEventListener("abort", fail); resolve(result); },
            error => { controller.signal.removeEventListener("abort", fail); reject(error); });
        });
        check(source, operation, options.expiry);
        if (part.done) break;
        if (part.value.byteLength > limit - size) throw deliveryError(operation, "invalid_response");
        bytes.set(part.value, size);
        size += part.value.byteLength;
      }
      if (options.range && size !== limit) throw deliveryError(operation, "invalid_response");
      check(source, operation, options.expiry);
      if (options.range || options.empty) return bytes;
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
      const result = JSON.parse(raw);
      if (JSON.stringify(result).replace(/[<>&\u2028\u2029]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")) !== raw)
        throw deliveryError(operation, "invalid_response");
      return result;
    } catch (error) {
      controller.abort();
      if (error?.name === "DeliveryError") throw error;
      throw deliveryError(operation, ["GET"].includes(options.method || "GET") ? "unavailable" : "unknown");
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      release?.();
      controller.abort();
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  };
  const object = (input, operation) => {
    const value = snapshot(input);
    if (!keys(value, ["objectID", "signal"]) || !hash(value.objectID) || value.signal !== undefined && !(value.signal instanceof AbortSignal))
      throw deliveryError(operation, "invalid_request");
    return value;
  };
  return {
    getProtectedMediaCapabilities: async () => mediaCapability(await request("media_capabilities", "/capabilities")),
    getProtectedMediaTransferCapabilities: async () => mediaTransferCapability(await request("media_transfer_capabilities", "/transfer/capabilities")),
    getProtectedMediaUploadProgress: async input => {
      const value = object(input, "media_upload_progress");
      const result = mediaUploadProgress(await request("media_upload_progress", `/objects/${value.objectID}/upload-progress`, { signal: value.signal }));
      if (result.object.objectID !== value.objectID) throw deliveryError("media_upload_progress", "invalid_response");
      return result;
    },
    beginProtectedMedia: async input => {
      const value = mediaBeginInput(input);
      // Go's request hash uses the fixed field order and encoding/json escapes.
      const body = JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
      const result = mediaMetadata(await request("media_begin", "/objects", { method: "POST", headers: { "content-type": "application/json" }, body }));
      if (result.uploadID !== value.upload.uploadID || result.filename !== value.upload.filename || result.sizeBytes !== value.upload.sizeBytes || result.sha256 !== value.upload.sha256)
        throw deliveryError("media_begin", "invalid_response");
      return result;
    },
    putProtectedMediaChunk: async input => {
      const value = snapshot(input);
      if (!keys(value, ["objectID", "index", "body", "signal"]) || !hash(value.objectID) || !Number.isSafeInteger(value.index) ||
          value.index < 0 || value.index >= FILE_BYTES / CHUNK_BYTES || !(value.body instanceof Uint8Array) || value.body.length < 1 || value.body.length > CHUNK_BYTES ||
          value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw deliveryError("media_chunk", "invalid_request");
      const body = new Uint8Array(value.body);
      const result = mediaMetadata(await request("media_chunk", `/objects/${value.objectID}/chunks/${value.index}`, { method: "PUT", body, signal: value.signal }));
      if (result.objectID !== value.objectID) throw deliveryError("media_chunk", "invalid_response");
      return result;
    },
    finalizeProtectedMedia: async input => {
      const value = object(input, "media_finalize");
      const result = mediaMetadata(await request("media_finalize", `/objects/${value.objectID}/finalize`, { method: "POST", signal: value.signal }));
      if (result.objectID !== value.objectID || !["uploaded_unbound", "bound"].includes(result.state)) throw deliveryError("media_finalize", "invalid_response");
      return result;
    },
    getProtectedMedia: async input => {
      const value = object(input, "media_status");
      const result = mediaMetadata(await request("media_status", `/objects/${value.objectID}`, { signal: value.signal }));
      if (result.objectID !== value.objectID) throw deliveryError("media_status", "invalid_response");
      return result;
    },
    cancelProtectedMedia: async input => {
      const value = object(input, "media_cancel");
      const result = mediaMetadata(await request("media_cancel", `/objects/${value.objectID}/cancel`, { method: "POST", signal: value.signal }));
      if (result.objectID !== value.objectID || result.state !== "cancelled") throw deliveryError("media_cancel", "invalid_response");
      return result;
    },
    readProtectedMediaRange: async input => {
      const value = snapshot(input);
      if (!keys(value, ["attachment", "start", "end", "signal"]) || !time(value.start) || !time(value.end) || value.end < value.start ||
          value.end - value.start >= CHUNK_BYTES || value.signal !== undefined && !(value.signal instanceof AbortSignal))
        throw deliveryError("media_range", "invalid_request");
      const attachment = mediaAttachment(value.attachment);
      if (attachment.sizeBytes === 0) {
        if (value.start !== 0 || value.end !== 0 || attachment.sha256 !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
          throw deliveryError("media_range", "invalid_request");
        return request("media_range", `/objects/${attachment.contentRef}/content`, { expiry: attachment.expiresAt, empty: attachment, signal: value.signal });
      }
      if (value.end >= attachment.sizeBytes) throw deliveryError("media_range", "invalid_request");
      return request("media_range", `/objects/${attachment.contentRef}/content`, { expiry: attachment.expiresAt,
        range: { ...attachment, start: value.start, end: value.end }, headers: { range: `bytes=${value.start}-${value.end}` }, signal: value.signal });
    },
  };
}
