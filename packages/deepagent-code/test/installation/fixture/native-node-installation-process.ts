import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Cause, Effect, Exit } from "effect"
import { NativeInstallation } from "../../../src/installation/native-installation"

export async function main() {
  if (process.env.DAC_NATIVE_NODE_COHORT_ROOT) {
    const { NativeWindowsBootstrap } = await import("../../../src/installation/windows-native-bootstrap")
    await NativeWindowsBootstrap.installFixedEntry()
  }
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const handle = yield* NativeInstallation.current()
    const description = yield* NativeInstallation.describe(handle)
    const assets = yield* NativeInstallation.assetDirectory(handle)
    const clone = yield* Effect.exit(NativeInstallation.assetDirectory({ ...handle }))
    if (process.argv.at(-1) === "mutate") {
      const mutation = yield* Effect.promise(() => fs.appendFile(fileURLToPath(import.meta.url), "\n// mutated after admission\n").then(
        () => ({ changed: true, rejected: false }),
        (error: unknown) => {
          if (error && typeof error === "object" && "code" in error && ["EACCES", "EPERM", "EBUSY"].includes(String(error.code)))
            return { changed: false, rejected: true }
          throw error
        },
      ))
      const rechecked = yield* Effect.exit(NativeInstallation.requireCurrent(handle))
      const invalidated = yield* Effect.exit(NativeInstallation.describe(handle))
      return { ...mutation, invalidated: Exit.isFailure(invalidated), cloneRejected: Exit.isFailure(clone) }
    }
    yield* NativeInstallation.requireCurrent(handle)
    return { description, assets, cloneRejected: Exit.isFailure(clone) }
  }))
  process.stdout.write(JSON.stringify(Exit.isFailure(exit)
    ? { ok: false, error: Cause.squash(exit.cause) } : { ok: true, result: exit.value }) + "\n",
    () => setImmediate(() => process.exit(Exit.isFailure(exit) ? 2 : 0)))
}

if (import.meta.main && !process.env.DAC_NATIVE_NODE_COHORT_ROOT) await main()
