import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { TextField } from "@deepagent-code/ui/text-field"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk"
import { BrowserFileExchange } from "./browser-file-exchange"
import { SharedBrowserCreate } from "./shared-browser-create"
import type { SharedBrowserPlatform } from "@/context/platform"
import {
  BrowserScriptGrantEditor,
  prepareBrowserScriptGrant,
  type BrowserScriptGrantDraft,
  type BrowserValidationScript,
} from "./browser-script-grant"

export type { BrowserValidationScript } from "./browser-script-grant"
type State = {
  owner: string
  durationMinutes: 5 | 15 | 30
  origin: string
  profile: "local" | "public" | "exchange" | "publicInteraction" | "apiPost"
  origins: string
  apiTargets: string
  resolverPolicy: "system" | "cloudflare_doh_v1" | "alidns_doh_v1"
  pageMode: "static" | "dynamic"
  paths: string
  source: string
  argsJSON: string
  scriptMode: "readonly" | "program"
  programOperations: BrowserScriptGrantDraft["programOperations"]
  programSteps: string
  clipboard: "off" | "read" | "write" | "both"
  script?: BrowserValidationScript
  controlID: string
  busy: boolean
  error: string
  sharedOpen?: boolean
  request?: Parameters<DeepAgentCodeClient["browser"]["create"]>[0]["body"]
  requestUnknown?: boolean
  cancellation?: Parameters<DeepAgentCodeClient["browser"]["cancel"]>[0]
  view?: NonNullable<Awaited<ReturnType<DeepAgentCodeClient["browser"]["get"]>>["data"]>
}
// This cache only retains explicit request identity for dialog reopen/exact retry. It is
// scoped to the actual SDK client, never an execution permission or a cold host proof.
const controls = new WeakMap<object, Map<string, [Store<State>, SetStoreFunction<State>]>>()
// The native confirmation gate is under verification; new controls omit this grant.
const clipboardAvailable = false

