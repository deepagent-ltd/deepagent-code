import { createEffect, createMemo, onCleanup, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { McpOperatorClient } from "@deepagent-code/core/mcp/operator-client"
import { useProject } from "../context/project"
import { useClipboard } from "../context/clipboard"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useSync } from "../context/sync"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import type { McpStatus } from "@deepagent-code/sdk/client"
import { mcpConnectionBlocked, mcpConnectionMessage } from "../util/mcp-status"
import { DialogMcpSecrets } from "./dialog-mcp-secrets"

function Status(props: { status: McpStatus; loading: boolean }) {
  const { theme } = useTheme()
  const i18n = useTuiI18n()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  if (props.status.status === "connected") {
    return (
      <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ {i18n.t("tui.mcp.status.connected")}</span>
    )
  }
  if (props.status.status === "disconnected") {
    return (
      <span style={{ fg: mcpConnectionBlocked(props.status) ? theme.warning : theme.textMuted }}>
        {i18n.t("tui.mcp.status.disconnected")}
      </span>
    )
  }
  return <span style={{ fg: theme.textMuted }}>{i18n.t(`tui.mcp.status.${props.status.status}`)}</span>
}

export function DialogMcp() {
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const clipboard = useClipboard()
  const i18n = useTuiI18n()
  const client = sdk.client
  const directory = project.instance.directory()
  const workspace = project.workspace.current()
  const controller = new AbortController()
  const releaseInteraction = sdk.protectMcp()
  const [state, setState] = createStore({
    name: undefined as string | undefined,
    prepared: undefined as McpOperatorClient.Prepared | undefined,
    busy: false,
    confirm: false,
    review: false,
    form: undefined as "code" | "issuer" | undefined,
    authorizationUrl: undefined as string | undefined,
    oauthState: undefined as string | undefined,
    code: "",
    error: "",
    credentials: false,
  })
  let closed = false
  const live = () =>
    !closed &&
    client === sdk.client &&
    project.instance.directory() === directory &&
    project.workspace.current() === workspace
  const release = async () => {
    const ticket = state.prepared?.ticket
    setState("prepared", undefined)
    if (ticket) await sdk.mcpOperator?.release(ticket)
  }
  onCleanup(() => {
    closed = true
    controller.abort()
    void release()
      .catch(() => undefined)
      .finally(releaseInteraction)
  })
  createEffect(() => {
    if (project.instance.directory() !== directory || project.workspace.current() !== workspace) dialog.clear()
  })
  const refresh = async () => {
    const response = await client.mcp.status(undefined, { throwOnError: true })
    if (live() && response.data) sync.set("mcp", response.data)
  }
  const report = (error: unknown) => {
    if (!live()) return
    if (error instanceof McpOperatorClient.RequestError && error.code === "SCOPE_CHANGED") setState("review", true)
    setState("error", error instanceof Error ? error.message : i18n.t("tui.mcp.connection.recoveryRequired"))
  }
  const choose = async (name: string) => {
    if (state.busy) return
    setState({ busy: true, error: "", name, review: false })
    try {
      await release()
      if (sdk.mcpOperator) {
        if (workspace !== undefined || directory !== sdk.directory)
          throw new Error(i18n.t("tui.mcp.operator.scopeChanged"))
        const prepared = await sdk.mcpOperator.prepare(name, controller.signal)
        if (!live()) {
          await sdk.mcpOperator.release(prepared.ticket)
          return
        }
        setState("prepared", prepared)
      }
    } catch (error) {
      report(error)
    } finally {
      if (live()) setState("busy", false)
    }
  }
  const invoke = async (action: McpOperatorClient.Action, callback?: McpOperatorClient.Command["callback"]) => {
    if (state.busy || !state.name || !live()) return
    const name = state.name
    const ticket = state.prepared?.ticket
    if (action !== "clearAuth" && mcpConnectionBlocked(sync.data.mcp[name])) {
      setState("error", i18n.t("tui.mcp.connection.recoveryRequired"))
      return
    }
    setState({ busy: true, error: "", confirm: false })
    try {
      const result = await (async (): Promise<McpOperatorClient.Result> => {
        if (sdk.mcpOperator) {
          if (!ticket) throw new Error(i18n.t("tui.mcp.operator.scopeChanged"))
          return sdk.mcpOperator.send({ ticket, action, ...(callback ? { callback } : {}) }, controller.signal)
        }
        const options = { throwOnError: true as const, signal: controller.signal }
        if (action === "connect") await client.mcp.connect({ name }, options)
        if (action === "disconnect") await client.mcp.disconnect({ name }, options)
        if (action === "clearAuth") await client.mcp.auth.remove({ name }, options)
        if (action === "authenticate") await client.mcp.auth.authenticate({ name }, options)
        if (action === "finishAuth" && callback) await client.mcp.auth.callback({ name, ...callback }, options)
        if (action === "startAuth") {
          const result = await client.mcp.auth.start({ name }, options)
          if (!result.data) throw new Error(i18n.t("tui.mcp.connection.recoveryRequired"))
          return result.data
        }
        return {}
      })()
      if (!live()) return
      if (action === "startAuth" && result.authorizationUrl && result.oauthState) {
        setState({ authorizationUrl: result.authorizationUrl, oauthState: result.oauthState })
      } else if (action === "finishAuth" || action === "clearAuth") {
        setState({ authorizationUrl: undefined, oauthState: undefined, code: "", form: undefined })
      }
      await refresh()
    } catch (error) {
      report(error)
      await refresh().catch(() => undefined)
    } finally {
      if (live()) setState("busy", false)
    }
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (!state.name)
      return Object.entries(sync.data.mcp ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, status]) => ({
          value: name,
          title: name,
          footer: <Status status={status} loading={false} />,
        }))
    if (state.review)
      return [
        { value: "review", title: i18n.t("tui.mcp.operator.review") },
        { value: "credentials", title: i18n.t("tui.mcp.secrets.open") },
        { value: "back", title: i18n.t("tui.mcp.operator.back") },
      ]
    if (state.confirm)
      return [
        { value: "confirmClear", title: i18n.t("tui.mcp.operator.confirmClear") },
        { value: "cancelClear", title: i18n.t("tui.mcp.operator.back") },
      ]
    if (state.authorizationUrl)
      return [
        { value: "copy", title: i18n.t("tui.mcp.operator.copyUrl") },
        { value: "code", title: i18n.t("tui.mcp.operator.enterCode") },
        { value: "back", title: i18n.t("tui.mcp.operator.back") },
      ]
    const status = sync.data.mcp[state.name]
    const config = sync.data.config.mcp?.[state.name]
    const oauth =
      state.prepared?.oauth ?? (config && "type" in config && config.type === "remote" && config.oauth !== false)
    const uri =
      config && "type" in config && config.type === "remote" && typeof config.oauth === "object"
        ? config.oauth.redirectUri
        : undefined
    const redirect = uri ? URL.parse(uri) : undefined
    const manual =
      state.prepared?.manual ??
      (!!redirect &&
        (redirect.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)))
    return [
      ...(!mcpConnectionBlocked(status)
        ? [
            {
              value: status?.status === "connected" ? "disconnect" : "connect",
              title: i18n.t(status?.status === "connected" ? "tui.mcp.action.disconnect" : "tui.mcp.action.connect"),
            },
          ]
        : []),
      ...(oauth && !mcpConnectionBlocked(status)
        ? [{ value: manual ? "startAuth" : "authenticate", title: i18n.t("tui.mcp.action.authenticate") }]
        : []),
      { value: "refresh", title: i18n.t("tui.mcp.action.refresh") },
      ...(oauth ? [{ value: "clearAuth", title: i18n.t("tui.mcp.operator.clear") }] : []),
      { value: "credentials", title: i18n.t("tui.mcp.secrets.open") },
      { value: "back", title: i18n.t("tui.mcp.operator.back") },
    ]
  })
  const select = async (value: string) => {
    if (value === "credentials" && state.name && !state.busy && live()) {
      setState("credentials", true)
      return
    }
    if (state.busy || !live()) return
    if (!state.name) {
      await choose(value)
      return
    }
    if (value === "back") {
      setState("busy", true)
      await release().catch(report)
      if (live())
        setState({
          name: undefined,
          busy: false,
          authorizationUrl: undefined,
          oauthState: undefined,
          code: "",
          error: "",
        })
      return
    }
    if (value === "review") {
      await choose(state.name)
      return
    }
    if (value === "refresh") {
      await refresh().catch(report)
      return
    }
    if (value === "clearAuth") {
      setState("confirm", true)
      return
    }
    if (value === "cancelClear") {
      setState("confirm", false)
      return
    }
    if (value === "confirmClear") {
      await invoke("clearAuth")
      return
    }
    if (value === "copy") {
      if (state.authorizationUrl) await clipboard.write?.(state.authorizationUrl)
      return
    }
    if (value === "code") {
      setState("form", "code")
      return
    }
    if (["connect", "disconnect", "authenticate", "startAuth"].includes(value))
      await invoke(value as McpOperatorClient.Action)
  }
  // Keep a concrete root while forms change; the dialog factory must not be
  // recreated when a control-flow accessor selects a different child.
  return (
    <box>
      <Switch>
        <Match when={state.credentials && state.name}>
          <DialogMcpSecrets
            name={state.name!}
            client={client}
            directory={directory}
            workspace={workspace}
            server={sdk.url}
            current={live}
            close={() => setState("credentials", false)}
          />
        </Match>
        <Match when={state.form === "code"}>
          <DialogPrompt
            title={i18n.t("tui.mcp.operator.enterCode")}
            description={<text>{i18n.t("tui.mcp.operator.manualHint")}</text>}
            onConfirm={(value) => {
              if (value.trim()) setState({ code: value.trim(), form: "issuer" })
            }}
          />
        </Match>
        <Match when={state.form === "issuer"}>
          <DialogPrompt
            title={i18n.t("tui.mcp.operator.enterIssuer")}
            description={<text>{i18n.t("tui.mcp.operator.manualHint")}</text>}
            onConfirm={(value) => {
              const code = state.code
              const oauthState = state.oauthState
              setState("form", undefined)
              if (oauthState)
                void invoke("finishAuth", { code, oauthState, ...(value.trim() ? { iss: value.trim() } : {}) })
            }}
          />
        </Match>
        <Match when={!state.form}>
          <DialogSelect
            title={state.name ? `MCP · ${state.name}` : "MCP"}
            skipFilter={!!state.name}
            renderFilter={!state.name}
            locked={state.busy}
            options={options()}
            current={options()[0]?.value}
            footer={
              <text>
                {[
                  state.prepared?.target,
                  (() => {
                    const status = state.name ? sync.data.mcp[state.name] : undefined
                    const key = status?.status === "disconnected" ? mcpConnectionMessage(status) : undefined
                    return key ? i18n.t(key) : undefined
                  })(),
                  state.busy ? i18n.t("tui.mcp.operator.waiting") : undefined,
                  state.confirm ? i18n.t("tui.mcp.operator.clearHint") : undefined,
                  state.authorizationUrl ? i18n.t("tui.mcp.operator.manualHint") : undefined,
                  state.error,
                ]
                  .filter(Boolean)
                  .join("\n")}
              </text>
            }
            onSelect={(option) => {
              void select(option.value).catch(report)
            }}
          />
        </Match>
      </Switch>
    </box>
  )
}
