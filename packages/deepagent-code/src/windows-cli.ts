import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

type Port = Readonly<{
  capture: object
  current(capture: object): boolean
  preloaded(capture: object): boolean
  compiledCli(capture: object): boolean
  prepareCliWorkRuntime(capture: object): string
  launchCli(capture: object): object
  pollCli(capture: object, child: object): string
  closePreloadedNode(capture: object, child: object): void
  close(capture: object): void
}>

// Only the native child receipt can open the business entry. The parent passes
// no argv, environment, executable path or filesystem identity to Native.
async function main() {
  if (process.platform !== "win32" || !process.versions.bun ||
    !/[/\\]deepagent-code\.exe$/i.test(process.execPath) ||
    !(import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("B:/~BUN/") ||
      import.meta.url.startsWith("file:///B:/~BUN/") || (typeof Bun !== "undefined" && Bun.main.startsWith("B:/~BUN/"))))
    throw new Error("WINDOWS_CLI_COMPILED_ENTRY_REQUIRED")
  const observed: unknown = nativeCall("addon-load", () => createRequire(pathToFileURL(process.execPath))(
    fileURLToPath(new URL("./native-image-factory.node", pathToFileURL(process.execPath))),
  ))
  if (!observed || typeof observed !== "object" || !Object.isFrozen(observed) ||
    !("capture" in observed) || !observed.capture || typeof observed.capture !== "object" ||
    ["current", "preloaded", "compiledCli", "prepareCliWorkRuntime", "launchCli", "pollCli", "closePreloadedNode", "close"]
      .some((name) => typeof Reflect.get(observed, name) !== "function")) throw new Error("WINDOWS_CLI_NATIVE_PORT_REJECTED")
  const native = observed as Port
  if (!nativeCall("current", () => native.current(native.capture))) throw new Error("WINDOWS_CLI_NATIVE_CURRENT_REJECTED")
  if (nativeCall("preloaded", () => native.preloaded(native.capture))) {
    if (!nativeCall("compiled-cli", () => native.compiledCli(native.capture))) throw new Error("WINDOWS_CLI_RECEIPT_PURPOSE_REJECTED")
    const { NativeWindowsBootstrap } = await import("./installation/windows-native-bootstrap")
    await NativeWindowsBootstrap.installCompiledEntry()
    await import("./index")
    return
  }
  nativeCall("prepare-runtime", () => native.prepareCliWorkRuntime(native.capture))
  if (!nativeCall("current", () => native.current(native.capture)) || nativeCall("preloaded", () => native.preloaded(native.capture))) throw new Error("WINDOWS_CLI_NATIVE_CHANGED")
  const child = nativeCall("launch", () => native.launchCli(native.capture))
  const lifetime = { closed: false }
  const stop = () => {
    if (lifetime.closed) return
    // Native removes this external only after stopping and joining the original
    // root and unnamed Job. A failed close retains its leases and reports unknown.
    nativeCall("close-child", () => native.closePreloadedNode(native.capture, child))
    lifetime.closed = true
    nativeCall("close-capture", () => native.close(native.capture))
  }
  const interrupted = () => {
    try { stop(); process.exit(130) }
    catch { console.error("WINDOWS_CLI_NATIVE_RETIREMENT_UNKNOWN"); process.exit(1) }
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  try {
    while (true) {
      const state: unknown = JSON.parse(nativeCall("poll", () => native.pollCli(native.capture, child)))
      if (!state || typeof state !== "object" || !("version" in state) || state.version !== 1 ||
        !("running" in state) || typeof state.running !== "boolean" ||
        !("exit_code" in state) || !("tree_retired" in state) || typeof state.tree_retired !== "boolean" ||
        Object.keys(state).sort().join(",") !== "exit_code,running,tree_retired,version" ||
        (state.running && (state.exit_code !== null || state.tree_retired))) throw new Error("WINDOWS_CLI_NATIVE_RESULT_REJECTED")
      if (!state.running) {
        if (!state.tree_retired || typeof state.exit_code !== "number" || !Number.isInteger(state.exit_code) ||
          state.exit_code < -2_147_483_648 || state.exit_code > 4_294_967_295) throw new Error("WINDOWS_CLI_NATIVE_RETIREMENT_UNKNOWN")
        stop()
        process.exit(state.exit_code)
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  } catch (error) {
    stop()
    throw error
  } finally {
    process.removeListener("SIGINT", interrupted)
    process.removeListener("SIGTERM", interrupted)
  }
}

function nativeCall<Value>(operation: "addon-load" | "current" | "preloaded" | "compiled-cli" | "prepare-runtime" | "launch" | "poll" | "close-child" | "close-capture", run: () => Value): Value {
  try {
    return run()
  } catch (error) {
    try {
      const observedTag = error instanceof Error ? error.name : undefined
      const observedCode = error && typeof error === "object" && "code" in error ? error.code : undefined
      const tag = typeof observedTag === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(observedTag) ? observedTag : "unknown"
      const code = typeof observedCode === "string" && /^WINDOWS_[A-Z_]{1,96}$/.test(observedCode) ? observedCode : "UNCLASSIFIED"
      console.error(JSON.stringify({ stage: "windows-cli-native", operation, tag, code }))
    } finally {
      throw error
    }
  }
}

await main().catch((error: unknown) => {
  const code = error instanceof Error && /^WINDOWS_[A-Z_]{1,96}$/.test(error.message)
    ? error.message : error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      /^WINDOWS_[A-Z_]{1,96}$/.test(error.code) ? error.code : "UNCLASSIFIED"
  console.error(JSON.stringify({ stage: "windows-cli-entry", code }))
  console.error("WINDOWS_CLI_NATIVE_BOOTSTRAP_UNAVAILABLE")
  process.exitCode = 1
})
