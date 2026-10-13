import { Cause, Effect, Exit } from "effect"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { NativeInstallation } from "../../../src/installation/native-installation"

// Include the actual native module in the compiled fixture. No HTTP request or executor service is started.
if (RequestExecutor.isNativeObservation({ wireHash: "", bodyHash: "", bodyLength: 0, contentType: undefined }))
  throw new Error("Fabricated observation was accepted")

function emit(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const mode = process.argv.at(-1)
const program = Effect.gen(function* () {
  const handle = yield* NativeInstallation.current()
  const description = yield* NativeInstallation.describe(handle)
  if (mode === "hold") {
    emit({ ready: true, description })
    yield* Effect.promise(async () => {
      const reader = Bun.stdin.stream().getReader()
      try {
        const value = await reader.read()
        if (!value.done && value.value.byteLength > 0) return
        throw new Error("Fixture continuation was not provided")
      } finally {
        reader.releaseLock()
      }
    })
  }
  if (mode === "handles") {
    const fake = [
      {},
      { ...handle },
      JSON.parse(JSON.stringify(handle)),
      description,
      null,
    ] as NativeInstallation.VerifiedInstalledComponents[]
    const rejected = yield* Effect.forEach(fake, (input) =>
      Effect.all([
        Effect.exit(NativeInstallation.describe(input)),
        Effect.exit(NativeInstallation.requireCurrent(input)),
      ]),
    )
    return {
      description,
      frozen: Object.isFrozen(handle) && Object.isFrozen(description),
      mutable: Reflect.set(description, "executableHash", "fabricated"),
      serialized: JSON.stringify(handle),
      rejected: rejected.flat().every(Exit.isFailure),
      errors: rejected
        .flat()
        .flatMap((exit) => (Exit.isFailure(exit) ? [JSON.stringify(Cause.squash(exit.cause))] : [])),
    }
  }
  if (mode === "hold") {
    const rechecked = yield* Effect.exit(NativeInstallation.requireCurrent(handle))
    if (Exit.isFailure(rechecked)) {
      const invalidated = yield* Effect.exit(NativeInstallation.describe(handle))
      emit({ invalidated: Exit.isFailure(invalidated) })
      return yield* Effect.failCause(rechecked.cause)
    }
    return { description, rechecked: rechecked.value }
  }
  return { description, rechecked: yield* NativeInstallation.requireCurrent(handle) }
})

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit)) {
  emit({ ok: false, error: Cause.pretty(exit.cause), structured: Cause.squash(exit.cause) })
  process.exitCode = 2
} else emit({ ok: true, result: exit.value })
