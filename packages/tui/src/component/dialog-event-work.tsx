import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useTuiI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

type API = DeepAgentCodeClient["eventWork"]
type Candidate = NonNullable<Awaited<ReturnType<API["candidates"]>>["data"]>[number]
type Rule = NonNullable<Awaited<ReturnType<API["rules"]>>["data"]>["items"][number]
type Root = NonNullable<Awaited<ReturnType<API["roots"]>>["data"]>["items"][number]
type Command =
  | { kind: "rule"; input: Parameters<API["ruleControl"]>[0] }
  | { kind: "root"; input: Parameters<API["rootControl"]>[0] }
const requests = new WeakMap<object, Map<string, Command>>()

export function createEventWorkOwner() {
  const [owner, setOwner] = createStore({ alive: true })
  onCleanup(() => setOwner("alive", false))
  return () => owner.alive
}

export function DialogEventWork(props: {
  sessionID: string
  active?: () => boolean
  onOpenSession?: (id: string) => void
}) {
  const sdk = useSDK()
  const project = useProject()
  const i18n = useTuiI18n()
  const appearance = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  let details: ScrollBoxRenderable | undefined
  const client = sdk.client
  const directory = project.instance.directory()
  const workspaceID = project.workspace.current()
  const sessionID = props.sessionID
  const key = JSON.stringify([directory, workspaceID ?? null, sessionID])
  const retained = requests.get(client) ?? new Map<string, Command>()
  requests.set(client, retained)
  const [state, setState] = createStore({
    alive: true,
    view: "home" as "home" | "form" | "origins" | "rule" | "root",
    edit: undefined as "instruction" | "hours" | undefined,
    loading: false,
    busy: false,
    error: "",
    notice: "",
    candidates: undefined as Candidate[] | undefined,
    rules: undefined as Rule[] | undefined,
    roots: undefined as Root[] | undefined,
    rulesAfter: undefined as string | undefined,
    rootsAfter: undefined as string | undefined,
    nextRuleCursor: null as string | null,
    nextRootCursor: null as string | null,
    ruleID: "",
    rootID: "",
    form: false,
    originID: "",
    instruction: "",
    hours: "1",
    pending: retained.get(key),
    confirm: undefined as Command | undefined,
  })
  const abort = new AbortController()
  let reads = 0
  const text = (name: string) => i18n.t(`tui.eventWork.${name}` as Parameters<typeof i18n.t>[0])
  const current = () =>
    state.alive &&
    props.active?.() !== false &&
    sdk.client === client &&
    project.instance.directory() === directory &&
    project.workspace.current() === workspaceID &&
    props.sessionID === sessionID
  const selectedRule = () => state.rules?.find((rule) => rule.ruleID === state.ruleID)
  const selectedRoot = () => state.roots?.find((root) => root.rootID === state.rootID)
  const candidate = () => state.candidates?.find((item) => item.originID === state.originID)
  const candidateAvailable = (value: Candidate) => value.available === true
  const ready = () => current() && !state.loading && !state.busy && !state.pending
  onCleanup(() => {
    setState("alive", false)
    reads++
    abort.abort()
  })
  createEffect(() => {
    if (
      props.active?.() === false ||
      sdk.client !== client ||
      project.instance.directory() !== directory ||
      props.sessionID !== sessionID ||
      project.workspace.current() !== workspaceID
    )
      dialog.clear()
  })
  const commandTarget = (command: Command) => (command.kind === "rule" ? command.input.ruleID : command.input.rootID)
  const commandExpiry = (command: Command) => (command.kind === "rule" ? command.input.expiresAt : undefined)
  const options = () => ({
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
    throwOnError: false as const,
  })
  const failed = (error: unknown) => {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : ""
    return `${text("unavailable")}${code ? ` (${code})` : ""}`
  }
  const refresh = async (ruleID = state.ruleID, rulesAfter?: string, rootsAfter?: string) => {
    if (!current() || state.loading || state.busy) return
    const ticket = ++reads
    setState({ loading: true, error: "", confirm: undefined })
    const [candidates, rules] = await Promise.all([
      client.eventWork
        .candidates({ sourceSessionID: sessionID, directory, workspace: workspaceID }, options())
        .catch(() => undefined),
      client.eventWork
        .rules(
          { sourceSessionID: sessionID, directory, workspace: workspaceID, limit: 32, after: rulesAfter },
          options(),
        )
        .catch(() => undefined),
    ])
    if (!current() || ticket !== reads) return
    if (!candidates?.data || !rules?.data || candidates.data.some((item) => item.sourceSessionID !== sessionID)) {
      setState({
        loading: false,
        candidates: undefined,
        rules: undefined,
        roots: undefined,
        error: failed(candidates?.error ?? rules?.error),
      })
      return
    }
    const selected =
      rules.data.items.find((rule) => rule.ruleID === ruleID)?.ruleID ?? rules.data.items[0]?.ruleID ?? ""
    const roots = selected
      ? await client.eventWork
          .roots(
            {
              sourceSessionID: sessionID,
              directory,
              workspace: workspaceID,
              ruleID: selected,
              limit: 32,
              after: rootsAfter,
            },
            options(),
          )
          .catch(() => undefined)
      : undefined
    if (!current() || ticket !== reads) return
    setState({
      rulesAfter,
      rootsAfter,
      nextRuleCursor: rules.data.nextCursor,
      nextRootCursor: roots?.data?.nextCursor ?? null,
      candidates: candidates.data,
      rules: rules.data.items,
      ruleID: selected,
      roots: selected ? roots?.data?.items : [],
      rootID:
        roots?.data?.items.find((root) => root.rootID === state.rootID)?.rootID ?? roots?.data?.items[0]?.rootID ?? "",
      originID: candidates.data.some((item) => item.originID === state.originID)
        ? state.originID
        : (candidates.data[0]?.originID ?? ""),
      loading: false,
      error: selected && !roots?.data ? failed(roots?.error) : "",
    })
  }
  const dispatch = async (command: Command, retry = false) => {
    if (!current() || state.loading || state.busy || (!retry && state.pending)) return
    if (!retained.has(key) && retained.size >= 32) {
      setState("error", text("capacity"))
      return
    }
    const original = unwrap(command)
    retained.set(key, original)
    setState({ busy: true, pending: original, confirm: undefined, error: "", notice: "" })
    const result = await (
      original.kind === "rule"
        ? client.eventWork.ruleControl(original.input, options())
        : client.eventWork.rootControl(original.input, options())
    ).catch(() => undefined)
    if (!current()) return
    setState("busy", false)
    const failure = result?.error
    const data = result?.data
    const matches =
      data &&
      data.requestID === original.input.requestID &&
      data.expectedRevision === original.input.expectedRevision &&
      data.action === original.input.action &&
      (original.kind === "rule"
        ? "rule" in data && data.rule.ruleID === original.input.ruleID
        : "root" in data && data.root.rootID === original.input.rootID)
    if (!matches) {
      // A definitive first refusal can be surfaced. A previous uncertain effect remains owned.
      if (!retry && result?.response && result.response.status >= 400 && result.response.status < 500) {
        retained.delete(key)
        setState("pending", undefined)
      }
      setState("error", matches === false || data ? text("conflict") : failed(failure))
      return
    }
    retained.delete(key)
    setState({ pending: undefined, form: false, notice: text("accepted") })
    await refresh(original.kind === "rule" ? original.input.ruleID : state.ruleID)
  }
  const controlRule = async (action: "enable" | "pause" | "revoke") => {
    const original = selectedRule()
    if (!ready() || !original?.allowedActions.includes(action)) return
    setState({ loading: true, error: "" })
    const response = await client.eventWork
      .rules(
        { sourceSessionID: sessionID, directory, workspace: workspaceID, limit: 32, after: state.rulesAfter },
        options(),
      )
      .catch(() => undefined)
    if (!current()) return
    setState("loading", false)
    const actual = response?.data?.items.find((rule) => rule.ruleID === original.ruleID)
    if (!actual || actual.revision !== original.revision || !actual.allowedActions.includes(action)) {
      setState("error", text("conflict"))
      return
    }
    setState("confirm", {
      kind: "rule",
      input: {
        sourceSessionID: sessionID,
        directory,
        workspace: workspaceID,
        ruleID: actual.ruleID,
        requestID: crypto.randomUUID(),
        expectedRevision: actual.revision,
        action,
      },
    })
  }
  const cancelRoot = async () => {
    const root = selectedRoot()
    if (!ready() || !root?.allowedActions.includes("cancel")) return
    setState({ loading: true, error: "" })
    const response = await client.eventWork
      .roots(
        {
          sourceSessionID: sessionID,
          directory,
          workspace: workspaceID,
          ruleID: root.ruleID,
          limit: 32,
          after: state.rootsAfter,
        },
        options(),
      )
      .catch(() => undefined)
    if (!current()) return
    setState("loading", false)
    const actual = response?.data?.items.find((value) => value.rootID === root.rootID)
    if (!actual || actual.revision !== root.revision || !actual.allowedActions.includes("cancel")) {
      setState("error", text("conflict"))
      return
    }
    setState("confirm", {
      kind: "root",
      input: {
        sourceSessionID: sessionID,
        directory,
        workspace: workspaceID,
        rootID: actual.rootID,
        requestID: crypto.randomUUID(),
        expectedRevision: actual.revision,
        action: "cancel",
      },
    })
  }
  const create = async () => {
    const original = candidate()
    const hours = Number(state.hours)
    if (
      !ready() ||
      !original ||
      !candidateAvailable(original) ||
      !state.instruction.trim() ||
      new TextEncoder().encode(state.instruction).length > 60_000 ||
      !Number.isFinite(hours) ||
      hours <= 0
    )
      return
    setState({ loading: true, error: "" })
    const response = await client.eventWork
      .candidates({ sourceSessionID: sessionID, directory, workspace: workspaceID }, options())
      .catch(() => undefined)
    if (!current()) return
    setState("loading", false)
    const actual = response?.data?.find((value) => value.originID === original.originID)
    if (
      !actual ||
      !candidateAvailable(actual) ||
      actual.sourceSessionID !== sessionID ||
      actual.targetID !== original.targetID ||
      actual.mode !== original.mode ||
      actual.planHash !== original.planHash ||
      actual.profile.id !== original.profile.id ||
      actual.profile.version !== original.profile.version ||
      actual.profile.hash !== original.profile.hash ||
      actual.providerID !== original.providerID ||
      actual.modelID !== original.modelID ||
      JSON.stringify(actual.budget) !== JSON.stringify(original.budget)
    ) {
      setState("error", text("conflict"))
      return
    }
    const expiresAt = Math.min(actual.maxExpiresAt, actual.serverNow + Math.round(hours * 3_600_000))
    if (expiresAt <= actual.serverNow) {
      setState("error", text("conflict"))
      return
    }
    setState("confirm", {
      kind: "rule",
      input: {
        sourceSessionID: sessionID,
        directory,
        workspace: workspaceID,
        ruleID: crypto.randomUUID(),
        requestID: crypto.randomUUID(),
        expectedRevision: 0,
        action: "create",
        originID: actual.originID,
        instruction: state.instruction,
        expiresAt,
      },
    })
  }
  const open = async (root: Root, node: Root["nodes"][number]) => {
    if (!ready() || !props.onOpenSession || !node.sessionAvailable || !node.workID || !node.sessionID || !node.inputID)
      return
    setState({ busy: true, error: "" })
    const read = async () => {
      const result = await client.eventWork
        .session(
          { sourceSessionID: sessionID, directory, workspace: workspaceID, rootID: root.rootID, nodeID: node.nodeID },
          options(),
        )
        .catch(() => undefined)
      const value = result?.data
      if (
        !current() ||
        !value ||
        value.rootID !== root.rootID ||
        value.nodeID !== node.nodeID ||
        value.workID !== node.workID ||
        value.sessionID !== node.sessionID ||
        value.inputID !== node.inputID ||
        value.rootRevision !== root.revision ||
        value.controlRevision !== node.controlRevision ||
        value.version !== 1 ||
        !value.placement.directory ||
        !value.placement.projectID ||
        !value.placement.securityNamespaceID ||
        !value.placement.namespaceBindingHash ||
        (value.placement.workspaceID !== null && typeof value.placement.workspaceID !== "string") ||
        value.expiresAt <= Date.now()
      )
        return undefined
      return value
    }
    const pointer = await read()
    const session = pointer
      ? await sdk.forDirectory(pointer.placement.directory).session
          .get({ sessionID: pointer.sessionID, directory: pointer.placement.directory, workspace: pointer.placement.workspaceID ?? undefined }, options())
          .catch(() => undefined)
      : undefined
    const after = session?.data ? await read() : undefined
    if (!current()) return
    setState("busy", false)
    if (
      !pointer ||
      !after ||
      JSON.stringify(after) !== JSON.stringify(pointer) ||
      !session?.data ||
      session.data.id !== pointer.sessionID ||
      session.data.directory !== pointer.placement.directory ||
      session.data.projectID !== pointer.placement.projectID ||
      (session.data.workspaceID ?? null) !== pointer.placement.workspaceID
    ) {
      setState("error", text("sessionUnavailable"))
      return
    }
    props.onOpenSession(pointer.sessionID)
  }
  const items = (): DialogSelectOption<string>[] => {
    if (state.pending)
      return [
        { title: text("refresh"), value: "refresh", disabled: state.loading || state.busy },
        { title: text("retry"), value: "retry", disabled: state.loading || state.busy },
        { title: text("back"), value: "back" },
      ]
    if (state.confirm)
      return [
        { title: text("confirm"), value: "confirm", disabled: !ready() },
        { title: text("back"), value: "back" },
      ]
    if (state.view === "origins")
      return [
        ...(state.candidates ?? []).map((item) => ({
          title: `${text(`mode.${item.mode}`)} · ${item.targetID} · ${item.originID}`,
          value: `origin:${item.originID}`,
          disabled: !ready(),
        })),
        { title: text("back"), value: "back" },
      ]
    if (state.view === "form")
      return [
        { title: text("chooseOrigin"), value: "origins", disabled: !ready() },
        { title: text("instruction"), value: "instruction", description: state.instruction, disabled: !ready() },
        { title: text("hours"), value: "hours", description: state.hours, disabled: !ready() },
        {
          title: text("preview"),
          value: "create",
          disabled:
            !ready() ||
            !candidate() ||
            !candidateAvailable(candidate()!) ||
            !state.instruction.trim() ||
            new TextEncoder().encode(state.instruction).length > 60_000,
        },
        { title: text("back"), value: "back" },
      ]
    if (state.view === "root")
      return [
        { title: text("refresh"), value: "refresh", disabled: state.loading || state.busy },
        ...(selectedRoot()?.allowedActions.includes("cancel")
          ? [{ title: text("cancel"), value: "cancel", disabled: !ready() }]
          : []),
        ...(selectedRoot()?.nodes ?? [])
          .filter((node) => node.sessionAvailable && !!props.onOpenSession)
          .map((node) => ({
            title: `${text("open")} · ${node.nodeID}`,
            value: `open:${node.nodeID}`,
            disabled: !ready(),
          })),
        { title: text("back"), value: "back" },
      ]
    if (state.view === "rule")
      return [
        { title: text("refresh"), value: "refresh", disabled: state.loading || state.busy },
        ...(selectedRule()?.allowedActions ?? []).map((action) => ({
          title: text(action),
          value: `control:${action}`,
          disabled: !ready(),
        })),
        ...(state.nextRootCursor ? [{ title: text("moreRuns"), value: "moreRuns", disabled: !ready() }] : []),
        ...(state.roots ?? []).map((root) => ({
          title: `${root.rootID} · ${text(`state.${root.state}`)}`,
          value: `root:${root.rootID}`,
          disabled: !ready(),
        })),
        { title: text("back"), value: "back" },
      ]
    return [
      { title: text("refresh"), value: "refresh", disabled: state.loading || state.busy },
      { title: text("new"), value: "new", disabled: !ready() || !state.candidates?.length },
      ...(state.nextRuleCursor ? [{ title: text("moreRules"), value: "moreRules", disabled: !ready() }] : []),
      ...(state.rules ?? []).map((rule) => ({
        title: `${text(`mode.${rule.mode}`)} · ${text(`state.${rule.state}`)} · ${rule.ruleID}`,
        value: `rule:${rule.ruleID}`,
        disabled: !ready(),
      })),
      { title: text("back"), value: "back" },
    ]
  }
  const menuKey = () => `${state.view}:${state.pending ? "pending" : state.confirm ? "confirm" : "normal"}\0`
  const choose = (value: string) => {
    if (value === "back") {
      if (state.pending) {
        dialog.clear()
        return
      }
      if (state.confirm) {
        setState("confirm", undefined)
        return
      }
      if (state.view === "home") {
        dialog.clear()
        return
      }
      setState("view", state.view === "origins" ? "form" : state.view === "root" ? "rule" : "home")
      return
    }
    if (value === "refresh") {
      void refresh()
      return
    }
    if (value === "retry" && state.pending) {
      void dispatch(unwrap(state.pending), true)
      return
    }
    if (value === "confirm" && state.confirm) {
      void dispatch(unwrap(state.confirm))
      return
    }
    if (!ready()) return
    if (value === "moreRules" && state.nextRuleCursor) {
      void refresh(state.ruleID, state.nextRuleCursor)
      return
    }
    if (value === "moreRuns" && state.nextRootCursor) {
      void refresh(state.ruleID, state.rulesAfter, state.nextRootCursor)
      return
    }
    if (value === "new") {
      setState({ view: "form", form: true })
      return
    }
    if (value === "origins") {
      setState("view", "origins")
      return
    }
    if (value === "instruction" || value === "hours") {
      setState("edit", value)
      return
    }
    if (value === "create") {
      void create()
      return
    }
    if (value === "cancel") {
      void cancelRoot()
      return
    }
    if (value.startsWith("origin:") && state.candidates?.some((item) => item.originID === value.slice(7))) {
      setState({ originID: value.slice(7), view: "form", confirm: undefined })
      return
    }
    if (value.startsWith("rule:") && state.rules?.some((rule) => rule.ruleID === value.slice(5))) {
      setState("view", "rule")
      void refresh(value.slice(5), state.rulesAfter)
      return
    }
    if (value.startsWith("root:") && state.roots?.some((root) => root.rootID === value.slice(5))) {
      setState({ rootID: value.slice(5), view: "root" })
      return
    }
    const action = value.slice(8)
    if (value.startsWith("control:") && (action === "enable" || action === "pause" || action === "revoke")) {
      void controlRule(action)
      return
    }
    const root = selectedRoot()
    const node = root?.nodes.find((node) => node.nodeID === value.slice(5))
    if (value.startsWith("open:") && root && node) void open(unwrap(root), node)
  }
  onMount(() => void refresh())
  return (
    <box height={Math.max(8, Math.floor(dimensions().height * 0.8) - 1)}>
      <Show
        when={state.edit}
        keyed
        fallback={
          <DialogSelect
            title={text("title")}
            options={items().map((option) => ({ ...option, value: menuKey() + option.value }))}
            current={menuKey() + (items()[0]?.value ?? "back")}
            skipFilter
            onSelect={(option) => {
              if (option.value.startsWith(menuKey())) choose(option.value.slice(menuKey().length))
            }}
            bindings={[
              { key: "ctrl+up", desc: text("scroll"), group: "Dialog", cmd: () => details?.scrollBy(-1) },
              { key: "ctrl+down", desc: text("scroll"), group: "Dialog", cmd: () => details?.scrollBy(1) },
            ]}
            footer={
              <scrollbox
                ref={(value: ScrollBoxRenderable) => {
                  details = value
                }}
                height={Math.max(4, Math.floor(dimensions().height * 0.4))}
              >
                <box gap={1} paddingLeft={2} paddingRight={2}>
                  <text fg={appearance.theme.textMuted}>{text("description")}</text>
                  <text fg={appearance.theme.textMuted}>{directory}</text>
                  <Show when={state.loading}>
                    <text fg={appearance.theme.textMuted}>{text("loading")}</text>
                  </Show>
                  <Show when={state.error}>
                    <text fg={appearance.theme.error}>{state.error}</text>
                  </Show>
                  <Show when={state.notice}>
                    <text fg={appearance.theme.success}>{state.notice}</text>
                  </Show>
                  <Show when={state.pending}>
                    {(command) => (
                      <>
                        <text fg={appearance.theme.warning}>{text("unknown")}</text>
                        <text>
                          {text(command().input.action)} · {command().input.requestID} · {text("revision")}{" "}
                          {command().input.expectedRevision}
                        </text>
                      </>
                    )}
                  </Show>
                  <Show when={state.confirm}>
                    {(command) => (
                      <>
                        <text>
                          {text("confirm")} · {text(command().input.action)}
                        </text>
                        <text>
                          {commandTarget(command())} · {command().input.requestID} · {text("revision")}{" "}
                          {command().input.expectedRevision}
                        </text>
                        <Show when={commandExpiry(command())}>
                          {(expiry) => (
                            <text>
                              {text("expires")}: {new Date(expiry()).toLocaleString()}
                            </text>
                          )}
                        </Show>
                        <text>{text("controlIntent")}</text>
                      </>
                    )}
                  </Show>
                  <Show when={state.view === "form" && candidate()}>
                    {(item) => (
                      <>
                        <Show when={!candidateAvailable(item())}>
                          <text wrapMode="word">
                            {text(item().reason === "isolation_unavailable" ? "isolationUnavailable" : "unavailable")}
                          </text>
                        </Show>
                        <text>
                          {item().providerID} / {item().modelID} · {item().profile.id}
                        </text>
                        <text>
                          {text("reserve")}: {item().budget.maxTotalTokens} · {text("inputBound")}{" "}
                          {item().budget.maxInputTokens}
                        </text>
                        <text>{text("reserveHint")}</text>
                        <text>
                          {text("limits")}: {item().budget.maxProviderDispatches} / {item().budget.maxToolCalls} /{" "}
                          {item().budget.maxChildren} / {item().budget.maxDurationMs} ms
                        </text>
                        <Show when={item().plan}>
                          {(plan) => (
                            <>
                              <text>
                                {plan().id} · {item().planHash}
                              </text>
                              <text>
                                {text("concurrency")} {plan().maxConcurrent} · {text("serialProvider")}
                              </text>
                              <For each={plan().nodes}>
                                {(node) => (
                                  <>
                                    <text>
                                      {node.id} · {node.agentID}
                                    </text>
                                    <text>
                                      {text("dependencies")}: {node.dependencies.join(", ") || "—"}
                                    </text>
                                    <text>
                                      {text("reserve")}: {node.budget.maxTotalTokens}
                                    </text>
                                    <text>
                                      {text("tools")}: {node.toolIDs.join(", ") || "—"}
                                    </text>
                                    <text>
                                      {node.requiresWriteIsolation ? text("writeIsolation") : text("readOnly")}
                                    </text>
                                  </>
                                )}
                              </For>
                            </>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={state.view !== "form" && selectedRule()}>
                    {(rule) => (
                      <>
                        <text>
                          {text(`mode.${rule().mode}`)} · {text(`state.${rule().state}`)} · {rule().originID}
                        </text>
                        <text>
                          {text("revision")} {rule().revision} · {text("epoch")} {rule().epoch}
                        </text>
                        <text>
                          {text("expires")}: {new Date(rule().expiresAt).toLocaleString()}
                        </text>
                      </>
                    )}
                  </Show>
                  <Show when={state.rules?.length === 0 && !state.loading}>
                    <text>{text("empty")}</text>
                  </Show>
                  <Show when={state.roots?.length === 0 && state.view === "rule" && !state.loading}>
                    <text>{text("noRuns")}</text>
                  </Show>
                  <Show when={state.view === "root" && selectedRoot()}>
                    {(root) => (
                      <>
                        <text>
                          {root().planID ?? text(`mode.${root().mode}`)} · {root().planHash}
                        </text>
                        <text>
                          {text(`state.${root().state}`)} · {text(`control.${root().controlState}`)}
                        </text>
                        <text>
                          {text("reserve")}: {root().reservedTokens} / {root().budget.maxTotalTokens}
                        </text>
                        <text>{text("reserveHint")}</text>
                        <text>
                          {text("usage")}:{" "}
                          {root().actualUsage
                            ? `${root().actualUsage!.inputTokens} / ${root().actualUsage!.completionTokens}`
                            : text("notRecorded")}
                        </text>
                        <text>
                          {text("concurrency")} {root().schedulingConcurrency} · {text("serialProvider")}
                        </text>
                        <Show when={root().reason}>
                          <text>{root().reason}</text>
                        </Show>
                        <For each={root().nodes}>
                          {(node) => (
                            <>
                              <text>
                                {node.nodeID} · {node.agentID} · {text(`state.${node.state}`)}
                              </text>
                              <text>
                                {text("dependencies")}: {node.dependencies.join(", ") || "—"}
                              </text>
                              <text>
                                {text("reserve")}: {node.reservedTokens}
                              </text>
                              <text>
                                {text("usage")}:{" "}
                                {node.actualUsage
                                  ? `${node.actualUsage.inputTokens} / ${node.actualUsage.completionTokens}`
                                  : text("notRecorded")}
                              </text>
                              <Show when={node.reason}>
                                <text>{node.reason}</text>
                              </Show>
                              <Show when={node.resultHash}>
                                <text>
                                  {text("result")}: {node.resultHash}
                                </text>
                              </Show>
                              <Show when={node.terminalHash}>
                                <text>
                                  {text("terminalProof")}: {node.terminalHash}
                                </text>
                              </Show>
                            </>
                          )}
                        </For>
                      </>
                    )}
                  </Show>
                </box>
              </scrollbox>
            }
          />
        }
      >
        {(field) => (
          <DialogPrompt
            title={text(field)}
            value={state[field]}
            onCancel={() => setState("edit", undefined)}
            onConfirm={(value) => {
              setState(field, value)
              setState({ edit: undefined, confirm: undefined })
            }}
          />
        )}
      </Show>
    </box>
  )
}
