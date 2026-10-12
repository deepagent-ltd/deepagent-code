import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { ScrollBoxRenderable } from "@opentui/core"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useTuiI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import type {
  DeepAgentCodeClient,
  McpCredentialsPreviewResponse,
  McpCredentialsStatusResponse,
  McpBindingRepairPreview,
} from "@deepagent-code/sdk"

const pending = new WeakMap<DeepAgentCodeClient, Map<string, string>>()
const MAX_PENDING_MIGRATIONS = 32

export function DialogMcpSecrets(props: {
  name: string
  client: DeepAgentCodeClient
  directory: string
  workspace?: string
  server: string
  current: () => boolean
  close: () => void
}) {
  const language = useTuiI18n()
  const client = props.client
  const name = props.name
  const directory = props.directory
  const workspace = props.workspace
  const server = props.server
  const key = `${directory}\0${workspace ?? ""}\0${name}`
  const [state, setState] = createStore({
    preview: undefined as McpCredentialsPreviewResponse | undefined,
    binding: undefined as McpBindingRepairPreview | undefined,
    receipt: undefined as McpCredentialsStatusResponse | undefined,
    requestID: pending.get(client)?.get(key) ?? "",
    busy: false,
    blocked: !!pending.get(client)?.get(key),
    confirm: undefined as "initialize" | "migrate" | "repair" | undefined,
    error: "",
    message: "",
  })
  const owner = { live: true, generation: 0, abort: new AbortController() }
  let detailsScroll: ScrollBoxRenderable | undefined
  const live = () =>
    owner.live &&
    props.current() &&
    props.client === client &&
    props.name === name &&
    props.directory === directory &&
    props.workspace === workspace &&
    props.server === server
  const signal = () => AbortSignal.any([owner.abort.signal, AbortSignal.timeout(15_000)])
  const error = (value: unknown) => {
    if (
      value instanceof Error &&
      value.cause &&
      typeof value.cause === "object" &&
      "status" in value.cause &&
      value.cause.status === 401
    )
      return language.t("tui.mcp.secrets.authenticationRequired")
    const body =
      value instanceof Error && value.cause && typeof value.cause === "object" && "body" in value.cause
        ? value.cause.body
        : value
    const code = body && typeof body === "object" && "code" in body ? body.code : undefined
    if (code === "unavailable") return language.t("tui.mcp.secrets.unavailable")
    return `${language.t("tui.mcp.secrets.error")}${typeof code === "string" && ["invalid", "changed", "unknown", "capacity", "work_unsettled"].includes(code) ? ` (${code})` : ""}`
  }
  const remember = (requestID: string) => {
    const entries = pending.get(client) ?? new Map<string, string>()
    // Never replace an unknown operation or release its slot on dialog disposal.
    const retained = entries.get(key)
    if (retained && retained !== requestID) throw { code: "unknown" }
    if (!retained && entries.size >= MAX_PENDING_MIGRATIONS) throw { code: "capacity" }
    entries.set(key, requestID)
    pending.set(client, entries)
  }
  onCleanup(() => {
    owner.live = false
    owner.generation++
    owner.abort.abort()
    if (detailsScroll && !detailsScroll.isDestroyed) detailsScroll.destroyRecursively()
  })
  createEffect(() => {
    if (props.current()) return
    owner.live = false
    owner.generation++
    owner.abort.abort()
    setState({
      preview: undefined,
      binding: undefined,
      confirm: undefined,
      busy: false,
      error: language.t("tui.mcp.secrets.scopeChanged"),
    })
  })
  const read = async (kind: "preview" | "binding" | "status") => {
    if (!live() || state.busy || (kind === "status" && !state.requestID.trim())) return
    const generation = ++owner.generation
    setState({ busy: true, error: "", confirm: undefined })
    try {
      const options = { signal: signal(), throwOnError: true as const }
      if (kind === "preview") {
        const value = (await client.mcp.credentials.preview({ name, directory, workspace }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name) throw new Error("Unexpected credential preview")
        setState({ preview: value, binding: undefined })
      }
      if (kind === "binding") {
        const value = (await client.mcp.binding.preview({ name, directory, workspace }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name || value.old.canonicalRoot !== props.directory)
          throw new Error("Unexpected binding preview")
        setState({ binding: value, preview: undefined })
      }
      if (kind === "status") {
        const requestID = state.requestID.trim()
        const value = (await client.mcp.credentials.status({ name, directory, workspace, requestID }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name || value.requestID !== requestID)
          throw new Error("Unexpected migration receipt")
        setState("receipt", value)
        if (value.state === "committed") {
          if (pending.get(client)?.get(key) === requestID) pending.get(client)?.delete(key)
          setState("blocked", false)
        }
      }
    } catch (value) {
      if (live() && generation === owner.generation) setState("error", error(value))
    } finally {
      if (live() && generation === owner.generation) setState("busy", false)
    }
  }
  onMount(() => {
    void read(state.requestID ? "status" : "preview")
  })
  const submit = async (reconcile = false) => {
    if (!live() || state.busy || (!reconcile && (!state.confirm || state.blocked))) return
    const action = state.confirm
    const preview = state.preview
    const binding = state.binding
    const requestID =
      action === "migrate" && state.receipt?.state === "committed"
        ? crypto.randomUUID()
        : state.requestID || crypto.randomUUID()
    const generation = ++owner.generation
    setState({ busy: true, error: "", message: "", confirm: undefined })
    try {
      const options = { signal: signal(), throwOnError: true as const }
      if (action === "migrate") {
        if (!preview?.fields.length) return
        const fresh = (await client.mcp.credentials.preview({ name, directory, workspace }, options)).data
        if (!live() || generation !== owner.generation) return
        if (
          !fresh ||
          fresh.name !== name ||
          fresh.source !== preview.source ||
          JSON.stringify(fresh.fields) !== JSON.stringify(preview.fields)
        )
          throw new Error("Credential review changed")
        remember(requestID)
        setState({ requestID, blocked: true })
        // Use the reviewed token; a fresh read must not authorize changed secret bytes.
        const value = (
          await client.mcp.credentials.commit(
            { name, directory, workspace, previewID: preview.previewID, requestID },
            options,
          )
        ).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name || value.requestID !== requestID)
          throw new Error("Unexpected migration receipt")
        setState("receipt", value)
        if (value.state === "committed") {
          if (pending.get(client)?.get(key) === requestID) pending.get(client)?.delete(key)
          setState({ blocked: false, preview: undefined })
        }
      }
      if (action === "initialize") {
        setState("blocked", true)
        const value = (await client.mcp.credentials.initialize({ name, directory, workspace }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name) throw new Error("Unexpected initialization result")
        setState({ blocked: false, message: language.t("tui.mcp.secrets.initialized") })
      }
      if (action === "repair") {
        if (!binding) return
        const fresh = (await client.mcp.binding.preview({ name, directory, workspace }, options)).data
        if (!live() || generation !== owner.generation) return
        if (
          !fresh ||
          fresh.name !== name ||
          fresh.source !== binding.source ||
          fresh.nextObservedProjectId !== binding.nextObservedProjectId ||
          JSON.stringify(fresh.old) !== JSON.stringify(binding.old)
        )
          throw new Error("Binding review changed")
        setState("blocked", true)
        const value = (
          await client.mcp.binding.repair({ name, directory, workspace, previewID: binding.previewID }, options)
        ).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name || value.state !== "repaired") throw new Error("Unexpected binding result")
        setState({ blocked: false, binding: undefined, message: language.t("tui.mcp.secrets.repaired") })
      }
      if (reconcile) {
        const value = (await client.mcp.credentials.reconcile({ name, directory, workspace, requestID }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name || value.requestID !== requestID)
          throw new Error("Unexpected migration receipt")
        setState("receipt", value)
        if (value.state === "committed") {
          if (pending.get(client)?.get(key) === requestID) pending.get(client)?.delete(key)
          setState("blocked", false)
        }
      }
    } catch (value) {
      if (live() && generation === owner.generation)
        setState("error", `${error(value)}${state.blocked ? ` ${language.t("tui.mcp.secrets.unknown")}` : ""}`)
    } finally {
      if (live() && generation === owner.generation) setState("busy", false)
    }
  }
  const { theme } = useTheme()
  const [form, setForm] = createStore({ requestID: false })
  const options = createMemo(() =>
    state.confirm
      ? [
          { value: "confirm", title: language.t("tui.mcp.secrets.confirm") },
          { value: "cancel", title: language.t("tui.mcp.secrets.cancel") },
        ]
      : [
          { value: "preview", title: language.t("tui.mcp.secrets.preview") },
          { value: "binding", title: language.t("tui.mcp.secrets.bindingPreview") },
          ...(!state.blocked ? [{ value: "initialize", title: language.t("tui.mcp.secrets.initialize") }] : []),
          ...(!state.blocked && state.preview?.fields.length
            ? [{ value: "migrate", title: language.t("tui.mcp.secrets.commit") }]
            : []),
          ...(!state.blocked && state.binding
            ? [{ value: "repair", title: language.t("tui.mcp.secrets.repair") }]
            : []),
          ...(state.requestID.trim()
            ? [
                { value: "status", title: language.t("tui.mcp.secrets.status") },
                { value: "reconcile", title: language.t("tui.mcp.secrets.reconcile") },
              ]
            : []),
          ...(!state.blocked ? [{ value: "requestID", title: language.t("tui.mcp.secrets.requestID") }] : []),
          { value: "close", title: language.t("tui.mcp.secrets.close") },
        ],
  )
  const details = createMemo(() =>
    [
      state.confirm
        ? language.t(
            state.confirm === "initialize"
              ? "tui.mcp.secrets.confirmInitialize"
              : state.confirm === "migrate"
                ? "tui.mcp.secrets.confirmCommit"
                : "tui.mcp.secrets.confirmRepair",
          )
        : "",
      state.busy ? language.t("tui.mcp.secrets.acting") : "",
      state.error,
      state.message,
      state.receipt ? `${language.t(`tui.mcp.secrets.state.${state.receipt.state}`)} · ${state.receipt.moved}` : "",
      state.requestID ? `${language.t("tui.mcp.secrets.requestID")}: ${state.requestID}` : "",
      name,
      `${language.t("tui.common.pageUp")} ctrl+u · ${language.t("tui.common.pageDown")} ctrl+d`,
      server,
      directory,
      workspace ?? "",
      state.preview
        ? `${language.t("tui.mcp.secrets.source")}: ${state.preview.source}\n${language.t("tui.mcp.secrets.fields")}: ${state.preview.fields.map((field) => `${field.field}.${field.key}`).join(", ") || language.t("tui.mcp.secrets.empty")}`
        : "",
      state.binding
        ? `${language.t("tui.mcp.secrets.oldBinding")}: ${JSON.stringify(state.binding.old)}\n${language.t("tui.mcp.secrets.nextBinding")}: ${state.binding.nextObservedProjectId}`
        : "",
      language.t("tui.mcp.secrets.help"),
    ]
      .filter(Boolean)
      .join("\n"),
  )
  return (
    <box>
      {form.requestID ? (
        <DialogPrompt
          title={language.t("tui.mcp.secrets.requestID")}
          onConfirm={(value) => {
            if (live() && !state.busy && !state.blocked) setState("requestID", value.trim())
            setForm("requestID", false)
          }}
        />
      ) : (
        <DialogSelect
          title={language.t("tui.mcp.secrets.title")}
          renderFilter={false}
          locked={state.busy}
          options={options()}
          current={options()[0]?.value}
          bindings={[
            { key: "ctrl+u", desc: language.t("tui.common.pageUp"), cmd: () => detailsScroll?.scrollBy(-3) },
            { key: "ctrl+d", desc: language.t("tui.common.pageDown"), cmd: () => detailsScroll?.scrollBy(3) },
          ]}
          footer={
            <scrollbox ref={(value) => (detailsScroll = value)} maxHeight={7}>
              <text fg={theme.textMuted}>{details()}</text>
            </scrollbox>
          }
          onSelect={(option) => {
            if (option.value === "close") {
              owner.live = false
              owner.generation++
              owner.abort.abort()
              props.close()
              return
            }
            if (!live() || state.busy) return
            if (["preview", "binding", "status"].includes(option.value)) {
              void read(option.value as "preview" | "binding" | "status")
              return
            }
            if (option.value === "confirm") {
              void submit()
              return
            }
            if (option.value === "cancel") {
              setState("confirm", undefined)
              return
            }
            if (option.value === "reconcile") {
              void submit(true)
              return
            }
            if (option.value === "requestID") {
              setForm("requestID", true)
              return
            }
            if (["initialize", "migrate", "repair"].includes(option.value) && !state.blocked)
              setState("confirm", option.value as "initialize" | "migrate" | "repair")
          }}
        />
      )}
    </box>
  )
}
