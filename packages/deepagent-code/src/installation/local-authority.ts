export * as LocalAuthority from "./local-authority"

import { constants } from "node:fs"
import fs from "node:fs/promises"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { Cause, Effect, Option, Schema } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import type { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { ServerAuth } from "@/server/auth"
import type { CorsOptions } from "@/server/cors"
import { AuthRuntime } from "../im/auth-runtime"

const Installation = Schema.Struct({
  version: Schema.Literal(1),
  instanceID: Schema.String.check(Schema.isPattern(/^local_[a-f0-9]{32}$/)),
  secret: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type Installation = typeof Installation.Type
export const installationPath = () => path.join(Global.Path.data, "local-operator", "installation.json")
const denied = () =>
  new LocalOperatorSchema.Error({
    code: "LOCAL_OPERATOR_AUTH_REQUIRED",
    message: "Task changes require an enrolled operator authenticated over a loopback connection",
  })
const unavailable = () =>
  new LocalOperatorSchema.Error({
    code: "LOCAL_OPERATOR_UNAVAILABLE",
    message: "Local task identity is not enrolled or its private installation file is unavailable",
  })

/** Explicit setup only, after the caller's current authority check. Read/GET paths never create an identity. */
export const ensurePrivateInstallation = Effect.fn("LocalAuthority.ensurePrivateInstallation")(function* () {
  if (process.platform === "win32")
    return yield* Effect.gen(function* () {
      const { WindowsPrivateStorage } = yield* Effect.promise(() => import("../installation/windows-private-storage"))
      const privateFiles = yield* WindowsPrivateStorage.make("local_operator", true)
      const existing = yield* privateFiles.read("installation.json")
      if (existing) return yield* decodeInstallation(existing.text)
      const created = yield* privateFiles
        .publish(
          "installation.json",
          JSON.stringify({
            version: 1,
            instanceID: `local_${randomBytes(16).toString("hex")}`,
            secret: randomBytes(32).toString("hex"),
          }),
          null,
        )
        .pipe(Effect.exit)
      // Only an exact before-publication conflict may read the concurrent winner.
      // An unknown publication never causes a second create or key replacement.
      if (created._tag === "Failure") {
        const cause = created.cause
        const error = Cause.squash(cause)
        if (!(error instanceof WindowsPrivateStorage.Error) || error.reason !== "changed") return yield* unavailable()
      }
      const current = yield* privateFiles.read("installation.json")
      if (!current) return yield* unavailable()
      return yield* decodeInstallation(current.text)
    }).pipe(Effect.scoped, Effect.mapError(unavailable))
  if (!process.getuid) return yield* unavailable()
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(installationPath()), { recursive: true, mode: 0o700 }),
    catch: unavailable,
  })
  const directory = yield* Effect.tryPromise({
    try: () => fs.lstat(path.dirname(installationPath())),
    catch: unavailable,
  })
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid!()
  )
    return yield* unavailable()
  const created = yield* Effect.tryPromise({
    try: async () => {
      const file = await fs.open(
        installationPath(),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            instanceID: `local_${randomBytes(16).toString("hex")}`,
            secret: randomBytes(32).toString("hex"),
          }),
        )
        await file.sync()
      } finally {
        await file.close()
      }
    },
    catch: (error) => error,
  }).pipe(Effect.exit)
  // An existing key is read and checked; it is never overwritten after enrollment or rotation.
  if (created._tag === "Failure") return yield* readInstallation
  return yield* readInstallation
})

/** Preserve the existing offline enrollment entrypoint. This does not itself enroll an operator. */
export const initializeInstallation = Effect.fn("LocalAuthority.initializeInstallation")(function* () {
  return yield* ensurePrivateInstallation()
})

