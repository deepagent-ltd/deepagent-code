import { afterEach, expect, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import Proto from "../upstream/src/socket/proto";
import { SIGNAL_CMD } from "../upstream/src/enum";
import { IMDeviceProof } from "../../deepagent-code/src/im/device-proof";
await import("../../deepagent-code/src/im/kernel/shims");
const JuggleIM = (await import("../lib/index.js")).default;
const IO = (await import("../upstream/src/socket/io")).default;
const servers = [];
afterEach(() => servers.splice(0).forEach(server => server.stop(true)));
const wait = async (predicate) => {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 3000) throw new Error("Device protocol condition timed out"); await Bun.sleep(5); }
};
const encode = (name, value) => Proto.lookup(`codec.${name}`).encode(value).finish();
const xor = (bytes, key) => Uint8Array.from(bytes, (value, index) => value ^ key[index % 8]);
function fixture(options = {}) {
  const key = IMDeviceProof.identity();
  const token = "fixture-daim2-device-token";
  const state = { connections: [], queries: [], http: [], signCalls: 0, proofPaused: options.pauseProof === true,
    release: undefined, httpPaused: options.pauseNav === true, httpRelease: undefined,
    jtis: new Set(), challenges: [], verified: 0, healthTokens: [] };
  const proof = (jwt, expected) => {
    const parts = jwt.split(".");
    const header = JSON.parse(Buffer.from(parts[0], "base64url"));
    const payload = JSON.parse(Buffer.from(parts[1], "base64url"));
    expect(header.alg).toBe("ES256");
    expect(header.jwk).toEqual(key.publicJwk);
    expect(header.jwk.d).toBeUndefined();
    expect(verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), {
      key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
    }, Buffer.from(parts[2], "base64url"))).toBe(true);
    expect(payload).toMatchObject(expected);
    expect(state.jtis.has(payload.jti)).toBe(false); state.jtis.add(payload.jti);
    return payload;
  };
  const send = (peer, cmd, name, value) => peer.send(encode("ImWebsocketMsg", {
    version: 1, cmd, qos: 1, payload: xor(encode(name, value), peer.data.key),
  }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, owner) {
      const path = new URL(request.url).pathname;
      if (path === "/im" && owner.upgrade(request, { data: {} })) return;
      if (path === "/health") { state.healthTokens.push(request.headers.get("x-token")); return Response.json({ code: 0 }); }
      if (path === "/navigator/general" || path.startsWith("/navigator/protected-media/")) {
        state.http.push(path);
        expect(request.headers.get("authorization")).toBe(`DPoP ${token}`);
        expect(request.headers.get("x-token")).toBeNull();
        proof(request.headers.get("DPoP"), { htm: "GET", htu: request.url, ath: IMDeviceProof.credentialHash(token) });
        if (path === "/navigator/general") return Response.json({ code: 0, data: { user_id: "receiver", servers: [owner.url.origin] } }, { headers: { "cache-control": "no-store" } });
        return Response.json({ version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
          maxFileBytes: 10485760, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true },
          { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      return new Response(null, { status: 404 });
    }, websocket: {
      message(peer, bytes) {
        const envelope = Proto.lookup("codec.ImWebsocketMsg").decode(new Uint8Array(bytes));
        if (envelope.cmd === SIGNAL_CMD.CONNECT) {
          if (!peer.data.key) peer.data.key = Uint8Array.from([10, 8, 106, 117, 103, 57, 108, 101], (value, index) => value ^ envelope.payload[index]);
          const input = Proto.lookup("codec.ConnectMsgBody").decode(xor(envelope.payload, peer.data.key));
          state.connections.push(input);
          if (options.downgrade) { send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 0, userId: "receiver", timestamp: Date.now() }); return; }
          const ext = JSON.parse(input.ext);
          expect(input.token).toBe(token); expect(input.deviceId).toBe(key.jkt);
          if (!peer.data.challenge) {
            expect(ext).toEqual({ profile: "dac-im-connect-proof-v1" });
            const challenge = { profile: "dac-im-connect-proof-v1", nonce: "n".repeat(43), socketSession: `socket_${state.connections.length}_original`,
              audience: ownerAudience(), appkey: config.appkey, credentialDigest: IMDeviceProof.sha256(token),
              expiresAt: Date.now() + (options.challengeTTLms ?? 9000) + (options.serverClockOffsetMs ?? 0),
              ...options.challenge };
            peer.data.challenge = challenge; state.challenges.push(challenge);
            send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 11024, ext: JSON.stringify(challenge) }); return;
          }
          expect(Object.keys(ext)).toEqual(["profile", "proof"]);
          const challenge = peer.data.challenge;
          const claims = proof(ext.proof, { purpose: "im-connect", aud: challenge.audience, nonce: challenge.nonce,
            sid: challenge.socketSession, ath: IMDeviceProof.credentialHash(token), entitlementID: "e".repeat(32), bindingVersion: 1 });
          if (options.serverClockOffsetMs !== undefined) {
            const serverNow = Math.floor((Date.now() + options.serverClockOffsetMs) / 1000);
            expect(claims.iat).toBeGreaterThanOrEqual(serverNow - 30);
            expect(claims.iat).toBeLessThanOrEqual(serverNow + 5);
            expect(claims.exp).toBeGreaterThan(serverNow);
            expect(claims.exp - claims.iat).toBe(10);
            expect(claims.exp).toBe(Math.floor(challenge.expiresAt / 1000));
          }
          state.verified++;
          send(peer, SIGNAL_CMD.CONNECT_ACK, "ConnectAckMsgBody", { code: 0, userId: "receiver", timestamp: Date.now(), ext: '{"dacDeliveryLiveRead":2}' });
          return;
        }
        if (envelope.cmd === SIGNAL_CMD.QUERY) {
          const input = Proto.lookup("codec.QueryMsgBody").decode(xor(envelope.payload, peer.data.key));
          state.queries.push(input.topic);
          expect(state.verified).toBeGreaterThan(0);
          expect(input.topic).toBe("qry_user_info");
          send(peer, SIGNAL_CMD.QUERY_ACK, "QueryAckMsgBody", { index: input.index, code: 0, timestamp: Date.now(),
            data: encode("UserInfo", { userId: "receiver", nickname: "Receiver" }) });
        }
      },
    },
  });
  servers.push(server);
  const ownerAudience = () => server.url.origin.replace("http:", "ws:") + "/im";
  const auth = { profile: "dac-im-device-v1", publicJwk: key.publicJwk, jkt: key.jkt,
    entitlementID: "e".repeat(32), bindingVersion: 1, socketAudience: ownerAudience(), allowInsecureLoopbackForTests: true,
    async signConnect(challenge, source) {
      state.signCalls++;
      if (state.proofPaused) await new Promise(resolve => { state.release = resolve; });
      return IMDeviceProof.socket(key, challenge, { ...source, appkey: config.appkey, entitlementID: auth.entitlementID,
        bindingVersion: auth.bindingVersion, allowLoopback: true });
    },
    async signHttp(input) {
      if (state.httpPaused) await new Promise(resolve => { state.httpRelease = resolve; });
      return { authorization: `DPoP ${input.credential}`, "X-IM-Challenge-ID": "fixture_challenge_id_123",
        DPoP: IMDeviceProof.http(key, { method: input.method, url: input.url, nonce: "n".repeat(43), credential: input.credential, allowLoopback: true }) };
    },
  };
  const config = { appkey: `device_${server.port}`, navList: [server.url.origin], protectedDeliveryReader: true, protectedMedia: true,
    protectedDeviceAuth: auth, log: { isConsole: false } };
  return { state, config, token, make: () => JuggleIM.init(config) };
}

