import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { TextField } from "@deepagent-code/ui/text-field"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { SharedBrowserView } from "@/context/platform"
import type {
  BrowserFilesApproveData,
  BrowserFilesListResponse,
  BrowserFilesPreviewResponse,
  BrowserFilesStatusResponse,
  BrowserGetResponse,
  BrowserSharedFilesApproveData,
  BrowserSharedFilesPreviewResponse,
  BrowserSharedFilesStatusResponse,
} from "@deepagent-code/sdk"

type Preview =
  | { kind: "legacy"; value: BrowserFilesPreviewResponse }
  | { kind: "shared"; value: BrowserSharedFilesPreviewResponse }
type Approval =
  | { kind: "legacy"; value: BrowserFilesApproveData["body"] }
  | { kind: "shared"; value: BrowserSharedFilesApproveData["body"] }
type State = {
  owner: string
  busy: boolean
  error: string
  direction: "upload" | "download"
  relative: string
  target: string
  preview?: Preview
  previewStamp?: string
  approval?: Approval
  status?: BrowserFilesStatusResponse | BrowserSharedFilesStatusResponse
  page?: BrowserFilesListResponse
  cursor?: string
  unknown: boolean
}
const drafts = new WeakMap<object, Map<string, [Store<State>, SetStoreFunction<State>]>>()

