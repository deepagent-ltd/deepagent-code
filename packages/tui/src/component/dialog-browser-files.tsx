import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { BrowserFilesApproveData, BrowserFilesListResponse, BrowserFilesPreviewResponse, BrowserFilesStatusResponse,
  BrowserGetResponse } from "@deepagent-code/sdk"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useTuiI18n } from "../context/i18n"
import { DialogSelect } from "../ui/dialog-select"
import { DialogIMForm } from "./dialog-im-form"

type State = { owner: string; busy: boolean; error: string; form?: "upload" | "download";
  preview?: BrowserFilesPreviewResponse; approval?: BrowserFilesApproveData["body"];
  status?: BrowserFilesStatusResponse; page?: BrowserFilesListResponse; cursor?: string; unknown: boolean }
const drafts = new WeakMap<object, Map<string, [Store<State>, SetStoreFunction<State>]>>()

export function DialogBrowserFiles(props: { view: BrowserGetResponse; active: () => boolean; back: () => void }) {
  const sdk = useSDK()
  const project = useProject()
  const i18n = useTuiI18n()
  const client = sdk.client
  const directory = project.instance.directory()
  const workspace = project.workspace.current()
  const controlID = props.view.control.controlID
  const owner = crypto.randomUUID()
  const entries = drafts.get(client) ?? new Map<string, [Store<State>, SetStoreFunction<State>]>()
  drafts.set(client, entries)
  const key = JSON.stringify([directory, workspace, controlID])
  const [state, setState] = entries.get(key) ?? createStore<State>({ owner, busy: false, error: "", unknown: false })
  if (entries.size < 64 || entries.has(key)) entries.set(key, [state, setState])
  setState({ owner, busy: false })
  const lifetime = { disposed: false, generation: 0, abort: new AbortController() }
  const current = () => !lifetime.disposed && state.owner === owner && sdk.client === client &&
    project.instance.directory() === directory && project.workspace.current() === workspace && props.view.control.controlID === controlID
  const enabled = () => current() && props.active() && props.view.control.profile === "managed-loopback-exchange-v1"
  const text = (key: string) => i18n.t(`tui.browser.files.${key}` as Parameters<typeof i18n.t>[0])
  const signal = () => AbortSignal.any([lifetime.abort.signal, AbortSignal.timeout(30_000)])
  onCleanup(() => { lifetime.disposed = true; lifetime.generation++; lifetime.abort.abort() })
  createEffect(() => { if (current()) return; lifetime.generation++; lifetime.abort.abort() })
  const run = async (operation: () => Promise<void>) => {
    if (!current() || state.busy) return
    const generation = ++lifetime.generation
    setState({ busy: true, error: "" })
    try { await operation() }
    catch { if (current() && lifetime.generation === generation) setState("error", text("error")) }
    finally { if (current() && lifetime.generation === generation) setState("busy", false) }
  }
  const list = async (cursor?: string) => {
    const response = await client.browser.filesList({ controlID, cursor, limit: "4" }, { signal: signal(), throwOnError: true })
    if (current()) setState({ page: response.data, cursor })
  }
  const reconcile = async () => {
    const command = state.approval
    if (!command) return
    const response = await client.browser.filesStatus({ controlID, requestID: command.requestID }, { signal: signal(), throwOnError: true })
    if (current()) setState({ status: response.data, unknown: response.data.state === "missing" })
  }
  const approve = () => run(async () => {
    const preview = state.preview
    if (!enabled() || !preview || preview.controlID !== controlID) return
    const command = state.approval ?? { requestID: crypto.randomUUID(), previewID: preview.previewID,
      expectedControlRevision: preview.controlRevision, expiresAt: Math.min(props.view.control.expiresAt, Date.now() + 300_000) }
    setState({ approval: command, unknown: true })
    const result = await client.browser.filesApprove({ controlID, ...command }, { signal: signal(), throwOnError: true })
    if (!current() || result.data.controlID !== controlID) return
    await reconcile()
    await list()
  })
  const refresh = () => run(async () => { await reconcile(); await list(state.cursor) })
  onMount(() => void refresh())
  return <Show when={state.form} fallback={<DialogSelect title={text("title")} locked={state.busy} renderFilter={false}
    options={[
      { title: text("upload"), value: "upload", disabled: !enabled() || !!state.approval },
      { title: text("download"), value: "download", disabled: !enabled() || !!state.approval },
      { title: text(state.approval ? "retryExact" : "approve"), value: "approve", disabled: !enabled() || !state.preview || !!state.status?.grant },
      { title: text("refresh"), value: "refresh" },
      { title: text("new"), value: "new", disabled: state.unknown },
      { title: text("first"), value: "first", disabled: !state.cursor },
      { title: text("next"), value: "next", disabled: !state.page?.nextCursor },
      { title: i18n.t("tui.im.taskProposal.back"), value: "back" },
    ]}
    onSelect={(option) => {
      if (!current() || state.busy || option.disabled) return
      if (option.value === "back") { props.back(); return }
      if (option.value === "upload" || option.value === "download") { setState("form", option.value); return }
      if (option.value === "approve") { void approve(); return }
      if (option.value === "refresh") { void refresh(); return }
      if (option.value === "first") { void run(() => list()); return }
      if (option.value === "next") { void run(() => list(state.page?.nextCursor ?? undefined)); return }
      if (option.value === "new") setState({ approval: undefined, preview: undefined, status: undefined, unknown: false, error: "" })
    }}
    footer={<box paddingLeft={2} paddingRight={2} gap={1}>
      <text wrapMode="word">{text("hint")}</text>
      <Show when={state.busy}><text>{i18n.t("tui.im.working")}</text></Show>
      <Show when={state.preview}>{(value) => <text wrapMode="word">
        {value().preview.relative}{"\n"}
        {(() => { const preview = value().preview; return preview.direction === "upload" ? `${preview.bytes} ${text("bytes")}\n${preview.sha256}` : `${preview.maxBytes} ${text("bytes")}` })()}
        {"\n"}{text("nativeConfirmation")}
      </text>}</Show>
      <Show when={state.unknown}><text wrapMode="word">{text("unknown")}</text></Show>
      <Show when={state.error}><text wrapMode="word">{state.error}</text></Show>
      <For each={state.page?.grants}>{(grant) => <text wrapMode="word">{grant.name} · {text(grant.direction)} · {text(grant.state)}</text>}</For>
      <For each={state.page?.files}>{(file) => <text wrapMode="word">{file.name} · {file.bytes} {text("bytes")} · {text(file.state)}</text>}</For>
    </box>} />}>
    {(direction) => <DialogIMForm title={text("preview")} description={text("relativeHint")}
      fields={[{ label: text("relative") }, { label: text(direction() === "upload" ? "postPath" : "downloadURL") }]}
      back={() => setState("form", undefined)} submit={async (values, active) => {
        if (!enabled() || state.approval || entries.size >= 64 && !entries.has(key)) return
        const body = direction() === "upload"
          ? { direction: "upload" as const, relative: values[0].trim(), targetPath: values[1].trim() }
          : { direction: "download" as const, relative: values[0].trim(), targetURL: values[1].trim(), maxBytes: 52_428_800 }
        const result = await client.browser.filesPreview({ controlID, body }, { signal: signal(), throwOnError: true })
        if (!active() || !current() || result.data.controlID !== controlID || result.data.controlRevision !== props.view.control.revision) return
        setState({ preview: result.data, form: undefined, unknown: false, status: undefined, error: "" })
      }} />}
  </Show>
}
