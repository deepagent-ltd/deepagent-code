// DAC protected delivery contracts. These values describe one authenticated
// transport response; they are never authorization for a later operation.
import { mediaWireContent, strictBodyJSON } from "./media-contract";
import { deliveryError, snapshot, utf8, text, decimal, hash, time, keys } from "./values";
export { deliveryError, snapshot, utf8, text, decimal, hash, time, keys } from "./values";

export const topics = Object.freeze({
  qry_delivery_live_receiver_v1: ["live_receiver", "PrivateLiveJSON", 4096],
  qry_delivery_live_cut_v1: ["live_cut", "PrivateLiveJSON", 4096],
  qry_delivery_live_page_v1: ["live_page", "PrivateLiveJSON", 4194304],
  qry_delivery_reader: ["reader", "DeliveryReaderInfo", 4096],
  qry_delivery_changes: ["changes", "DeliveryChangesResult", 65536],
  qry_delivery_messages: ["messages", "DeliveryMessagesResult", 4194304],
  qry_delivery_read_cut: ["read_cut", "DeliveryReadCutResult", 4096],
  mark_delivery_read: ["mark_read", "DeliveryReadCutResult", 4096],
  qry_delivery_capabilities: ["capabilities", "DeliveryCapabilities", 4096],
  qry_delivery_receipt: ["receipt", "DeliveryReceiptResult", 4096],
});


export function wireError(operation, code) {
  return deliveryError(operation, ({ 11005: "denied", 12201: "reader_required",
    12202: "unavailable", 12203: "stale", 12204: "unknown", 12205: "capacity", 12206: "upgrade_required" })[code] || "unavailable", code);
}


export function readerRequest(topic, input) {
  const value = snapshot(input);
  const purpose = topics[topic]?.[0];
  const fields = {
    reader: ["version"],
    changes: ["version", "scopeKey", "after", "pageToken", "limit"],
    messages: ["version", "scopeKey", "projectionKey", "projectionRevision", "direction", "anchorDeliveryCursor", "limit"],
    read_cut: ["version", "scopeKey", "projectionKey", "projectionRevision"],
    mark_read: ["version", "scopeKey", "projectionKey", "projectionRevision", "throughOrdinal"],
  }[purpose];
  if (!fields || !keys(value, fields) || ![1, 2].includes(value.version) ||
      (purpose !== "reader" && !hash(value.scopeKey)) ||
      (["changes", "messages"].includes(purpose) && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 32)) ||
      (["messages", "read_cut", "mark_read"].includes(purpose) && (!hash(value.projectionKey) || !decimal(value.projectionRevision, true))) ||
      (purpose === "changes" && (!decimal(value.after) || (value.pageToken !== undefined && !text(value.pageToken, 1024)))) ||
      (purpose === "messages" && (!["older", "newer"].includes(value.direction) ||
        (value.anchorDeliveryCursor !== undefined && !decimal(value.anchorDeliveryCursor)))) ||
      (purpose === "mark_read" && !decimal(value.throughOrdinal))) throw deliveryError(purpose || "reader", "invalid_request");
  return Object.freeze(value);
}

export function receiptRequest(input) {
  const value = snapshot(input);
  if (!keys(value, ["version", "channelType", "targetId", "clientUid", "requestHash", "expiresAt"]) ||
      value.version !== 1 || ![1, 2].includes(value.channelType) || !text(value.targetId, 45) ||
      !text(value.clientUid, 2048) || !hash(value.requestHash) || !time(value.expiresAt, true))
    throw { ...deliveryError("receipt", "invalid_request"), msg: "receipt contract required" };
  return Object.freeze(value);
}

export function protectedInput(input) {
  const own = snapshot(input);
  const value = own ? { ...own, content: snapshot(own.content) } : undefined;
  if (!keys(value, ["tid", "clientMsgId", "name", "conversationType", "conversationId", "content", "deliveryExpiresAt"]) ||
      (value.tid !== undefined && !text(value.tid, 2048)) || value.name !== "jg:text" ||
      ![1, 2].includes(value.conversationType) || !text(value.conversationId, 45) || !text(value.clientMsgId, 2048) ||
      !keys(value.content, ["content"]) || !utf8(value.content.content, 65536, true) ||
      !time(value.deliveryExpiresAt, true) || value.deliveryExpiresAt <= Date.now() || value.deliveryExpiresAt > Date.now() + 259200000)
    throw { ...deliveryError("send", "invalid_request"), msg: "protected text contract required" };
  Object.freeze(value.content);
  return Object.freeze(value);
}

