import path from "node:path"
import { Effect } from "effect"
import { WorkProviderDispatchFixture } from "./work-provider-dispatch"
import { WorkRouteFixture } from "./work-route"

// Private deterministic process fixture only. No production runtime/counter approval is installed.
const fixture: WorkProviderDispatchFixture.Context = {
  root: process.argv[2]!,
  filename: path.join(process.argv[2]!, "authority.sqlite"),
  candidate: WorkRouteFixture.candidate(process.argv[3]!),
  state: { mode: "wait", bodies: [], reads: 0, streams: 0 },
}
await WorkProviderDispatchFixture.open(
  fixture,
  Effect.gen(function* () {
    const data = yield* WorkProviderDispatchFixture.initialize(fixture)
    yield* WorkProviderDispatchFixture.execute(fixture, data)
  }),
  { leaseMs: 1_000 },
)