export const readInstallation = Effect.suspend(() =>
  process.platform === "win32"
    ? Effect.gen(function* () {
        const { WindowsPrivateStorage } = yield* Effect.promise(() => import("../installation/windows-private-storage"))
        const privateFiles = yield* WindowsPrivateStorage.make("local_operator")
        const current = yield* privateFiles.read("installation.json")
        if (!current) return yield* unavailable()
        return yield* decodeInstallation(current.text)
      }).pipe(Effect.scoped, Effect.mapError(unavailable))
    : Effect.tryPromise({
        try: async () => {
          if (process.platform === "win32" || !process.getuid) throw unavailable()
          const filename = installationPath()
          const parent = path.dirname(filename)
          const directory = await fs.lstat(parent, { bigint: true })
          if (
            !directory.isDirectory() ||
            directory.isSymbolicLink() ||
            (directory.mode & 0o077n) !== 0n ||
            directory.uid !== BigInt(process.getuid!()) ||
            (await fs.realpath(parent)) !== parent
          )
            throw unavailable()
          const named = await fs.lstat(filename, { bigint: true })
          const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const stat = await file.stat({ bigint: true })
            if (
              !stat.isFile() ||
              (stat.mode & 0o077n) !== 0n ||
              stat.size < 1n ||
              stat.size > 1024n ||
              stat.nlink !== 1n ||
              stat.uid !== BigInt(process.getuid!()) ||
              fileIdentity(named) !== fileIdentity(stat)
            )
              throw unavailable()
            // Fixed allocation plus one overflow byte; readFile() could grow without bound after stat.
            const buffer = Buffer.alloc(1025)
            const progress = { bytes: 0 }
            while (progress.bytes < buffer.byteLength) {
              const read = await file.read(buffer, progress.bytes, buffer.byteLength - progress.bytes, null)
              if (!read.bytesRead) break
              progress.bytes += read.bytesRead
            }
            const after = await file.stat({ bigint: true })
            const current = await fs.lstat(filename, { bigint: true })
            const currentParent = await fs.lstat(parent, { bigint: true })
            if (
              progress.bytes > 1024 ||
              BigInt(progress.bytes) !== stat.size ||
              fileIdentity(stat) !== fileIdentity(after) ||
              fileIdentity(after) !== fileIdentity(current) ||
              fileIdentity(directory) !== fileIdentity(currentParent) ||
              (await fs.realpath(filename)) !== filename
            )
              throw unavailable()
            const value = Schema.decodeUnknownOption(Schema.fromJsonString(Installation), {
              onExcessProperty: "error",
            })(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, progress.bytes)))
            if (Option.isNone(value)) throw unavailable()
            return value.value
          } finally {
            await file.close()
          }
        },
        catch: unavailable,
      }),
)

/** Command preparation may hold the one original fixed Native credential leaf.
 * The caller's Scope owns it; current never accepts an installation/path DTO. */
export const holdWindowsInstallation = Effect.gen(function* () {
  if (process.platform !== "win32") return yield* unavailable()
  const { WindowsPrivateStorage } = yield* Effect.promise(() => import("../installation/windows-private-storage"))
  const privateFiles = yield* WindowsPrivateStorage.make("local_operator")
  const held = yield* privateFiles.holdInstallation
  const installation = yield* decodeInstallation(held.text)
  return Object.freeze({ installation, current: held.current.pipe(Effect.mapError(unavailable)) })
})

function decodeInstallation(text: string) {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Installation), { onExcessProperty: "error" })(text)
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(unavailable())
}

function fileIdentity(stat: import("node:fs").BigIntStats) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  )
}

export function binding(
  installation: Installation,
  username: string,
  password: string,
): LocalOperatorSchema.RuntimeBinding {
  return {
    instanceID: installation.instanceID,
    installationKeyHash: LocalOperator.hash(installation.secret),
    credentialBinding: createHmac("sha256", Buffer.from(installation.secret, "hex"))
      .update(JSON.stringify([username, password]))
      .digest("hex"),
  }
}

