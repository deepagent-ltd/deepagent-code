/** @jsxImportSource @opentui/solid */
export * as IMReaderProductTUI from "./im-reader-product"

import { TextRenderable, TextareaRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { IMReaderProductDescriptor } from "../../../app/test/fixture/im-reader-product-descriptor"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { SDKProvider } from "../../src/context/sdk"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiI18nProvider, useTuiI18n } from "../../src/context/i18n"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogIM } from "../../src/component/dialog-im"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

function nodes(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(nodes)]
}

export async function run(descriptorFile: string, observationDirectory: string) {
  if (!observationDirectory.startsWith("/")) throw new Error("Private observation directory required")
  const prepared = await IMReaderProductDescriptor.prepare(descriptorFile, true)
  await fs.mkdir(observationDirectory, { recursive: true, mode: 0o700 })
  const deadline = Math.min(prepared.input.deadlineAt, Date.now() + 75_000)
  const observations: { scope: "A" | "B"; kind: "groups" | "messages" | "detail"; lane: string;
    cursorHash: string; status: number; ids: string[]; epochHash: string }[] = []
  const completed: { scope: "A" | "B"; messageIDsObserved: number; renderedMarkers: number;
    visibleOldest: boolean; uiMessagePages: number }[] = []
  const state = { phase: "prepare", mutations: 0, legacyGroups: 0, wrongDirectory: 0, ownedRenderers: 0 }
  try {
    for (const key of ["A", "B", "A"] as const) {
      const scope = prepared.input.scopes[key]
      const from = observations.length
      const privateState = path.join(observationDirectory, `state-${completed.length}-${key}`)
      await fs.mkdir(privateState, { mode: 0o700 })
      await fs.writeFile(path.join(privateState, "kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }), { mode: 0o600 })
      const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname.startsWith("/api/v1/im/")) {
          if (request.method !== "GET") state.mutations++
          if (url.pathname.endsWith("/groups")) state.legacyGroups++
          if (url.searchParams.get("directory") !== scope.directory) state.wrongDirectory++
        }
        const response = await fetch(request)
        const kind = url.pathname.endsWith("/groups/page") ? "groups"
          : url.pathname.endsWith("/messages") ? "messages"
          : /^\/api\/v1\/im\/groups\/[^/]+$/.test(url.pathname) ? "detail" : undefined
        if (kind && request.method === "GET") {
          const raw = await response.clone().text()
          const value = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw))
          const rows = value && typeof value === "object" && (kind === "groups" ? "groups" in value : "messages" in value)
            ? kind === "groups" && "groups" in value ? value.groups : "messages" in value ? value.messages : undefined : undefined
          const reader = value && typeof value === "object" && "reader" in value ? value.reader : undefined
          const epoch = reader && typeof reader === "object" && "displayEpoch" in reader ? reader.displayEpoch : undefined
          observations.push({ scope: key, kind, lane: url.searchParams.get("lane") ?? "", status: response.status,
            cursorHash: url.searchParams.has("cursor") ? createHash("sha256").update(url.searchParams.get("cursor")!).digest("hex") : "",
            ids: Array.isArray(rows) ? rows.flatMap((row: unknown) => row && typeof row === "object" && "id" in row && typeof row.id === "string" ? [row.id] : []) : [],
            epochHash: typeof epoch === "string" ? createHash("sha256").update(epoch).digest("hex") : "" })
        }
        return response
      }, { preconnect: fetch.preconnect })
      function Open() {
        const dialog = useDialog()
        useTuiI18n().setLocale("en")
        onMount(() => dialog.replace(() => <DialogIM />))
        return <box />
      }
      function Harness() {
        const renderer = useRenderer()
        const keymap = createDefaultOpenTuiKeymap(renderer)
        const config = createTuiResolvedConfig({})
        onCleanup(registerOpencodeKeymap(keymap, renderer, config))
        return <TestTuiContexts directory={scope.directory} paths={{ home: privateState, state: privateState, worktree: scope.directory }}>
          <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark"><ToastProvider>
            <SDKProvider url={prepared.input.root.url} directory={scope.directory} headers={{ Authorization: prepared.authorization }} fetch={transport}>
              <TuiI18nProvider><ClipboardProvider value={{}}><DialogProvider><Open /></DialogProvider></ClipboardProvider></TuiI18nProvider>
            </SDKProvider>
          </ToastProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider>
        </TestTuiContexts>
      }
      const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
      state.ownedRenderers++
      async function until(test: () => boolean, maximum = 10_000) {
        const untilAt = Math.min(deadline, Date.now() + maximum)
        while (Date.now() < untilAt) {
          await app.renderOnce()
          if (test()) return
          await Bun.sleep(20)
        }
        throw new Error("Original TUI reader stage did not settle")
      }
      async function select(label: string) {
        const editor = app.renderer.currentFocusedEditor
        if (!(editor instanceof TextareaRenderable)) throw new Error("Original menu search has no keyboard owner")
        editor.clear()
        await app.mockInput.typeText(label)
        await until(() => app.captureCharFrame().includes(label))
        app.mockInput.pressEnter()
      }
      try {
        state.phase = `scope_${key}_list`
        await until(() => observations.slice(from).some((row) => row.kind === "groups" && row.lane === "ordinary") &&
          observations.slice(from).some((row) => row.kind === "groups" && row.lane === "protected"))
        for (const lane of ["ordinary", "protected"] as const) {
          const expected = scope[lane]
          for (let round = 0; round < 32; round++) {
            const ids = new Set(observations.slice(from).filter((row) => row.kind === "groups" && row.lane === lane).flatMap((row) => row.ids))
            if (expected.every((group) => ids.has(group.id))) break
            const before = observations.length
            await select(lane === "ordinary" ? "Load more local conversations" : "Load more remote conversations")
            await until(() => observations.length > before)
            if (round === 31) throw new Error("Original conversation page budget exceeded")
          }
        }
        const selected = scope.protected.find((group) => group.id === scope.selectedGroupID)!
        state.phase = `scope_${key}_history`
        await select(selected.name)
        await until(() => app.captureCharFrame().includes(scope.messages.newestMarker))
        for (let round = 0; round < 8; round++) {
          const ids = new Set(observations.slice(from).filter((row) => row.kind === "messages").flatMap((row) => row.ids))
          if (scope.messages.ids.every((id) => ids.has(id))) break
          const before = observations.filter((row) => row.kind === "messages").length
          app.mockInput.pressKey("p", { ctrl: true })
          await until(() => observations.filter((row) => row.kind === "messages").length > before)
          if (round === 7) throw new Error("Original history page budget exceeded")
        }
        await until(() => scope.messages.markers.every((marker) => nodes(app.renderer.root)
          .some((node) => node instanceof TextRenderable && node.plainText === marker)))
        const transcript = nodes(app.renderer.root).find((node) => node instanceof ScrollBoxRenderable)
        if (!(transcript instanceof ScrollBoxRenderable)) throw new Error("Original transcript widget is absent")
        // This observes the original widget's viewport, not native keyboard scrolling.
        transcript.scrollTo(0)
        await until(() => app.captureCharFrame().includes(scope.messages.oldestMarker))
        await fs.writeFile(path.join(observationDirectory, `tui-${completed.length}-${key}-oldest.txt`), app.captureCharFrame(), { mode: 0o600, flag: "wx" })
        const ids = new Set(observations.slice(from).filter((row) => row.kind === "messages").flatMap((row) => row.ids))
        if (ids.size !== 125 || scope.messages.ids.some((id) => !ids.has(id))) throw new Error("Original history identities differ")
        completed.push({ scope: key, messageIDsObserved: ids.size, renderedMarkers: scope.messages.markers.length,
          visibleOldest: true, uiMessagePages: observations.slice(from).filter((row) => row.kind === "messages" && row.status === 200).length })
      } finally {
        app.renderer.destroy()
        state.ownedRenderers--
      }
    }
    if (state.mutations || state.legacyGroups || state.wrongDirectory) throw new Error("Original TUI read path violated scope or mutation boundary")
    state.phase = "normal_pagination_complete_faults_open"
  } finally {
    await fs.writeFile(path.join(observationDirectory, "tui-reader-safe.json"), JSON.stringify({
      version: 1, phase: state.phase, originalOpenTUI: true, actualHTTP: true, completeCLI: false, completed,
      mutations: state.mutations, legacyGroups: state.legacyGroups, wrongDirectory: state.wrongDirectory,
      pages: observations.map((row) => ({ ...row, ids: undefined, itemCount: row.ids.length,
        idsHash: createHash("sha256").update(JSON.stringify(row.ids)).digest("hex") })),
      ownedRenderers: state.ownedRenderers, faults: IMReaderProductDescriptor.safe(prepared.input).faultCoverage,
    }, null, 2), { mode: 0o600, flag: "wx" })
  }
}

if (import.meta.main) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Original reader descriptor and private observation directory required")
  if (process.argv[4] === "--dry") {
    const prepared = await IMReaderProductDescriptor.prepare(process.argv[2])
    console.log(JSON.stringify({ dry: true, ...IMReaderProductDescriptor.safe(prepared.input), backendStarted: false }))
  }
  if (process.argv[4] !== "--dry") await run(process.argv[2], process.argv[3]).catch(() => {
    console.error("IM_READER_TUI_STAGE_FAILED; inspect private safe observation")
    process.exitCode = 1
  })
}
