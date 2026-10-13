import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { TextField } from "@deepagent-code/ui/text-field"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type {
  DeepAgentCodeClient,
  McpCredentialsPreviewResponse,
  McpCredentialsStatusResponse,
  McpBindingRepairPreview,
} from "@deepagent-code/sdk"

// Retain an unknown original request in this client owner only, without credentials or disk state.
const pending = new WeakMap<DeepAgentCodeClient, Map<string, string>>()
const MAX_PENDING_MIGRATIONS = 32

export function DialogMcpSecrets(props: { name: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const owner = { client: sdk.client, scope: sdk.scope, directory: sdk.directory, url: sdk.url }
  return (
    <McpSecretsPanel
      name={props.name}
      client={owner.client}
      directory={owner.directory}
      server={owner.url}
      current={() =>
        sdk.client === owner.client &&
        sdk.scope === owner.scope &&
        sdk.directory === owner.directory &&
        sdk.url === owner.url
      }
      close={() => dialog.close()}
    />
  )
}

export function McpSecretsPanel(props: {
  name: string
  client: DeepAgentCodeClient
  directory: string
  server: string
  current: () => boolean
  close: () => void
}) {
  const language = useLanguage()
  const client = props.client
  const name = props.name
  const directory = props.directory
  const server = props.server
  const key = `${directory}\0${name}`
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
  const live = () =>
    owner.live &&
    props.current() &&
    props.client === client &&
    props.name === name &&
    props.directory === directory &&
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
      return language.t("mcp.secrets.authenticationRequired")
    const body =
      value instanceof Error && value.cause && typeof value.cause === "object" && "body" in value.cause
        ? value.cause.body
        : value
    const code = body && typeof body === "object" && "code" in body ? body.code : undefined
    if (code === "unavailable") return language.t("mcp.secrets.unavailable")
    return `${language.t("mcp.secrets.error")}${typeof code === "string" && ["invalid", "changed", "unknown", "capacity", "work_unsettled"].includes(code) ? ` (${code})` : ""}`
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
      error: language.t("mcp.secrets.scopeChanged"),
    })
  })
  const read = async (kind: "preview" | "binding" | "status") => {
    if (!live() || state.busy || (kind === "status" && !state.requestID.trim())) return
    const generation = ++owner.generation
    setState({ busy: true, error: "", confirm: undefined })
    try {
      const options = { signal: signal(), throwOnError: true as const }
      if (kind === "preview") {
        const value = (await client.mcp.credentials.preview({ name, directory }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name) throw new Error("Unexpected credential preview")
        setState({ preview: value, binding: undefined })
      }
      if (kind === "binding") {
        const value = (await client.mcp.binding.preview({ name, directory }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name || value.old.canonicalRoot !== props.directory)
          throw new Error("Unexpected binding preview")
        setState({ binding: value, preview: undefined })
      }
      if (kind === "status") {
        const requestID = state.requestID.trim()
        const value = (await client.mcp.credentials.status({ name, directory, requestID }, options)).data
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
        const fresh = (await client.mcp.credentials.preview({ name, directory }, options)).data
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
          await client.mcp.credentials.commit({ name, directory, previewID: preview.previewID, requestID }, options)
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
        const value = (await client.mcp.credentials.initialize({ name, directory }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name) throw new Error("Unexpected initialization result")
        setState({ blocked: false, message: language.t("mcp.secrets.initialized") })
      }
      if (action === "repair") {
        if (!binding) return
        const fresh = (await client.mcp.binding.preview({ name, directory }, options)).data
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
        const value = (await client.mcp.binding.repair({ name, directory, previewID: binding.previewID }, options)).data
        if (!live() || generation !== owner.generation) return
        if (!value || value.name !== name || value.state !== "repaired") throw new Error("Unexpected binding result")
        setState({ blocked: false, binding: undefined, message: language.t("mcp.secrets.repaired") })
      }
      if (reconcile) {
        const value = (await client.mcp.credentials.reconcile({ name, directory, requestID }, options)).data
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
        setState("error", `${error(value)}${state.blocked ? ` ${language.t("mcp.secrets.unknown")}` : ""}`)
    } finally {
      if (live() && generation === owner.generation) setState("busy", false)
    }
  }
  return (
    <Dialog title={language.t("mcp.secrets.title")}>
      <div class="flex min-w-0 flex-col gap-3 p-4">
        <p class="text-12-regular text-text-weak">{language.t("mcp.secrets.help")}</p>
        <div class="break-all text-12-regular">
          {name}
          <br />
          {props.server}
          <br />
          {props.directory}
        </div>
        <Show when={state.error}>
          <p role="alert" class="text-12-regular text-text-critical-base">
            {state.error}
          </p>
        </Show>
        <Show when={state.message}>
          <p role="status">{state.message}</p>
        </Show>
        <Show when={state.busy}>
          <p role="status">{language.t("mcp.secrets.acting")}</p>
        </Show>
        <Show when={state.preview}>
          {(preview) => (
            <div class="flex min-w-0 flex-col gap-2">
              <p class="break-all text-12-regular">
                {language.t("mcp.secrets.source")}: {preview().source}
              </p>
              <p>{language.t("mcp.secrets.fields")}</p>
              <For each={preview().fields}>
                {(field) => (
                  <div class="break-all text-12-regular">
                    {field.field}.{field.key}
                  </div>
                )}
              </For>
              <Show when={!preview().fields.length}>
                <p>{language.t("mcp.secrets.empty")}</p>
              </Show>
            </div>
          )}
        </Show>
        <Show when={state.binding}>
          {(binding) => (
            <div class="flex min-w-0 flex-col gap-2">
              <p class="break-all text-12-regular">
                {language.t("mcp.secrets.source")}: {binding().source}
              </p>
              <p>{language.t("mcp.secrets.oldBinding")}</p>
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all text-11-regular">
                {JSON.stringify(binding().old, null, 2)}
              </pre>
              <p class="break-all text-12-regular">
                {language.t("mcp.secrets.nextBinding")}: {binding().nextObservedProjectId}
              </p>
            </div>
          )}
        </Show>
        <Show when={state.receipt}>
          {(receipt) => (
            <p role="status">
              {language.t(`mcp.secrets.state.${receipt().state}`)} · {receipt().moved}
            </p>
          )}
        </Show>
        <TextField
          label={language.t("mcp.secrets.requestID")}
          value={state.requestID}
          disabled={state.busy || state.blocked}
          onChange={(value) => setState("requestID", value)}
        />
        <Show when={state.confirm}>
          {(action) => (
            <div class="flex flex-col gap-2 rounded-md border border-border-base p-3">
              <p>
                {language.t(
                  action() === "initialize"
                    ? "mcp.secrets.confirmInitialize"
                    : action() === "migrate"
                      ? "mcp.secrets.confirmCommit"
                      : "mcp.secrets.confirmRepair",
                )}
              </p>
              <div class="flex gap-2">
                <Button disabled={state.busy || !live()} onClick={() => void submit()}>
                  {language.t("mcp.secrets.confirm")}
                </Button>
                <Button variant="ghost" disabled={state.busy} onClick={() => setState("confirm", undefined)}>
                  {language.t("mcp.secrets.cancel")}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <div class="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={state.busy || !live()} onClick={() => void read("preview")}>
            {language.t("mcp.secrets.preview")}
          </Button>
          <Button variant="secondary" disabled={state.busy || !live()} onClick={() => void read("binding")}>
            {language.t("mcp.secrets.bindingPreview")}
          </Button>
          <Button
            variant="secondary"
            disabled={state.busy || state.blocked || !live()}
            onClick={() => setState("confirm", "initialize")}
          >
            {language.t("mcp.secrets.initialize")}
          </Button>
          <Button
            disabled={state.busy || state.blocked || !state.preview?.fields.length || !live()}
            onClick={() => setState("confirm", "migrate")}
          >
            {language.t("mcp.secrets.commit")}
          </Button>
          <Button
            disabled={state.busy || state.blocked || !state.binding || !live()}
            onClick={() => setState("confirm", "repair")}
          >
            {language.t("mcp.secrets.repair")}
          </Button>
          <Button
            variant="secondary"
            disabled={state.busy || !state.requestID.trim() || !live()}
            onClick={() => void read("status")}
          >
            {language.t("mcp.secrets.status")}
          </Button>
          <Button
            variant="secondary"
            disabled={state.busy || !state.requestID.trim() || !live()}
            onClick={() => void submit(true)}
          >
            {language.t("mcp.secrets.reconcile")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              owner.live = false
              owner.generation++
              owner.abort.abort()
              props.close()
            }}
          >
            {language.t("mcp.secrets.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
