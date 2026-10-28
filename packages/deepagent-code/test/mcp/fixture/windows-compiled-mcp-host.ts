import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { runCompiledTests } from "../../fixture/compiled-test-registry"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { NativeWindowsBootstrap } from "../../../src/installation/windows-native-bootstrap"

// All homes and caches are set by the owned cohort before the fixed compiled
// entry imports production code. Do not run the source preload, which repoints
// those homes after the original Native capture has already been installed.
const file = process.argv.at(-1)
if (file !== "auth-scope" && file !== "oauth-auto-connect") throw new Error("Unknown original MCP case file")
const root = process.env.DAC_WINDOWS_MCP_ROOT
if (!root) throw new Error("Owned MCP result root is absent")
// Keep one original owner for the file. Each case still closes its own Root
// scope; a closed Native capture is never revived for the next case.
const owner = await Effect.runPromise(Scope.make())
const prepared = await (async () => {
  try {
    const bootstrap = await Effect.runPromise(Effect.gen(function* () {
      return yield* NativeWindowsBootstrap.make(yield* NativeInstallation.current())
    }).pipe(Effect.provideService(Scope.Scope, owner)))
    const { seedRipgrep } = await import("../../lib/seed-ripgrep")
    await seedRipgrep(process.env.DEEPAGENT_CODE_TEST_HOME!)
    const { Log } = await import("@deepagent-code/core/util/log")
    await Log.init({ print: false, dev: true, level: "DEBUG" })
    const { initProjectors } = await import("../../../src/server/projectors")
    initProjectors()
    if (file === "auth-scope") await import("../auth-scope.cases")
    if (file === "oauth-auto-connect") await import("../oauth-auto-connect.cases")
    const result = await runCompiledTests(file === "auth-scope" ? 27 : 8)
    const currentBeforeRetirement = Exit.isSuccess(await Effect.runPromiseExit(bootstrap.requireCurrent))
    return { bootstrap, result, currentBeforeRetirement }
  } finally {
    await Effect.runPromise(Scope.close(owner, Exit.void))
  }
})()
const result = prepared.result
const currentBeforeRetirement = prepared.currentBeforeRetirement
const bootstrap = prepared.bootstrap
const retiredReadRejected = Exit.isFailure(await Effect.runPromiseExit(bootstrap.requireCurrent))
await fs.writeFile(path.join(root, "original-mcp-cases.json"), JSON.stringify({ file, ...result,
  currentBeforeRetirement, retiredReadRejected }))
console.info("WINDOWS_MCP_ORIGINAL_COVERAGE", JSON.stringify({ file, expected: result.expected,
  registered: result.registered, executed: result.executed, pass: result.pass }))
// A failed or expired body cannot keep this owned test process alive. The real
// compiled launcher records the code and joins the Native process tree.
process.exit(result.pass && currentBeforeRetirement && retiredReadRejected ? 0 : 2)
