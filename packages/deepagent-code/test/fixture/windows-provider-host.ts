import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { runCompiledTests } from "./compiled-test-registry"
import { NativeInstallation } from "../../src/installation/native-installation"
import { NativeWindowsBootstrap } from "../../src/installation/windows-native-bootstrap"

const root = process.env.DAC_WINDOWS_PROVIDER_ROOT
if (!root) throw new Error("Owned provider result root is absent")
const owner = await Effect.runPromise(Scope.make())
const prepared = await (async () => {
  try {
    const bootstrap = await Effect.runPromise(Effect.gen(function* () {
      return yield* NativeWindowsBootstrap.make(yield* NativeInstallation.current())
    }).pipe(Effect.provideService(Scope.Scope, owner)))
    const { seedRipgrep } = await import("../lib/seed-ripgrep")
    await seedRipgrep(process.env.DEEPAGENT_CODE_TEST_HOME!)
    const { Log } = await import("@deepagent-code/core/util/log")
    await Log.init({ print: false, dev: true, level: "DEBUG" })
    const { initProjectors } = await import("../../src/server/projectors")
    initProjectors()
    await import("../provider/provider.test")
    const result = await runCompiledTests(1)
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
await fs.writeFile(path.join(root, "windows-provider-cases.json"), JSON.stringify({
  ...result,
  currentBeforeRetirement,
  retiredReadRejected,
}))
console.info("WINDOWS_PROVIDER_COVERAGE", JSON.stringify({
  expected: result.expected,
  registered: result.registered,
  executed: result.executed,
  pass: result.pass,
}))
process.exit(result.pass && currentBeforeRetirement && retiredReadRejected ? 0 : 2)
