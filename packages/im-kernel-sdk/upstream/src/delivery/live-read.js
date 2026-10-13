import { deliveryError, snapshot, keys, hash, text, time, decimal } from "./values";
import { strictBodyJSON } from "./media-contract";

export const LIVE_CUT = "qry_delivery_live_cut_v1";
export const LIVE_PAGE = "qry_delivery_live_page_v1";
export const LIVE_RECEIVER = "qry_delivery_live_receiver_v1";
export const LIVE_BYTES = 4194304;
export const liveTopic = topic => topic === LIVE_CUT || topic === LIVE_PAGE || topic === LIVE_RECEIVER;

export function liveRequest(topic, input) {
  const value = snapshot(input);
  const allowed = ["version", "readerVersion", "subscriberID", "scopeKey", "projectionKey", "projectionRevision",
    ...(topic === LIVE_PAGE ? ["direction", "anchorDeliveryCursor", "limit", "cutID"] : []),
    ...(topic === LIVE_CUT ? ["receiverBaselineID"] : [])];
  if (!liveTopic(topic) || !keys(value, allowed) || value.version !== 1 || value.readerVersion !== 2 || !/^[0-9a-f]{32}$/.test(value.subscriberID) ||
    !hash(value.scopeKey) || (topic === LIVE_RECEIVER ? value.projectionKey !== "" || value.projectionRevision !== "" : !hash(value.projectionKey) || !decimal(value.projectionRevision, true)) ||
    topic === LIVE_CUT && value.receiverBaselineID !== undefined && !/^[0-9a-f]{32}$/.test(value.receiverBaselineID) ||
    topic === LIVE_PAGE && (value.direction !== "newer" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 32 ||
      !/^[0-9a-f]{32}$/.test(value.cutID) || value.anchorDeliveryCursor !== undefined && !decimal(value.anchorDeliveryCursor)))
    throw deliveryError("live_read", "invalid_request");
  // Canonical request order matches the private Go v1 decoder, including the
  // absent optional anchor. No public reader protobuf fields are changed.
  return Object.freeze({ version: 1, readerVersion: 2, subscriberID: value.subscriberID, scopeKey: value.scopeKey,
    projectionKey: value.projectionKey, projectionRevision: value.projectionRevision,
    ...(topic === LIVE_PAGE ? { direction: "newer", ...(value.anchorDeliveryCursor ? { anchorDeliveryCursor: value.anchorDeliveryCursor } : {}),
      limit: value.limit, cutID: value.cutID } : {}),
    ...(topic === LIVE_CUT && value.receiverBaselineID ? { receiverBaselineID: value.receiverBaselineID } : {}) });
}

export function decodeLive(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > LIVE_BYTES)
    throw deliveryError("live_read", "invalid_response");
  return strictBodyJSON(new TextDecoder("utf-8", { fatal: true }).decode(bytes), LIVE_BYTES);
}

