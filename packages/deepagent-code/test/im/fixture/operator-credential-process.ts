import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { ServerAuth } from "../../../src/server/auth"
import { layer, prepare } from "./operator-credentials"

const database = Database.defaultLayer
const result = await Effect.runPromise(
  prepare(process.argv[2]!).pipe(
    Effect.provide(layer.pipe(Layer.provide(database))),
    Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
    Effect.provide(database),
    Effect.provide(ServerAuth.Config.defaultLayer),
    Effect.scoped,
  ),
)
process.stdout.write(`${JSON.stringify(result)}\n`)
