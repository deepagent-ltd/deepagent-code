import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import type {
  DeepAgentCodeClient,
  McpAppOpenResponse,
  McpAppsResponse,
  McpAppInvokeResponse,
  PermissionRequest,
} from "@deepagent-code/sdk"
import { replyPermission } from "@/context/global-sync/permission-v2"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { createMcpAppBridge, mcpAppPermissions, mcpAppSandboxUrl } from "@/utils/mcp-app-sandbox"
import { invokeMcpApp } from "@/utils/mcp-app-invocation"

export function DialogMcpApps(props: { name: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const params = useParams()
  const navigate = useNavigate()
  const owner = {
    client: sdk.client,
    scope: sdk.scope,
    directory: sdk.directory,
    url: sdk.url,
    name: props.name,
    sessionID: params.id,
  }
  const [permission, setPermission] = createStore({ responding: false, error: "" })
  return (
    <McpAppsPanel
      name={owner.name}
      url={owner.url}
      client={owner.client}
      directory={owner.directory}
      sessionID={owner.sessionID}
      sessions={sync.data.session.map((session) => ({ id: session.id, title: session.title }))}
      selectSession={(sessionID) => {
        if (sdk.client !== owner.client || sdk.scope !== owner.scope || sdk.directory !== owner.directory) return
        dialog.close()
        navigate(`/${base64Encode(owner.directory)}/session/${sessionID}`)
        queueMicrotask(() => {
          if (
            sdk.client === owner.client &&
            sdk.scope === owner.scope &&
            sdk.directory === owner.directory &&
            params.id === sessionID
          )
            dialog.show(() => <SDKProvider directory={owner.directory}><DialogMcpApps name={owner.name} /></SDKProvider>)
        })
      }}
      current={() =>
        sdk.client === owner.client &&
        sdk.scope === owner.scope &&
        sdk.directory === owner.directory &&
        sdk.url === owner.url &&
        params.id === owner.sessionID &&
        props.name === owner.name &&
        sync.data.mcp?.[owner.name]?.status === "connected"
      }
      subscribe={(invalidate) =>
        sdk.event.on("mcp.tools.changed", (event) => {
          if (event.properties.server === owner.name) invalidate()
        })
      }
      subscribeInvocation={(changed) =>
        sdk.event.on("session.mcp-app.changed", (event) => changed(event.properties.status))
      }
      permission={owner.sessionID ? sync.data.permission[owner.sessionID]?.[0] : undefined}
      permissionResponding={permission.responding}
      permissionError={permission.error}
      decidePermission={(request, response) => {
        if (
          permission.responding ||
          sdk.client !== owner.client ||
          sdk.scope !== owner.scope ||
          sdk.directory !== owner.directory ||
          params.id !== owner.sessionID ||
          request.sessionID !== owner.sessionID
        )
          return
        setPermission({ responding: true, error: "" })
        void replyPermission(owner.client, {
          sessionID: request.sessionID,
          requestID: request.id,
          response,
          directory: owner.directory,
          v2: !!sync.data.permission_v2[request.id],
        }).then(
          () => setPermission("responding", false),
          () =>
            setPermission({
              responding: false,
              error: "Permission reply failed. Check the current request before retrying.",
            }),
        )
      }}
      close={() => dialog.close()}
    />
  )
}

export function McpAppsPanel(props: {
  name: string
  url: string
  client: DeepAgentCodeClient
  directory: string
  sessionID?: string
  sessions?: readonly { id: string; title: string }[]
  selectSession?: (sessionID: string) => void
  current: () => boolean
  subscribe: (invalidate: () => void) => () => void
  subscribeInvocation?: (changed: (status: McpAppInvokeResponse) => void) => () => void
  permission?: PermissionRequest
  permissionResponding?: boolean
  permissionError?: string
  decidePermission?: (request: PermissionRequest, response: "once" | "always" | "reject") => void
  close: () => void
}) {
  const language = useLanguage()
  const client = props.client
  const directory = props.directory
  const name = props.name
  const [state, setState] = createStore({
    resources: [] as McpAppsResponse,
    selected: undefined as McpAppsResponse[number] | undefined,
    view: undefined as McpAppOpenResponse | undefined,
    busy: false,
    error: "",
    sessionID: props.sessionID ?? "",
    invocation: undefined as McpAppInvokeResponse | undefined,
  })
  const owner = { live: true, revision: 0, abort: new AbortController() }
  let checking = false
  const live = () =>
    owner.live && props.current() && props.client === client && props.directory === directory && props.name === name
  const signal = () => AbortSignal.any([owner.abort.signal, AbortSignal.timeout(10000)])
  const retire = (view: McpAppOpenResponse) => {
    // Closing only invalidates the old observer lease. It never reads resources or executes
    // tools, and always uses the original client/directory rather than a replacement owner.
    void client.mcp.appClose({ directory, viewID: view.viewID }, { signal: AbortSignal.timeout(3000) }).catch(() => {})
  }
  const invalidate = (message = "") => {
    owner.revision++
    owner.abort.abort()
    owner.abort = new AbortController()
    const view = state.view
    setState({ view: undefined, busy: false, error: message })
    if (view) retire(view)
  }
  const refresh = async () => {
    if (!live() || state.busy) return
    invalidate()
    const revision = owner.revision
    setState({ busy: true, resources: [], selected: undefined })
    const result = await client.mcp.apps({ directory }, { signal: signal() }).then(
      (response) => response.data,
      () => undefined,
    )
    if (!live() || owner.revision !== revision) return
    const resources = result?.filter((item) => item.server === name) ?? []
    setState({
      busy: false,
      resources,
      selected: resources[0],
      error: result ? "" : language.t("common.requestFailed"),
    })
  }
  const open = async () => {
    if (!live() || state.busy || !state.selected) return
    invalidate()
    const revision = owner.revision
    const selected = state.selected
    setState("busy", true)
    const view = await client.mcp
      .appOpen(
        {
          directory,
          server: selected.server,
          tool: selected.tool,
          generation: selected.generation,
          resourceUri: selected.resourceUri,
          consent: true,
          ...(state.sessionID ? { sessionID: state.sessionID } : {}),
        },
        { signal: signal() },
      )
      .then(
        (response) => response.data,
        () => undefined,
      )
    if (!live() || owner.revision !== revision) {
      if (view) retire(view)
      return
    }
    if (
      !view ||
      view.sessionID !== (state.sessionID || undefined) ||
      typeof view.expiresAt !== "number" ||
      !Number.isSafeInteger(view.expiresAt) ||
      view.expiresAt <= Date.now() ||
      view.descriptor.server !== selected.server ||
      view.descriptor.tool !== selected.tool ||
      view.descriptor.generation !== selected.generation ||
      view.descriptor.resourceUri !== selected.resourceUri ||
      new TextEncoder().encode(view.html).length > 262144
    ) {
      if (view) retire(view)
      setState({ busy: false, error: language.t("mcp.apps.expired") })
      return
    }
    setState({ busy: false, view })
  }
  onMount(() => {
    void refresh()
    const unsubscribe = props.subscribe(() => {
      invalidate(language.t("mcp.apps.expired"))
      setState({ resources: [], selected: undefined })
    })
    const timer = setInterval(async () => {
      const view = state.view
      if (!view || checking || !live()) return
      if (typeof view.expiresAt !== "number" || view.expiresAt <= Date.now()) {
        invalidate(language.t("mcp.apps.expired"))
        return
      }
      checking = true
      const revision = owner.revision
      const current = await client.mcp.appCheck({ directory, viewID: view.viewID }, { signal: signal() }).then(
        (response) => response.data,
        () => undefined,
      )
      checking = false
      if (!live() || revision !== owner.revision || state.view?.viewID !== view.viewID) return
      if (
        !current ||
        current.generation !== view.descriptor.generation ||
        current.server !== view.descriptor.server ||
        current.tool !== view.descriptor.tool ||
        current.resourceUri !== view.descriptor.resourceUri
      )
        invalidate(language.t("mcp.apps.expired"))
    }, 2000)
    onCleanup(() => {
      unsubscribe()
      clearInterval(timer)
    })
  })
  createEffect(() => {
    if (live()) return
    invalidate(language.t("mcp.apps.expired"))
  })
  onCleanup(() => {
    owner.live = false
    invalidate()
    owner.abort.abort()
  })

  return (
    <Dialog title={language.t("mcp.apps.title")} size="large">
      <div class="flex min-w-0 flex-col gap-3 px-4 pb-4">
        <p class="text-13-regular text-text-base">{language.t("mcp.apps.consent", { name })}</p>
        <p class="text-12-regular text-text-weak">{language.t("mcp.apps.limited")}</p>
        <Show when={props.sessionID || props.sessions?.length}>
          <label class="text-12-regular text-text-base">{language.t("mcp.apps.session")}</label>
          <SelectV2
            options={[{ id: "", title: language.t("mcp.apps.resourceOnly") }, ...(props.sessions ?? [])]}
            current={{
              id: state.sessionID,
              title: state.sessionID
                ? (props.sessions?.find((session) => session.id === state.sessionID)?.title ?? state.sessionID)
                : language.t("mcp.apps.resourceOnly"),
            }}
            value={(session) => session.id || "resource-only"}
            label={(session) => session.title}
            disabled={state.busy || !live()}
            onSelect={(session) => {
              if (!session || session.id === state.sessionID) return
              invalidate()
              if (session.id && session.id !== props.sessionID) {
                props.selectSession?.(session.id)
                return
              }
              setState({ sessionID: session.id, invocation: undefined })
            }}
          />
        </Show>
        <SelectV2
          options={state.resources}
          current={state.selected}
          value={(item) => `${item.generation}/${item.tool}`}
          label={(item) => `${item.tool} · ${item.resourceUri}`}
          disabled={state.busy || !live()}
          onSelect={(selected) => {
            if (selected?.generation === state.selected?.generation && selected?.tool === state.selected?.tool) return
            invalidate()
            setState("selected", selected ?? undefined)
          }}
        />
        <div class="flex flex-wrap gap-2">
          <Button disabled={!live() || state.busy || !state.selected} onClick={() => void open()}>
            {language.t("mcp.apps.open")}
          </Button>
          <Button variant="secondary" disabled={!live() || state.busy} onClick={() => void refresh()}>
            {language.t("oversight.common.refresh")}
          </Button>
          <Button variant="secondary" onClick={props.close}>
            {language.t("common.close")}
          </Button>
        </div>
        <Show when={state.error}>
          <p role="alert" class="text-12-regular text-icon-critical-base">
            {state.error}
          </p>
        </Show>
        <Show when={props.permission && props.permission.sessionID === state.sessionID ? props.permission : undefined}>
          {(request) => (
            <SessionPermissionDock
              request={request()}
              responding={!!props.permissionResponding}
              onDecide={(response) => props.decidePermission?.(request(), response)}
            />
          )}
        </Show>
        <Show when={props.permissionError}>
          <p role="alert" class="text-12-regular text-icon-critical-base">
            {props.permissionError}
          </p>
        </Show>
        <Show when={state.invocation}>
          {(invocation) => (
            <div
              role="status"
              data-mcp-app-invocation={invocation().invocationID}
              class="rounded-md border border-border-base p-2 text-12-regular"
            >
              <p>{language.t(`mcp.apps.state.${invocation().state}`)}</p>
              <p class="break-all text-text-weak">{invocation().invocationID}</p>
            </div>
          )}
        </Show>
        <Show when={state.view} keyed>
          {(view) => {
            const current = () => live() && state.view?.viewID === view.viewID
            return (
              <McpAppFrame
                url={props.url}
                html={view.html}
                current={current}
                locale={language.intl()}
                invalidated={() => invalidate(language.t("mcp.apps.expired"))}
                invoke={
                  view.sessionID && props.subscribeInvocation
                    ? (input) =>
                        invokeMcpApp({
                          ...input,
                          client,
                          directory,
                          sessionID: view.sessionID!,
                          viewID: view.viewID,
                          signal: AbortSignal.any([owner.abort.signal, AbortSignal.timeout(75000)]),
                          current,
                          subscribe: props.subscribeInvocation!,
                          observed: (status) => {
                            if (current()) setState("invocation", status)
                          },
                        })
                    : undefined
                }
                listTools={
                  view.sessionID
                    ? async () => {
                        if (!current()) throw new Error("MCP App view changed")
                        const result = await client.mcp
                          .appViewTools(
                            { directory, sessionID: view.sessionID!, viewID: view.viewID },
                            { signal: signal() },
                          )
                          .then((response) => response.data)
                        if (
                          !current() ||
                          !result ||
                          result.viewID !== view.viewID ||
                          result.sessionID !== view.sessionID ||
                          result.generation !== view.descriptor.generation ||
                          new TextEncoder().encode(JSON.stringify(result)).length > 1048576
                        )
                          throw new Error("MCP App tool snapshot changed")
                        return { tools: result.tools }
                      }
                    : undefined
                }
              />
            )
          }}
        </Show>
      </div>
    </Dialog>
  )
}

export function McpAppFrame(props: {
  url: string
  html: string
  current: () => boolean
  locale: string
  invalidated: () => void
  invoke?: (input: {
    rpcID: string | number
    name: string
    arguments: Record<string, unknown>
  }) => Promise<Record<string, unknown>>
  listTools?: () => Promise<Record<string, unknown>>
}) {
  const [state, setState] = createStore({ height: 320 })
  let frame: HTMLIFrameElement | undefined
  const bridge = createMcpAppBridge({
    html: props.html,
    post: (message) => frame?.contentWindow?.postMessage(message, "*"),
    context: {
      locale: props.locale,
      theme: document.documentElement.dataset.colorScheme === "dark" ? "dark" : "light",
    },
    onSize: (height) => setState("height", height),
    onInvalidated: props.invalidated,
    invoke: props.invoke,
    listTools: props.listTools,
  })
  onMount(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (!props.current()) {
        bridge.close()
        props.invalidated()
        return
      }
      if (event.source !== frame?.contentWindow || event.origin !== "null") return
      bridge.receive(event.data)
    }
    window.addEventListener("message", receive)
    onCleanup(() => window.removeEventListener("message", receive))
  })
  onCleanup(() => bridge.close())
  return (
    <iframe
      ref={frame}
      title="MCP App"
      sandbox="allow-scripts"
      allow={mcpAppPermissions}
      referrerPolicy="no-referrer"
      src={mcpAppSandboxUrl(props.url)}
      style={{
        width: "100%",
        height: `${state.height}px`,
        border: "1px solid var(--border-base)",
        "border-radius": "6px",
      }}
    />
  )
}