export function BrowserFileExchange(
  props: ({ view: BrowserGetResponse } | { shared: SharedBrowserView }) & { active: () => boolean },
) {
  const sdk = useSDK()
  const language = useLanguage()
  const client = sdk.client
  const directory = sdk.directory
  const scope = sdk.scope
  const identity = () =>
    "shared" in props
      ? ["shared", props.shared.resource.resourceID, props.shared.resource.rootSessionID, props.shared.resource.scope]
      : ["legacy", props.view.control.controlID, props.view.control.scope.sessionID, props.view.control.scope]
  const ownerKey = JSON.stringify(identity())
  const id = "shared" in props ? props.shared.resource.resourceID : props.view.control.controlID
  const owner = crypto.randomUUID()
  const entries = drafts.get(client) ?? new Map<string, [Store<State>, SetStoreFunction<State>]>()
  drafts.set(client, entries)
  const key = JSON.stringify([scope, directory, ownerKey])
  const [state, setState] =
    entries.get(key) ??
    createStore<State>({ owner, busy: false, error: "", direction: "upload", relative: "", target: "", unknown: false })
  if (entries.size < 64 || entries.has(key)) entries.set(key, [state, setState])
  setState({ owner, busy: false })
  const stamp = () => JSON.stringify([props.active(), "shared" in props ? props.shared.resource : props.view.control])
  const lifetime = { disposed: false, generation: 0, abort: new AbortController(), stamp: stamp() }
  const current = () =>
    !lifetime.disposed &&
    state.owner === owner &&
    sdk.client === client &&
    sdk.scope === scope &&
    sdk.directory === directory &&
    JSON.stringify(identity()) === ownerKey
  const text = (key: string) => language.t(`browser.files.${key}` as Parameters<typeof language.t>[0])
  const enabled = () =>
    current() &&
    props.active() &&
    ("shared" in props
      ? props.shared.resource.state === "agent_owned" &&
        !props.shared.resource.agentAccessFenced &&
        props.shared.resource.resourceAlive &&
        !!props.shared.resource.liveLeaseID
      : props.view.control.profile === "managed-loopback-exchange-v1")
  const permitted = () =>
    enabled() && ("view" in props || props.shared.resource.policy.filePolicy?.[state.direction] === true)
  const cancelled = () =>
    state.approval?.kind === "shared" &&
    state.status?.state === "cancelled" &&
    state.status.requestID === state.approval.value.requestID
  onCleanup(() => {
    lifetime.disposed = true
    lifetime.generation++
    lifetime.abort.abort()
  })
  createEffect(() => {
    const next = stamp()
    if (current() && lifetime.stamp === next && (!state.preview || state.previewStamp === next)) return
    lifetime.generation++
    lifetime.abort.abort()
    lifetime.abort = new AbortController()
    lifetime.stamp = next
    // Retain an unknown command across handoff; only its original bytes may be queried/retried.
    if (state.owner === owner)
      setState({
        busy: false,
        preview: undefined,
        status: cancelled() ? state.status : undefined,
        page: undefined,
        cursor: undefined,
      })
  })
  const run = async (body: (valid: () => boolean, signal: AbortSignal) => Promise<void>) => {
    if (!current() || state.busy) return
    const generation = ++lifetime.generation
    const snapshot = stamp()
    const valid = () => current() && lifetime.generation === generation && stamp() === snapshot
    const signal = AbortSignal.any([lifetime.abort.signal, AbortSignal.timeout(30_000)])
    setState({ busy: true, error: "" })
    try {
      await body(valid, signal)
    } catch {
      if (valid()) setState("error", text("error"))
    } finally {
      if (valid()) setState("busy", false)
    }
  }
  const list = async (cursor: string | undefined, valid: () => boolean, signal: AbortSignal) => {
    const result =
      "shared" in props
        ? await client.browser.sharedFilesList({ resourceID: id, cursor, limit: "4" }, { signal, throwOnError: true })
        : await client.browser.filesList({ controlID: id, cursor, limit: "4" }, { signal, throwOnError: true })
    if (valid()) setState({ page: result.data, cursor })
  }
  const reconcile = async (valid: () => boolean, signal: AbortSignal) => {
    const command = state.approval
    // A confirmed negative decision is terminal for these exact original bytes. Handoff
    // or reopening the view must not turn it into a retryable confirmation request.
    if (!command || cancelled()) return
    const result =
      command.kind === "shared"
        ? await client.browser.sharedFilesStatus(
            { resourceID: id, requestID: command.value.requestID },
            { signal, throwOnError: true },
          )
        : await client.browser.filesStatus(
            { controlID: id, requestID: command.value.requestID },
            { signal, throwOnError: true },
          )
    if (result.data.requestID !== command.value.requestID) throw new Error(text("error"))
    if (valid()) setState({ status: result.data, unknown: result.data.state === "missing" })
  }
  const preview = () =>
    run(async (valid, signal) => {
      if (!permitted() || state.approval || (entries.size >= 64 && !entries.has(key))) return
      if ("shared" in props) {
        const result = await client.browser.sharedFilesPreview(
          {
            resourceID: id,
            body:
              state.direction === "upload"
                ? { direction: "upload", relative: state.relative.trim(), targetURL: state.target.trim() }
                : {
                    direction: "download",
                    relative: state.relative.trim(),
                    targetURL: state.target.trim(),
                    maxBytes: 52_428_800,
                  },
          },
          { signal, throwOnError: true },
        )
        const value = result.data
        if (
          !valid() ||
          value.resourceID !== id ||
          value.resourceRevision !== props.shared.resource.revision ||
          value.leaseID !== props.shared.resource.liveLeaseID ||
          value.manualEpoch !== props.shared.resource.manualEpoch
        )
          return
        setState({ preview: { kind: "shared", value }, previewStamp: stamp(), status: undefined, unknown: false })
        return
      }
      const result = await client.browser.filesPreview(
        {
          controlID: id,
          body:
            state.direction === "upload"
              ? { direction: "upload", relative: state.relative.trim(), targetPath: state.target.trim() }
              : {
                  direction: "download",
                  relative: state.relative.trim(),
                  targetURL: state.target.trim(),
                  maxBytes: 52_428_800,
                },
        },
        { signal, throwOnError: true },
      )
      if (!valid() || result.data.controlID !== id || result.data.controlRevision !== props.view.control.revision)
        return
      setState({
        preview: { kind: "legacy", value: result.data },
        previewStamp: stamp(),
        status: undefined,
        unknown: false,
      })
    })
  const approve = () =>
    run(async (valid, signal) => {
      if (cancelled()) return
      const preview = state.preview
      const command: Approval | undefined =
        state.approval ??
        (!permitted() || !preview
          ? undefined
          : preview.kind === "shared" && "shared" in props
            ? {
                kind: "shared",
                value: {
                  requestID: crypto.randomUUID(),
                  previewID: preview.value.previewID,
                  expectedResourceRevision: preview.value.resourceRevision,
                  expectedLeaseID: preview.value.leaseID,
                  expectedLeaseEpoch: preview.value.leaseEpoch,
                  expectedManualEpoch: preview.value.manualEpoch,
                  expiresAt: Math.min(props.shared.resource.expiresAt, Date.now() + 300_000),
                },
              }
            : preview.kind === "legacy" && "view" in props
              ? {
                  kind: "legacy",
                  value: {
                    requestID: crypto.randomUUID(),
                    previewID: preview.value.previewID,
                    expectedControlRevision: preview.value.controlRevision,
                    expiresAt: Math.min(props.view.control.expiresAt, Date.now() + 300_000),
                  },
                }
              : undefined)
      if (!command || !valid()) return
      // Persist before native confirmation; abort/transport failure does not prove no grant was created.
      setState({ approval: command, unknown: true })
      if (command.kind === "shared") {
        const result = await client.browser.sharedFilesApprove(
          { resourceID: id, ...command.value },
          { signal, throwOnError: true },
        )
        if ("state" in result.data && result.data.state === "cancelled") {
          if (result.data.resourceID !== id || result.data.requestID !== command.value.requestID)
            throw new Error(text("error"))
          if (valid())
            setState({
              status: { requestID: command.value.requestID, state: "cancelled", grant: null },
              unknown: false,
            })
          return
        }
      }
      if (command.kind === "legacy")
        await client.browser.filesApprove({ controlID: id, ...command.value }, { signal, throwOnError: true })
      if (!valid()) return
      await reconcile(valid, signal)
      if (valid()) await list(undefined, valid, signal)
    })
  onMount(
    () =>
      void run(async (valid, signal) => {
        await reconcile(valid, signal)
        if (valid()) await list(state.cursor, valid, signal)
      }),
  )
  return (
    <section class="flex min-w-0 flex-col gap-3 rounded-lg border border-border-base p-3" aria-label={text("title")}>
      <p class="text-13-medium text-text-strong">{text("title")}</p>
      <p class="text-12-regular text-text-weak">{text("shared" in props ? "sharedHint" : "hint")}</p>
      <div class="flex flex-col gap-2">
        <span id={`browser-file-direction-${owner}`} class="text-13-regular">
          {text("direction")}
        </span>
        <SelectV2
          aria-labelledby={`browser-file-direction-${owner}`}
          options={["upload", "download"] as const}
          current={state.direction}
          label={(value) => text(value)}
          disabled={state.busy || !!state.approval || !enabled()}
          onSelect={(value) => {
            if (value) setState({ direction: value, preview: undefined })
          }}
        />
      </div>
      <TextField
        label={text("relative")}
        description={text("relativeHint")}
        value={state.relative}
        disabled={state.busy || !!state.approval || !enabled()}
        onChange={(value) => setState({ relative: value, preview: undefined })}
      />
      <TextField
        label={text(state.direction === "upload" ? ("shared" in props ? "uploadURL" : "postPath") : "downloadURL")}
        value={state.target}
        disabled={state.busy || !!state.approval || !enabled()}
        onChange={(value) => setState({ target: value, preview: undefined })}
      />
      <Show when={state.preview}>
        {(value) => (
          <div class="flex min-w-0 flex-col gap-1 text-12-regular [overflow-wrap:anywhere]">
            <span>{value().value.preview.relative}</span>
            <span>
              {(() => {
                const preview = value().value.preview
                return preview.direction === "upload" ? preview.bytes : preview.maxBytes
              })()}{" "}
              {text("bytes")}
            </span>
            <span>
              {(() => {
                const preview = value().value.preview
                return preview.direction === "upload" ? preview.sha256 : ""
              })()}
            </span>
            <span>{text("nativeConfirmation")}</span>
          </div>
        )}
      </Show>
      <Show when={state.status?.grant}>
        {(grant) => (
          <p role="status" class="text-12-regular [overflow-wrap:anywhere]">
            {grant().name} · {text(grant().state)} · {new Date(grant().expiresAt).toLocaleTimeString()}
          </p>
        )}
      </Show>
      <Show when={state.unknown}>
        <p role="status" class="text-12-regular text-text-weak">
          {text("unknown")}
        </p>
      </Show>
      <Show when={cancelled()}>
        <p role="status" class="text-12-regular text-text-weak">
          {text("cancelled")}
        </p>
      </Show>
      <Show when={state.error}>
        <p role="alert" class="text-12-regular text-text-danger-base">
          {state.error}
        </p>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button
          size="small"
          variant="secondary"
          disabled={state.busy || !permitted() || !!state.approval || !state.relative || !state.target}
          onClick={() => void preview()}
        >
          {text("preview")}
        </Button>
        <Button
          size="small"
          disabled={
            state.busy ||
            cancelled() ||
            !(state.approval ? current() : permitted() && !!state.preview) ||
            !!state.status?.grant
          }
          onClick={() => void approve()}
        >
          {text(state.approval ? "retryExact" : "approve")}
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={state.busy}
          onClick={() =>
            void run(async (valid, signal) => {
              await reconcile(valid, signal)
              if (valid()) await list(state.cursor, valid, signal)
            })
          }
        >
          {text("refresh")}
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={state.busy || state.unknown}
          onClick={() =>
            setState({ preview: undefined, approval: undefined, status: undefined, unknown: false, error: "" })
          }
        >
          {text("new")}
        </Button>
      </div>
      <Show when={state.page}>
        {(page) => (
          <div class="flex min-w-0 flex-col gap-2">
            <For each={page().grants}>
              {(grant) => (
                <p class="text-12-regular [overflow-wrap:anywhere]">
                  {grant.name} · {text(grant.direction)} · {text(grant.state)}
                </p>
              )}
            </For>
            <For each={page().files}>
              {(file) => (
                <p class="text-12-regular [overflow-wrap:anywhere]">
                  {file.name} · {file.bytes} {text("bytes")} · {text(file.state)}
                </p>
              )}
            </For>
            <div class="flex flex-wrap gap-2">
              <Button
                size="small"
                variant="ghost"
                disabled={state.busy || !state.cursor}
                onClick={() => void run((valid, signal) => list(undefined, valid, signal))}
              >
                {text("first")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={state.busy || !page().nextCursor}
                onClick={() => void run((valid, signal) => list(page().nextCursor ?? undefined, valid, signal))}
              >
                {text("next")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </section>
  )
}
