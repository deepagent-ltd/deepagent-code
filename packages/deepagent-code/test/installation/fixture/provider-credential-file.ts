import fs from "node:fs/promises"
import { Effect, Exit, Cause } from "effect"
import { LocalTaskAuthority } from "@/im/local-task-authority"

const mode = Bun.argv.at(-1)
await Effect.runPromise(LocalTaskAuthority.initializeInstallation())
const filename = LocalTaskAuthority.installationPath()
const original = fs.open
const state = { changed: false, bytes: 0 }
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
const result = await Effect.runPromiseExit(LocalTaskAuthority.readInstallation)
Object.defineProperty(fs, "open", { configurable: true, writable: true, value: original })
state.bytes = (await fs.stat(filename)).size
const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
process.stdout.write(
  JSON.stringify({
    accepted: Exit.isSuccess(result),
    ...state,
    error: typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
  }) + "\n",
)
