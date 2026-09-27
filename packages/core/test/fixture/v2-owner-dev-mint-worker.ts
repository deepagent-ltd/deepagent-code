import "./install-version"
import { Effect, Layer, Schedule } from "effect"
import { Database } from "../../src/database/database"
import { DatabaseBootstrapError } from "../../src/database/bootstrap"
import { FSUtil } from "../../src/fs-util"
import { Global } from "../../src/global"
import { V2OwnerDevMint } from "../../src/session/runner/v2-owner-dev-mint"
import { EffectFlock } from "../../src/util/effect-flock"

const input = JSON.parse(process.argv[2]!) as { readonly database: string; readonly state: string }
process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
delete process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY

const global = Global.layerWith({ state: input.state })
const flock = EffectFlock.layer.pipe(Layer.provide(global), Layer.provide(FSUtil.defaultLayer))

const outcome = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* V2OwnerDevMint.ensureDevOwnerAuthorization((yield* Database.Service).db, input.state)
  }).pipe(
    Effect.provide(Database.layerFromPath(input.database)),
    Effect.provide(flock),
    // Database preflight deliberately fences a concurrent process during migration checks.
    // Retry only that transient refusal; all other bootstrap failures still fail the worker.
    Effect.retry({
      while: (error) => error instanceof DatabaseBootstrapError &&
        error.state.issues.some((issue) => issue.code === "another_process_active"),
      schedule: Schedule.spaced("50 millis").pipe(Schedule.take(20)),
    }),
  ),
)

process.stdout.write(JSON.stringify(outcome))
