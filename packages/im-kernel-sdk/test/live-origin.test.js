import { expect, test } from "bun:test";
import Proto from "../upstream/src/socket/proto";
import { SIGNAL_CMD } from "../upstream/src/enum";

await import("../../deepagent-code/src/im/kernel/shims");
const JuggleIM = (await import("../lib/index.js")).default;
const { KernelTaskLiveOrigin } = await import("../../deepagent-code/src/im/kernel/task-live-origin");

test("original protected WS observations are frozen and current; NTF/history/copies grant no observation", async () => {
  const fixture = socket();
  const received = [];
  const waiters = new Map();
  const client = JuggleIM.init({ appkey: `private-live-${fixture.server.port}`, navList: [fixture.server.url.origin],
    protectedDeliveryReader: true });
  const receive = (handle) => {
    const value = client.readProtectedLiveMessage(handle);
    received.push({ handle, value });
    waiters.get(value.messageID)?.(value);
  };
  const unsubscribe = client.onProtectedLiveMessage(receive);
  const pending = (id) => {
    const deferred = Promise.withResolvers();
    waiters.set(id, deferred.resolve);
    return deferred.promise;
  };
  const handles = [];
  const releaseCapture = KernelTaskLiveOrigin.subscribe(client, (handle) => handles.push(handle));
  try {
    await client.connect({ token: "private-live-test-token" });
    const first = pending("first-live");
    fixture.publish({ msgId: "first-live" });
    expect(await first).toMatchObject({ version: 1, receiverID: "receiver", conversationType: 1,
      conversationID: "sender", senderID: "sender", messageID: "first-live", sequence: "1",
      messageType: "jg:text", wireContent: '{"content":"real WS 中文"}', isSend: false, hasReference: false });
    expect(received[0].value.originalDestroyTime).toBeUndefined();
    expect(Object.isFrozen(received[0].handle)).toBe(true);
    expect(Object.isFrozen(received[0].value)).toBe(true);
    expect(Object.keys(received[0].handle)).toEqual([]);
    expect(client.readProtectedLiveMessage({ ...received[0].handle })).toBeUndefined();
    expect(KernelTaskLiveOrigin.read(handles[0])).toMatchObject({ observation: received[0].value });
    expect(KernelTaskLiveOrigin.read({ ...handles[0] })).toBeUndefined();
    expect(JuggleIM.init({ appkey: "other", protectedDeliveryReader: true })
      .readProtectedLiveMessage(received[0].handle)).toBeUndefined();
    expect(() => client.emit(JuggleIM.Event.MESSAGE_RECEIVED, {})).toThrow();
    expect(() => client.on(JuggleIM.Event.MESSAGE_RECEIVED, receive)).toThrow();
    const history = await client.getDeliveryMessages({ version: 1, scopeKey: "a".repeat(64), projectionKey: "b".repeat(64),
      projectionRevision: "1", direction: "older", limit: 1 });
    expect(history.items[0].messageId).toBe("native-history");
    expect(received).toHaveLength(1);
    expect(() => client.getHistoryMessages({ conversationType: 1, conversationId: "sender" })).toThrow();
    const large = pending("large-sequence");
    fixture.publish({ msgId: "large-sequence", msgIndex: "9007199254740993", referMsg: { msgId: "original" } });
    expect(await large).toMatchObject({ sequence: "9007199254740993", hasReference: true,
      wireContent: '{"content":"real WS 中文"}' });
    const before = fixture.topics.length;
    fixture.publish({}, "ntf");
    fixture.publish({ msgId: "bad-kind", msgType: "dac:media.v1" });
    fixture.publish({ msgId: "bad-identity", senderId: "" });
    fixture.publish({ msgId: "bad-sequence", msgIndex: 0 });
    fixture.publish({ msgId: "bad-text", msgContent: new Uint8Array([255]) });
    fixture.publish({ msgId: "duplicate-text", msgContent: new TextEncoder().encode('{"content":"first","content":"last"}') });
    fixture.publish({ msgId: "surrogate-text", msgContent: new TextEncoder().encode('{"content":"\\ud800"}') });
    fixture.publish({ msgId: "bad-size", msgContent: new Uint8Array(65537) });
    const barrier = pending("barrier-live");
    fixture.publish({ msgId: "barrier-live", destroyTime: Date.now() + 60_000 });
    expect((await barrier).originalDestroyTime).toBeGreaterThan(Date.now());
    expect(received.map((item) => item.value.messageID)).toEqual(["first-live", "large-sequence", "barrier-live"]);
    expect(fixture.topics.length).toBe(before);
    const old = received[0].handle;
    const oldCapture = handles[0];
    await client.disconnect();
    expect(client.readProtectedLiveMessage(old)).toBeUndefined();
    expect(KernelTaskLiveOrigin.read(oldCapture)).toBeUndefined();
    await client.connect({ token: "private-live-test-token" });
    expect(client.readProtectedLiveMessage(old)).toBeUndefined();
    const after = pending("new-generation");
    fixture.publish({ msgId: "new-generation" });
    expect((await after).generation).toBeGreaterThan(received[0].value.generation);
    releaseCapture();
    expect(KernelTaskLiveOrigin.read(handles.at(-1))).toBeUndefined();
    unsubscribe();
    const stopped = received.length;
    const verified = Promise.withResolvers();
    const release = client.onProtectedLiveMessage((handle) => verified.resolve(client.readProtectedLiveMessage(handle)));
    fixture.publish({ msgId: "unsubscribed" });
    expect((await verified.promise).messageID).toBe("unsubscribed");
    release();
    expect(received).toHaveLength(stopped);
    expect(fixture.connected).toBe(2);
  } finally {
    unsubscribe();
    releaseCapture();
    await client.disconnect();
    fixture.server.stop(true);
  }
}, 20_000);