export function validateResult(topic, request, value) {
  const purpose = topics[topic][0];
  const require = condition => { if (!condition) throw deliveryError(purpose, "invalid_response"); };
  require(value.version === (purpose === "capabilities" || purpose === "receipt" ? 1 : request.version));
  if (purpose === "capabilities") {
    require(value.profile === "mysql-receipt-v1" && value.maxLifetimeMs === 259200000 && value.eventualDelivery === false &&
      Number.isSafeInteger(value.maxContentBytes) && value.maxContentBytes > 0 && value.maxContentBytes <= 65536);
    return value;
  }
  if (purpose === "receipt") {
    require(["confirmed_acceptance", "unknown", "not_found", "conflict", "expired", "unavailable"].includes(value.state));
    if (value.state === "confirmed_acceptance") require(value.clientUid === request.clientUid && value.requestHash === request.requestHash &&
      value.expiresAt === request.expiresAt && text(value.msgId, 2048) && time(value.msgTime, true) && decimal(value.msgSeqNo, true));
    return value;
  }
  require(hash(value.scopeKey) && time(value.serverNow, true));
  if (purpose === "reader") {
    require(decimal(value.currentCursor) && value.maxPageItems === 32 && value.maxChangeBytes === 65536 &&
      value.maxMessageBytes === 4194304 && value.maxWindowPages === 100000);
    return value;
  }
  require(value.scopeKey === request.scopeKey);
  if (purpose === "changes") {
    require(value.after === request.after && decimal(value.upper) && decimal(value.scanCursor) &&
      BigInt(value.upper) >= BigInt(request.after) && BigInt(value.scanCursor) >= BigInt(request.after) &&
      BigInt(value.scanCursor) <= BigInt(value.upper) && Array.isArray(value.items) && value.items.length <= request.limit &&
      typeof value.windowComplete === "boolean" && typeof value.caughtUp === "boolean" && (!value.caughtUp || value.windowComplete));
    require(value.windowComplete ? value.pageToken === "" : text(value.pageToken, 1024) && value.items.length > 0);
    const seen = new Set();
    let previous;
    for (const item of value.items) {
      require(hash(item.projectionKey) && !seen.has(item.projectionKey) && decimal(item.revision, true) && decimal(item.cursor, true) &&
        BigInt(item.cursor) >= BigInt(request.after) && BigInt(item.cursor) <= BigInt(value.upper) && ["visible", "revoked"].includes(item.visibility));
      require(!previous || BigInt(item.cursor) > BigInt(previous.cursor) || item.cursor === previous.cursor && item.projectionKey > previous.projectionKey);
      seen.add(item.projectionKey); previous = item;
      if (item.visibility === "revoked") {
        require([item.liveUnread, item.storedUnread, item.admittedOrdinal, item.readOrdinal, item.latestMessageId, item.latestSequence, item.targetId].every(x => x === "") &&
          item.nextExpiryAt === 0 && item.latestMessageTime === 0 && item.conversationType === 0);
        continue;
      }
      require([item.liveUnread, item.storedUnread, item.admittedOrdinal, item.readOrdinal].every(x => decimal(x)) &&
        BigInt(item.liveUnread) <= BigInt(item.storedUnread) && BigInt(item.readOrdinal) <= BigInt(item.admittedOrdinal) &&
        [1, 2].includes(item.conversationType) && text(item.targetId, 45) && time(item.nextExpiryAt));
      require(item.latestMessageId === "" ? item.latestSequence === "" && item.latestMessageTime === 0 :
        text(item.latestMessageId, 2048) && decimal(item.latestSequence, true) && time(item.latestMessageTime, true));
    }
    require(previous ? value.scanCursor === previous.cursor && value.scanProjectionKey === previous.projectionKey :
      value.windowComplete && (value.scanProjectionKey === "" || hash(value.scanProjectionKey)));
    return value;
  }
  require(value.projectionKey === request.projectionKey && decimal(value.projectionRevision, true));
  if (purpose === "messages") {
    require(value.projectionRevision === request.projectionRevision && value.direction === request.direction &&
      typeof value.finished === "boolean" && Array.isArray(value.items) && value.items.length <= request.limit);
    const seen = new Set();
    let previous = request.anchorDeliveryCursor;
    for (const item of value.items) {
      require(hash(item.effectKey) && !seen.has(item.effectKey) && text(item.messageId, 2048) && decimal(item.sequence, true) &&
        decimal(item.deliveryCursor, true) && time(item.messageTime, true) && time(item.expiresAt, true) &&
        item.expiresAt > value.serverNow && text(item.senderId, 45) && text(item.targetId, 45) &&
        [1, 2].includes(item.conversationType) && utf8(item.content, 65536) && typeof item.isSend === "boolean" && typeof item.isRead === "boolean");
      if (request.version === 1) {
        require(item.messageType === undefined || item.messageType === "");
        // Preserve the exact reader-v1 returned shape after the additive proto
        // field is generated; the old metadata hashes must remain unchanged.
        delete item.messageType;
      } else {
        require(["jg:text", "dac:media.v1"].includes(item.messageType));
        if (item.messageType === "dac:media.v1") mediaWireContent(item.content, item.expiresAt);
        if (item.messageType === "jg:text") {
          const content = snapshot(strictBodyJSON(item.content, 65536));
          require(keys(content, ["content"]) && utf8(content.content, 65536, true));
        }
      }
      require(previous === undefined || (request.direction === "older" ? BigInt(item.deliveryCursor) < BigInt(previous) : BigInt(item.deliveryCursor) > BigInt(previous)));
      seen.add(item.effectKey); previous = item.deliveryCursor;
    }
    require(value.items.length ? value.nextDeliveryCursor === previous : value.finished && value.nextDeliveryCursor === "");
    return value;
  }
  require([value.throughOrdinal, value.targetAdmittedOrdinal, value.readOrdinal, value.liveUnread, value.storedUnread].every(x => decimal(x)) &&
    BigInt(value.throughOrdinal) <= BigInt(value.targetAdmittedOrdinal) && BigInt(value.readOrdinal) <= BigInt(value.targetAdmittedOrdinal) &&
    BigInt(value.liveUnread) <= BigInt(value.storedUnread) && value.complete === (BigInt(value.readOrdinal) >= BigInt(value.targetAdmittedOrdinal)));
  require(purpose === "read_cut" ? value.projectionRevision === request.projectionRevision :
    value.throughOrdinal === request.throughOrdinal && BigInt(value.readOrdinal) >= BigInt(request.throughOrdinal) &&
    BigInt(value.projectionRevision) >= BigInt(request.projectionRevision));
  return value;
}
