export * as IMDeviceStore from "./device-store"

import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { Flock } from "@deepagent-code/core/util/flock"
import { SecretStore } from "@/mcp/secret-store"
import { IMDeviceProof } from "./device-proof"

const service = "deepagent-code-im-device-v1"
const installation = "installation-p256-v1"

export class Error extends Schema.TaggedErrorClass<Error>()("IMDeviceStoreError", { code: Schema.String }) {}
const failure = () => new Error({ code: "im_device_store_unavailable" })

/** An explicit test backend is injectable; production always selects strict native custody. */
export function make(input?: { backend?: SecretStore.Backend; directory?: string }) {
  const directory = input?.directory ?? path.join(Global.Path.data, "im-device")
  const backend = input?.backend
    ? Promise.resolve(input.backend)
    : SecretStore.selectNativeBackend(service, path.join(directory, "secrets.dpapi.json"))
  // Defer unavailable-native errors to IM operations, keeping ordinary coding available.
  void backend.catch(() => undefined)
  const ready = () =>
    Effect.tryPromise({
      try: async () => {
        const store = await backend
        if (!(await store.available())) throw failure()
        return store
      },
      catch: failure,
    })
  const locked = <A>(run: (store: SecretStore.Backend) => Promise<A>) =>
    Effect.gen(function* () {
      const store = yield* ready()
      return yield* Effect.tryPromise({
        try: async () => {
          const lock = await Flock.acquire("im-device-custody", {
            dir: path.join(directory, "locks"),
            timeoutMs: 5000,
            reclaimDeadProcess: true,
          })
          try {
            return await run(store)
          } finally {
            await lock.release()
          }
        },
        catch: failure,
      })
    })
  const identity = locked(async (store) => {
    const saved = await store.get(installation)
    const marker = path.join(directory, "identity.json")
    const recorded = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (saved) {
      const key = IMDeviceProof.identity(saved)
      if (
        recorded !== undefined &&
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ jkt: Schema.String })))(recorded).jkt !== key.jkt
      )
        throw failure()
      if (recorded === undefined)
        await writeFile(
          marker,
          JSON.stringify({ profile: IMDeviceProof.profile, jkt: key.jkt, publicJwk: key.publicJwk }),
        )
      return key
    }
    if (recorded !== undefined) throw failure()
    const key = IMDeviceProof.identity()
    await store.put(installation, key.privateKey)
    if ((await store.get(installation)) !== key.privateKey) throw failure()
    await writeFile(marker, JSON.stringify({ profile: IMDeviceProof.profile, jkt: key.jkt, publicJwk: key.publicJwk }))
    return key
  })
  const account = (realm: string, name: string) => `${IMDeviceProof.sha256(realm)}:${name}`
  const put = (realm: string, name: string, value: string) =>
    locked(async (store) => {
      await store.put(account(realm, name), value)
      if ((await store.get(account(realm, name))) !== value) throw failure()
    })
  const get = (realm: string, name: string) =>
    Effect.gen(function* () {
      const store = yield* ready()
      return yield* Effect.tryPromise({ try: () => store.get(account(realm, name)), catch: failure })
    })
  const remove = (realm: string, name: string) => locked((store) => store.remove(account(realm, name)))
  return {
    identity,
    put,
    get,
    remove,
    acquireOwner: (realm: string) =>
      Effect.tryPromise({
        try: () =>
          Flock.acquire(`im-owner:${IMDeviceProof.sha256(realm)}`, {
            dir: path.join(directory, "owners"),
            timeoutMs: 0,
            reclaimDeadProcess: true,
          }),
        catch: () => new Error({ code: "im_owner_busy" }),
      }),
    preflight: Effect.gen(function* () {
      const key = yield* identity
      const probe = randomBytes(16).toString("hex")
      yield* locked(async (store) => {
        try {
          await store.put(account("local-preflight", probe), probe)
          if ((await store.get(account("local-preflight", probe))) !== probe) throw failure()
        } finally {
          await store.remove(account("local-preflight", probe))
        }
      })
      return { profile: IMDeviceProof.profile, publicJwk: key.publicJwk, deviceJkt: key.jkt } as const
    }),
    http: (request: Parameters<typeof IMDeviceProof.http>[1]) =>
      identity.pipe(Effect.map((key) => IMDeviceProof.http(key, request))),
    bootstrap: (request: Parameters<typeof IMDeviceProof.bootstrap>[1]) =>
      identity.pipe(Effect.map((key) => IMDeviceProof.bootstrap(key, request))),
    socket: (challenge: IMDeviceProof.SocketChallenge, source: Parameters<typeof IMDeviceProof.socket>[2]) =>
      identity.pipe(Effect.map((key) => IMDeviceProof.socket(key, challenge, source))),
  }
}

export class Service extends Context.Service<Service, ReturnType<typeof make>>()("@deepagent-code/im/DeviceStore") {}
export const layer = Layer.sync(Service, () => make())