export function DialogBrowserControl(props: {
  sessionID: string
  onUse: (controlID: string, script?: BrowserValidationScript) => void
  sharedBrowser?: SharedBrowserPlatform
  onSharedUse?: (resourceID: string) => void
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const client = sdk.client
  const scope = sdk.scope
  const directory = sdk.directory
  const sessionID = props.sessionID
  const key = JSON.stringify([scope, directory, sessionID])
  const owner = crypto.randomUUID()
  const entries = controls.get(client) ?? new Map<string, [Store<State>, SetStoreFunction<State>]>()
  controls.set(client, entries)
  const [state, setState] =
    entries.get(key) ??
    createStore<State>({ owner, durationMinutes: 5, origin: "http://127.0.0.1:3000", profile: "local", origins: "", apiTargets: "[]", resolverPolicy: "system", pageMode: "static",
      paths: "", source: "", argsJSON: "null", scriptMode: "readonly", programOperations: ["fill"], programSteps: "4",
      clipboard: "off", controlID: "", busy: false, error: "" })
  if (entries.size < 64 || entries.has(key)) entries.set(key, [state, setState])
  setState({ owner, busy: false })
  let disposed = false
  const current = () =>
    !disposed &&
    state.owner === owner &&
    sdk.client === client &&
    sdk.scope === scope &&
    sdk.directory === directory &&
    props.sessionID === sessionID
  onCleanup(() => {
    disposed = true
  })
  createEffect(() => {
    if (state.owner !== owner) return
    if (sdk.client !== client || sdk.scope !== scope || sdk.directory !== directory || props.sessionID !== sessionID)
      dialog.close()
  })
  const text = (key: string) => language.t(`browser.control.${key}` as Parameters<typeof language.t>[0])
  const available = () =>
    !state.cancellation &&
    state.view?.availability === "available" &&
    state.view.nativeVerification === "verified" &&
    state.view.control.state === "active" &&
    state.view.control.expiresAt > Date.now()
  const scriptAvailable = () => {
    const script = state.script
    const control = state.view?.control
    if (!available() || !script || control?.profile !== "managed-loopback-interaction-v1") return false
    if (script.mode === "program") return control.programGrants?.some((grant) =>
      grant.scriptHash === script.scriptHash && grant.argsHash === script.argsHash && grant.maxSteps === script.maxSteps &&
      JSON.stringify(grant.operations) === JSON.stringify(script.operations)) === true
    return control.scriptGrants?.some((grant) => grant.readOnly === true &&
      grant.scriptHash === script.scriptHash && grant.argsHash === script.argsHash) === true
  }
  const publicControl = () => {
    const control = state.view?.control
    return control?.profile === "managed-public-readonly-v1" || control?.profile === "managed-public-interaction-v1" || control?.profile === "managed-public-api-v1" ? control : undefined
  }
  const publicInteractionControl = () => {
    const control = state.view?.control
    return control?.profile === "managed-public-interaction-v1" ? control : undefined
  }
  const apiControl = () => {
    const control = state.view?.control
    return control?.profile === "managed-public-api-v1" ? control : undefined
  }
  const receive = (value: State["view"]) => {
    if (!current()) return
    if (!value || value.control.scope.sessionID !== sessionID || value.control.scope.directory !== directory)
      throw new Error(text("scopeChanged"))
    setState({ view: value, controlID: value.control.controlID })
  }
  const run = async (operation: () => Promise<void>) => {
    if (!current() || state.busy) return
    setState({ busy: true, error: "" })
    try {
      await operation()
    } catch (error) {
      if (current()) setState("error", error instanceof Error ? error.message : text("unknown"))
    } finally {
      if (state.owner === owner) setState("busy", false)
    }
  }
  const refresh = () =>
    run(async () => {
      const id = state.controlID
      if (!id) return
      receive((await client.browser.get({ controlID: id }, { throwOnError: true })).data)
    })
  const connect = () =>
    run(async () => {
      if (!state.request) {
        if (entries.size >= 64 && !entries.has(key)) throw new Error(text("capacity"))
        const script = await prepareBrowserScriptGrant({
          source: state.profile === "local" ? state.source : "",
          argsJSON: state.profile === "local" ? state.argsJSON : "null",
          scriptMode: state.scriptMode,
          programOperations: [...state.programOperations],
          programSteps: state.programSteps,
        }, { script: text("scriptInvalid"), program: text("program.invalid") })
        if (!current()) return
        const fields = {
          requestID: crypto.randomUUID(),
          sessionID,
          origin: state.origin.trim(),
          expiresAt: Date.now() + state.durationMinutes * 60_000,
        }
        const request = state.profile === "public" ? {
          ...fields,
          profile: "managed-public-readonly-v1" as const,
          approvedOrigins: [...new Set([fields.origin, ...state.origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)])],
          resolverPolicy: state.resolverPolicy,
        } : state.profile === "publicInteraction" ? {
          ...fields, profile: "managed-public-interaction-v1" as const,
          approvedOrigins: [...new Set([fields.origin, ...state.origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)])],
          resolverPolicy: state.resolverPolicy, pageMode: state.pageMode,
          postTargets: [...new Set(state.paths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
            .map((path) => ({ origin: fields.origin, path })),
        } : state.profile === "apiPost" ? {
          ...fields, profile: "managed-public-api-v1" as const,
          approvedOrigins: [...new Set([fields.origin, ...state.origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)])],
          resolverPolicy: state.resolverPolicy, pageMode: state.pageMode,
          apiPostTargets: await (async () => {
            const { Option, Schema } = await import("effect")
            const { BrowserSchema } = await import("@deepagent-code/core/browser/schema")
            if (!state.apiTargets.isWellFormed() || new TextEncoder().encode(state.apiTargets).byteLength > 8192)
              throw new Error(text("invalid"))
            const targets = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserSchema.ApiPostTargets), { onExcessProperty: "error" })(state.apiTargets)
            if (Option.isNone(targets) || targets.value.some((target) => new URL(target.url).origin !== fields.origin)) throw new Error(text("invalid"))
            return targets.value.map((target) => ({ ...target, contentTypes: [...target.contentTypes] }))
          })(),
        } : state.profile === "exchange" ? {
          ...fields, profile: "managed-loopback-exchange-v1" as const,
          postPaths: [...new Set(state.paths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))],
          filePolicy: { upload: true, download: true },
        } : {
          ...fields,
          profile: "managed-loopback-interaction-v1" as const,
          postPaths: state.paths
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
          ...(script?.mode === "program" ? { programGrants: [{ scriptHash: script.scriptHash, argsHash: script.argsHash,
            operations: script.operations!, maxSteps: script.maxSteps! }] }
            : script ? { scriptGrants: [{ scriptHash: script.scriptHash, argsHash: script.argsHash, readOnly: true as const }] } : {}),
          ...(clipboardAvailable && state.clipboard !== "off" ? { clipboardPolicy: {
            read: state.clipboard === "read" || state.clipboard === "both",
            write: state.clipboard === "write" || state.clipboard === "both",
          } } : {}),
        }
        if (!current()) return
        setState({ request, script, requestUnknown: false })
      }
      // A failed response never makes a new ID or changes the original permission request.
      if (!current()) return
      const previouslyUnknown = state.requestUnknown === true
      // Until a checked response arrives, the original request may have created custody.
      // A later pre-create rejection cannot erase uncertainty from an earlier attempt.
      setState("requestUnknown", true)
      const response = await client.browser.create({ body: state.request! }, { throwOnError: false })
      if (!current()) return
      if (response.error) {
        const scopeDenied = response.response?.status === 403 && typeof response.error === "object" &&
          response.error !== null && "code" in response.error && response.error.code === "BROWSER_SCOPE_DENIED"
        const beforeCreate = scopeDenied && typeof response.error === "object" && response.error !== null &&
          "message" in response.error && typeof response.error.message === "string" &&
          /^BROWSER_CREATE_SCOPE_DENIED:(native_transport|native_origin|session_placement|project_observation|project_resolution|project_current|location_resolution|location_current|namespace_current|control_scope)$/.test(response.error.message)
        if (!previouslyUnknown && (response.response?.status === 400 || beforeCreate))
          setState({ request: undefined, requestUnknown: false })
        const unavailable = typeof response.error === "object" && response.error !== null &&
          "code" in response.error && response.error.code === "BROWSER_HOST_UNAVAILABLE"
        throw new Error(scopeDenied
          ? text("scopeDenied") + (previouslyUnknown || !beforeCreate ? ` ${text("unknown")}` : "")
          : text(response.response?.status === 400 ? "invalid" : unavailable ? "unavailable" : "unknown"))
      }
      receive(response.data)
      setState("requestUnknown", false)
    })
  const cancel = () =>
    run(async () => {
      if (!state.view) return
      if (!state.cancellation)
        setState("cancellation", {
          controlID: state.view.control.controlID,
          requestID: crypto.randomUUID(),
          expectedRevision: state.view.control.revision,
        })
      receive((await client.browser.cancel(state.cancellation!, { throwOnError: true })).data)
    })
  onMount(() => {
    if (state.controlID) void refresh()
  })
  const legacy = () => (
    <>
      <div class="flex min-h-0 w-[520px] max-w-[calc(100vw-32px)] flex-col gap-4 overflow-y-auto px-6 pb-6">
        <p class="text-13-regular text-text-weak">{text("description")}</p>
        <Show when={!state.view}>
          <div class="flex flex-col gap-2">
            <span class="text-13-regular text-text-base" id={`browser-duration-${owner}`}>{text("duration")}</span>
            <SelectV2 aria-labelledby={`browser-duration-${owner}`} options={[5, 15, 30] as const}
              current={state.durationMinutes} label={(value) => text(`duration${value}`)}
              disabled={state.busy || !!state.request} onSelect={(value) => {
                if (value) setState("durationMinutes", value)
              }} />
            <p class="text-12-regular text-text-weak">{text("durationHint")}</p>
          </div>
          <div class="flex flex-col gap-2">
            <span class="text-13-regular text-text-base" id={`browser-mode-${owner}`}>{text("mode")}</span>
            <SelectV2 aria-labelledby={`browser-mode-${owner}`} options={["local", "public", "exchange", "publicInteraction", "apiPost"] as const}
              current={state.profile} label={(value) => text(value === "public" ? "publicReadonly" : value === "publicInteraction"
                ? "publicInteraction" : value === "apiPost" ? "apiPost" : value === "exchange" ? "fileExchange" : "localInteractive")}
              disabled={state.busy || !!state.request} onSelect={(value) => {
                if (!value || value === state.profile) return
                setState({ profile: value, origin: value === "public" || value === "publicInteraction" || value === "apiPost" ? "https://example.com" : "http://127.0.0.1:3000" })
              }} />
          </div>
          <TextField
            label={text(state.profile === "public" || state.profile === "publicInteraction" || state.profile === "apiPost" ? "publicOrigin" : "origin")}
            value={state.origin}
            disabled={state.busy || !!state.request}
            onChange={(value) => setState("origin", value)}
          />
          <Show when={state.profile !== "public" && state.profile !== "apiPost"}><TextField
            label={text("paths")}
            description={text("pathsHint")}
            multiline
            rows={3}
            value={state.paths}
            disabled={state.busy || !!state.request}
            onChange={(value) => setState("paths", value)}
          /></Show>
          <Show when={state.profile === "public" || state.profile === "publicInteraction" || state.profile === "apiPost"}>
            <p class="text-13-regular text-text-weak">{text(state.profile === "apiPost" ? "apiHint" : state.profile === "publicInteraction" ? "publicInteractionHint" : "publicHint")}</p>
            <TextField label={text("approvedOrigins")} description={text("approvedOriginsHint")} multiline rows={3}
              value={state.origins} disabled={state.busy || !!state.request} onChange={(value) => setState("origins", value)} />
            <div class="flex flex-col gap-2">
              <span class="text-13-regular text-text-base" id={`browser-resolver-${owner}`}>{text("resolver")}</span>
              <SelectV2 aria-labelledby={`browser-resolver-${owner}`} options={["system", "cloudflare_doh_v1", "alidns_doh_v1"] as const}
                current={state.resolverPolicy} label={(value) => text(value === "system" ? "resolverSystem" : value === "alidns_doh_v1" ? "resolverAliDNS" : "resolverCloudflare")}
                disabled={state.busy || !!state.request} onSelect={(value) => { if (value) setState("resolverPolicy", value) }} />
            </div>
            <p class="text-13-regular text-text-weak">{text("resolverHint")}</p>
            <Show when={state.profile === "publicInteraction" || state.profile === "apiPost"}>
              <div class="flex flex-col gap-2">
                <span id={`browser-public-page-mode-${owner}`} class="text-13-regular">{text("pageMode")}</span>
                <SelectV2 aria-labelledby={`browser-public-page-mode-${owner}`} options={["static", "dynamic"] as const}
                  current={state.pageMode} label={(value) => text(value === "dynamic" ? "pageDynamic" : "pageStatic")}
                  disabled={state.busy || !!state.request} onSelect={(value) => { if (value) setState("pageMode", value) }} />
              </div>
              <p class="text-13-regular text-text-weak">{text("pageModeHint")}</p>
            </Show>
          </Show>
          <Button disabled={state.busy || !!state.controlID} onClick={() => void connect()}>
            {text(state.request ? "retry" : "connect")}
          </Button>
          <Show when={state.profile === "apiPost"}>
            <TextField label={text("apiTargets")} description={text("apiTargetsHint")} multiline rows={5}
              value={state.apiTargets} disabled={state.busy || !!state.request} onChange={(value) => setState("apiTargets", value)} />
          </Show>
          <Show when={state.profile === "local"}>
          <Show when={clipboardAvailable} fallback={<p class="text-13-regular text-text-weak">{text("clipboard.unavailable")}</p>}>
          <div class="flex flex-col gap-2"><span id={`browser-clipboard-policy-${owner}`} class="text-13-regular">{text("clipboard.label")}</span>
            <SelectV2 aria-labelledby={`browser-clipboard-policy-${owner}`} options={["off", "read", "write", "both"] as const}
            current={state.clipboard} label={(value) => text(`clipboard.${value}`)}
            disabled={state.busy || !!state.request} onSelect={(value) => { if (value) setState("clipboard", value) }} />
            <p class="text-13-regular text-text-weak">{text("clipboard.hint")}</p></div></Show>
          <BrowserScriptGrantEditor draft={state} id={owner} disabled={state.busy || !!state.request}
            onChange={(value) => setState(value)} /></Show>
        </Show>
        <Show when={state.view?.control.profile === "managed-loopback-exchange-v1" && state.view}>
          {(view) => <BrowserFileExchange view={view()} active={available} />}
        </Show>
        <TextField
          label={text("controlID")}
          value={state.controlID}
          disabled={state.busy || !!state.view}
          onChange={(value) => setState("controlID", value.trim())}
        />
        <Show when={state.view}>
          {(view) => (
            <div class="flex flex-col gap-1 text-13-regular text-text-base">
              <span>{view().control.origin}</span>
              <Show when={publicControl()}>{(control) => <>
                <span>{text(control().profile === "managed-public-api-v1" ? "apiPost" : control().profile === "managed-public-interaction-v1" ? "publicInteraction" : "publicReadonly")}</span>
                <span>{control().approvedOrigins.join(", ")}</span>
                <span>{text(control().resolverPolicy === "system" ? "resolverSystem" : control().resolverPolicy === "alidns_doh_v1" ? "resolverAliDNS" : "resolverCloudflare")}</span>
                <Show when={publicInteractionControl()}>{(interaction) => <>
                  <span>{text(interaction().pageMode === "dynamic" ? "pageDynamic" : "pageStatic")}</span>
                  <span>{interaction().postTargets.map((target) => target.path).join(", ")}</span>
                </>}</Show>
              </>}
              </Show>
              <Show when={apiControl()}>{(api) => <>
                <span>{text("apiHint")}</span>
                <pre class="whitespace-pre-wrap break-all">{JSON.stringify(api().apiPostTargets, null, 2)}</pre>
              </>}</Show>
              <span>{text(view().stopConfirmed ? "stopped" : available() ? "active" : "unavailable")}</span>
              <span>
                {text("expires")} {new Date(view().control.expiresAt).toLocaleTimeString()}
              </span>
            </div>
          )}
        </Show>
        <Show when={state.error}>
          <p role="alert" class="text-13-regular text-text-danger-base">
            {state.error}
          </p>
        </Show>
        <Show when={scriptAvailable()}><p class="text-13-regular text-text-weak">{text(state.script?.mode === "program" ? "program.ready" : "scriptReady")}</p></Show>
        <div class="flex flex-wrap gap-2">
          <Show when={state.view?.stopConfirmed}>
            <Button
              disabled={state.busy}
              onClick={() =>
                setState({
                  view: undefined,
                  durationMinutes: 5,
                  request: undefined,
                  script: undefined,
                  cancellation: undefined,
                  controlID: "",
                  error: "",
                })
              }
            >
              {text("new")}
            </Button>
          </Show>
          <Button variant="secondary" disabled={state.busy || !state.controlID} onClick={() => void refresh()}>
            {text("refresh")}
          </Button>
          <Button
            disabled={state.busy || !available()}
            onClick={() => {
              if (current() && available()) {
                props.onUse(state.controlID)
                dialog.close()
              }
            }}
          >
            {text("use")}
          </Button>
          <Show when={state.script}>
            <Button disabled={state.busy || !scriptAvailable()} onClick={() => {
              if (!current() || !scriptAvailable() || !state.script) return
              props.onUse(state.controlID, { ...state.script })
              dialog.close()
            }}>{text(state.script?.mode === "program" ? "program.use" : "scriptUse")}</Button>
          </Show>
          <Button
            variant="secondary"
            disabled={state.busy || !state.view || state.view.stopConfirmed}
            onClick={() => void cancel()}
          >
            {text("stop")}
          </Button>
        </div>
      </div>
    </>
  )

  return (
    <Dialog title={text("title")}>
      <Show when={props.sharedBrowser && !state.view && !state.request}>
        <div class="px-6 pt-4">
          <Button variant="secondary" onClick={() => setState("sharedOpen", !state.sharedOpen)}>
            {language.t(state.sharedOpen ? "browser.shared.legacyOptions" : "browser.shared.title")}
          </Button>
        </div>
      </Show>
      <Show when={state.sharedOpen && props.sharedBrowser} fallback={legacy()}>
        {(bridge) => (
          <div class="px-6 py-4">
            <SharedBrowserCreate bridge={bridge()} sessionID={props.sessionID} directory={directory} scope={scope} advancedGrants
              onUse={(resourceID) => {
                if (!current()) return
                props.onSharedUse?.(resourceID)
                dialog.close()
              }} />
          </div>
        )}
      </Show>
    </Dialog>
  )
}