function socket() {
  const peers = [];
  const topics = [];
  const connected = { value: 0 };
  const encode = (name, value) => Proto.lookup(`codec.${name}`).encode(value).finish();
  const xor = (bytes, key) => Uint8Array.from(bytes, (value, index) => value ^ key[index % 8]);
  const send = (peer, cmd, name, value) => peer.send(encode("ImWebsocketMsg", {
    version: 1, cmd, qos: 1, payload: xor(encode(name, value), peer.data.key) }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, owner) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/navigator/general") return Response.json({ code: 0,
      data: { user_id: "receiver", servers: [owner.url.origin] } });
    if (pathname === "/health") return Response.json({ code: 0 });
    if (pathname === "/im" && owner.upgrade(request, { data: { key: undefined } })) return;
    return new Response(null, { status: 404 });
  }, websocket: {
    message(peer, payload) {
      const envelope = Proto.lookup("codec.ImWebsocketMsg").decode(new Uint8Array(payload));
      if (envelope.cmd === SIGNAL_CMD.CONNECT) {
        // Original SDK CONNECT carries the fixed protobuf protocol ID; derive
        // its protocol XOR mask without replacing the SDK's socket or decoder.
        const known = [10, 8, 106, 117, 103, 57, 108, 101];
        peer.data.key = Uint8Array.from(known, (value, index) => value ^ envelope.payload[index]);
        const request = Proto.lookup("codec.ConnectMsgBody").decode(xor(envelope.payload, peer.data.key));
        expect(request.protoId).toBe("jug9le1m");
        expect(request.token).toBe("private-live-test-token");
        peers.push(peer);
        connected.value++;
        send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 0, userId: "receiver", timestamp: Date.now() });
        return;
      }
      if (envelope.cmd !== SIGNAL_CMD.QUERY) return;
      const request = Proto.lookup("codec.QueryMsgBody").decode(xor(envelope.payload, peer.data.key));
      topics.push(request.topic);
      const data = request.topic === "qry_user_info" ? encode("UserInfo", { userId: "receiver", nickname: "Receiver" })
        : encode("DeliveryMessagesResult", { version: 1, scopeKey: "a".repeat(64), projectionKey: "b".repeat(64),
          projectionRevision: "1", direction: "older", nextDeliveryCursor: "1", finished: true, serverNow: Date.now(),
          items: [{ effectKey: "c".repeat(64), messageId: "native-history", sequence: "1", deliveryCursor: "1",
            messageTime: Date.now(), expiresAt: Date.now() + 60_000, senderId: "sender", targetId: "sender",
            conversationType: 1, content: '{"content":"history"}' }] });
      send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: request.index, code: 0, timestamp: Date.now(), data });
    },
  } });
  return { server, topics, get connected() { return connected.value; }, publish(input, topic = "msg") {
    const message = {
      targetId: "sender", type: 1, msgType: "jg:text", senderId: "sender", msgId: "incoming", msgIndex: 1,
      msgContent: new TextEncoder().encode('{"content":"real WS 中文"}'), msgTime: Date.now(), ...input };
    // The bundled protobuf writer supplies Number instead of Long. Encode the
    // native int64 field exactly so this actual WS also covers values above 2^53.
    const integer = { value: BigInt(message.msgIndex), bytes: [] };
    do {
      const byte = Number((integer.value & 127n).toString());
      integer.value >>= 7n;
      integer.bytes.push(byte | (integer.value > 0n ? 128 : 0));
    } while (integer.value > 0n);
    const data = topic === "ntf" ? encode("Notify", { syncTime: Date.now(), type: 1 }) : Uint8Array.from([
      ...encode("DownMsg", { targetId: message.targetId, type: message.type, msgType: message.msgType,
        senderId: message.senderId, msgId: message.msgId }),
      48, ...integer.bytes,
      ...encode("DownMsg", { ...message, targetId: undefined, type: undefined, msgType: undefined,
        senderId: undefined, msgId: undefined, msgIndex: undefined }),
    ]);
    send(peers.at(-1), SIGNAL_CMD.PUBLISH, "PublishMsgBody", { index: 1, topic, data, timestamp: Date.now() });
  } };
}
