import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore, unwrap, type SetStoreFunction, type Store } from "solid-js/store"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useTuiI18n } from "../context/i18n"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"

type State = {
  owner: string
  busy: boolean
  error: string
  creating: boolean
  selected: string
  duration: 5 | 15 | 30
  request?: SharedBrowserSchema.Create
  createdID?: string
  resources: SharedBrowserSchema.Resource[]
  takeovers: Record<string, SharedBrowserSchema.Takeover>
  closes: Record<string, SharedBrowserSchema.Close>
}
const controls = new WeakMap<DeepAgentCodeClient, Map<string, [Store<State>, SetStoreFunction<State>]>>()

export function DialogSharedBrowser(props: { sessionID: string; onUse?: (resourceID: string) => void }) {
  const sdk = useSDK()
  const project = useProject()
  const i18n = useTuiI18n()
  const dialog = useDialog()
  const client = sdk.client
  const sessionID = props.sessionID
  const directory = project.instance.directory()
  const workspace = project.workspace.current()
  const key = JSON.stringify([directory, workspace, sessionID])
  const owner = crypto.randomUUID()
  const entries = controls.get(client) ?? new Map<string, [Store<State>, SetStoreFunction<State>]>()
  controls.set(client, entries)
  const [state, setState] =
    entries.get(key) ??
    createStore<State>({
      owner,
      busy: false,
      error: "",
      creating: false,
      selected: "",
      duration: 5,
      resources: [],
      takeovers: {},
      closes: {},
    })
  if (entries.size < 64 || entries.has(key)) entries.set(key, [state, setState])
  setState({ owner, busy: false })
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const current = () =>
    !disposed &&
    state.owner === owner &&
    sdk.client === client &&
    props.sessionID === sessionID &&
    project.instance.directory() === directory &&
    project.workspace.current() === workspace
  const text = (name: string) => i18n.t(`tui.browser.shared.${name}` as Parameters<typeof i18n.t>[0])
  const [terminal, setTerminal] = createSignal(sdk.browserOwner?.current())
  const [submissionRevision, setSubmissionRevision] = createSignal(0)
  const pendingInput = () => {
    submissionRevision()
    return sdk.browserSubmit.pending(sessionID)
  }
  const cancelableInput = () => {
    submissionRevision()
    return sdk.browserSubmit.canCancelBeforeDispatch(sessionID)
  }
  const offTerminal = sdk.browserOwner?.onState((view) => {
    if (current()) setTerminal(view)
  })
  onCleanup(() => offTerminal?.())
  const terminalHere = () =>
    terminal()?.rootSessionID === sessionID && terminal()?.directory === directory ? terminal() : undefined
  const ownerText = (name: "pair" | "pending" | "active" | "retired" | "detach" | "retry" | "cancelUnsent") =>
    i18n.t(`tui.browser.owner.${name}`)
  const selected = createMemo(
    () => state.resources.find((resource) => resource.resourceID === state.selected) ?? state.resources[0],
  )
  createEffect(() => {
    if (state.owner !== owner) return
    if (
      sdk.client !== client ||
      props.sessionID !== sessionID ||
      project.instance.directory() !== directory ||
      project.workspace.current() !== workspace
    )
      dialog.clear()
  })
  const receive = (resource: SharedBrowserSchema.Resource | undefined) => {
    if (!current()) return
    if (
      !resource ||
      resource.rootSessionID !== sessionID ||
      resource.scope.sessionID !== sessionID ||
      resource.scope.directory !== directory
    )
      throw new Error(text("scopeChanged"))
    setState("resources", (values) =>
      values.some((value) => value.resourceID === resource.resourceID)
        ? values.map((value) =>
            value.resourceID === resource.resourceID && value.revision <= resource.revision ? resource : value,
          )
        : [...values, resource],
    )
  }
  const run = async (operation: () => Promise<void>) => {
    if (!current() || state.busy) return
    setState({ busy: true, error: "" })
    try {
      await operation()
    } catch (error) {
      if (current())
        setState(
          "error",
          error instanceof Error &&
            ["scopeChanged", "invalid", "capacity", "originalUnavailable", "originalCloseUnavailable"].some(
              (name) => text(name) === error.message,
            )
            ? error.message
            : text("unknown"),
        )
    } finally {
      if (state.owner === owner) setState("busy", false)
    }
  }
  const refresh = () =>
    run(async () => {
      const result = await client.browser.sharedList({ sessionID }, { throwOnError: true })
      if (!current()) return
      result.data?.resources.forEach(receive)
    })
  const create = (policyJSON?: string) =>
    run(async () => {
      if (workspace !== undefined) throw new Error(text("scopeChanged"))
      if (!entries.has(key)) throw new Error(text("capacity"))
      if (!state.request) {
        const { Option, Schema } = await import("effect")
        const { SharedBrowserSchema } = await import("@deepagent-code/core/browser/shared-schema")
        if (!policyJSON?.isWellFormed() || new TextEncoder().encode(policyJSON).byteLength > 131072)
          throw new Error(text("invalid"))
        const policy = Schema.decodeUnknownOption(Schema.fromJsonString(SharedBrowserSchema.Policy), {
          onExcessProperty: "error",
        })(policyJSON)
        if (Option.isNone(policy)) throw new Error(text("invalid"))
        if (!current()) return
        setState("request", {
          version: 2,
          profile: SharedBrowserSchema.PROFILE,
          inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
          requestID: crypto.randomUUID(),
          sessionID,
          policy: policy.value,
          expiresAt: Date.now() + state.duration * 60_000,
        })
      }
      if (!current() || !state.request) return
      const request = unwrap(state.request)
      const result = await client.browser.sharedCreate(
        {
          ...request,
          policy: {
            ...request.policy,
            approvedOrigins: [...request.policy.approvedOrigins],
            manualApprovedOrigins: [...request.policy.manualApprovedOrigins],
            postGrants: request.policy.postGrants.map((grant) => ({ ...grant })),
            scriptGrants: request.policy.scriptGrants?.map((grant) => ({ ...grant })),
            programGrants: request.policy.programGrants?.map((grant) => ({
              ...grant,
              operations: [...grant.operations],
            })),
          },
        },
        { throwOnError: true },
      )
      if (!current()) return
      receive(result.data?.resource)
      setState({ createdID: result.data?.resource.resourceID, selected: result.data?.resource.resourceID ?? "" })
    }).finally(() => {
      // Keep the approving form alive until its request settles, including an
      // unknown response. Replacing it sooner can dispose the original owner.
      if (current() && state.request) setState("creating", false)
    })
  const takeover = (retry: boolean) =>
    run(async () => {
      const resource = selected()
      if (!resource) return
      const original = state.takeovers[resource.resourceID]
      if (retry && !original) throw new Error(text("originalUnavailable"))
      if (!retry && resource.state !== "agent_owned" && resource.state !== "acquire_pending") return
      const request = retry
        ? original!
        : original?.expectedRevision === resource.revision
          ? original
          : {
              resourceID: resource.resourceID,
              requestID: crypto.randomUUID(),
              expectedRevision: resource.revision,
            }
      setState("takeovers", resource.resourceID, request)
      receive(
        (
          await client.browser.sharedTakeover(
            {
              path_resourceID: request.resourceID,
              body_resourceID: request.resourceID,
              requestID: request.requestID,
              expectedRevision: request.expectedRevision,
            },
            { throwOnError: true },
          )
        ).data?.resource,
      )
    })
  const close = () =>
    run(async () => {
      const resource = selected()
      if (!resource) return
      if (resource.state === "closing" && !state.closes[resource.resourceID])
        throw new Error(text("originalCloseUnavailable"))
      const request = state.closes[resource.resourceID] ?? {
        resourceID: resource.resourceID,
        requestID: crypto.randomUUID(),
        expectedRevision: resource.revision,
      }
      setState("closes", resource.resourceID, request)
      receive(
        (
          await client.browser.sharedClose(
            {
              path_resourceID: request.resourceID,
              body_resourceID: request.resourceID,
              requestID: request.requestID,
              expectedRevision: request.expectedRevision,
            },
            { throwOnError: true },
          )
        ).data?.resource,
      )
    })
  onMount(() => {
    // Reopening an unresolved approval preserves its error and exact identity;
    // a background list must not erase the outcome the user needs to reconcile.
    if (!state.request || state.createdID) void refresh()
  })

  return (
    <Show
      when={state.creating}
      fallback={
        <DialogSelect
          title={text("title")}
          locked={state.busy}
          skipFilter
          renderFilter={false}
          footer={
            <box paddingLeft={2} paddingRight={2} gap={1}>
              <text wrapMode="word">{text("hint")}</text>
              <text wrapMode="word">
                {terminalHere() ? ownerText(terminalHere()!.state) : text("resumeUnavailable")}
              </text>
              <Show when={terminalHere()}>{(view) => <text wrapMode="word">SHA256: {view().challengeHash}</text>}</Show>
              <Show when={selected()}>
                {(resource) => (
                  <text wrapMode="word">
                    {resource().policy.origin}
                    {"\n"}
                    {resource().resourceID}
                    {"\n"}
                    {text(resource().state)}
                  </text>
                )}
              </Show>
              <Show
                when={
                  selected() &&
                  ["fenced_blocked", "recovery_required"].includes(selected()!.state) &&
                  !state.takeovers[selected()!.resourceID]
                }
              >
                <text wrapMode="word">{text("originalUnavailable")}</text>
              </Show>
              <Show when={selected()?.state === "closing" && !state.closes[selected()!.resourceID]}>
                <text wrapMode="word">{text("originalCloseUnavailable")}</text>
              </Show>
              <Show when={state.error}>
                <text wrapMode="word">{state.error}</text>
              </Show>
            </box>
          }
          options={[
            ...state.resources.map((resource) => ({
              value: `resource:${resource.resourceID}`,
              title: resource.policy.origin,
              description: text(resource.state),
              category: text("pages"),
            })),
            ...(!state.request
              ? [
                  { title: text("create"), value: "create" },
                  ...([5, 15, 30] as const).map((value) => ({
                    title: i18n.t(`tui.browser.control.duration${value}`),
                    value: `duration${value}`,
                    description: state.duration === value ? i18n.t("tui.browser.control.durationSelected") : undefined,
                  })),
                ]
              : state.createdID
                ? [{ title: text("new"), value: "new" }]
                : [{ title: text("retryCreate"), value: "retryCreate" }]),
            { title: text("refresh"), value: "refresh" },
            ...(sdk.browserOwner
              ? [
                  {
                    title: ownerText("pair"),
                    value: "terminalPair",
                    disabled: terminalHere()?.state === "active" || terminalHere()?.state === "pending",
                  },
                ]
              : []),
            ...(terminalHere() && terminalHere()?.state !== "retired"
              ? [{ title: ownerText("detach"), value: "terminalDetach" }]
              : []),
            ...(pendingInput() ? [{ title: ownerText("retry"), value: "terminalRetry" }] : []),
            ...(cancelableInput() ? [{ title: ownerText("cancelUnsent"), value: "terminalCancelUnsent" }] : []),
            ...(selected()
              ? [
                  { title: text("use"), value: "use", disabled: selected()?.state !== "agent_owned" || !props.onUse },
                  ...(["agent_owned", "acquire_pending", "takeover_pending"].includes(selected()!.state)
                    ? [
                        {
                          title: text(selected()?.state === "takeover_pending" ? "takeoverPending" : "takeover"),
                          value: "takeover",
                          disabled: selected()?.state === "takeover_pending",
                        },
                      ]
                    : []),
                  ...(["fenced_blocked", "recovery_required"].includes(selected()!.state)
                    ? [
                        {
                          title: text("retryTakeover"),
                          value: "retryTakeover",
                          disabled: !state.takeovers[selected()!.resourceID],
                        },
                      ]
                    : []),
                  {
                    title: text("close"),
                    value: "close",
                    disabled:
                      selected()?.state === "closed" ||
                      (selected()?.state === "closing" && !state.closes[selected()!.resourceID]),
                  },
                ]
              : []),
            { title: text("back"), value: "back" },
          ]}
          onSelect={(option) => {
            if (!current() || state.busy || option.disabled) return
            if (option.value.startsWith("resource:")) {
              setState("selected", option.value.slice(9))
              return
            }
            if (option.value === "create") {
              setState("creating", true)
              return
            }
            if (option.value === "retryCreate") {
              void create()
              return
            }
            if (option.value === "new") {
              setState({ request: undefined, createdID: undefined, creating: true })
              return
            }
            if (option.value === "duration5" || option.value === "duration15" || option.value === "duration30") {
              setState("duration", option.value === "duration5" ? 5 : option.value === "duration15" ? 15 : 30)
              return
            }
            if (option.value === "terminalPair") {
              void run(async () => {
                const view = await sdk.browserOwner?.pair({ rootSessionID: sessionID, directory })
                if (current()) setTerminal(view)
              })
              return
            }
            if (option.value === "terminalDetach") {
              void run(async () => {
                await sdk.browserOwner?.detach()
              })
              return
            }
            if (option.value === "terminalRetry") {
              void run(async () => {
                try {
                  await sdk.browserSubmit.retry(sessionID)
                } finally {
                  if (current()) setSubmissionRevision((value) => value + 1)
                }
              })
              return
            }
            if (option.value === "terminalCancelUnsent") {
              if (sdk.browserSubmit.cancelBeforeDispatch(sessionID)) {
                setState("error", "")
                setSubmissionRevision((value) => value + 1)
              }
              return
            }
            if (option.value === "refresh") {
              void refresh()
              return
            }
            if (option.value === "takeover") {
              void takeover(false)
              return
            }
            if (option.value === "retryTakeover") {
              void takeover(true)
              return
            }
            if (option.value === "close") {
              void close()
              return
            }
            if (option.value === "use" && selected()?.state === "agent_owned") props.onUse?.(selected()!.resourceID)
            if (option.value === "use" || option.value === "back") dialog.clear()
          }}
        />
      }
    >
      <DialogPrompt
        title={text("create")}
        busy={state.busy}
        description={
          <box gap={1}>
            <text wrapMode="word">{text("policyHint")}</text>
            <text wrapMode="word">{i18n.t("tui.browser.control.durationHint")}</text>
            <Show when={state.error}>
              <text wrapMode="word">{state.error}</text>
            </Show>
          </box>
        }
        value={JSON.stringify({
          origin: "https://example.com",
          approvedOrigins: ["https://example.com"],
          manualApprovedOrigins: ["https://example.com"],
          resolverPolicy: "system",
          postGrants: [],
        })}
        onCancel={() => setState("creating", false)}
        onConfirm={(value) => void create(value)}
      />
    </Show>
  )
}
