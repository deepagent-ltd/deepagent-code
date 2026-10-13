import { LIVE_CUT, LIVE_PAGE, LIVE_RECEIVER, liveTopic, liveRequest } from "./live-read";
import { SIGNAL_CMD } from "../enum";
import { deliveryError, wireError, topics, readerRequest, receiptRequest, protectedInput, validateResult } from "./contract";
import MediaClient from "./media-client";
import { protectedMediaInput } from "./media-contract";

export default function DeliveryClient(io, message, protectedMedia = false) {
  const media = MediaClient(io, protectedMedia);
  const readerVersion = () => io.deliveryReceiverBaselineAvailable() ? 2 : protectedMedia ? 2 : 1;
  const current = () => ({ generation: io.deliveryGeneration(), user: io.getCurrentUser().id });
  const check = (source, operation) => {
    if (!io.isConnected() || source.generation !== io.deliveryGeneration() || source.user !== io.getCurrentUser().id)
      throw deliveryError(operation, "disconnected");
  };
  const query = (topic, request) => new Promise((resolve, reject) => {
    if (!io.isConnected()) return reject(deliveryError(topics[topic][0], "disconnected"));
    const source = current();
    io.sendCommand(SIGNAL_CMD.QUERY, { topic, userId: source.user,
      targetId: topic === "qry_delivery_receipt" ? request.targetId : source.user, request }, result => {
      try {
        if (result.deliveryError) return reject(result.deliveryError);
        check(source, topics[topic][0]);
        if (result.code) return reject(wireError(topics[topic][0], result.code));
        if (liveTopic(topic)) return io.acceptDeliveryLiveRead(topic, request, result.delivery).then(resolve, reject);
        resolve(validateResult(topic, request, result.delivery));
      } catch (error) { reject(error?.name === "DeliveryError" ? error : deliveryError(topics[topic][0], "invalid_response")); }
    }).catch(() => reject(deliveryError(topics[topic][0], "unavailable")));
  });
  const capabilities = () => query("qry_delivery_capabilities");
  const reader = (topic, input) => {
    const request = readerRequest(topic, input);
    if (request.version !== readerVersion()) throw deliveryError(topics[topic][0], "unsupported_capability");
    return query(topic, request);
  };
  return {
    getDeliveryCapabilities: capabilities,
    getDeliveryReceipt: async input => {
      const request = receiptRequest(input);
      const source = current();
      await capabilities();
      check(source, "receipt");
      return query("qry_delivery_receipt", request);
    },
    sendProtectedMessage: async input => {
      const value = protectedInput(input);
      const source = current();
      const capability = await capabilities();
      check(source, "send");
      if (new TextEncoder().encode(JSON.stringify(value.content)).length > capability.maxContentBytes)
        throw deliveryError("send", "invalid_request");
      const canonical = JSON.stringify(["dac.delivery.request.v1", value.conversationType, value.conversationId,
        value.clientMsgId, "jg:text", value.content.content, 10, value.deliveryExpiresAt])
        .replace(/[<>&\u2028\u2029]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
      check(source, "send");
      const requestHash = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      return message.sendMessage({ ...value, deliveryVersion: 1, deliveryRequestHash: requestHash, lifeTime: 0, lifeTimeAfterRead: 0 }).catch(result => {
        if (result?.error?.name === "DeliveryError") throw result.error;
        if (result?.error?.code) throw wireError("send", result.error.code);
        throw deliveryError("send", "unknown");
      });
    },
    ...media,
    sendProtectedMedia: async input => {
      if (!protectedMedia) throw deliveryError("media_send", "unsupported_capability");
      const value = protectedMediaInput(input);
      const source = current();
      await capabilities();
      check(source, "media_send");
      await media.getProtectedMediaCapabilities();
      check(source, "media_send");
      const canonical = JSON.stringify(["dac.delivery.media-request.v1", value.conversationType, value.conversationId,
        value.clientMsgId, "dac:media.v1", value.content, 10, value.deliveryExpiresAt])
        .replace(/[<>&\u2028\u2029]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
      check(source, "media_send");
      const requestHash = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const result = await message.sendMessage({ ...value, deliveryVersion: 1, deliveryRequestHash: requestHash, lifeTime: 0, lifeTimeAfterRead: 0 }).catch(result => {
        if (result?.error?.name === "DeliveryError") throw result.error;
        if (result?.error?.code) throw wireError("media_send", result.error.code);
        throw deliveryError("media_send", "unknown");
      });
      check(source, "media_send");
      return result;
    },
    getDeliveryReceiverBaseline: async input => {
      if (!io.deliveryReceiverBaselineAvailable()) throw deliveryError("live_read", "unsupported_capability");
      return query(LIVE_RECEIVER,liveRequest(LIVE_RECEIVER,{version:1,readerVersion:2,subscriberID:input.subscriberID,scopeKey:input.scopeKey,projectionKey:"",projectionRevision:""}));
    },
    getDeliveryLiveCut: async (input, baseline) => {
      if (!io.deliveryLiveReadAvailable()) throw deliveryError("live_read", "unsupported_capability");
      const original=baseline===undefined?undefined:io.readDeliveryReceiverBaseline(baseline);
      if (baseline!==undefined && (!original || original.subscriberID!==input.subscriberID || original.scopeKey!==input.scopeKey)) throw deliveryError("live_read","stale");
      return query(LIVE_CUT, liveRequest(LIVE_CUT, { version: 1, readerVersion: 2, subscriberID: input.subscriberID, scopeKey: input.scopeKey, projectionKey: input.projectionKey, projectionRevision: input.projectionRevision,
        ...(original?{receiverBaselineID:original.baselineID}:{}) }));
    },
    getDeliveryLiveMessages: async (input, cut) => {
      const basis = io.readDeliveryLiveCut(cut);
      if (!basis) throw deliveryError("live_read", "stale");
      return query(LIVE_PAGE, liveRequest(LIVE_PAGE, { version: 1, readerVersion: 2, subscriberID: basis.subscriberID, scopeKey: input.scopeKey,
        projectionKey: input.projectionKey, projectionRevision: input.projectionRevision, direction: input.direction,
        anchorDeliveryCursor: input.anchorDeliveryCursor, limit: input.limit, cutID: basis.cutID }));
    },
    getDeliveryReader: async () => reader("qry_delivery_reader", { version: readerVersion() }),
    getDeliveryChanges: async input => reader("qry_delivery_changes", input),
    getDeliveryMessages: async input => reader("qry_delivery_messages", input),
    getDeliveryReadCut: async input => reader("qry_delivery_read_cut", input),
    getDeliveryOutputProof: async input => reader("qry_delivery_output_proof", input),
    markDeliveryRead: async input => reader("mark_delivery_read", input),
  };
}
