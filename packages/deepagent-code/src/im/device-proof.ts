export * as IMDeviceProof from "./device-proof"

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto"

export const profile = "dac-im-device-v1"
export const socketProfile = "dac-im-connect-proof-v1"
// The server accepts HTTP proof iat up to 30 seconds behind its own clock.
export const maxServerClockLeadMs = 30000
export type Purpose =
  | "activation"
  | "activation-status"
  | "login"
  | "migration-bind"
  | "migration-status"
  | "kernel-http"
  | "entitlement-read"
export type PublicJwk = { kty: "EC"; crv: "P-256"; x: string; y: string }
export type Identity = { privateKey: string; publicJwk: PublicJwk; jkt: string }
export type SocketChallenge = {
  profile: typeof socketProfile
  nonce: string
  socketSession: string
  audience: string
  appkey: string
  credentialDigest: string
  expiresAt: number
}

export class Error extends globalThis.Error {
  readonly code = "im_device_proof_invalid"
  constructor() {
    super("IM device proof or target is invalid")
    this.name = "IMDeviceProofError"
  }
}

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
export const credentialHash = (value: string) => createHash("sha256").update(value).digest("base64url")

/** Length-prefixed UTF-8, shared with the API; it never normalizes a user's wire name. */
export function digest(fields: readonly string[]) {
  if (
    fields.length > 32 ||
    fields.some(
      (field) =>
        typeof field !== "string" ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(field),
    )
  )
    throw new Error()
  const bytes = fields.map((field) => Buffer.from(field, "utf8"))
  const size = 14 + bytes.reduce((total, field) => total + 4 + field.length, 0)
  if (size > 8192 || bytes.some((field) => field.length > 4096)) throw new Error()
  const prefix = Buffer.alloc(14)
  prefix.write("DAIM-LPF1\0", "ascii")
  prefix.writeUInt32BE(fields.length, 10)
  return sha256(
    Buffer.concat([
      prefix,
      ...bytes.flatMap((field) => {
        const length = Buffer.alloc(4)
        length.writeUInt32BE(field.length)
        return [length, field]
      }),
    ]),
  )
}

export function publicJwk(value: unknown): PublicJwk {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "crv,kty,x,y") throw new Error()
  const key = value as Partial<PublicJwk>
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    typeof key.y !== "string" ||
    ![key.x, key.y].every(
      (field) => /^[A-Za-z0-9_-]{43}$/.test(field) && Buffer.from(field, "base64url").toString("base64url") === field,
    )
  )
    throw new Error()
  const result = { kty: key.kty, crv: key.crv, x: key.x, y: key.y }
  createPublicKey({ key: result, format: "jwk" })
  return result
}

export function thumbprint(value: PublicJwk) {
  const key = publicJwk(value)
  return credentialHash(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))
}

export function identity(privateKey?: string): Identity {
  const key = privateKey
    ? createPrivateKey(privateKey)
    : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error()
  const exported = createPublicKey(key).export({ format: "jwk" })
  const jwk = publicJwk({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y })
  return { privateKey: key.export({ type: "pkcs8", format: "pem" }).toString(), publicJwk: jwk, jkt: thumbprint(jwk) }
}

export function target(value: string, allowLoopback = false) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 2048 ||
    (url.protocol !== "https:" &&
      !(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error()
  url.search = ""
  return url.href
}

export function http(
  key: Identity,
  input: {
    method: "GET" | "POST" | "PUT" | "DELETE"
    url: string
    nonce: string
    credential?: string
    allowLoopback?: boolean
  },
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.nonce)) throw new Error()
  return jwt(key, "dpop+jwt", {
    htm: input.method,
    htu: target(input.url, input.allowLoopback),
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString("base64url"),
    nonce: input.nonce,
    ...(input.credential ? { ath: credentialHash(input.credential) } : {}),
  })
}

export function bootstrap(
  key: Identity,
  input: {
    realm: string
    purpose: Purpose
    requestHash: string
    transactionID?: string
    entitlementID?: string
    allowLoopback?: boolean
  },
) {
  const realm = target(input.realm, input.allowLoopback).replace(/\/$/, "")
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error()
  return jwt(key, "dpop+jwt", {
    htm: "POST",
    htu: `${realm}/api/im/device/challenges`,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString("base64url"),
    dac_purpose: input.purpose,
    dac_request_hash: digest([
      "dac.im.bootstrap.v1",
      realm,
      input.purpose,
      input.transactionID ?? "",
      input.entitlementID ?? "",
      input.requestHash,
      key.jkt,
    ]),
  })
}

export function socket(
  key: Identity,
  challenge: SocketChallenge,
  source: {
    audience: string
    appkey: string
    token: string
    entitlementID: string
    bindingVersion: number
    allowLoopback?: boolean
  },
) {
  const audience = new URL(source.audience)
  const now = Date.now()
  if (
    audience.username ||
    audience.password ||
    audience.search ||
    audience.hash ||
    (audience.protocol !== "wss:" &&
      !(source.allowLoopback && audience.protocol === "ws:" && ["127.0.0.1", "[::1]"].includes(audience.hostname))) ||
    challenge.profile !== socketProfile ||
    challenge.audience !== audience.href ||
    challenge.appkey !== source.appkey ||
    challenge.credentialDigest !== sha256(source.token) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) ||
    challenge.socketSession.length < 11 ||
    challenge.socketSession.length > 128 ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= now ||
    challenge.expiresAt > now + 10000 + maxServerClockLeadMs ||
    !/^[a-f0-9]{32}$/.test(source.entitlementID) ||
    !Number.isSafeInteger(source.bindingVersion) ||
    source.bindingVersion < 1
  )
    throw new Error()
  return jwt(key, "dac-im-connect-proof+jwt", {
    v: 1,
    purpose: "im-connect",
    aud: challenge.audience,
    appkey: source.appkey,
    nonce: challenge.nonce,
    sid: challenge.socketSession,
    ath: credentialHash(source.token),
    entitlementID: source.entitlementID,
    bindingVersion: source.bindingVersion,
    // The verified challenge carries the server's original 10-second interval.
    // Use that clock for both claims so exp-iat never exceeds the server limit.
    iat: Math.floor((challenge.expiresAt - 10000) / 1000),
    exp: Math.floor(challenge.expiresAt / 1000),
    jti: randomBytes(32).toString("base64url"),
  })
}

function jwt(key: Identity, typ: string, payload: object) {
  if (thumbprint(key.publicJwk) !== key.jkt) throw new Error()
  const header = Buffer.from(JSON.stringify({ typ, alg: "ES256", jwk: key.publicJwk })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" })
  const result = `${header}.${body}.${signature.toString("base64url")}`
  if (signature.length !== 64 || Buffer.byteLength(result) > 4096) throw new Error()
  return result
}
