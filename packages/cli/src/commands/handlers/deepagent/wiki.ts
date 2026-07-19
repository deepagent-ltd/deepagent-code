import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { rawGet, requireCapability } from "./util"

type WikiPageSummary = { docId: string; type: string; title: string; scope: string; editable: boolean; version: number }
type WikiPage = { docId: string; type: string; title: string; markdown: string; editable: boolean; version: number }
type WikiSearchHit = { docId: string; type: string; scope: string; title: string; score: number }

export default Runtime.handler(Commands.commands.wiki, Effect.fn("cli.wiki")(function* (input) {
  yield* requireCapability("wiki")

  if (input.action === "list") {
    const typeFlag = Option.getOrElse(input.type as Option.Option<string>, () => undefined)
    const url = typeFlag ? `/deepagent/wiki/pages?type=${encodeURIComponent(typeFlag)}` : "/deepagent/wiki/pages"
    const result = yield* rawGet<{ pages: WikiPageSummary[] }>(url)
    const pages = result.data?.pages ?? []
    for (const p of pages) {
      console.log(`${p.docId} [${p.type}] ${p.title}`)
      console.log(`  scope: ${p.scope}, v${p.version}${p.editable ? " (editable)" : ""}`)
    }
    if (pages.length === 0) console.log("No wiki pages found")
    return
  }

  if (input.action === "get") {
    const docId = input.args[0] as string | undefined
    if (!docId) yield* Effect.fail(new Error("docId is required: wiki get <docId>"))
    const scope = Option.getOrElse(input.scope as Option.Option<string>, () => "project")
    const result = yield* rawGet<WikiPage>(`/deepagent/wiki/page?docId=${encodeURIComponent(docId!)}&scope=${encodeURIComponent(scope)}`)
    if (!result.data) {
      console.log("Page not found")
      return
    }
    console.log(`# ${result.data.title}`)
    console.log(`docId: ${result.data.docId} | type: ${result.data.type} | v${result.data.version}`)
    console.log("---")
    console.log(result.data.markdown)
    return
  }

  // search
  const text = (input.args as ReadonlyArray<string>).join(" ")
  if (!text) yield* Effect.fail(new Error("Search text is required: wiki search <text>"))
  const params = new URLSearchParams({ text })
  const typeFlag = Option.getOrElse(input.type as Option.Option<string>, () => undefined)
  const scopeFlag = Option.getOrElse(input.scope as Option.Option<string>, () => undefined)
  if (typeFlag) params.set("type", typeFlag)
  if (scopeFlag) params.set("scope", scopeFlag)
  const result = yield* rawGet<{ hits: WikiSearchHit[] }>(`/deepagent/wiki/search?${params.toString()}`)
  const hits = result.data?.hits ?? []
  for (const h of hits) {
    console.log(`${h.docId} [${h.type}] ${h.title} (score: ${h.score.toFixed(2)})`)
  }
  if (hits.length === 0) console.log("No results found")
}))