test("actual generated SDK performs two Connects, real ES256 verification, HTTP DPoP and preserved live capability", async () => {
  const f = fixture({ pauseProof: true }); const client = f.make();
  const connected = client.connect({ token: f.token });
  try {
    await wait(() => f.state.signCalls === 1);
    expect(client.isConnected()).toBe(false); expect(client.isProtectedLiveReadAvailable()).toBe(false);
    expect(client.captureProtectedCurrentLink()).toBeUndefined(); expect(f.state.queries).toHaveLength(0);
    expect(f.state.connections).toHaveLength(1); f.state.release();
    await connected;
    expect(f.state.connections).toHaveLength(2); expect(f.state.verified).toBe(1);
    expect(client.isConnected()).toBe(true); expect(client.isProtectedLiveReadAvailable()).toBe(true);
    await client.getProtectedMediaCapabilities();
    expect(f.state.http).toEqual(["/navigator/general", "/navigator/protected-media/v1/capabilities"]);
    expect(f.state.healthTokens).toEqual([null]);
  } finally { await client.disconnect(); }
}, 15000);

test("a standard success ACK cannot downgrade a device-enabled SDK", async () => {
  const f = fixture({ downgrade: true }); const client = f.make();
  try { await expect(client.connect({ token: f.token })).rejects.toMatchObject({ code: 11025 });
    expect(client.isConnected()).toBe(false); expect(f.state.queries).toHaveLength(0);
  } finally { await client.disconnect(); }
});

for (const challenge of [{ profile: "unknown" }, { audience: "wss://wrong.example/im" }, { credentialDigest: "a".repeat(64) }, { expiresAt: 1 }])
  test(`invalid challenge never gets a second Connect: ${JSON.stringify(challenge)}`, async () => {
    const f = fixture({ challenge }); const client = f.make();
    try { await expect(client.connect({ token: f.token })).rejects.toMatchObject({ code: challenge.expiresAt === 1 ? 11027 : 11026 });
      expect(f.state.connections).toHaveLength(1); expect(f.state.signCalls).toBe(0); expect(client.isConnected()).toBe(false);
    } finally { await client.disconnect(); }
  });

