export * as McpWindowsStorage from "./windows-storage"

import path from "node:path"
import { Cause, Context, Effect, Layer } from "effect"
import { Global } from "@deepagent-code/core/global"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { EffectBridge } from "@/effect/bridge"
import { NativeWindowsBootstrap } from "@/installation/windows-native-bootstrap"
import { WindowsPrivateStorage } from "@/installation/windows-private-storage"
import type { Codec } from "./dpapi"

type Purpose = "mcp_legacy_auth" | "mcp_secret_envelopes" | "mcp_secret_migration"
type Read = Readonly<{ text: string; hash: string; witness: WindowsPrivateStorage.Snapshot }>
export interface Journal {
  readonly current: () => void
  readonly flush: () => void
  readonly close: () => void
  readonly bindClose: (close: () => void) => void
}
export interface Port {
  readonly codec?: Codec
  readonly current: () => Promise<void>
  readonly legacySecrets: () => Promise<boolean>
  readonly openJournal: (mode: "read" | "write") => Promise<Journal | undefined>
  readonly read: (purpose: Purpose) => Promise<Read | undefined>
  readonly publish: (purpose: Purpose, text: string, expected: WindowsPrivateStorage.Snapshot | null) => Promise<WindowsPrivateStorage.Snapshot>
  readonly mutateSecrets: (change: (text: string | undefined) => string | undefined | Promise<string | undefined>) => Promise<void>
}

/** Only the original Root installs this port. A missing native capture never falls
 * back to path-based Windows credential reads or plaintext secret storage. */
export const Current = Context.Reference<Port | undefined>("McpWindowsStorage.Current", { defaultValue: () => undefined })

