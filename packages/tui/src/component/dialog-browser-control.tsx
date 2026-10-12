import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useTuiI18n } from "../context/i18n"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogBrowserFiles } from "./dialog-browser-files"

const programOperations = ["fill", "select", "click", "press", "scroll", "drag"] as const
type ProgramOperation = typeof programOperations[number]
type Configuration =
  | { profile: "managed-loopback-interaction-v1"; origin: string; postPaths: string[] }
  | { profile: "managed-loopback-exchange-v1"; origin: string; postPaths: string[]; filePolicy: { upload: boolean; download: boolean } }
  | { profile: "managed-public-readonly-v1"; origin: string; approvedOrigins: string[]; resolverPolicy: "system" | "cloudflare_doh_v1" | "alidns_doh_v1" }
  | { profile: "managed-public-interaction-v1"; origin: string; approvedOrigins: string[]; resolverPolicy: "system" | "cloudflare_doh_v1" | "alidns_doh_v1";
    pageMode: "static" | "dynamic"; postTargets: { origin: string; path: string }[] }
  | Omit<Extract<Parameters<DeepAgentCodeClient["browser"]["create"]>[0]["body"], { profile: "managed-public-api-v1" }>, "requestID" | "sessionID" | "expiresAt">
export type BrowserValidationScript = { source: string; argsJSON: string; scriptHash: string; argsHash: string;
  mode?: "program"; operations?: ProgramOperation[]; maxSteps?: number }
type State = {
  owner: string
  durationMinutes: 5 | 15 | 30
  busy: boolean
  error: string
  controlID: string
  source: string
  argsJSON: string
  scriptMode: "readonly" | "program"
  programOperations: ProgramOperation[]
  programSteps: number
  clipboard: "off" | "read" | "write" | "both"
  script?: BrowserValidationScript
  form?: "create" | "createPublicSystem" | "createPublicDoH" | "createPublicAliDNS" | "createPublicInteraction" | "createAPI" | "createExchange" | "files" | "restore" | "scriptSource" | "scriptArgs" | "programPolicy"
  request?: Parameters<DeepAgentCodeClient["browser"]["create"]>[0]["body"]
  cancellation?: Parameters<DeepAgentCodeClient["browser"]["cancel"]>[0]
  view?: NonNullable<Awaited<ReturnType<DeepAgentCodeClient["browser"]["get"]>>["data"]>
}
const controls = new WeakMap<object, Map<string, [Store<State>, SetStoreFunction<State>]>>()
// Keep the UI closed while the original native confirmation gate is unverified.
const clipboardAvailable = false

