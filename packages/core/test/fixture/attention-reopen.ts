import "./install-version"
import { Effect } from "effect"
import { Attention } from "../../src/attention"
import { services } from "./attention"

const list = await Effect.runPromise(
  Attention.Service.use((service) => service.list()).pipe(Effect.provide(services(process.argv[2]!)), Effect.scoped),
)
process.stdout.write(JSON.stringify(list))
