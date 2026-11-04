import fs from "node:fs/promises"
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { Effect, Exit, Cause, Layer } from "effect"
import { LocalAuthority } from "@/installation/local-authority"
import { NativeWindowsBootstrap } from "@/installation/windows-native-bootstrap"

const mode = Bun.argv.at(-1)
const { NativeInstallation } = await import("@/installation/native-installation")
const precheck = await Effect.runPromiseExit(NativeInstallation.current())
const filename = LocalAuthority.installationPath()
const state = { changed: false, bytes: 0, heldMutationRejected: false }
const result = await Effect.runPromiseExit(Effect.gen(function* () {
  if (process.platform === "win32") {
    return yield* Effect.gen(function* () {
      yield* LocalAuthority.initializeInstallation()
      if (mode === "grow" || mode === "replace") {
        yield* Effect.scoped(Effect.gen(function* () {
          const { WindowsPrivateStorage } = yield* Effect.promise(() => import("@/installation/windows-private-storage"))
          const privateFiles = yield* WindowsPrivateStorage.make("local_operator")
          yield* privateFiles.holdInstallation
          state.heldMutationRejected = yield* Effect.tryPromise({
            try: async () => {
              try {
                if (mode === "grow") await fs.appendFile(filename, " ".repeat(262_144))
                if (mode === "replace") {
                  await fs.writeFile(`${filename}.replacement`, await fs.readFile(filename), { mode: 0o600 })
                  await fs.rename(`${filename}.replacement`, filename)
                }
                return false
              } catch (error) {
                const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
                if (["EACCES", "EPERM", "EBUSY"].includes(code ?? "")) return true
                throw error
              }
            },
            catch: (error) => error,
          })
        }))
      }
      const bootstrap = yield* NativeWindowsBootstrap.Service
      const storage = bootstrap.privateStorage!
      const original = storage.read
      return yield* LocalAuthority.readInstallation.pipe(Effect.provideService(NativeWindowsBootstrap.Service, {
        ...bootstrap,
        privateStorage: {
          ...storage,
          read: (lease: Parameters<typeof storage.read>[0], name: Parameters<typeof storage.read>[1]) => {
            const observed = Reflect.apply(original, storage, [lease, name])
            if (!state.changed && (mode === "grow" || mode === "replace")) {
              state.changed = true
              if (mode === "grow") appendFileSync(filename, " ".repeat(262_144))
              if (mode === "replace") {
                writeFileSync(`${filename}.replacement`, readFileSync(filename), { mode: 0o600 })
                renameSync(`${filename}.replacement`, filename)
              }
            }
            return observed
          },
        },
      }))
    }).pipe(Effect.provide(Layer.effect(NativeWindowsBootstrap.Service, Effect.gen(function* () {
      return yield* NativeWindowsBootstrap.make(yield* NativeInstallation.current())
    }))))
  }
  yield* LocalAuthority.initializeInstallation()
  const original = fs.open
  if (mode === "grow" || mode === "replace") {
    // Instrument a real descriptor boundary; all reads/stats and the concurrent mutation are OS I/O.
    // No synthetic stat/result bypasses the production reader.
    Object.defineProperty(fs, "open", {
      configurable: true,
      writable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const file = await Reflect.apply(original, fs, args)
        if (args[0] !== filename) return file
        const stat = file.stat
        Object.defineProperty(file, "stat", {
          configurable: true,
          writable: true,
          value: async (...options: Parameters<typeof file.stat>) => {
            const before = await Reflect.apply(stat, file, options)
            if (!state.changed) {
              state.changed = true
              if (mode === "grow") await fs.appendFile(filename, " ".repeat(262_144))
              if (mode === "replace") {
                await fs.writeFile(`${filename}.replacement`, await fs.readFile(filename), { mode: 0o600 })
                await fs.rename(`${filename}.replacement`, filename)
              }
            }
            return before
          },
        })
        return file
      },
    })
  }
  return yield* LocalAuthority.readInstallation.pipe(
    Effect.ensuring(Effect.sync(() => Object.defineProperty(fs, "open", { configurable: true, writable: true, value: original }))),
  )
}))
state.bytes = (await fs.stat(filename)).size
const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
process.stdout.write(
  JSON.stringify({
    accepted: Exit.isSuccess(result),
    ...state,
    error: typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
    cause: Exit.isFailure(result) ? Cause.pretty(result.cause) : undefined,
    precheck: Exit.isSuccess(precheck) ? "accepted" : Cause.pretty(precheck.cause),
  }) + "\n",
)