export function DialogBrowserControl(props: { sessionID: string; onUse: (controlID: string, script?: BrowserValidationScript) => void }) {
  const sdk = useSDK()
  const project = useProject()
  const i18n = useTuiI18n()
  const dialog = useDialog()
  const client = sdk.client
  const directory = project.instance.directory()
  const workspace = project.workspace.current()
  const sessionID = props.sessionID
  const entries = controls.get(client) ?? new Map<string, [Store<State>, SetStoreFunction<State>]>()
  controls.set(client, entries)
  const key = JSON.stringify([directory, workspace, sessionID])
  const owner = crypto.randomUUID()
  const [state, setState] = entries.get(key) ?? createStore<State>({ owner, durationMinutes: 5, busy: false, error: "", controlID: "", source: "", argsJSON: "null",
    scriptMode: "readonly", programOperations: ["fill"], programSteps: 4, clipboard: "off" })
  if (entries.size < 64 || entries.has(key)) entries.set(key, [state, setState])
  setState({ owner, busy: false })
  let disposed = false
  const current = () =>
    !disposed &&
    state.owner === owner &&
    sdk.client === client &&
    props.sessionID === sessionID &&
    project.instance.directory() === directory &&
    project.workspace.current() === workspace
  onCleanup(() => {
    disposed = true
  })
  createEffect(() => {
    if (state.owner !== owner) return
    if (
      sdk.client !== client ||
      project.instance.directory() !== directory ||
      project.workspace.current() !== workspace ||
      props.sessionID !== sessionID
    )
      dialog.clear()
  })
  const text = (key: string) => i18n.t(`tui.browser.control.${key}` as Parameters<typeof i18n.t>[0])
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
  const receive = (value: State["view"]) => {
    if (!current()) return
    if (!value || value.control.scope.sessionID !== sessionID || value.control.scope.directory !== directory)
      throw new Error(text("scopeChanged"))
    setState({ view: value, controlID: value.control.controlID, form: undefined })
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
      if (state.controlID)
        receive((await client.browser.get({ controlID: state.controlID }, { throwOnError: true })).data)
    })
  const connect = (configuration?: Configuration | (() => Promise<Configuration>)) =>
    run(async () => {
      if (workspace !== undefined) throw new Error(text("scopeChanged"))
      if (!state.request) {
        const approved = typeof configuration === "function" ? await configuration() : configuration
        if (!current()) return
        if (!approved) throw new Error(text("invalid"))
        if (entries.size >= 64 && !entries.has(key)) throw new Error(text("capacity"))
        const input = { source: approved.profile === "managed-loopback-interaction-v1" ? state.source : "",
          argsJSON: approved.profile === "managed-loopback-interaction-v1" ? state.argsJSON : "null" }
        if (!input.source.isWellFormed() || !input.argsJSON.isWellFormed()) throw new Error(text("scriptInvalid"))
        const bytes = [new TextEncoder().encode(input.source), new TextEncoder().encode(input.argsJSON)]
        if (bytes.some((value) => value.byteLength > 8192)) throw new Error(text("scriptInvalid"))
        const script = input.source ? await (async () => {
          const { Option, Schema } = await import("effect")
          if (Option.isNone(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.argsJSON)))
            throw new Error(text("scriptInvalid"))
          const hashes = await Promise.all(bytes.map((value) => crypto.subtle.digest("SHA-256", value)))
          return { ...input,
            scriptHash: Array.from(new Uint8Array(hashes[0])).map((value) => value.toString(16).padStart(2, "0")).join(""),
            argsHash: Array.from(new Uint8Array(hashes[1])).map((value) => value.toString(16).padStart(2, "0")).join(""),
            ...(state.scriptMode === "program" ? { mode: "program" as const,
              operations: [...state.programOperations], maxSteps: state.programSteps } : {}) }
        })() : undefined
        if (!current()) return
        setState({ script, request: { requestID: crypto.randomUUID(), sessionID,
          ...approved, expiresAt: Date.now() + state.durationMinutes * 60_000,
          ...(script?.mode === "program" ? { programGrants: [{ scriptHash: script.scriptHash, argsHash: script.argsHash,
            operations: script.operations!, maxSteps: script.maxSteps! }] }
            : script ? { scriptGrants: [{ scriptHash: script.scriptHash, argsHash: script.argsHash, readOnly: true }] } : {}),
          ...(clipboardAvailable && approved.profile === "managed-loopback-interaction-v1" && state.clipboard !== "off"
            ? { clipboardPolicy: { read: state.clipboard === "read" || state.clipboard === "both",
              write: state.clipboard === "write" || state.clipboard === "both" } } : {}),
        } })
      }
      const request = state.request
      if (!request || !current()) return
      const response = await client.browser.create({ body: request }, { throwOnError: false })
      if (!current()) return
      if (response.error) {
        if (response.response?.status === 400) setState("request", undefined)
        const unavailable = typeof response.error === "object" && response.error !== null &&
          "code" in response.error && response.error.code === "BROWSER_HOST_UNAVAILABLE"
        if ((request.profile === "managed-public-interaction-v1" || request.profile === "managed-public-api-v1") && response.response?.status !== 400) {
          // The dispatched approval is frozen; return to an exact-retry menu only
          // after the HTTP operation, so replacing the dialog cannot drop it.
          setState({ form: undefined, error: text(unavailable ? "unavailable" : "unknown") })
          return
        }
        throw new Error(text(response.response?.status === 400 ? "invalid" : unavailable ? "unavailable" : "unknown"))
      }
      receive(response.data)
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
  return (
    <Show when={state.form === "files" && state.view} fallback={<Show
      when={state.form}
      keyed
      fallback={
        <DialogSelect
          title={text("title")}
          locked={state.busy}
          skipFilter
          footer={
            <box paddingLeft={2} paddingRight={2} gap={1}>
              <text wrapMode="word">{text("description")}</text>
              <Show when={!state.view && !state.request}><text wrapMode="word">{text(clipboardAvailable ? "clipboard.hint" : "clipboard.unavailable")}</text></Show>
              <Show when={state.view?.control.profile === "managed-loopback-interaction-v1" && state.view.control.clipboardPolicy}>
                <text wrapMode="word">{text(`clipboard.${state.view?.control.profile === "managed-loopback-interaction-v1" &&
                  state.view.control.clipboardPolicy?.read ? state.view.control.clipboardPolicy.write ? "both" : "read" : "write"}`)}</text>
              </Show>
              <Show when={state.source}><text wrapMode="word">{text(state.scriptMode === "program" ? "program.hint" : "scriptHint")}</text></Show>
              <Show when={scriptAvailable()}><text wrapMode="word">{text(state.script?.mode === "program" ? "program.ready" : "scriptReady")}</text></Show>
              <Show when={state.view}>
                {(view) => (
                  <text wrapMode="word">
                    {view().control.origin}
                    {"\n"}
                    {state.controlID}
                    {"\n"}
                    {text(view().stopConfirmed ? "stopped" : available() ? "active" : "unavailable")}
                  </text>
                )}
              </Show>
              <Show when={publicControl()}>{(control) => <text wrapMode="word">
                {text(control().profile === "managed-public-api-v1" ? "apiPost" : control().profile === "managed-public-interaction-v1" ? "publicInteraction" : "publicReadonly")}{"\n"}{control().approvedOrigins.join(", ")}{"\n"}
                {text(control().resolverPolicy === "system" ? "resolverSystem" : control().resolverPolicy === "alidns_doh_v1" ? "resolverAliDNS" : "resolverCloudflare")}
              </text>}</Show>
              <Show when={publicInteractionControl()}>{(control) => <text wrapMode="word">
                {text(control().pageMode === "dynamic" ? "pageDynamic" : "pageStatic")}{"\n"}
                {control().postTargets.map((target) => target.path).join(", ")}
              </text>}</Show>
              <Show when={state.view?.control.profile === "managed-public-api-v1"}>
                <text wrapMode="word">{text("apiHint")}{"\n"}{JSON.stringify(state.view?.control.profile === "managed-public-api-v1" ? state.view.control.apiPostTargets : [])}</text>
              </Show>
              <Show when={state.error}>
                <text wrapMode="word">{state.error}</text>
              </Show>
            </box>
          }
          options={[
            ...(state.view?.stopConfirmed ? [{ title: text("new"), value: "new" }] : []),
            ...(!state.view
              ? [
                  { title: text(state.request ? "retry" : "connect"), value: "connect", disabled: !!state.controlID },
                  { title: text("restore"), value: "restore" },
                  ...(!state.request ? [{ title: text("scriptEdit"), value: "scriptEdit" },
                    ...(state.source ? [{ title: text("scriptClear"), value: "scriptClear" }] : []),
                    { title: text("publicConnectSystem"), value: "publicSystem" },
                    { title: text("publicConnectDoH"), value: "publicDoH" },
                    { title: text("publicConnectAliDNS"), value: "publicAliDNS" }] : []),
                  ...(!state.request ? [{ title: text("fileExchange"), value: "exchange" },
                    ...(clipboardAvailable ? [{ title: text(`clipboard.${state.clipboard}`), value: "clipboard" }] : []),
                    { title: text("program.policy"), value: "programPolicy" },
                    ...(state.scriptMode === "program" ? [{ title: text("program.readonly"), value: "programReadonly" }] : []),
                    { title: text("publicInteraction"), value: "publicInteraction" },
                    { title: text("apiPost"), value: "apiPost" },
                    ...([5, 15, 30] as const).map((value) => ({ title: text(`duration${value}`),
                      description: state.durationMinutes === value ? text("durationSelected") : undefined,
                      value: `duration${value}` }))] : []),
                ]
              : []),
            { title: text("refresh"), value: "refresh", disabled: !state.controlID },
            { title: text("use"), value: "use", disabled: !available() },
            ...(state.view?.control.profile === "managed-loopback-exchange-v1"
              ? [{ title: i18n.t("tui.browser.files.title"), value: "files", disabled: !available() }] : []),
            ...(state.script ? [{ title: text(state.script.mode === "program" ? "program.use" : "scriptUse"), value: "scriptUse", disabled: !scriptAvailable() }] : []),
            { title: text("stop"), value: "stop", disabled: !state.view || state.view.stopConfirmed },
          ]}
          onSelect={(option) => {
            if (!current() || state.busy || option.disabled) return
            if (option.value === "new" && state.view?.stopConfirmed) {
              setState({
                view: undefined,
                durationMinutes: 5,
                request: undefined,
                script: undefined,
                cancellation: undefined,
                controlID: "",
                error: "",
                form: undefined,
              })
              return
            }
            if (!state.request && (option.value === "duration5" || option.value === "duration15" || option.value === "duration30")) {
              setState("durationMinutes", option.value === "duration5" ? 5 : option.value === "duration15" ? 15 : 30)
              return
            }
            if (option.value === "connect") {
              if (state.request) void connect()
              else setState("form", "create")
              return
            }
            if (option.value === "restore") {
              setState("form", "restore")
              return
            }
            if (option.value === "publicSystem") { setState("form", "createPublicSystem"); return }
            if (option.value === "publicDoH") { setState("form", "createPublicDoH"); return }
            if (option.value === "publicAliDNS") { setState("form", "createPublicAliDNS"); return }
            if (option.value === "apiPost") { setState("form", "createAPI"); return }
            if (option.value === "publicInteraction") { setState("form", "createPublicInteraction"); return }
            if (option.value === "exchange") { setState("form", "createExchange"); return }
            if (option.value === "files") { setState("form", "files"); return }
            if (option.value === "scriptEdit") { setState("form", "scriptSource"); return }
            if (option.value === "programPolicy") { setState("form", "programPolicy"); return }
            if (option.value === "programReadonly") { setState({ scriptMode: "readonly", script: undefined }); return }
            if (option.value === "clipboard") {
              setState("clipboard", state.clipboard === "off" ? "read" : state.clipboard === "read" ? "write"
                : state.clipboard === "write" ? "both" : "off")
              return
            }
            if (option.value === "scriptClear") { setState({ source: "", argsJSON: "null", script: undefined, scriptMode: "readonly" }); return }
            if (option.value === "refresh") {
              void refresh()
              return
            }
            if (option.value === "stop") {
              void cancel()
              return
            }
            if (option.value === "use" && available()) {
              props.onUse(state.controlID)
              dialog.clear()
            }
            if (option.value === "scriptUse" && scriptAvailable() && state.script) {
              props.onUse(state.controlID, { ...state.script })
              dialog.clear()
            }
          }}
        />
      }
    >
      {(form) => (
        <DialogPrompt
          title={text(form === "create" ? "connect" : form === "createPublicSystem" ? "publicConnectSystem"
            : form === "createPublicDoH" ? "publicConnectDoH" : form === "createPublicAliDNS" ? "publicConnectAliDNS" : form === "createPublicInteraction" ? "publicInteraction"
              : form === "createAPI" ? "apiPost" : form === "createExchange" ? "fileExchange" : form === "restore" ? "restore"
              : form === "programPolicy" ? "program.policy" : form)}
          description={
            <box gap={1}>
              <text wrapMode="word">{text("duration")}: {text(`duration${state.durationMinutes}`)}</text>
              <text wrapMode="word">{text("durationHint")}</text>
              <text wrapMode="word">{text(form === "create" || form === "createExchange" ? "formHint"
                : form === "createPublicSystem" || form === "createPublicDoH" || form === "createPublicAliDNS" ? "publicFormHint"
                  : form === "createAPI" ? "apiTargetsHint" : form === "createPublicInteraction" ? "publicInteractionFormHint" : form === "restore" ? "controlID" : form === "programPolicy" ? "program.policyHint"
                    : state.scriptMode === "program" ? "program.hint" : "scriptHint")}</text>
              <Show when={form === "createPublicSystem" || form === "createPublicDoH" || form === "createPublicAliDNS"}>
                <text wrapMode="word">{text("publicHint")}</text>
                <text wrapMode="word">{text("resolverHint")}</text>
              </Show>
              <Show when={form === "createAPI"}><text wrapMode="word">{text("apiHint")}</text></Show>
              <Show when={form === "createPublicInteraction"}>
                <text wrapMode="word">{text("publicInteractionHint")}</text>
                <text wrapMode="word">{text("pageModeHint")}</text>
              </Show>
              <Show when={state.error}>
                <text wrapMode="word">{state.error}</text>
              </Show>
            </box>
          }
          value={form === "create" || form === "createExchange" ? "http://127.0.0.1:3000\n"
            : form === "createPublicSystem" || form === "createPublicDoH" || form === "createPublicAliDNS" ? "https://example.com\n"
              : form === "createPublicInteraction" ? JSON.stringify({ origin: "https://example.com",
                approvedOrigins: ["https://example.com"], resolverPolicy: "system", pageMode: "static", postTargets: [] })
              : form === "createAPI" ? JSON.stringify({ origin: "https://example.com", approvedOrigins: ["https://example.com"],
                  resolverPolicy: "system", pageMode: "static", apiPostTargets: [] })
              : form === "restore" ? state.controlID : form === "scriptSource" ? state.source : form === "programPolicy"
                ? JSON.stringify({ operations: state.programOperations, maxSteps: state.programSteps }) : state.argsJSON}
          busy={state.busy}
          onCancel={() => setState("form", undefined)}
          onConfirm={(value) => {
            if (!current() || state.busy) return
            if (form === "createAPI") {
              void connect(async () => {
                const { Option, Schema } = await import("effect")
                const { BrowserSchema } = await import("@deepagent-code/core/browser/schema")
                if (!value.isWellFormed() || new TextEncoder().encode(value).byteLength > 8192) throw new Error(text("invalid"))
                const configuration = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
                  origin: BrowserSchema.PublicOrigin, approvedOrigins: BrowserSchema.ApprovedOrigins,
                  resolverPolicy: BrowserSchema.ResolverPolicy, pageMode: BrowserSchema.PublicPageMode,
                  apiPostTargets: BrowserSchema.ApiPostTargets,
                }).check(Schema.makeFilter((input) => input.approvedOrigins.includes(input.origin) &&
                  input.apiPostTargets.every((target) => new URL(target.url).origin === input.origin)))), { onExcessProperty: "error" })(value)
                if (Option.isNone(configuration)) throw new Error(text("invalid"))
                return { profile: "managed-public-api-v1", ...configuration.value, approvedOrigins: [...configuration.value.approvedOrigins],
                  apiPostTargets: configuration.value.apiPostTargets.map((target) => ({ ...target, contentTypes: [...target.contentTypes] })) }
              })
              return
            }
            if (form === "createPublicInteraction") {
              void connect(async () => {
                const { Option, Schema } = await import("effect")
                const { BrowserSchema } = await import("@deepagent-code/core/browser/schema")
                if (!value.isWellFormed() || new TextEncoder().encode(value).byteLength > 8192)
                  throw new Error(text("invalid"))
                const configuration = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
                  origin: BrowserSchema.PublicOrigin, approvedOrigins: BrowserSchema.ApprovedOrigins,
                  resolverPolicy: BrowserSchema.ResolverPolicy, pageMode: BrowserSchema.PublicPageMode,
                  postTargets: BrowserSchema.PublicPostTargets,
                }).check(Schema.makeFilter((input) => input.approvedOrigins.includes(input.origin) &&
                  input.postTargets.every((target) => target.origin === input.origin)))), { onExcessProperty: "error" })(value)
                if (Option.isNone(configuration)) throw new Error(text("invalid"))
                return { profile: "managed-public-interaction-v1", ...configuration.value,
                  approvedOrigins: [...configuration.value.approvedOrigins],
                  postTargets: configuration.value.postTargets.map((target) => ({ ...target })) }
              })
              return
            }
            if (form === "programPolicy") {
              void run(async () => {
                const { Option, Schema } = await import("effect")
                if (!value.isWellFormed() || new TextEncoder().encode(value).byteLength > 1024)
                  throw new Error(text("program.invalid"))
                const policy = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
                  operations: Schema.Array(Schema.Literals(programOperations)).check(Schema.isMinLength(1), Schema.isMaxLength(6),
                    Schema.makeFilter((values) => new Set(values).size === values.length)),
                  maxSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
                })), { onExcessProperty: "error" })(value)
                if (Option.isNone(policy)) throw new Error(text("program.invalid"))
                if (current()) setState({ scriptMode: "program", programOperations: [...policy.value.operations],
                  programSteps: policy.value.maxSteps, script: undefined, form: undefined })
              })
              return
            }
            if (form === "scriptSource") {
              if (!value.isWellFormed() || new TextEncoder().encode(value).byteLength > 8192) { setState("error", text("scriptInvalid")); return }
              setState({ source: value, script: undefined, form: value ? "scriptArgs" : undefined, error: "" })
              return
            }
            if (form === "scriptArgs") {
              void run(async () => {
                const { Option, Schema } = await import("effect")
                if (!value.isWellFormed() || new TextEncoder().encode(value).byteLength > 8192 ||
                  Option.isNone(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value))) throw new Error(text("scriptInvalid"))
                if (current()) setState({ argsJSON: value, script: undefined, form: undefined })
              })
              return
            }
            if (form === "restore") {
              setState("controlID", value.trim())
              void refresh()
              return
            }
            const lines = value.split(/\r?\n/).map((line) => line.trim())
            if (form === "createPublicSystem" || form === "createPublicDoH" || form === "createPublicAliDNS") {
              void connect({ profile: "managed-public-readonly-v1", origin: lines[0] ?? "",
                approvedOrigins: [...new Set(lines.filter(Boolean))],
                resolverPolicy: form === "createPublicDoH" ? "cloudflare_doh_v1" : form === "createPublicAliDNS" ? "alidns_doh_v1" : "system" })
              return
            }
            if (form === "createExchange") {
              void connect({ profile: "managed-loopback-exchange-v1", origin: lines[0] ?? "",
                postPaths: [...new Set(lines.slice(1).filter(Boolean))], filePolicy: { upload: true, download: true } })
              return
            }
            void connect({ profile: "managed-loopback-interaction-v1", origin: lines[0] ?? "", postPaths: lines.slice(1).filter(Boolean) })
          }}
        />
      )}
    </Show>}>
      {(view) => <DialogBrowserFiles view={view()} active={available} back={() => setState("form", undefined)} />}
    </Show>
  )
}
