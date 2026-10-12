import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { LocalOperator } from "../../src/im/local-operator"
import { WorkCountAcquisition } from "../../src/session/work-count-acquisition"
import { WorkAuthorityFixture } from "./work-authority"
import { WorkRouteApprovalFixture } from "./work-route-approval"

const [filename, keyfile, endpoint] = Bun.argv.slice(2)
if (!filename || !keyfile || !endpoint || !endpoint.startsWith("http://127.0.0.1:"))
  throw new Error("Invalid fixture input")
const proof = WorkRouteApprovalFixture.authority(Buffer.from(await Bun.file(keyfile).arrayBuffer()))
await Effect.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* WorkCountAcquisition.beginSending(db, {
      workID: "work-count",
      acquisitionID: "count-one",
      expectedRevision: 1,
      ownerToken: "owner-a",
      bootID: "boot-a",
      now: 1001,
    })
  }).pipe(
    Effect.provide(
      Layer.mergeAll(WorkAuthorityFixture.database(filename), proof.route, proof.count, WorkAuthorityFixture.verifier),
    ),
    Effect.provideService(LocalOperator.Runtime, WorkRouteApprovalFixture.runtime),
    Effect.scoped,
  ),
)
// Controlled caller only: the production acquisition/counter service is intentionally absent.
// One actual loopback disclosure follows the production store's committed sending transition.
await fetch(endpoint, { method: "POST", body: "controlled-count-disclosure", redirect: "manual" })
await new Promise(() => {})
