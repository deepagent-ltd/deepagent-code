import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { call } from "./util"

type PackItem = { id: string; name: string; version: string; risk: string; pinned: boolean; builtin?: boolean; description?: string }

export default Runtime.handler(Commands.commands.packs, Effect.fn("cli.packs")(function* (input) {
  if (input.action === "list") {
    const result = yield* call((c) => c.deepagent.packsAll())
    const packs = ((result.data as { packs?: PackItem[] })?.packs) ?? []
    for (const p of packs) {
      const tags = [p.builtin ? "builtin" : null, p.pinned ? "pinned" : null].filter(Boolean).join(", ")
      console.log(`${p.id}${tags ? ` [${tags}]` : ""}`)
      console.log(`  ${p.name} v${p.version} — risk: ${p.risk}`)
      if (p.description) console.log(`  ${p.description}`)
    }
    if (packs.length === 0) console.log("No domain packs found")
    return
  }

  const packId = Option.getOrElse(input.packId, () => "")
  if (!packId) yield* Effect.fail(new Error("packId is required for pin/unpin"))

  if (input.action === "pin") {
    const result = yield* call((c) => c.deepagent.packsPin({ packId }))
    if ((result.data as { ok?: boolean })?.ok) console.log(`Pinned: ${packId}`)
    else console.log(`Failed to pin: ${packId}`)
    return
  }

  const result = yield* call((c) => c.deepagent.packsUnpin({ packId }))
  if ((result.data as { ok?: boolean })?.ok) console.log(`Unpinned: ${packId}`)
  else console.log(`Failed to unpin: ${packId}`)
}))
