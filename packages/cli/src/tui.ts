import { run } from "@deepagent-code/tui"
import type { Args } from "@deepagent-code/tui/context/args"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { runtimeModules as keymapRuntimeModules } from "@opentui/keymap/runtime-modules"

ensureRuntimePluginSupport({ additional: keymapRuntimeModules })

export function runTui(
  transport: { url: string; headers: RequestInit["headers"] },
  args: Args,
  directory?: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const origStderrWrite = process.stderr.write.bind(process.stderr)
      const origConsoleLog = console.log
      const origConsoleInfo = console.info
      const origConsoleError = console.error
      const origConsoleWarn = console.warn
      const noop = () => {}
      const stderrWritable = process.stderr.write
      try {
        Object.defineProperty(process.stderr, "write", {
          value: () => true,
          writable: true,
          configurable: true,
        })
      } catch {
        process.stderr.write = () => true
      }
      console.log = noop
      console.info = noop
      console.error = noop
      console.warn = noop

      let config: unknown
      let pluginHost: unknown
      try {
        const { TuiConfig: LegacyTuiConfig } = await import("deepagent-code/config/tui")
        config = await LegacyTuiConfig.get()
        const { createLegacyTuiPluginHost } = await import("deepagent-code/plugin/tui/runtime")
        pluginHost = createLegacyTuiPluginHost()

        await Effect.runPromise(
          run({
            ...transport,
            args,
            config: config as never,
            directory,
            pluginHost: pluginHost as never,
          }).pipe(Effect.provide(Global.defaultLayer)),
        )
      } finally {
        try {
          Object.defineProperty(process.stderr, "write", {
            value: stderrWritable,
            writable: true,
            configurable: true,
          })
        } catch {
          process.stderr.write = stderrWritable
        }
        console.log = origConsoleLog
        console.info = origConsoleInfo
        console.error = origConsoleError
        console.warn = origConsoleWarn
      }
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })
}
