import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { TextField } from "@deepagent-code/ui/text-field"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { BrowserFilesApproveData, BrowserFilesListResponse, BrowserFilesPreviewResponse, BrowserFilesStatusResponse,
  BrowserGetResponse } from "@deepagent-code/sdk"

type State = { owner: string; busy: boolean; error: string; direction: "upload" | "download"; relative: string;
  target: string; preview?: BrowserFilesPreviewResponse; approval?: BrowserFilesApproveData["body"];
  status?: BrowserFilesStatusResponse; page?: BrowserFilesListResponse; cursor?: string; unknown: boolean }
const drafts = new WeakMap<object, Map<string, [Store<State>, SetStoreFunction<State>]>>()

export function BrowserFileExchange(props: { view: BrowserGetResponse; active: () => boolean }) {
  const sdk = useSDK()
  const language = useLanguage()
  const client = sdk.client
  const directory = sdk.directory
  const scope = sdk.scope
  const controlID = props.view.control.controlID
  const owner = crypto.randomUUID()
  const entries = drafts.get(client) ?? new Map<string, [Store<State>, SetStoreFunction<State>]>()
  drafts.set(client, entries)
  const key = JSON.stringify([scope, directory, controlID])
  const [state, setState] = entries.get(key) ?? createStore<State>({ owner, busy: false, error: "", direction: "upload",
    relative: "", target: "", unknown: false })
  if (entries.size < 64 || entries.has(key)) entries.set(key, [state, setState])
  setState({ owner, busy: false })
  const lifetime = { disposed: false, generation: 0, abort: new AbortController() }
  const current = () => !lifetime.disposed && state.owner === owner && sdk.client === client && sdk.scope === scope &&
    sdk.directory === directory && props.view.control.controlID === controlID
  const text = (key: string) => language.t(`browser.files.${key}` as Parameters<typeof language.t>[0])
  const enabled = () => current() && props.active() && props.view.control.profile === "managed-loopback-exchange-v1"
  const signal = () => AbortSignal.any([lifetime.abort.signal, AbortSignal.timeout(30_000)])
  onCleanup(() => { lifetime.disposed = true; lifetime.generation++; lifetime.abort.abort() })
  createEffect(() => { if (current()) return; lifetime.generation++; lifetime.abort.abort() })
  const run = async (body: () => Promise<void>) => {
    if (!current() || state.busy) return
    const generation = ++lifetime.generation
    setState({ busy: true, error: "" })
    try { await body() }
    catch { if (current() && lifetime.generation === generation) setState("error", text("error")) }
    finally { if (current() && lifetime.generation === generation) setState("busy", false) }
  }
  const list = async (cursor?: string) => {
    const result = await client.browser.filesList({ controlID, cursor, limit: "4" }, { signal: signal(), throwOnError: true })
    if (current()) setState({ page: result.data, cursor })
  }
  const reconcile = async () => {
    const command = state.approval
    if (!command) return
    const result = await client.browser.filesStatus({ controlID, requestID: command.requestID }, { signal: signal(), throwOnError: true })
    if (!current()) return
    setState({ status: result.data, unknown: result.data.state === "missing" })
  }
  const preview = () => run(async () => {
    if (!enabled() || state.approval || entries.size >= 64 && !entries.has(key)) return
    const body = state.direction === "upload"
      ? { direction: state.direction, relative: state.relative.trim(), targetPath: state.target.trim() }
      : { direction: state.direction, relative: state.relative.trim(), targetURL: state.target.trim(), maxBytes: 52_428_800 }
    const result = await client.browser.filesPreview({ controlID, body }, { signal: signal(), throwOnError: true })
    if (!current() || result.data.controlID !== controlID || result.data.controlRevision !== props.view.control.revision) return
    setState({ preview: result.data, status: undefined, unknown: false })
  })
  const approve = () => run(async () => {
    const value = state.preview
    if (!enabled() || !value || value.controlID !== controlID) return
    const command = state.approval ?? { requestID: crypto.randomUUID(), previewID: value.previewID,
      expectedControlRevision: value.controlRevision, expiresAt: Math.min(props.view.control.expiresAt, Date.now() + 300_000) }
    if (!current()) return
    // Preserve the exact command before native confirmation. Reopening queries this ID,
    // and a lost response never grants permission to transfer or to create another grant.
    setState({ approval: command, unknown: true })
    const result = await client.browser.filesApprove({ controlID, ...command }, { signal: signal(), throwOnError: true })
    if (!current() || result.data.controlID !== controlID) return
    await reconcile()
    await list(undefined)
  })
  onMount(() => void run(async () => { await reconcile(); await list(state.cursor) }))
  return <section class="flex min-w-0 flex-col gap-3 rounded-lg border border-border-base p-3" aria-label={text("title")}>
    <p class="text-13-medium text-text-strong">{text("title")}</p>
    <p class="text-12-regular text-text-weak">{text("hint")}</p>
    <div class="flex flex-col gap-2">
      <span id={`browser-file-direction-${owner}`} class="text-13-regular">{text("direction")}</span>
      <SelectV2 aria-labelledby={`browser-file-direction-${owner}`} options={["upload", "download"] as const}
        current={state.direction} label={(value) => text(value)} disabled={state.busy || !!state.approval || !enabled()}
        onSelect={(value) => { if (value) setState({ direction: value, preview: undefined }) }} />
    </div>
    <TextField label={text("relative")} description={text("relativeHint")} value={state.relative}
      disabled={state.busy || !!state.approval || !enabled()} onChange={(value) => setState({ relative: value, preview: undefined })} />
    <TextField label={text(state.direction === "upload" ? "postPath" : "downloadURL")} value={state.target}
      disabled={state.busy || !!state.approval || !enabled()} onChange={(value) => setState({ target: value, preview: undefined })} />
    <Show when={state.preview}>{(value) => <div class="flex min-w-0 flex-col gap-1 text-12-regular [overflow-wrap:anywhere]">
      <span>{value().preview.relative}</span>
      <span>{(() => { const preview = value().preview; return preview.direction === "upload" ? preview.bytes : preview.maxBytes })()} {text("bytes")}</span>
      <span>{(() => { const preview = value().preview; return preview.direction === "upload" ? preview.sha256 : "" })()}</span>
      <span>{text("nativeConfirmation")}</span>
    </div>}</Show>
    <Show when={state.status?.grant}>{(grant) => <p role="status" class="text-12-regular [overflow-wrap:anywhere]">
      {grant().name} · {text(grant().state)} · {new Date(grant().expiresAt).toLocaleTimeString()}
    </p>}</Show>
    <Show when={state.unknown}><p role="status" class="text-12-regular text-text-weak">{text("unknown")}</p></Show>
    <Show when={state.error}><p role="alert" class="text-12-regular text-text-danger-base">{state.error}</p></Show>
    <div class="flex flex-wrap gap-2">
      <Button size="small" variant="secondary" disabled={state.busy || !enabled() || !!state.approval || !state.relative || !state.target}
        onClick={() => void preview()}>{text("preview")}</Button>
      <Button size="small" disabled={state.busy || !enabled() || !state.preview || !!state.status?.grant}
        onClick={() => void approve()}>{text(state.approval ? "retryExact" : "approve")}</Button>
      <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void run(async () => { await reconcile(); await list(state.cursor) })}>
        {text("refresh")}</Button>
      <Button size="small" variant="secondary" disabled={state.busy || state.unknown} onClick={() =>
        setState({ preview: undefined, approval: undefined, status: undefined, unknown: false, error: "" })}>{text("new")}</Button>
    </div>
    <Show when={state.page}>{(page) => <div class="flex min-w-0 flex-col gap-2">
      <For each={page().grants}>{(grant) => <p class="text-12-regular [overflow-wrap:anywhere]">{grant.name} · {text(grant.direction)} · {text(grant.state)}</p>}</For>
      <For each={page().files}>{(file) => <p class="text-12-regular [overflow-wrap:anywhere]">{file.name} · {file.bytes} {text("bytes")} · {text(file.state)}</p>}</For>
      <div class="flex flex-wrap gap-2">
        <Button size="small" variant="ghost" disabled={state.busy || !state.cursor} onClick={() => void run(() => list(undefined))}>{text("first")}</Button>
        <Button size="small" variant="ghost" disabled={state.busy || !page().nextCursor} onClick={() => void run(() => list(page().nextCursor ?? undefined))}>{text("next")}</Button>
      </div>
    </div>}</Show>
  </section>
}