export const configured = Effect.fn("LocalAuthority.configured")(function* (config: ServerAuth.Info) {
  if (!ServerAuth.required(config) || Option.isNone(config.password)) return yield* unavailable()
  const installation = yield* readInstallation
  return { runtime: binding(installation, config.username, config.password.value), password: config.password.value }
})

/** Password verification produces only a generation witness. Every SQL mutation rechecks it. */
export const authenticatePassword = Effect.fn("LocalAuthority.authenticatePassword")(function* (
  db: Database.Interface["db"],
  runtime: LocalOperatorSchema.RuntimeBinding,
  username: string,
  password: string,
  requireConfiguration = true,
) {
  const current = yield* db
    .transaction((tx) => LocalOperator.requireCurrent(tx, requireConfiguration))
    .pipe(Effect.provideService(LocalOperator.Runtime, runtime))
  if (
    current.username !== username ||
    !(yield* Effect.tryPromise({
      try: (signal) => AuthRuntime.verify(password, current.credential_verifier, signal),
      catch: (error) => (error instanceof LocalOperatorSchema.Error ? error : denied()),
    }))
  )
    return yield* denied()
  return LocalOperator.mutationWitness(current)
})

export const authenticate = Effect.fn("LocalAuthority.authenticate")(function* (
  db: Database.Interface["db"],
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
  cors?: CorsOptions,
) {
  // Peer and local socket addresses are transport facts. Host/Forwarded headers and query auth
  // cannot grant a mutation witness. Fetch-only adapters without these facts fail closed.
  const socket = "socket" in request.source ? request.source.socket : undefined
  if (
    typeof socket !== "object" ||
    socket === null ||
    !("localAddress" in socket) ||
    !("remoteAddress" in socket) ||
    !loopback(socket.localAddress) ||
    !loopback(socket.remoteAddress)
  )
    return yield* denied()
  if (
    new URL(request.originalUrl, "http://localhost").searchParams.has("auth_token") ||
    !allowedOrigin(request.headers.origin, "localPort" in socket ? socket.localPort : undefined, cors)
  )
    return yield* denied()
  const configuredIdentity = yield* configured(config)
  const authorization = request.headers.authorization
  if (!authorization?.startsWith("Basic ") || authorization.length > 8192) return yield* denied()
  const decoded = yield* Effect.try({
    try: () =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(authorization.slice(6), "base64")),
    catch: denied,
  })
  const separator = decoded.indexOf(":")
  if (separator < 1) return yield* denied()
  const username = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  // Reject wrong server credentials before spending Argon2 resources; no secret is logged.
  if (!equal(username, config.username) || !equal(password, configuredIdentity.password)) return yield* denied()
  const witness = yield* authenticatePassword(db, configuredIdentity.runtime, username, password)
  return { runtime: configuredIdentity.runtime, witness }
})

export function provide<A, E, R>(
  authorization: { runtime: LocalOperatorSchema.RuntimeBinding; witness: LocalOperatorSchema.MutationWitness },
  effect: Effect.Effect<A, E, R>,
) {
  return effect.pipe(
    Effect.provideService(LocalOperator.Runtime, authorization.runtime),
    Effect.provideService(LocalOperator.Mutation, authorization.witness),
  )
}

function equal(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
function loopback(value: unknown) {
  return typeof value === "string" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(value)
}
function allowedOrigin(origin: string | undefined, localPort: unknown, cors?: CorsOptions) {
  if (!origin) return true
  if (
    ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "oc://renderer"].includes(origin) ||
    cors?.cors?.includes(origin)
  )
    return true
  if (!URL.canParse(origin)) return false
  const url = new URL(origin)
  return (
    url.origin === origin &&
    !url.username &&
    !url.password &&
    typeof localPort === "number" &&
    Number.isInteger(localPort) &&
    localPort > 0 &&
    localPort <= 65_535 &&
    Number(url.port || "80") === localPort &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
}
