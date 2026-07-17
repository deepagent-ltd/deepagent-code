import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { call } from "./util"

type KnowledgeItem = {
  id: string
  type: string
  summary: string
  evidence_strength: string
  approval_status: string
}

export default Runtime.handler(Commands.commands.review, Effect.fn("cli.review")(function* (input) {
  if (input.action === "pending") {
    const result = yield* call((c) => c.deepagent.knowledge.pending())
    const items = ((result.data as { items?: KnowledgeItem[] })?.items) ?? []
    for (const item of items) {
      console.log(`${item.id} [${item.approval_status}] ${item.type} — ${item.evidence_strength}`)
      console.log(`  ${item.summary}`)
    }
    if (items.length === 0) console.log("No pending knowledge")
    return
  }

  // approve / reject
  const ids = [...(input.ids as ReadonlyArray<string>)]
  if (ids.length === 0) yield* Effect.fail(new Error(`At least one ID is required: review ${input.action} <id...>`))

  if (input.action === "approve") {
    const result = yield* call((c) => c.deepagent.knowledge.approve({ ids }))
    const updated = (result.data as { updated?: string[] })?.updated ?? []
    console.log(`Approved ${updated.length} item(s): ${updated.join(", ")}`)
    return
  }

  const result = yield* call((c) => c.deepagent.knowledge.rejectIds({ ids }))
  const updated = (result.data as { updated?: string[] })?.updated ?? []
  console.log(`Rejected ${updated.length} item(s): ${updated.join(", ")}`)
}))
