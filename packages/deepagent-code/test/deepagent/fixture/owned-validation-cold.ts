import { Cause, Effect, Exit } from "effect"
import { OwnedValidation } from "../../../src/deepagent/owned-validation"

const persisted = await Bun.file(process.argv[2]!).json()
const result = await Effect.runPromise(OwnedValidation.run(persisted).pipe(Effect.exit))
const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
console.log(
  JSON.stringify({
    inspectMissing: OwnedValidation.inspect(persisted) === undefined,
    unavailable: error instanceof OwnedValidation.Error && error.code === "HANDLE_UNAVAILABLE",
  }),
)
