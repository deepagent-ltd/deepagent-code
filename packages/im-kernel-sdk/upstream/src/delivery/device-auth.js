const PROFILE = "dac-im-connect-proof-v1";
const MAX_SERVER_CLOCK_LEAD_MS = 30000;
const proof = value => typeof value === "string" && value.length >= 100 && value.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
const exact = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.prototype.hasOwnProperty.call(value, name));
export const deviceError = (code = 11026) => ({ code, msg: "IM device proof was not verified" });
export function deviceConfig(value) {
  if (value === undefined) return;
  if (!value || value.profile !== "dac-im-device-v1" || typeof value.signConnect !== "function" || typeof value.signHttp !== "function" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.jkt) || !/^[a-f0-9]{32}$/.test(value.entitlementID) ||
    !Number.isSafeInteger(value.bindingVersion) || value.bindingVersion < 1 ||
    !exact(value.publicJwk, ["kty", "crv", "x", "y"]) || value.publicJwk.kty !== "EC" || value.publicJwk.crv !== "P-256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.publicJwk.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.publicJwk.y)) throw deviceError(11025);
  const url = new URL(value.socketAudience);
  if (url.href !== value.socketAudience || url.username || url.password || url.search || url.hash ||
    url.protocol !== "wss:" && !(value.allowInsecureLoopbackForTests === true && url.protocol === "ws:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw deviceError(11025);
  return Object.freeze({ ...value, publicJwk: Object.freeze({ ...value.publicJwk }) });
}
// Navigator and the exact signed audience are Host-owned coordinates. An advertised
// CMP server can confirm that realm, but cannot select another origin or path.
export function deviceEndpoints(auth, navigator, server) {
  const clean = value => typeof value === "string" && value.length <= 2048 &&
    !/[\u0000-\u0020\u007f\\?#]/.test(value) && URL.canParse(value);
  if (!auth || !clean(navigator) || typeof server !== "string") throw deviceError(11025);
  const nav = new URL(navigator), socket = new URL(auth.socketAudience);
  const socketOrigin = socket.origin.replace(/^ws/, "http");
  const advertisedURL = /^wss?:\/\//.test(server) ? server.replace(/^ws/, "http") :
    server.includes("://") ? server : `${new URL(socketOrigin).protocol}//${server}`;
  if (!clean(advertisedURL)) throw deviceError(11025);
  const advertised = new URL(advertisedURL);
  const valid = value => !value.username && !value.password && !value.search && !value.hash &&
    (value.protocol === "https:" || auth.allowInsecureLoopbackForTests === true && value.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(value.hostname));
  const prefix = nav.pathname.replace(/\/+$/, "");
  // Old root Navigator and socket services may have distinct Host-approved origins.
  // Their authority remains the exact signed audience, never an advertised redirect.
  const realm = prefix ? nav.href.replace(/\/+$/, "") : socketOrigin;
  if (!valid(nav) || !valid(advertised) || nav.href.replace(/\/+$/, "") !== navigator.replace(/\/+$/, "") ||
    advertised.href.replace(/\/+$/, "") !== advertisedURL.replace(/\/+$/, "") || advertised.origin !== new URL(realm).origin ||
    advertised.pathname.replace(/\/+$/, "") !== "" && advertised.pathname.replace(/\/+$/, "") !== prefix ||
    socket.href !== `${new URL(realm).origin.replace(/^http/, "ws")}${prefix ? `${prefix}/ws` : "/im"}`)
    throw deviceError(11025);
  return Object.freeze({ realm, health: `${realm}/health`, socket: auth.socketAudience });
}
export async function signConnect(auth, raw, source, current) {
  if (!current()) throw deviceError();
  if (typeof raw !== "string" || raw.length > 8192) throw deviceError();
  const challenge = JSON.parse(raw);
  const now = Date.now();
  if (!exact(challenge, ["profile", "nonce", "socketSession", "audience", "appkey", "credentialDigest", "expiresAt"]) ||
    challenge.profile !== PROFILE || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) || typeof challenge.socketSession !== "string" ||
    challenge.socketSession.length < 11 || challenge.socketSession.length > 128 || challenge.audience !== auth.socketAudience ||
    challenge.audience !== source.audience || challenge.appkey !== source.appkey || !/^[a-f0-9]{64}$/.test(challenge.credentialDigest) ||
    !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt > now + 10000 + MAX_SERVER_CLOCK_LEAD_MS) throw deviceError();
  if (challenge.expiresAt <= now) throw deviceError(11027);
  // Remote clock lead never extends this local, monotonic signing budget.
  const deadline = performance.now() + Math.min(10000, challenge.expiresAt - now);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source.token));
  if (!current() || challenge.credentialDigest !== Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")) throw deviceError();
  if (performance.now() >= deadline) throw deviceError(11027);
  let timeout;
  try {
    const value = await Promise.race([auth.signConnect(Object.freeze(challenge), Object.freeze({
      audience: source.audience, token: source.token, connectionEpoch: source.connectionEpoch,
    })), new Promise((_, reject) => { timeout = setTimeout(() => reject(deviceError(11027)), Math.max(1, deadline - performance.now())); })]);
    if (challenge.expiresAt <= Date.now() || performance.now() >= deadline) throw deviceError(11027);
    if (!current() || !proof(value)) throw deviceError();
    return JSON.stringify({ profile: PROFILE, proof: value });
  } finally { clearTimeout(timeout); }
}
export async function signHttp(auth, input, current) {
  if (!auth) return { authorization: `Bearer ${input.credential}` };
  if (!current()) throw deviceError();
  const url = new URL(input.url);
  if (url.username || url.password || url.hash || url.protocol !== "https:" &&
    !(auth.allowInsecureLoopbackForTests === true && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw deviceError();
  const result = await auth.signHttp(Object.freeze({ ...input }));
  if (!current() || !exact(result, ["DPoP", "X-IM-Challenge-ID", "authorization"]) ||
    !proof(result.DPoP) || result.authorization !== `DPoP ${input.credential}` ||
    typeof result["X-IM-Challenge-ID"] !== "string" || result["X-IM-Challenge-ID"].length < 16 || result["X-IM-Challenge-ID"].length > 128) throw deviceError();
  return Object.freeze({ ...result });
}
export const initialConnectExt = () => JSON.stringify({ profile: PROFILE });