test("a signer completed after disconnect cannot send a second Connect or resolve the old source", async () => {
  const f = fixture({ pauseProof: true }); const client = f.make();
  const result = client.connect({ token: f.token }).catch(error => error);
  await wait(() => f.state.signCalls === 1);
  await client.disconnect(); f.state.release(); await result; await Bun.sleep(20);
  expect(f.state.connections).toHaveLength(1); expect(f.state.queries).toHaveLength(0);
  expect(client.isConnected()).toBe(false);
});

test("a media signature completed after disconnect sends no HTTP operation", async () => {
  const f = fixture(); const client = f.make();
  try {
    await client.connect({ token: f.token }); f.state.httpPaused = true;
    const result = client.getProtectedMediaCapabilities().catch(error => error);
    await wait(() => !!f.state.httpRelease); await client.disconnect(); f.state.httpRelease(); await result;
    expect(f.state.http).toEqual(["/navigator/general"]);
  } finally { await client.disconnect(); }
});

test("every reconnect obtains a new Connect proof and never reuses the previous connection", async () => {
  const f = fixture(); const client = f.make();
  try {
    await client.connect({ token: f.token });
    await client.disconnect();
    await client.connect({ token: f.token });
    expect(f.state.connections).toHaveLength(4);
    expect(f.state.signCalls).toBe(2); expect(f.state.verified).toBe(2);
    expect(f.state.challenges[0].socketSession).not.toBe(f.state.challenges[1].socketSession);
    expect(JSON.parse(f.state.connections[1].ext).proof).not.toBe(JSON.parse(f.state.connections[3].ext).proof);
    expect(client.isProtectedLiveReadAvailable()).toBe(true);
  } finally { await client.disconnect(); }
});

test("a navigation signer completed after disconnect dispatches no HTTP and settles the old connect", async () => {
  const f = fixture({ pauseNav: true }); const client = f.make();
  const result = client.connect({ token: f.token }).catch(error => error);
  await wait(() => !!f.state.httpRelease);
  await client.disconnect(); await result; f.state.httpRelease(); await Bun.sleep(20);
  expect(f.state.http).toHaveLength(0); expect(f.state.connections).toHaveLength(0);
  expect(client.isConnected()).toBe(false);
});

test("the configured socket audience must equal the socket actually opened", async () => {
  const f = fixture(); f.config.protectedDeviceAuth.socketAudience = "wss://wrong.example/im";
  const client = f.make();
  try {
    await expect(client.connect({ token: f.token })).rejects.toMatchObject({ code: 11025 });
    expect(f.state.connections).toHaveLength(0); expect(f.state.signCalls).toBe(0);
  } finally { await client.disconnect(); }
});

for (const serverClockOffsetMs of [300, 29000, -5000])
  test(`generated SDK accepts bounded server clock ${serverClockOffsetMs}ms without extending the signed interval`, async () => {
    const f = fixture({ serverClockOffsetMs, challengeTTLms: 10000 }); const client = f.make();
    try {
      await client.connect({ token: f.token });
      expect(f.state.connections).toHaveLength(2); expect(f.state.verified).toBe(1);
      expect(client.isConnected()).toBe(true); expect(client.captureProtectedCurrentLink()).toBeDefined();
    } finally { await client.disconnect(); }
  });

test("generated SDK refuses a challenge beyond the bounded server clock before invoking the signer", async () => {
  const f = fixture({ serverClockOffsetMs: 31000, challengeTTLms: 10000 }); const client = f.make();
  try {
    await expect(client.connect({ token: f.token })).rejects.toMatchObject({ code: 11026 });
    expect(f.state.connections).toHaveLength(1); expect(f.state.signCalls).toBe(0); expect(f.state.verified).toBe(0);
  } finally { await client.disconnect(); }
});

test("generated SDK caps a pending signer at ten real seconds despite server clock lead", async () => {
  const f = fixture({ serverClockOffsetMs: 29000, challengeTTLms: 10000, pauseProof: true }); const client = f.make();
  const started = performance.now();
  try {
    await expect(client.connect({ token: f.token })).rejects.toMatchObject({ code: 11027 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(9500);
    expect(performance.now() - started).toBeLessThan(14000);
    expect(f.state.connections).toHaveLength(1); expect(f.state.signCalls).toBe(1); expect(f.state.verified).toBe(0);
  } finally { await client.disconnect(); f.state.release?.(); }
}, 15000);

test("Connect logging retains command metadata without tokens, challenges or proofs", async () => {
  const f = fixture(); const output = [];
  const io = IO({ ...f.config, isSync: false, isPC: false, logger: { info: value => output.push(value) } });
  try {
    await new Promise((resolve, reject) => io.connect({ token: f.token, deviceId: f.config.protectedDeviceAuth.jkt }, result => {
      if (result.error.code !== 0) return reject(result.error);
      result.next(); resolve(result);
    }));
    io.disconnect();
    const log = JSON.stringify(output);
    expect(log).toContain("cmd"); expect(log).toContain("bytes");
    expect(log).not.toContain(f.token);
    expect(log).not.toContain(f.state.challenges[0].nonce);
    expect(log).not.toContain(JSON.parse(f.state.connections[1].ext).proof);
  } finally { io.disconnect(); }
});
