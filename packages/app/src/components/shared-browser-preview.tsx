import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { Button } from "@deepagent-code/ui/button"
import { TextField } from "@deepagent-code/ui/text-field"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import type { SharedBrowserPlatform, SharedBrowserView } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { BrowserControlPill } from "./browser-control-pill"
import { BrowserFileExchange } from "./browser-file-exchange"

export function SharedBrowserPreview(props: {
  view: SharedBrowserView
  bridge: SharedBrowserPlatform
  onUpdate: (view: SharedBrowserView) => void
  onReturnToSession: () => void
}) {
  const language = useLanguage()
  const text = (key: string) => language.t(`browser.shared.${key}` as Parameters<typeof language.t>[0])
  const [state, setState] = createStore({
    png: "",
    observedAt: 0,
    error: "",
    loading: false,
    closing: false,
    filesOpen: false,
    origin: "",
    approvingOrigin: false,
    originRequest: undefined as SharedBrowserSchema.ApproveOrigin | undefined,
  })
  const files = () => props.view.resource.policy.filePolicy?.upload || props.view.resource.policy.filePolicy?.download
  const fileActive = () =>
    props.view.resource.state === "agent_owned" &&
    props.view.resource.resourceAlive &&
    !props.view.resource.agentAccessFenced &&
    !props.view.resource.manualEnabled &&
    !!props.view.resource.liveLeaseID &&
    props.view.resource.expiresAt > Date.now() &&
    !state.closing
  createEffect(() => {
    props.view.resource.resourceID
    props.view.resource.manualEpoch
    setState("filesOpen", false)
    setState({ origin: "", originRequest: undefined, approvingOrigin: false })
  })
  const requests = {
    takeover: undefined as SharedBrowserSchema.Takeover | undefined,
    close: undefined as SharedBrowserSchema.Close | undefined,
    preview: 0,
  }
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const current = (view: SharedBrowserView, bridge: SharedBrowserPlatform) =>
    !disposed &&
    props.bridge === bridge &&
    props.view.resource.resourceID === view.resource.resourceID &&
    props.view.resource.rootSessionID === view.resource.rootSessionID &&
    props.view.resource.mainIncarnation === view.resource.mainIncarnation &&
    JSON.stringify(props.view.resource.scope) === JSON.stringify(view.resource.scope) &&
    props.view.resource.manualEpoch === view.resource.manualEpoch

  const preview = async () => {
    if (props.view.resource.state !== "agent_owned") return
    const view = props.view
    const bridge = props.bridge
    const sequence = ++requests.preview
    setState({ loading: true, error: "" })
    try {
      // This reads Main's already-admitted screenshot cache, never starts a capture.
      const value = await bridge.preview({
        resourceID: view.resource.resourceID,
        sessionID: view.resource.rootSessionID,
        manualEpoch: view.resource.manualEpoch,
      })
      if (
        !current(view, bridge) ||
        sequence !== requests.preview ||
        props.view.resource.state !== "agent_owned" ||
        value.manualEpoch !== view.resource.manualEpoch
      )
        return
      setState({ png: value.png ? `data:image/png;base64,${value.png}` : "", observedAt: value.observedAt ?? 0 })
    } catch (error) {
      if (current(view, bridge) && sequence === requests.preview && props.view.resource.state === "agent_owned")
        setState({ png: "", observedAt: 0, error: error instanceof Error ? error.message : text("previewUnavailable") })
    } finally {
      if (current(view, bridge) && sequence === requests.preview) setState("loading", false)
    }
  }
  createEffect(() => {
    const resourceID = props.view.resource.resourceID
    if (requests.takeover?.resourceID !== resourceID) requests.takeover = undefined
    if (requests.close?.resourceID !== resourceID) requests.close = undefined
    props.view.resource.manualEpoch
    props.view.resource.revision
    const owner = props.view.resource.state
    requests.preview++
    setState({ png: "", observedAt: 0, error: "", loading: false, closing: false })
    if (owner === "agent_owned") void preview()
  })

  const takeover = async (retry = false) => {
    const view = props.view
    const bridge = props.bridge
    const original = view.pendingTakeover ?? requests.takeover
    const request = retry
      ? original
      : original?.resourceID === view.resource.resourceID && original.expectedRevision === view.resource.revision
        ? original
        : {
            resourceID: view.resource.resourceID,
            requestID: crypto.randomUUID(),
            expectedRevision: view.resource.revision,
          }
    if (!request || request.resourceID !== view.resource.resourceID) throw new Error(text("originalRequestUnavailable"))
    requests.takeover = request
    const result = await bridge.takeover({ ...request })
    if (
      !disposed &&
      props.bridge === bridge &&
      props.view.resource.resourceID === view.resource.resourceID &&
      result.resource.resourceID === view.resource.resourceID
    )
      props.onUpdate(result)
  }
  const close = async () => {
    if (state.closing) return
    const view = props.view
    const bridge = props.bridge
    const original = view.pendingClose ?? requests.close
    const request =
      original?.resourceID === view.resource.resourceID
        ? original
        : {
            resourceID: view.resource.resourceID,
            requestID: crypto.randomUUID(),
            expectedRevision: view.resource.revision,
          }
    requests.close = request
    setState({ closing: true, error: "" })
    try {
      const result = await bridge.close({ ...request })
      if (
        !disposed &&
        props.bridge === bridge &&
        props.view.resource.resourceID === view.resource.resourceID &&
        result.resource.resourceID === view.resource.resourceID
      )
        props.onUpdate(result)
    } catch (error) {
      if (current(view, bridge)) setState("error", error instanceof Error ? error.message : text("closeUnconfirmed"))
    } finally {
      if (current(view, bridge)) setState("closing", false)
    }
  }
  const originRequest = () => props.view.pendingOrigin ?? state.originRequest
  const approveOrigin = async () => {
    const bridge = props.bridge
    const view = { ...props.view, resource: { ...props.view.resource, scope: { ...props.view.resource.scope } } }
    const origin = state.origin.trim()
    if (
      !bridge.approveOrigin ||
      state.approvingOrigin ||
      view.resource.state !== "human_owned" ||
      !view.resource.manualEnabled ||
      !view.resource.agentAccessFenced ||
      state.closing
    )
      return
    setState({ approvingOrigin: true, error: "" })
    try {
      const { SharedBrowserSchema } = await import("@deepagent-code/core/browser/shared-schema")
      const { Option, Schema } = await import("effect")
      if (!current(view, bridge)) return
      const parsed = Schema.decodeUnknownOption(SharedBrowserSchema.ApproveOrigin)({
        resourceID: view.resource.resourceID,
        requestID: crypto.randomUUID(),
        expectedRevision: view.resource.revision,
        expectedManualEpoch: view.resource.manualEpoch,
        expectedPolicyHash: view.resource.policyHash,
        origin,
      })
      const request = originRequest() ?? (Option.isSome(parsed) ? parsed.value : undefined)
      if (!request) throw new Error(text("invalidPolicy"))
      setState("originRequest", request)
      const result = await bridge.approveOrigin({ ...request })
      if (
        !current(view, bridge) ||
        result.resource.resourceID !== view.resource.resourceID ||
        result.resource.manualEpoch !== view.resource.manualEpoch ||
        result.resource.rootSessionID !== view.resource.rootSessionID
      )
        return
      setState("originRequest", undefined)
      setState("origin", "")
      props.onUpdate(result)
    } catch (error) {
      if (current(view, bridge)) {
        setState("error", error instanceof Error ? error.message : text("requestFailed"))
        await cancelOrigin(true)
      }
    } finally {
      if (current(view, bridge)) setState("approvingOrigin", false)
    }
  }
  const cancelOrigin = async (automatic = false) => {
    const bridge = props.bridge
    const view = { ...props.view, resource: { ...props.view.resource, scope: { ...props.view.resource.scope } } }
    const request = originRequest()
    if (!request || !bridge.cancelOrigin || (!automatic && state.approvingOrigin)) return
    setState("approvingOrigin", true)
    try {
      const result = await bridge.cancelOrigin({ ...request })
      if (
        !current(view, bridge) ||
        !result.cancelled ||
        result.view.resource.resourceID !== view.resource.resourceID ||
        result.view.resource.manualEpoch !== view.resource.manualEpoch
      )
        return
      setState("originRequest", undefined)
      props.onUpdate(result.view)
    } catch {
      // Missing/lost cancellation acknowledgement is not proof of no commit.
    } finally {
      if (current(view, bridge)) setState("approvingOrigin", false)
    }
  }

  return (
    <section class="flex min-h-0 flex-1 flex-col" aria-label={text("title")}>
      <div
        class="flex h-11 shrink-0 min-w-0 items-center gap-1 border-b border-border-weak-base px-2"
        data-slot="browser-address-bar"
      >
        <div
          class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-surface-inset-base px-2"
          title={text("approvedSite")}
        >
          <Icon name="shield" size="small" class="shrink-0 text-icon-weak" />
          <input
            readOnly
            aria-label={text("approvedSite")}
            value={props.view.resource.policy.origin}
            class="h-full min-w-0 flex-1 bg-transparent text-12-regular text-text-base outline-none"
          />
        </div>
        <Show when={files()}>
          <IconButton
            icon="folder"
            variant="ghost"
            class="h-7 w-7 shrink-0 rounded-md"
            aria-label={language.t("browser.files.title")}
            title={language.t("browser.files.title")}
            aria-expanded={state.filesOpen}
            onClick={() => setState("filesOpen", (value) => !value)}
          />
        </Show>
        <Show when={props.view.resource.state === "agent_owned"}>
          <IconButton
            icon="reset"
            variant="ghost"
            class="h-7 w-7 shrink-0 rounded-md"
            disabled={state.loading}
            onClick={() => void preview()}
            aria-label={text("refreshPreview")}
            title={text("refreshPreview")}
          />
        </Show>
        <IconButton
          icon="stop"
          variant="ghost"
          class="h-7 w-7 shrink-0 rounded-md"
          aria-label={text("close")}
          title={text("close")}
          disabled={state.closing || props.view.resource.state === "closing" || props.view.resource.state === "closed"}
          onClick={() => void close()}
        />
      </div>
      <div class="relative flex min-h-0 flex-1 flex-col" data-slot="shared-browser-viewport">
        <Show
          when={props.view.resource.state === "agent_owned"}
          fallback={
            <div class="flex min-h-0 flex-1 items-center justify-center px-6 pb-24 text-center">
              <div class="flex max-w-64 flex-col items-center gap-3 text-text-weak">
                <Icon name="window-cursor" size="large" />
                <p class="text-12-regular leading-relaxed">
                  {text(props.view.resource.state === "human_owned" ? "manualPage" : "previewPaused")}
                </p>
              </div>
            </div>
          }
        >
          <div class="flex min-h-0 flex-1 flex-col overflow-auto pb-32">
            <Show
              when={state.png}
              fallback={
                <div class="flex min-h-0 flex-1 items-center justify-center px-6 pb-8 text-center">
                  <div class="flex max-w-64 flex-col items-center gap-2">
                    <div class="mb-1 flex size-10 items-center justify-center rounded-xl bg-surface-inset-base text-icon-weak">
                      <Icon name="window-cursor" size="large" />
                    </div>
                    <p class="text-13-medium text-text-base">{text("waitingPreview")}</p>
                    <p class="text-12-regular leading-relaxed text-text-weak">{text("noPreview")}</p>
                  </div>
                </div>
              }
            >
              {(png) => <img src={png()} alt={text("previewAlt")} class="block h-auto w-full" />}
            </Show>
            <Show when={state.observedAt > 0}>
              <span class="px-3 py-2 text-11-regular text-text-weak">
                {text("capturedAt")} {new Date(state.observedAt).toLocaleTimeString()}
              </span>
            </Show>
          </div>
        </Show>
        <div
          class="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-3"
          style={{ bottom: "clamp(24px, 7%, 72px)" }}
          data-slot="shared-browser-control-overlay"
        >
          <div class="pointer-events-auto max-w-full">
            <BrowserControlPill
              resourceID={props.view.resource.resourceID}
              ownershipEpoch={props.view.resource.manualEpoch}
              state={props.view.resource.state}
              elapsedMs={props.view.elapsedMs}
              error={state.error}
              onTakeover={() => takeover()}
              onRetryTakeover={props.view.pendingTakeover || requests.takeover ? () => takeover(true) : undefined}
              onReturnToSession={props.onReturnToSession}
              onCloseResource={() => void close()}
            />
          </div>
        </div>
      </div>
      <Show when={state.filesOpen && files()}>
        <div
          class="max-h-[45%] shrink-0 overflow-y-auto border-t border-border-weak-base p-3"
          data-slot="shared-browser-files"
        >
          <BrowserFileExchange shared={props.view} active={fileActive} />
        </div>
      </Show>
      <Show
        when={
          props.bridge.approveOrigin && props.view.resource.state === "human_owned" && props.view.resource.manualEnabled
        }
      >
        <div class="shrink-0 border-t border-border-weak-base p-3" data-slot="shared-browser-origin-approval">
          <TextField
            label={text("policy.title")}
            value={originRequest()?.origin ?? state.origin}
            disabled={state.approvingOrigin || !!originRequest() || state.closing}
            onChange={(origin) => setState("origin", origin)}
            placeholder="https://example.com"
          />
          <p class="py-2 text-12-regular text-text-weak">{text("policy.hint")}</p>
          <Button
            disabled={state.approvingOrigin || state.closing || (!originRequest() && !state.origin.trim())}
            onClick={() => void approveOrigin()}
          >
            {originRequest() ? language.t("browser.files.retryExact") : text("policy.approve")}
          </Button>
          <Show when={props.bridge.cancelOrigin && (originRequest() || state.origin.trim())}>
            <Button
              disabled={state.approvingOrigin || state.closing}
              onClick={() => {
                if (originRequest()) void cancelOrigin()
                else setState("origin", "")
              }}
            >
              {language.t("common.cancel")}
            </Button>
          </Show>
        </div>
      </Show>
    </section>
  )
}