export const layer = Layer.effectContext(Effect.gen(function* () {
  const bootstrap = yield* NativeWindowsBootstrap.Service
  const flock = yield* EffectFlock.Service
  const bridge = yield* EffectBridge.make()
  const lifetime = { active: true }
  const journals = new Set<() => void>()
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    lifetime.active = false
    const failures: unknown[] = []
    for (const close of journals) {
      try { close() }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, "MCP Windows storage retirement failed")
  }))
  const invoke = <A>(purpose: Purpose,
    run: (storage: Effect.Success<ReturnType<typeof WindowsPrivateStorage.make>>) => Effect.Effect<A, WindowsPrivateStorage.Error>) =>
    Effect.suspend(() => lifetime.active
      ? WindowsPrivateStorage.make(purpose, false).pipe(Effect.flatMap(run), Effect.scoped,
        Effect.provideService(NativeWindowsBootstrap.Service, bootstrap))
      : Effect.fail(new WindowsPrivateStorage.Error({ reason: "changed" })))
  const name = (purpose: Purpose) => purpose === "mcp_legacy_auth" ? "mcp-auth.json"
    : purpose === "mcp_secret_migration" ? "mcp-secret-migration.json" : "mcp-secrets.dpapi.json"
  const run = async <A, E>(effect: Effect.Effect<A, E>) => {
    const result = await bridge.promise(effect.pipe(Effect.result))
    if (result._tag === "Failure") throw result.failure
    return result.success
  }
  const codec = process.versions.bun ? undefined : yield* Effect.gen(function* () {
    const { DpapiHelper } = yield* Effect.promise(() => import("./dpapi-helper"))
    return yield* DpapiHelper.make
  }).pipe(Effect.orElseSucceed(() => undefined))
  return Context.make(Current, {
    codec,
    current: () => run(Effect.suspend(() => lifetime.active
      ? bootstrap.requireCurrent.pipe(Effect.mapError(() => new WindowsPrivateStorage.Error({ reason: "changed" })))
      : Effect.fail(new WindowsPrivateStorage.Error({ reason: "changed" })))),
    legacySecrets: () => run(Effect.gen(function* () {
      if (!lifetime.active || !bootstrap.legacyMcpSecrets) return yield* new WindowsPrivateStorage.Error({ reason: "unavailable" })
      yield* bootstrap.requireCurrent.pipe(Effect.mapError(() => new WindowsPrivateStorage.Error({ reason: "changed" })))
      const exists = yield* Effect.try({ try: () => bootstrap.legacyMcpSecrets!(Global.Path.data),
        catch: () => new WindowsPrivateStorage.Error({ reason: "unavailable" }) })
      yield* bootstrap.requireCurrent.pipe(Effect.mapError(() => new WindowsPrivateStorage.Error({ reason: "changed" })))
      return exists
    })),
    openJournal: (mode) => run(Effect.gen(function* () {
      if (!lifetime.active || !bootstrap.mcpJournal || !NativeWindowsBootstrap.describe(bootstrap.capture))
        return yield* new WindowsPrivateStorage.Error({ reason: "unavailable" })
      yield* bootstrap.requireCurrent.pipe(Effect.mapError(() => new WindowsPrivateStorage.Error({ reason: "changed" })))
      const native = bootstrap.mcpJournal
      const lease = yield* Effect.try({ try: () => native.open(JSON.stringify({ version: 1,
        root: path.join(Global.Path.config, "mcp-oauth"), write: mode === "write" })),
        catch: (error) => new WindowsPrivateStorage.Error({ reason: typeof error === "object" && error !== null &&
          "code" in error && error.code === "MCP_JOURNAL_CAPACITY" ? "capacity" : "unavailable" }) })
      if (!lease) return undefined
      const state = { active: true, closeStore: undefined as (() => void) | undefined }
      const close = () => {
        if (!state.active) return
        state.active = false
        journals.delete(close)
        try { state.closeStore?.() }
        finally { native.close(lease) }
      }
      journals.add(close)
      return Object.freeze({
        current: () => {
          if (!lifetime.active || !state.active || !NativeWindowsBootstrap.describe(bootstrap.capture) || !native.current(lease))
            throw new WindowsPrivateStorage.Error({ reason: "changed" })
        },
        flush: () => {
          if (!lifetime.active || !state.active) throw new WindowsPrivateStorage.Error({ reason: "unknown" })
          try { native.flush(lease) }
          catch { throw new WindowsPrivateStorage.Error({ reason: "unknown" }) }
        },
        close,
        bindClose: (closeStore: () => void) => {
          if (!lifetime.active || !state.active || state.closeStore) throw new WindowsPrivateStorage.Error({ reason: "changed" })
          state.closeStore = closeStore
        },
      })
    })),
    read: (purpose) => run(invoke(purpose, (storage) => storage.read(name(purpose)))),
    publish: (purpose, text, expected) => run(invoke(purpose,
      (storage) => storage.publish(name(purpose), text, expected))),
    mutateSecrets: (change) => {
      const progress = { published: false }
      return run(Effect.gen(function* () {
        const before = yield* invoke("mcp_secret_envelopes", (storage) => storage.read("mcp-secrets.dpapi.json"))
        const next = yield* Effect.tryPromise({ try: async () => change(before?.text), catch: (error) => error })
        if (next === undefined) return
        progress.published = true
        yield* invoke("mcp_secret_envelopes",
          (storage) => storage.publish("mcp-secrets.dpapi.json", next, before?.witness ?? null))
      }).pipe(flock.withLock(`mcp-secrets:${path.join(Global.Path.data, "mcp-secrets", "mcp-secrets.dpapi.json")}`),
        Effect.catchCause((cause) => {
          const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
          if (reason && Cause.isFailReason(reason) && !(reason.error instanceof EffectFlock.LockTimeoutError) &&
            !(reason.error instanceof EffectFlock.LockCompromisedError)) return Effect.fail(reason.error)
          return Effect.fail(new WindowsPrivateStorage.Error({ reason: progress.published ? "unknown" : "unavailable" }))
        })))
    },
  })
})).pipe(Layer.provide(EffectFlock.defaultLayer))