// The only writer is the original protected query callback. Public read methods
// never accept a DTO as a cut/page/observation, and cloned handles are useless.
export default function LiveRead(current, origin, validatePage) {
  const cuts = new WeakMap();
  const pages = new WeakMap();
  const registered = new Map();
  const baselines = new WeakMap();
  const receiverRegistered = new Map();
  const running = { value: 0 };
  const same = owner => {
    const latest = current();
    return latest && latest.socket === owner.socket && latest.generation === owner.generation && latest.receiverID === owner.receiverID;
  };
  const valid = captured => captured && same(captured.owner) && performance.now() < captured.deadline && Date.now() < captured.cut.expiresAt;
  const cut = handle => { const captured = cuts.get(handle); return valid(captured) ? captured.cut : undefined; };
  const page = handle => { const captured = pages.get(handle); return valid(captured) ? captured.value : undefined; };
  const baseline = handle => { const captured = baselines.get(handle); return valid(captured) ? captured.cut : undefined; };
  const accept = async (topic, request, response) => {
    const owner = current();
    if (!owner || running.value >= 8) throw deliveryError("live_read", owner ? "capacity" : "unsupported_capability");
    const opened = performance.now(), receivedAt = Date.now();
    running.value++;
    try {
      if (topic === LIVE_RECEIVER) {
        const value = snapshot(response), basis = snapshot(value?.baseline);
        if (!keys(value, ["version", "baseline"]) || value.version !== 1 ||
          !keys(basis, ["version", "baselineID", "subscriberID", "scopeKey", "receiverID", "acceptanceSendboxID", "serverNow", "expiresAt"]) ||
          basis.version !== 1 || !/^[0-9a-f]{32}$/.test(basis.baselineID) || basis.subscriberID !== request.subscriberID || basis.scopeKey !== request.scopeKey || basis.receiverID !== owner.receiverID ||
          !decimal(basis.acceptanceSendboxID) || !time(basis.serverNow,true) || !time(basis.expiresAt,true) || basis.expiresAt <= basis.serverNow || basis.expiresAt > basis.serverNow+86400000 || basis.expiresAt <= receivedAt)
          throw deliveryError("live_read", "invalid_response");
        const old = receiverRegistered.get(basis.subscriberID);
        if (old && same(old.owner)) {
          if (JSON.stringify(old.cut)!==JSON.stringify(basis) || !valid(old)) throw deliveryError("live_read","conflict");
          return old.handle;
        }
        if (receiverRegistered.size>=64) throw deliveryError("live_read","capacity");
        if (!same(owner)) throw deliveryError("live_read","disconnected");
        const handle=Object.freeze({});
        const captured={owner,handle,cut:Object.freeze(basis),deadline:opened+(basis.expiresAt-basis.serverNow)};
        baselines.set(handle,captured);receiverRegistered.set(basis.subscriberID,captured);
        return handle;
      }
      if (topic === LIVE_CUT) {
        const value = snapshot(response), basis = snapshot(value?.cut);
        if (!keys(value, ["version", "cut"]) || value.version !== 1 ||
          !keys(basis, ["version", "cutID", "subscriberID", "scopeKey", "projectionKey", "conversationScopeKey", "acceptanceRevision", "receiverID", "serverNow", "expiresAt", "receiverBaselineID", "acceptanceSendboxID"]) ||
          basis.version !== 1 || basis.subscriberID !== request.subscriberID || !/^[0-9a-f]{32}$/.test(basis.cutID) || basis.scopeKey !== request.scopeKey || basis.projectionKey !== request.projectionKey ||
          !hash(basis.conversationScopeKey) || !decimal(basis.acceptanceRevision) || basis.receiverID !== owner.receiverID ||
          !time(basis.serverNow, true) || !time(basis.expiresAt, true) || (basis.expiresAt <= basis.serverNow || basis.expiresAt > basis.serverNow + 86400000) || basis.expiresAt <= receivedAt)
          throw deliveryError("live_read", "invalid_response");
        if (request.receiverBaselineID !== undefined) {
          const receiver=receiverRegistered.get(request.subscriberID);
          if (!valid(receiver) || receiver.cut.baselineID!==request.receiverBaselineID || basis.receiverBaselineID!==request.receiverBaselineID || basis.acceptanceSendboxID!==receiver.cut.acceptanceSendboxID || basis.scopeKey!==receiver.cut.scopeKey || basis.expiresAt!==receiver.cut.expiresAt || basis.acceptanceRevision!=="0")
            throw deliveryError("live_read","invalid_response");
        } else if (basis.receiverBaselineID!==undefined || basis.acceptanceSendboxID!==undefined) throw deliveryError("live_read","invalid_response");
        const old = registered.get(basis.subscriberID+":"+basis.projectionKey);
        if (old && same(old.owner)) {
          if (JSON.stringify(old.cut) !== JSON.stringify(basis) || !valid(old)) throw deliveryError("live_read", "conflict");
          return old.handle;
        }
        if (registered.size >= 64) throw deliveryError("live_read", "capacity");
        if (!same(owner)) throw deliveryError("live_read", "disconnected");
        const handle = Object.freeze({});
        const captured = { owner, handle, cut: Object.freeze(basis), deadline: opened + (basis.expiresAt - basis.serverNow) };
        cuts.set(handle, captured); registered.set(basis.subscriberID+":"+basis.projectionKey, captured);
        return handle;
      }
      const captured = registered.get(request.subscriberID+":"+request.projectionKey);
      const value = snapshot(response);
      if (!valid(captured) || captured.cut.cutID !== request.cutID || !keys(value, ["version", "cutID", "page", "proofs"]) || value.version !== 1 ||
        value.cutID !== request.cutID || !Array.isArray(value.proofs) || value.proofs.length > 32 || !snapshot(value.page))
        throw deliveryError("live_read", "invalid_response");
      const original = validatePage({ version: 2, scopeKey: request.scopeKey, projectionKey: request.projectionKey,
        projectionRevision: request.projectionRevision, direction: request.direction,
        ...(request.anchorDeliveryCursor !== undefined ? { anchorDeliveryCursor: request.anchorDeliveryCursor } : {}), limit: request.limit }, value.page);
      if (!keys(original, ["version", "scopeKey", "projectionKey", "projectionRevision", "direction", "nextDeliveryCursor", "finished", "serverNow", "items"]))
        throw deliveryError("live_read", "invalid_response");
      const proofs = new Map();
      for (const input of value.proofs) {
        const proof = snapshot(input);
        if (!keys(proof, ["effectKey", "conversationScopeKey", "allocationRevision", "contentHash", "acceptedSendboxID"]) || !hash(proof.effectKey) || proofs.has(proof.effectKey) ||
          proof.conversationScopeKey !== captured.cut.conversationScopeKey || !decimal(proof.allocationRevision, true) ||
          BigInt(proof.allocationRevision) <= BigInt(captured.cut.acceptanceRevision) || !hash(proof.contentHash))
          throw deliveryError("live_read", "invalid_response");
        if (captured.cut.receiverBaselineID !== undefined ? !decimal(proof.acceptedSendboxID,true) || BigInt(proof.acceptedSendboxID)<=BigInt(captured.cut.acceptanceSendboxID) : proof.acceptedSendboxID !== undefined)
          throw deliveryError("live_read","invalid_response");
        proofs.set(proof.effectKey, proof);
      }
      const facts = [];
      for (const item of original.items) {
        if (!keys(item, ["effectKey", "messageId", "sequence", "deliveryCursor", "messageTime", "expiresAt", "senderId", "targetId", "conversationType", "content", "isSend", "isRead", "messageType"]))
          throw deliveryError("live_read", "invalid_response");
        const proof = proofs.get(item.effectKey);
        if (!proof) continue;
        if (item.isSend || item.messageType !== "jg:text" || item.senderId === owner.receiverID || !text(item.senderId, 512))
          throw deliveryError("live_read", "invalid_response");
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.content)));
        if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== proof.contentHash)
          throw deliveryError("live_read", "invalid_response");
        proofs.delete(item.effectKey);
        facts.push({ version: 1, generation: owner.generation, receiverID: owner.receiverID,
          conversationType: item.conversationType, conversationID: item.targetId, messageID: item.messageId,
          sequence: item.sequence, senderID: item.senderId, messageTime: item.messageTime,
          wireContent: item.content, messageType: "jg:text", isSend: false, hasReference: false,
          originalDestroyTime: item.expiresAt });
      }
      if (proofs.size) throw deliveryError("live_read", "invalid_response");
      if (!same(owner) || !valid(captured) || performance.now() >= opened + 1000)
        throw deliveryError("live_read", "stale");
      const observations = Object.freeze(facts.map(fact => origin.seal(fact)));
      original.items.forEach(Object.freeze); Object.freeze(original.items); Object.freeze(original);
      const handle = Object.freeze({});
      pages.set(handle, { owner, cut: captured.cut, deadline: opened + 30000,
        value: Object.freeze({ page: original, observations, receivedAt, deadline: opened + 30000 }) });
      return handle;
    } finally { running.value--; }
  };
  return { accept, cut, page, baseline, pending: () => running.value,
    clear: () => { registered.clear(); receiverRegistered.clear(); } };
}
