import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { call } from "./util"

type EnvFactItem = {
  fact_id: string
  version: number
  description: string
  degraded: boolean
  body?: { host?: string; port?: number; container?: string; purpose?: string }
}

export default Runtime.handler(Commands.commands["env-facts"], Effect.fn("cli.env-facts")(function* (input) {
  if (input.action === "list") {
    const result = yield* call((c) => c.deepagent.envFacts.list())
    const data = result.data as { adopted?: EnvFactItem[]; pending?: EnvFactItem[] } | undefined
    const adopted = data?.adopted ?? []
    const pending = data?.pending ?? []

    if (adopted.length > 0) {
      console.log("Adopted:")
      for (const f of adopted) {
        const deg = f.degraded ? " (degraded)" : ""
        console.log(`  ${f.fact_id} v${f.version}${deg}: ${f.description}`)
      }
    }
    if (pending.length > 0) {
      if (adopted.length > 0) console.log()
      console.log("Pending:")
      for (const f of pending) {
        const deg = f.degraded ? " (degraded)" : ""
        console.log(`  ${f.fact_id} v${f.version}${deg}: ${f.description}`)
      }
    }
    if (adopted.length === 0 && pending.length === 0) console.log("No environment facts found")
    return
  }

  // decide
  const factId = Option.getOrElse(input.factId, () => "")
  const decision = Option.getOrElse(input.decision, () => "")
  if (!factId) yield* Effect.fail(new Error("factId is required: env-facts decide <factId> <adopt|reject>"))
  if (!decision) yield* Effect.fail(new Error("decision is required: env-facts decide <factId> <adopt|reject>"))

  const result = yield* call((c) => c.deepagent.envFacts.decide({ factId, decision: decision as "adopt" | "reject" }))
  if ((result.data as { ok?: boolean })?.ok) console.log(`${decision}: ${factId}`)
  else console.log(`Failed: ${factId}`)
}))
