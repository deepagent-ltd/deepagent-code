import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk"

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
  workspaceID?: string
  active?: () => boolean
  onOpenSession?: (id: string, directory: string) => void
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const client = sdk.client
  const directory = sdk.directory
  const scope = sdk.scope
  const sessionID = props.sessionID
  const workspaceID = props.workspaceID
  const key = JSON.stringify([scope, directory, workspaceID ?? null, sessionID])
  const retained = requests.get(client) ?? new Map<string, Command>()
  requests.set(client, retained)
  const [state, setState] = createStore({
    alive: true,
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
  const text = (name: string) => language.t(`eventWork.${name}` as Parameters<typeof language.t>[0])
  const current = () =>
    state.alive &&
    props.active?.() !== false &&
    sdk.client === client &&
    sdk.scope === scope &&
    sdk.directory === directory &&
    props.sessionID === sessionID &&
    props.workspaceID === workspaceID
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
      sdk.scope !== scope ||
      sdk.directory !== directory ||
      props.sessionID !== sessionID ||
      props.workspaceID !== workspaceID
    )
      dialog.close()
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
      ? await sdk.createClient({ directory: pointer.placement.directory }).session
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
    props.onOpenSession(pointer.sessionID, pointer.placement.directory)
  }
  onMount(() => void refresh())
  return (
    <Dialog title={text("title")}>
      <div class="flex flex-col gap-4 p-5 max-h-[80vh] overflow-y-auto min-w-0">
        <p class="text-13-regular text-text-weak">{text("description")}</p>
        <p class="break-all text-text-weak">{directory}</p>
        <div class="flex gap-2 flex-wrap">
          <Button disabled={!current() || state.loading || state.busy} onClick={() => void refresh()}>
            {text("refresh")}
          </Button>
          <Button
            disabled={!ready() || !state.candidates?.length}
            onClick={() => setState({ form: true, confirm: undefined })}
          >
            {text("new")}
          </Button>
        </div>
        <Show when={state.loading}>
          <p role="status">{text("loading")}</p>
        </Show>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <Show when={state.notice}>
          <p role="status">{state.notice}</p>
        </Show>
        <Show when={state.pending}>
          {(command) => (
            <section class="border border-border-weak-base rounded-lg p-3 flex flex-col gap-2">
              <p role="status">{text("unknown")}</p>
              <p class="break-all">
                {text(command().input.action)} · {command().input.requestID} · {text("revision")}{" "}
                {command().input.expectedRevision}
              </p>
              <Button
                disabled={!current() || state.busy || state.loading}
                onClick={() => void dispatch(unwrap(command()), true)}
              >
                {text("retry")}
              </Button>
            </section>
          )}
        </Show>
        <Show when={state.confirm}>
          {(command) => (
            <section class="border border-border-weak-base rounded-lg p-3 flex flex-col gap-2">
              <p>
                {text("confirm")} · {text(command().input.action)}
              </p>
              <p class="break-all">
                {commandTarget(command())} · {command().input.requestID} · {text("revision")}{" "}
                {command().input.expectedRevision}
              </p>
              <Show when={commandExpiry(command())}>
                {(expiry) => (
                  <p>
                    {text("expires")}: {new Date(expiry()).toLocaleString()}
                  </p>
                )}
              </Show>
              <p>{text("controlIntent")}</p>
              <Button disabled={!ready()} onClick={() => void dispatch(unwrap(command()))}>
                {text("confirm")}
              </Button>
              <Button variant="ghost" disabled={state.busy} onClick={() => setState("confirm", undefined)}>
                {text("back")}
              </Button>
            </section>
          )}
        </Show>
        <Show when={state.form}>
          <section class="border border-border-weak-base rounded-lg p-3 flex flex-col gap-3">
            <label class="flex flex-col gap-1">
              {text("chooseOrigin")}
              <select
                aria-label={text("chooseOrigin")}
                value={state.originID}
                disabled={!ready()}
                onChange={(event) => setState({ originID: event.currentTarget.value, confirm: undefined })}
              >
                <For each={state.candidates}>
                  {(item) => (
                    <option value={item.originID}>
                      {text(`mode.${item.mode}`)} · {item.targetID} · {item.originID}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <Show when={candidate()}>
              {(item) => (
                <>
                  <Show when={!candidateAvailable(item())}>
                    <p role="status">
                      {text(item().reason === "isolation_unavailable" ? "isolationUnavailable" : "unavailable")}
                    </p>
                  </Show>
                  <p>
                    {item().providerID} / {item().modelID} · {item().profile.id}
                  </p>
                  <p>
                    {text("reserve")} {item().budget.maxTotalTokens} · {text("inputBound")}{" "}
                    {item().budget.maxInputTokens}
                  </p>
                  <p>{text("reserveHint")}</p>
                  <p>
                    {text("limits")}: {item().budget.maxProviderDispatches} / {item().budget.maxToolCalls} /{" "}
                    {item().budget.maxChildren} / {item().budget.maxDurationMs} ms
                  </p>
                  <Show when={item().plan}>
                    {(plan) => (
                      <div class="flex flex-col gap-2">
                        <p class="break-all">
                          {plan().id} · {item().planHash}
                        </p>
                        <p>
                          {text("concurrency")} {plan().maxConcurrent} · {text("serialProvider")}
                        </p>
                        <For each={plan().nodes}>
                          {(node) => (
                            <div class="border border-border-weak-base rounded-lg p-2">
                              <p class="break-all">
                                {node.id} · {node.agentID}
                              </p>
                              <p class="break-all">
                                {text("dependencies")}: {node.dependencies.join(", ") || "—"}
                              </p>
                              <p>
                                {text("reserve")}: {node.budget.maxTotalTokens}
                              </p>
                              <p class="break-all">
                                {text("tools")}: {node.toolIDs.join(", ") || "—"}
                              </p>
                              <p>{node.requiresWriteIsolation ? text("writeIsolation") : text("readOnly")}</p>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <label class="flex flex-col gap-1">
              {text("instruction")}
              <textarea
                rows={4}
                aria-label={text("instruction")}
                value={state.instruction}
                disabled={!ready()}
                onInput={(event) => setState({ instruction: event.currentTarget.value, confirm: undefined })}
              />
            </label>
            <label>
              {text("hours")}
              <input
                type="number"
                min="0.01"
                step="0.01"
                aria-label={text("hours")}
                value={state.hours}
                disabled={!ready()}
                onInput={(event) => setState({ hours: event.currentTarget.value, confirm: undefined })}
              />
            </label>
            <Button
              disabled={
                !ready() ||
                !candidate() ||
                !candidateAvailable(candidate()!) ||
                !state.instruction.trim() ||
                new TextEncoder().encode(state.instruction).length > 60_000
              }
              onClick={() => void create()}
            >
              {text("preview")}
            </Button>
            <Button variant="ghost" disabled={state.busy} onClick={() => setState({ form: false, confirm: undefined })}>
              {text("back")}
            </Button>
          </section>
        </Show>
        <Show when={state.rules?.length === 0 && !state.loading}>
          <p>{text("empty")}</p>
        </Show>
        <For each={state.rules}>
          {(rule) => (
            <Button
              variant={state.ruleID === rule.ruleID ? "secondary" : "ghost"}
              disabled={!ready()}
              onClick={() => void refresh(rule.ruleID, state.rulesAfter)}
            >
              {text(`mode.${rule.mode}`)} · {text(`state.${rule.state}`)} · {rule.ruleID}
            </Button>
          )}
        </For>
        <Show when={state.nextRuleCursor}>
          <Button disabled={!ready()} onClick={() => void refresh(state.ruleID, state.nextRuleCursor ?? undefined)}>
            {text("moreRules")}
          </Button>
        </Show>
        <Show when={selectedRule()}>
          {(rule) => (
            <section class="flex flex-col gap-2">
              <p class="break-all">
                {rule().originID} · {text("revision")} {rule().revision} · {text("epoch")} {rule().epoch}
              </p>
              <p>
                {text("expires")}: {new Date(rule().expiresAt).toLocaleString()}
              </p>
              <div class="flex gap-2 flex-wrap">
                <For each={rule().allowedActions}>
                  {(action) => (
                    <Button disabled={!ready()} onClick={() => void controlRule(action)}>
                      {text(action)}
                    </Button>
                  )}
                </For>
              </div>
            </section>
          )}
        </Show>
        <Show when={state.roots?.length === 0 && !!selectedRule() && !state.loading}>
          <p>{text("noRuns")}</p>
        </Show>
        <For each={state.roots}>
          {(root) => (
            <Button
              variant={state.rootID === root.rootID ? "secondary" : "ghost"}
              disabled={!ready()}
              onClick={() => setState("rootID", root.rootID)}
            >
              {root.rootID} · {text(`state.${root.state}`)} · {text(`control.${root.controlState}`)}
            </Button>
          )}
        </For>
        <Show when={state.nextRootCursor}>
          <Button
            disabled={!ready()}
            onClick={() => void refresh(state.ruleID, state.rulesAfter, state.nextRootCursor ?? undefined)}
          >
            {text("moreRuns")}
          </Button>
        </Show>
        <Show when={selectedRoot()}>
          {(root) => (
            <section class="flex flex-col gap-3">
              <p class="break-all">
                {root().planID ?? text(`mode.${root().mode}`)} · {root().planHash}
              </p>
              <p>
                {text("reserve")}: {root().reservedTokens} / {root().budget.maxTotalTokens}
              </p>
              <p>{text("reserveHint")}</p>
              <p>
                {text("usage")}:{" "}
                {root().actualUsage
                  ? `${root().actualUsage!.inputTokens} / ${root().actualUsage!.completionTokens}`
                  : text("notRecorded")}
              </p>
              <p>
                {text("concurrency")} {root().schedulingConcurrency} · {text("serialProvider")}
              </p>
              <Show when={root().reason}>
                <p class="break-all">{root().reason}</p>
              </Show>
              <Show when={root().allowedActions.includes("cancel")}>
                <Button disabled={!ready()} onClick={() => void cancelRoot()}>
                  {text("cancel")}
                </Button>
              </Show>
              <For each={root().nodes}>
                {(node) => (
                  <article class="border border-border-weak-base rounded-lg p-3 flex flex-col gap-2 min-w-0">
                    <p class="break-all">
                      {node.nodeID} · {node.agentID} · {text(`state.${node.state}`)}
                    </p>
                    <p class="break-all">
                      {text("dependencies")}: {node.dependencies.join(", ") || "—"}
                    </p>
                    <p>
                      {text("reserve")}: {node.reservedTokens}
                    </p>
                    <p>
                      {text("usage")}:{" "}
                      {node.actualUsage
                        ? `${node.actualUsage.inputTokens} / ${node.actualUsage.completionTokens}`
                        : text("notRecorded")}
                    </p>
                    <Show when={node.reason}>
                      <p class="break-all">{node.reason}</p>
                    </Show>
                    <Show when={node.resultHash}>
                      <p class="break-all">
                        {text("result")}: {node.resultHash}
                      </p>
                    </Show>
                    <Show when={node.terminalHash}>
                      <p class="break-all">
                        {text("terminalProof")}: {node.terminalHash}
                      </p>
                    </Show>
                    <Show when={node.sessionAvailable && props.onOpenSession}>
                      <Button disabled={!ready()} onClick={() => void open(unwrap(root()), node)}>
                        {text("open")}
                      </Button>
                    </Show>
                  </article>
                )}
              </For>
            </section>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
