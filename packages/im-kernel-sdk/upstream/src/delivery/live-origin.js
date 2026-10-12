import Proto from "../socket/proto";
import { wireInteger, safeInteger } from "./codec";
import { deliveryError, keys, utf8 } from "./contract";
import { strictBodyJSON } from "./media-contract";

const text = (value, limit = 512) => typeof value === "string" && value.length > 0 &&
  !value.includes("\0") && new TextEncoder().encode(value).length <= limit;

// These observations are transport facts, never task or membership grants.
// Only the current IO's original WS frame path can call publish.
export default function LiveOrigin(current) {
  const listeners = new Set();
  const observations = new WeakMap();
  const read = (observation) => {
    const captured = observations.get(observation);
    const owner = current();
    return captured && owner && owner.generation === captured.generation &&
      owner.receiverID === captured.receiverID ? captured : undefined;
  };
  const subscribe = (callback) => {
    if (typeof callback !== "function") throw deliveryError("live_observation", "invalid_request");
    if (listeners.size >= 64) throw deliveryError("live_observation", "capacity");
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  const publish = (stream) => {
    const owner = current();
    if (!owner || !listeners.size || !(stream instanceof Uint8Array) || stream.length > 131072) return;
    const fact = decode(stream, owner);
    const latest = current();
    if (!fact || !latest || latest.generation !== owner.generation || latest.receiverID !== owner.receiverID) return;
    const observation = seal(fact);
    for (const callback of listeners) {
      // One observer cannot break the transport or another observer's subscription.
      try { callback(observation); } catch (_) {}
    }
  };
  const seal = (fact) => {
    const owner = current();
    if (!owner || owner.generation !== fact.generation || owner.receiverID !== fact.receiverID) throw deliveryError("live_observation", "disconnected");
    const observation = Object.freeze({}); observations.set(observation, Object.freeze(fact)); return observation;
  };
  return { subscribe, read, publish, seal };
}

function decode(stream, owner) {
  try {
    const envelope = Proto.lookup("codec.PublishMsgBody").decode(stream);
    if (envelope.topic !== "msg" || envelope.data.length > 100352) return;
    const message = Proto.lookup("codec.DownMsg").decode(envelope.data);
    if (message.msgType !== "jg:text" || ![1, 2].includes(message.type) || message.isDelete ||
      !text(message.targetId) || !text(message.senderId) || !text(message.msgId) ||
      message.msgContent.length > 65536) return;
    const wireContent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(message.msgContent);
    const content = strictBodyJSON(wireContent, 65536);
    if (!keys(content, ["content"]) || !utf8(content.content, 65536, true)) return;
    const sequence = wireInteger(envelope.data, 6);
    const messageTime = safeInteger(envelope.data, 8);
    const originalDestroyTime = safeInteger(envelope.data, 31);
    if (sequence === "0" || messageTime <= 0 || originalDestroyTime > 0 && originalDestroyTime <= messageTime) return;
    return { version: 1, generation: owner.generation, receiverID: owner.receiverID,
      conversationType: message.type, conversationID: message.targetId, messageID: message.msgId,
      sequence, senderID: message.senderId, messageTime, wireContent, messageType: "jg:text",
      isSend: message.isSend, hasReference: message.referMsg !== null && message.referMsg !== undefined,
      ...(originalDestroyTime > 0 ? { originalDestroyTime } : {}) };
  } catch (_) {
    // Invalid or unrelated pushes retain ordinary protected connection semantics.
    return;
  }
}
