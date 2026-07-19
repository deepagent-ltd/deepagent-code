import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect, Option } from "effect"

export default Runtime.handler(Commands.commands.upgrade, (input) =>
  Effect.gen(function* () {
    const { Installation } = yield* Effect.promise(() => import("deepagent-code/installation/index"))
    const { InstallationVersion } = yield* Effect.promise(() =>
      import("@deepagent-code/core/installation/version"),
    )

    const methodOpt = input.method as Option.Option<string>
    const detectedMethod = yield* Effect.promise(() => Installation.method())
    const methodRaw = Option.getOrElse(methodOpt, () => detectedMethod)
    const method = methodRaw as string

    if (method === "unknown") {
      yield* Effect.fail(
        new Error(
          `deepagent-code is installed to ${process.execPath} and may be managed by a package manager. Use --method to specify.`,
        ),
      )
    }

    console.log(`Using method: ${method}`)
    const targetOpt = input.target as Option.Option<string>
    const targetRaw = Option.getOrElse(targetOpt, () => undefined)
    const target = targetRaw ? targetRaw.replace(/^v/, "") : yield* Effect.promise(() => Installation.latest())

    if (InstallationVersion === target) {
      console.log(`deepagent-code upgrade skipped: ${target} is already installed`)
      return
    }

    console.log(`From ${InstallationVersion} → ${target}`)
    yield* Effect.tryPromise({
      try: () => Installation.upgrade(method as never, target),
      catch: (err) =>
        new Error(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`),
    })
    console.log("Upgrade complete")
  }),
)
