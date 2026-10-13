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
import { DialogSelect } from "../ui/dialog-select"

type API = DeepAgentCodeClient["eventValidation"]
type Rule = NonNullable<Awaited<ReturnType<API["rules"]>>["data"]>[number]
type Run = NonNullable<Awaited<ReturnType<API["runs"]>>["data"]>[number]
type Control = Parameters<API["control"]>[0]
type Candidates = NonNullable<Awaited<ReturnType<API["candidates"]>>["data"]>
type Captured = NonNullable<Awaited<ReturnType<API["capture"]>>["data"]>
type Configure = Parameters<API["configureCaptured"]>[0]
type InvestigationAPI = DeepAgentCodeClient["eventInvestigation"]
type InvestigationCandidates = NonNullable<Awaited<ReturnType<InvestigationAPI["candidates"]>>["data"]>
type InvestigationCaptured = NonNullable<Awaited<ReturnType<InvestigationAPI["capture"]>>["data"]>
type InvestigationControl = Parameters<InvestigationAPI["control"]>[0]
type InvestigationReport = NonNullable<Awaited<ReturnType<InvestigationAPI["reports"]>>["data"]>[number]
type Command =
  | { kind: "control"; input: Control }
  | { kind: "configure"; input: Configure }
  | { kind: "investigation"; input: InvestigationControl; preview?: InvestigationCaptured["preview"] }
// Keep unknown command identity for explicit retry, never background execution.
const requests = new WeakMap<object, Map<string, Command>>()

export function createEventValidationOwner() {
  const [owner, setOwner] = createStore({ alive: true })
  onCleanup(() => setOwner("alive", false))
  return () => owner.alive
}

export function DialogEventValidation(props: {
  sessionID: string
  active?: () => boolean
  onOpenSession?: (sessionID: string) => void
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
  const workspace = project.workspace.current()
  const sessionID = props.sessionID
  const key = JSON.stringify([directory, workspace, sessionID])
  const retained = requests.get(client) ?? new Map<string, Command>()
  requests.set(client, retained)
  const [state, setState] = createStore({
    investigation: undefined as InvestigationCandidates | undefined,
    investigationCaptured: undefined as InvestigationCaptured | undefined,
    investigationTarget: "",
    investigationHours: "1",
    investigationLoading: false,
    investigationError: "",
    reports: [] as InvestigationReport[],
    reportsError: "",
    checkedAt: Date.now(),
    form: false,
    targets: [] as Candidates["targets"],
    targetID: "",
    recipeID: "",
    parameters: {} as Record<string, string>,
    watch: "",
    maxRuns: "10",
    hours: "1",
    captured: undefined as Captured | undefined,
    rules: [] as Rule[],
    runs: [] as Run[],
    runsError: "",
    selected: "",
    compared: "",
    loading: false,
    busy: false,
    error: "",
    notice: "",
    pending: retained.get(key),
    confirm: undefined as Control["action"] | undefined,
    investigationView: false,
    investigationPick: false,
    report: "",
    detail: false,
    edit: undefined as "watch" | "maxRuns" | "hours" | "investigationHours" | undefined,
    pick: "" as "" | "target" | "recipe" | `parameter:${string}`,
  })
  let disposed = false
  let reads = 0
  let investigationReads = 0
  const text = (name: string) => i18n.t(`tui.eventValidation.${name}` as Parameters<typeof i18n.t>[0])
  const current = () =>
    !disposed &&
    props.active?.() !== false &&
    sdk.client === client &&
    project.instance.directory() === directory &&
    project.workspace.current() === workspace &&
    props.sessionID === sessionID
  const selected = () => state.rules.find((rule) => rule.ruleID === state.selected)
  const recipe = () =>
    state.targets
      .find((target) => target.targetID === state.targetID)
      ?.recipes.find((recipe) => recipe.logicalID === state.recipeID)
  const chooseRecipe = (targetID: string, recipeID: string) => {
    const chosen = state.targets
      .find((target) => target.targetID === targetID)
      ?.recipes.find((recipe) => recipe.logicalID === recipeID)
    setState({ targetID, recipeID, watch: chosen?.inputs.join("\n") ?? "", parameters: {}, captured: undefined })
    for (const parameter of chosen?.parameters ?? []) setState("parameters", parameter.key, parameter.choices[0] ?? "")
  }
  const actionable = () => !state.loading && !state.busy && !state.pending && !!selected()
  onCleanup(() => {
    disposed = true
    reads++
    investigationReads++
  })
  createEffect(() => {
    if (
      props.active?.() === false ||
      sdk.client !== client ||
      project.instance.directory() !== directory ||
      project.workspace.current() !== workspace ||
      props.sessionID !== sessionID
    ) {
      reads++
      investigationReads++
      setState({
        investigation: undefined,
        investigationCaptured: undefined,
        reports: [],
        rules: [],
        runs: [],
        runsError: "",
        confirm: undefined,
        captured: undefined,
        targets: [],
        form: false,
      })
      dialog.clear()
    }
  })
  const investigationReady = () => current() && actionable() && !state.investigationLoading && !!state.investigation
  const ruleExpired = () => !!selected() && selected()!.configuration.expiresAt <= state.checkedAt
  const controlReady = (action: Control["action"]) =>
    current() && actionable() && ((action !== "enable" && action !== "verify") || !ruleExpired())
  const permitControl = (action: Control["action"]) => {
    if (!current() || !actionable()) return false
    const now = Date.now()
    setState("checkedAt", now)
    if ((action === "enable" || action === "verify") && selected()!.configuration.expiresAt <= now) {
      setState({ error: text("reason.expired"), confirm: undefined })
      return false
    }
    return true
  }
  const investigationExpired = () =>
    ruleExpired() || (!!state.investigation && state.investigation.maxExpiresAt <= state.checkedAt)
  const previewExpired = () =>
    !!state.investigationCaptured &&
    (state.investigationCaptured.expiresAt <= state.checkedAt ||
      state.investigationCaptured.preview.grantExpiresAt <= state.checkedAt)
  const investigationFresh = () => investigationReady() && !investigationExpired()
  const investigationState = () => {
    if (state.pending?.input.ruleID === state.selected) return text("unknown")
    const authority = selected()?.investigationAuthority
    if (!authority || authority.state === "disabled") return text("investigation.off")
    return text(
      ruleExpired() || authority.grant.expiresAt <= state.checkedAt ? "investigation.expired" : "investigation.on",
    )
  }
  const targetSummary = (target: InvestigationCandidates["targets"][number]) =>
    [
      `${text("investigation.target")}: ${target.targetID} · ${target.profile.id} v${target.profile.version}`,
      `${text("investigation.read")}: ${target.read.join(", ") || "—"}`,
      `${text("investigation.provider")}:\n${target.provider.providerID}/${target.provider.modelID} · ${target.provider.routeID}`,
      `${text("investigation.budgetTokens")}:\n ${target.budget.maxTotalTokens} / ${target.budget.maxInputTokens} / ${target.budget.maxCompletionTokens}`,
      `${text("investigation.budgetCalls")}:\n ${target.budget.maxProviderDispatches} / ${target.budget.maxToolCalls} / ${target.budget.maxChildren}`,
      `${text("investigation.budgetTime")}:\n ${target.budget.maxDurationMs} / ${target.budget.hourTokensMax} / ${target.budget.hourWindowMinutes} · ${text("timeout")}: ${target.durationMs}`,
    ].join("\n")
  const readInvestigation = async (ruleID = state.selected) => {
    if (!current() || !ruleID) return
    const generation = ++investigationReads
    setState("checkedAt", Date.now())
    setState({
      investigation: undefined,
      investigationCaptured: undefined,
      investigationLoading: true,
      investigationError: "",
      reports: [],
      reportsError: "",
    })
    const results = await Promise.allSettled([
      client.eventInvestigation.candidates({ ruleID }, { throwOnError: false }),
      client.eventInvestigation.reports({ ruleID }, { throwOnError: false }),
    ])
    if (!current() || generation !== investigationReads || state.selected !== ruleID) return
    setState("checkedAt", Date.now())
    const candidates = results[0]
    if (
      candidates.status === "fulfilled" &&
      candidates.value.data?.ruleID === ruleID &&
      Array.isArray(candidates.value.data.targets)
    ) {
      const data = candidates.value.data
      setState({
        investigation: data,
        investigationTarget: data.targets.some((target) => target.targetID === state.investigationTarget)
          ? state.investigationTarget
          : (data.targets[0]?.targetID ?? ""),
      })
    } else {
      setState("investigationError", text("investigation.unavailable"))
    }
    const reports = results[1]
    if (
      reports.status === "fulfilled" &&
      Array.isArray(reports.value.data) &&
      reports.value.data.every(
        (report) => typeof report.receiptID === "string" && typeof report.sessionID === "string" && !!report.work,
      )
    )
      setState("reports", reports.value.data.slice(0, 32))
    else setState("reportsError", text("investigation.reportsUnavailable"))
    setState("investigationLoading", false)
  }
  const captureInvestigation = async () => {
    setState("checkedAt", Date.now())
    if (investigationExpired()) {
      setState("investigationError", text("reason.expired"))
      return
    }
    const candidates = state.investigation
    if (
      !investigationFresh() ||
      !candidates ||
      !candidates.targets.some((target) => target.targetID === state.investigationTarget)
    )
      return
    const duration = Number(state.investigationHours) * 3_600_000
    const expiresAt = Math.min(candidates.maxExpiresAt, Date.now() + duration)
    if (
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      setState("investigationError", text("invalid"))
      return
    }
    const targetID = state.investigationTarget
    const generation = investigationReads
    setState({ busy: true, investigationError: "", investigationCaptured: undefined })
    try {
      const response = await client.eventInvestigation.capture(
        { ruleID: candidates.ruleID, targetID, expiresAt },
        { throwOnError: false },
      )
      if (!current() || generation !== investigationReads || state.selected !== candidates.ruleID) return
      const captured = response.data
      if (
        !captured ||
        captured.expiresAt <= Date.now() ||
        captured.preview.ruleID !== candidates.ruleID ||
        captured.preview.ruleRevision !== candidates.ruleRevision ||
        captured.preview.epoch !== candidates.epoch ||
        captured.preview.operatorRevision !== candidates.operatorRevision ||
        captured.preview.target.targetID !== targetID ||
        captured.preview.grantExpiresAt !== expiresAt ||
        captured.preview.target.profile.id !== "event_investigate_v1"
      ) {
        setState(
          "investigationError",
          `${text("investigation.unavailable")}${response.error && typeof response.error === "object" && "code" in response.error ? ` · ${response.error.code}` : ""}`,
        )
        return
      }
      setState({ investigationCaptured: captured, checkedAt: Date.now() })
    } catch {
      if (current() && generation === investigationReads)
        setState("investigationError", text("investigation.unavailable"))
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const controlInvestigation = (operation: InvestigationControl["operation"]) => {
    setState("checkedAt", Date.now())
    if (operation === "enable" && (investigationExpired() || previewExpired())) {
      setState("investigationError", text("reason.expired"))
      return
    }
    if (!investigationReady()) return
    const candidates = state.investigation
    const captured = state.investigationCaptured
    if (!candidates) return
    if (
      operation === "enable" &&
      (!captured || captured.expiresAt <= Date.now() || captured.preview.grantExpiresAt <= Date.now())
    ) {
      setState({ investigationCaptured: undefined, investigationError: text("conflict") })
      return
    }
    void dispatch({
      kind: "investigation",
      preview: operation === "enable" ? captured?.preview : undefined,
      input: {
        ruleID: candidates.ruleID,
        requestID: crypto.randomUUID(),
        operation,
        expectedEpoch: operation === "enable" ? captured!.preview.epoch : candidates.epoch,
        expectedOperatorRevision:
          operation === "enable" ? captured!.preview.operatorRevision : candidates.operatorRevision,
        targetID: operation === "enable" ? captured!.preview.target.targetID : null,
        expiresAt: operation === "enable" ? captured!.preview.grantExpiresAt : null,
        captureID: operation === "enable" ? captured!.captureID : null,
      },
    })
  }
  const openReport = (report: InvestigationReport) => {
    if (
      current() &&
      !state.busy &&
      state.reports.some((item) => item.receiptID === report.receiptID && item.sessionID === report.sessionID)
    )
      props.onOpenSession?.(report.sessionID)
  }
  const refresh = async (id = state.selected) => {
    if (!current()) return
    const generation = ++reads
    setState("checkedAt", Date.now())
    investigationReads++
    setState({
      investigation: undefined,
      investigationCaptured: undefined,
      reports: [],
      reportsError: "",
      investigationError: "",
      investigationLoading: false,
      runs: [],
      runsError: "",
      loading: true,
      error: "",
      confirm: undefined,
    })
    const response = await client.eventValidation.rules({ throwOnError: false }).catch(() => undefined)
    if (!current() || generation !== reads) return
    if (!Array.isArray(response?.data)) {
      setState({
        rules: [],
        selected: "",
        compared: "",
        investigationView: false,
        investigationPick: false,
        report: "",
        detail: false,
        error: text("unavailable"),
        loading: false,
      })
      return
    }
    setState("checkedAt", Date.now())
    const chosen = response.data.some((rule) => rule.ruleID === id) ? id : (response.data[0]?.ruleID ?? "")
    setState({ rules: response.data, selected: chosen, compared: "" })
    if (!chosen) {
      setState({ investigationView: false, investigationPick: false, report: "", detail: false, loading: false })
      return
    }
    void readInvestigation(chosen)
    const history = await client.eventValidation
      .runs({ ruleID: chosen }, { throwOnError: false })
      .catch(() => undefined)
    if (!current() || generation !== reads || state.selected !== chosen) return
    // History is a separate read; its refusal cannot retract a successful Rule or report read.
    setState({
      runs: Array.isArray(history?.data) ? history.data : [],
      runsError: Array.isArray(history?.data) ? "" : `${text("history")}: ${text("unavailable")}`,
      loading: false,
    })
  }
  const dispatch = async (request: Command) => {
    if (!current() || state.busy) return
    if (!retained.has(key) && retained.size >= 32) {
      setState("error", text("capacity"))
      return
    }
    const retrying = retained.has(key)
    const snapshot = structuredClone(unwrap(request))
    retained.set(key, snapshot)
    setState({ pending: snapshot, busy: true, error: "", notice: "", confirm: undefined })
    try {
      const response =
        request.kind === "control"
          ? await client.eventValidation.control(request.input, { throwOnError: false })
          : request.kind === "configure"
            ? await client.eventValidation.configureCaptured(request.input, { throwOnError: false })
            : await client.eventInvestigation.control(request.input, { throwOnError: false })
      if (!current()) return
      if (response.error) {
        const status = response.response?.status
        if (status && status >= 400 && status < 500) {
          // A retry rejection cannot resolve the earlier unknown dispatch.
          if (!retrying) {
            retained.delete(key)
            setState("pending", undefined)
          }
          await refresh(request.input.ruleID)
          if (current()) setState("error", text(status === 409 ? "conflict" : "unavailable"))
          return
        }
        setState("error", text("unknown"))
        return
      }
      if (
        !response.data ||
        response.data.receipt.ruleID !== request.input.ruleID ||
        response.data.receipt.requestID !== request.input.requestID ||
        response.data.receipt.action !==
          (request.kind === "control" ? request.input.action : request.kind === "configure" ? "create" : "update") ||
        (request.kind === "investigation" &&
          (!response.data.receipt.investigation ||
            response.data.receipt.investigation.operation !== request.input.operation ||
            response.data.receipt.investigation.epoch !== request.input.expectedEpoch + 1))
      ) {
        setState("error", text("unknown"))
        return
      }
      retained.delete(key)
      if (request.kind === "investigation") {
        setState({ pending: undefined, investigationCaptured: undefined, notice: text("investigation.accepted") })
        await refresh(request.input.ruleID)
        return
      }
      setState({
        pending: undefined,
        captured: undefined,
        form: false,
        detail: request.kind === "configure" || state.detail,
        notice: text(request.kind === "configure" ? "saved" : "accepted"),
      })
      await refresh(request.input.ruleID)
    } catch {
      if (current()) setState("error", text("unknown"))
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const control = (action: Control["action"]) => {
    const rule = selected()
    if (!rule || !permitControl(action)) return
    void dispatch({
      kind: "control",
      input: { ruleID: rule.ruleID, expectedRevision: rule.revision, requestID: crypto.randomUUID(), action },
    })
  }
  const retry = () => {
    const pending = state.pending
    if (pending)
      void dispatch(
        pending.kind === "control"
          ? { kind: "control", input: { ...pending.input } }
          : pending.kind === "configure"
            ? { kind: "configure", input: { ...pending.input } }
            : { kind: "investigation", input: { ...pending.input }, preview: pending.preview },
      )
  }
  const begin = async () => {
    if (!current() || state.busy || state.pending) return
    setState({ busy: true, error: "", notice: "", captured: undefined, targets: [], form: true })
    try {
      const response = await client.eventValidation.candidates({ sessionID }, { throwOnError: true })
      if (!current()) return
      setState("targets", response.data?.targets ?? [])
      const first = state.targets[0]
      chooseRecipe(first?.targetID ?? "", first?.recipes[0]?.logicalID ?? "")
    } catch {
      if (current()) setState("error", text("unavailable"))
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const capture = async () => {
    const selectedRecipe = recipe()
    if (!current() || state.busy || state.pending || !selectedRecipe) return
    const maxRuns = Number(state.maxRuns)
    const duration = Number(state.hours) * 3_600_000
    const expiresAt = Date.now() + duration
    if (
      !Number.isSafeInteger(maxRuns) ||
      maxRuns < 1 ||
      maxRuns > 10_000 ||
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      !Number.isSafeInteger(expiresAt)
    ) {
      setState("error", text("invalid"))
      return
    }
    setState({ busy: true, error: "", captured: undefined })
    try {
      const response = await client.eventValidation.capture(
        {
          sessionID,
          targetID: state.targetID,
          recipeID: selectedRecipe.logicalID,
          parameters: selectedRecipe.parameters.map((parameter) => ({
            key: parameter.key,
            value: state.parameters[parameter.key] ?? "",
          })),
          watch: state.watch
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
          maxRuns,
          expiresAt,
        },
        { throwOnError: true },
      )
      if (!current()) return
      if (!response.data || response.data.expiresAt <= Date.now()) throw new Error("expired")
      setState("captured", response.data)
    } catch {
      if (current()) setState("error", text("invalid"))
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const save = () => {
    if (!current() || state.busy || state.pending || !state.captured) return
    if (state.captured.expiresAt <= Date.now()) {
      setState({ captured: undefined, error: text("conflict") })
      return
    }
    void dispatch({
      kind: "configure",
      input: {
        captureID: state.captured.captureID,
        ruleID: crypto.randomUUID(),
        requestID: crypto.randomUUID(),
        expectedRevision: 0,
      },
    })
  }
  onMount(() => {
    void refresh()
  })
  // A stable native node keeps the dialog's state owner across editor/menu swaps.
  return (
    <box height={Math.max(8, Math.floor(dimensions().height * 0.75) - 1)}>
      <Show
        when={state.edit}
        keyed
        fallback={
          <DialogSelect
            title={text("title")}
            skipFilter
            placeholder={text("navigation")}
            bindings={[
              { key: "ctrl+up", desc: text("navigation"), group: "Dialog", cmd: () => details?.scrollBy(-1) },
              { key: "ctrl+down", desc: text("navigation"), group: "Dialog", cmd: () => details?.scrollBy(1) },
            ]}
            current={
              state.investigationView
                ? state.investigationPick
                  ? `investigation-target:${state.investigationTarget}`
                  : state.pending
                    ? "retry"
                    : state.report
                      ? "investigation-open"
                      : state.investigationCaptured
                        ? "investigation-enable"
                        : "investigation-back"
                : state.confirm
                  ? "confirm"
                  : state.form
                    ? state.pick === "target"
                      ? `target:${state.targetID}`
                      : state.pick === "recipe"
                        ? `recipe:${state.recipeID}`
                        : state.pick.startsWith("parameter:")
                          ? `choice:${state.parameters[state.pick.slice(10)] ?? ""}`
                          : state.pending
                            ? "retry"
                            : state.captured
                              ? "save"
                              : "pick-target"
                    : state.pending
                      ? "refresh"
                      : state.detail
                        ? "back"
                        : "refresh"
            }
            locked={state.busy || state.loading}
            footer={
              <scrollbox
                ref={(value) => (details = value)}
                width={Math.max(1, Math.min(60, dimensions().width - 2) - 6)}
                height={Math.max(3, Math.floor(dimensions().height / 4))}
              >
                <box gap={1}>
                  <text fg={appearance.theme.text} wrapMode="word">
                    {text("description")}
                  </text>
                  <text fg={appearance.theme.text} wrapMode="word">
                    {directory}
                  </text>
                  <Show when={state.pending} keyed>
                    {(pending) => (
                      <text fg={appearance.theme.text} wrapMode="word">
                        {text(state.busy ? "sending" : "unknown")}
                        {"\n"}
                        {text("confirmAction")}:{" "}
                        {text(
                          pending.kind === "control"
                            ? pending.input.action
                            : pending.kind === "configure"
                              ? "save"
                              : `investigation.${pending.input.operation}`,
                        )}
                        {"\n"}
                        {directory} · {pending.input.ruleID} ·{" "}
                        {pending.kind === "investigation"
                          ? `${text("investigation.epoch")} ${pending.input.expectedEpoch} · ${text("investigation.operatorRevision")} ${pending.input.expectedOperatorRevision} · ${pending.input.targetID ?? "—"} · ${pending.input.expiresAt ?? "—"}`
                          : `${text("revision")} ${pending.input.expectedRevision}`}
                        {"\n"}
                        {pending.input.requestID}
                        {pending.kind === "investigation" && pending.preview
                          ? `\n${targetSummary(pending.preview.target)}`
                          : ""}
                      </text>
                    )}
                  </Show>
                  <Show when={state.error}>
                    <text fg={appearance.theme.text} wrapMode="word">
                      {state.error}
                    </text>
                  </Show>
                  <Show when={state.runsError}>
                    <text fg={appearance.theme.text} wrapMode="word">
                      {state.runsError}
                    </text>
                  </Show>
                  <Show when={state.notice}>
                    <text fg={appearance.theme.text} wrapMode="word">
                      {state.notice}
                    </text>
                  </Show>
                  <Show when={state.loading}>
                    <text fg={appearance.theme.text}>{text("loading")}</text>
                  </Show>
                  <Show when={!state.loading && !state.error && !state.rules.length}>
                    <text fg={appearance.theme.text}>{text("empty")}</text>
                  </Show>
                  <Show when={state.form}>
                    <text fg={appearance.theme.text} wrapMode="word">
                      {state.targetID} · {state.recipeID}
                      {"\n"}
                      {text("watch")}: {state.watch}
                      {"\n"}
                      {text("maxRuns")}: {state.maxRuns} · {text("hours")}: {state.hours}
                    </text>
                    <For each={recipe()?.parameters ?? []}>
                      {(parameter) => (
                        <text fg={appearance.theme.text}>
                          {parameter.key}: {state.parameters[parameter.key]}
                        </text>
                      )}
                    </For>
                    <Show when={!state.targets.length && !state.busy && !state.error}>
                      <text fg={appearance.theme.text}>{text("noTargets")}</text>
                    </Show>
                    <Show when={state.captured}>
                      {(captured) => (
                        <text fg={appearance.theme.text} wrapMode="word">
                          {text("command")}: installed-bun-v1{" "}
                          {captured()
                            .preview.recipe.argv.map((argument) =>
                              argument.kind === "literal"
                                ? JSON.stringify(argument.value)
                                : `${argument.parameter}=${JSON.stringify(captured().preview.parameters.find((value) => value.key === argument.parameter)?.value ?? "")}`,
                            )
                            .join(" ")}
                          {"\n"}
                          {text("outputs")}: {captured().preview.recipe.outputs.join(", ") || "—"}
                          {"\n"}
                          {text("timeout")}: {captured().preview.recipe.timeoutMs} · {text("sandbox")}
                          {"\n"}
                          {text("preview")}: {captured().preview.recipe.logicalID} · {text("revision")}{" "}
                          {captured().preview.recipe.revision}
                          {"\n"}
                          {text("watch")}: {captured().preview.watch.join(", ")}
                          {"\n"}
                          {text("maxRuns")}: {captured().preview.maxRuns}
                          {"\n"}
                          {text("expires")}: {new Date(captured().preview.ruleExpiresAt).toLocaleString()}
                          {"\n"}
                          {text("previewExpires")}: {new Date(captured().expiresAt).toLocaleTimeString()}
                          {"\n"}
                          {text("noInvestigation")}
                        </text>
                      )}
                    </Show>
                  </Show>
                  <Show when={state.investigationView && selected()}>
                    <box gap={1}>
                      <text fg={appearance.theme.text} wrapMode="word">
                        {investigationState()} · {text("investigation.autoFixOff")}
                      </text>
                      <text fg={appearance.theme.text} wrapMode="word">
                        {text("investigation.description")}
                        {"\n"}
                        {text("investigation.candidateNotice")}
                      </text>
                      <text fg={appearance.theme.text} wrapMode="word">
                        {text("investigation.epoch")}: {selected()?.investigationAuthority?.epoch ?? 0}
                        {selected()?.investigationAuthority?.grant
                          ? ` · ${text("expires")}: ${new Date(selected()!.investigationAuthority!.grant!.expiresAt).toLocaleString()}`
                          : ""}
                      </text>
                      <Show when={state.investigationLoading}>
                        <text fg={appearance.theme.text}>{text("loading")}</text>
                      </Show>
                      <Show when={investigationExpired() || previewExpired()}>
                        <text fg={appearance.theme.text}>{text("reason.expired")}</text>
                      </Show>
                      <Show when={state.investigationError}>
                        <text fg={appearance.theme.text} wrapMode="word">
                          {state.investigationError}
                        </text>
                      </Show>
                      <Show when={state.investigation}>
                        {(candidates) => (
                          <text fg={appearance.theme.text} wrapMode="word">
                            {text("investigation.epoch")}: {candidates().epoch} ·{" "}
                            {text("investigation.operatorRevision")}: {candidates().operatorRevision}
                            {"\n"}
                            {text("investigation.maxExpiry")}: {new Date(candidates().maxExpiresAt).toLocaleString()}
                            {"\n"}
                            {text("investigation.target")}: {state.investigationTarget || "—"} ·{" "}
                            {text("investigation.hours")}: {state.investigationHours}
                            {!candidates().targets.length ? `\n${text("investigation.noTargets")}` : ""}
                          </text>
                        )}
                      </Show>
                      <Show when={state.investigationCaptured}>
                        {(captured) => (
                          <text fg={appearance.theme.text} wrapMode="word">
                            {targetSummary(captured().preview.target)}
                            {"\n"}
                            {text("investigation.epoch")}: {captured().preview.epoch} ·{" "}
                            {text("investigation.operatorRevision")}: {captured().preview.operatorRevision}
                            {"\n"}
                            {text("expires")}: {new Date(captured().preview.grantExpiresAt).toLocaleString()}
                            {"\n"}
                            {text("previewExpires")}: {new Date(captured().expiresAt).toLocaleTimeString()}
                          </text>
                        )}
                      </Show>
                      <text fg={appearance.theme.text}>{text("investigation.reports")}</text>
                      <Show when={state.reportsError}>
                        <text fg={appearance.theme.text} wrapMode="word">
                          {state.reportsError}
                        </text>
                      </Show>
                      <Show when={!state.investigationLoading && !state.reportsError && !state.reports.length}>
                        <text fg={appearance.theme.text}>{text("investigation.noReports")}</text>
                      </Show>
                      <Show when={state.reports.find((report) => report.receiptID === state.report)}>
                        {(report) => (
                          <text fg={appearance.theme.text} wrapMode="word">
                            {text("contentRevision")}: {report().contentRevision} · {report().contentHash}
                            {"\n"}
                            {report().runID} · {report().receiptID} · {text("investigation.epoch")}:{" "}
                            {report().grantEpoch}
                            {"\n"}
                            {text("investigation.work")}:{" "}
                            {text(`investigation.admission.${report().work.admissionState}`)} /{" "}
                            {text(`investigation.control.${report().work.controlState}`)} /{" "}
                            {text(`investigation.outcome.${report().work.outcome}`)}
                            {"\n"}
                            {text("revision")}: {report().work.controlRevision} · {text("expires")}:{" "}
                            {new Date(report().deadline).toLocaleString()}
                            {"\n"}
                            {report().sessionID}
                          </text>
                        )}
                      </Show>
                    </box>
                  </Show>
                  <Show when={state.detail && !state.investigationView && selected()}>
                    {(rule) => (
                      <box gap={1}>
                        <text fg={appearance.theme.text} wrapMode="word">
                          {rule().configuration.scope.canonicalRoot}
                          {"\n"}
                          {rule().configuration.recipe.logicalID} · {text(`state.${rule().state}`)}
                        </text>
                        <text fg={appearance.theme.text} wrapMode="word">
                          {text("revision")}: {rule().revision} · {text("contentRevision")}: {rule().contentRevision}
                          {"\n"}
                          {text("runs")}: {rule().runCount}/{rule().configuration.maxRuns} · {text("expires")}:{" "}
                          {new Date(rule().configuration.expiresAt).toLocaleString()}
                        </text>
                        <text fg={appearance.theme.text} wrapMode="word">
                          {text("reason")}:{" "}
                          {ruleExpired() && rule().lastReason === "ready"
                            ? `${text("reason.expired")} · ${text("historical")}: ${text("reason.ready")}`
                            : text(`reason.${rule().lastReason}`)}
                          {"\n"}
                          {text("watch")}: {rule().configuration.watch.join(", ")}
                          {"\n"}
                          {text("noInvestigation")}
                        </text>
                        <Show when={state.confirm}>
                          {(action) => (
                            <text fg={appearance.theme.text}>
                              {text("confirmAction")}: {text(action())}
                            </text>
                          )}
                        </Show>
                        <Show when={state.runs.find((run) => run.record.runID === state.compared)}>
                          {(run) => (
                            <scrollbox height={10}>
                              <text fg={appearance.theme.text} wrapMode="word">
                                {text(run().current ? "current" : "historical")} ·{" "}
                                {text(`observation.${run().observation}`)}
                                {"\n"}
                                {text("contentRevision")}: {run().record.contentRevision} · {text("currentVersion")}:{" "}
                                {rule().contentRevision}
                                {"\n"}
                                {text("cancelRequested")}: {text(run().record.cancelRequested ? "yes" : "no")} ·{" "}
                                {text("stopConfirmed")}: {text(run().record.result?.stopConfirmed ? "yes" : "no")}
                                {"\n"}
                                {text("exitCode")}: {run().record.result?.exitCode ?? "—"}
                              </text>
                              <For
                                each={
                                  run().record.result ? [run().record.result!.stdout, run().record.result!.stderr] : []
                                }
                              >
                                {(stream) => (
                                  <text fg={appearance.theme.text} wrapMode="word">
                                    {stream.bytes} B ·{" "}
                                    {text(
                                      stream.truncated || stream.excerptTruncated || stream.excerpt.length > 8192
                                        ? "truncated"
                                        : "complete",
                                    )}
                                    {"\n"}
                                    {stream.excerpt.slice(0, 8192).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "�")}
                                  </text>
                                )}
                              </For>
                            </scrollbox>
                          )}
                        </Show>
                      </box>
                    )}
                  </Show>
                </box>
              </scrollbox>
            }
            options={
              state.investigationView
                ? state.investigationPick
                  ? [
                      ...(state.investigation?.targets ?? []).map((target) => ({
                        title: target.targetID,
                        value: `investigation-target:${target.targetID}`,
                      })),
                      { title: text("back"), value: "investigation-pick-back" },
                    ]
                  : [
                      { title: text("back"), value: "investigation-back" },
                      {
                        title: text("investigation.refresh"),
                        value: "investigation-refresh",
                        disabled: state.investigationLoading,
                      },
                      ...(state.pending ? [{ title: text("retry"), value: "retry" }] : []),
                      ...(!state.investigationCaptured
                        ? [
                            {
                              title: text("investigation.target"),
                              value: "investigation-pick",
                              disabled: !investigationFresh(),
                            },
                            {
                              title: text("investigation.hours"),
                              value: "edit:investigationHours",
                              disabled: !investigationFresh(),
                            },
                            {
                              title: text("investigation.preview"),
                              value: "investigation-capture",
                              disabled: !investigationFresh() || !state.investigationTarget,
                            },
                          ]
                        : [
                            {
                              title: text("investigation.enable"),
                              value: "investigation-enable",
                              disabled: !investigationFresh() || previewExpired(),
                            },
                          ]),
                      {
                        title: text("investigation.disable"),
                        value: "investigation-disable",
                        disabled: !investigationReady(),
                      },
                      ...(state.report
                        ? [
                            {
                              title: text("investigation.open"),
                              value: "investigation-open",
                              disabled: !props.onOpenSession,
                            },
                          ]
                        : []),
                      ...state.reports.map((report) => ({
                        title: `${text("contentRevision")} ${report.contentRevision} · ${text(`investigation.outcome.${report.work.outcome}`)}`,
                        value: `investigation-report:${report.receiptID}`,
                        category: text("investigation.reports"),
                      })),
                    ]
                : state.form
                  ? state.pick === "target"
                    ? [
                        ...state.targets.map((target) => ({
                          title: target.targetID,
                          value: `target:${target.targetID}`,
                        })),
                        { title: text("back"), value: "form-back" },
                      ]
                    : state.pick === "recipe"
                      ? [
                          ...(state.targets.find((target) => target.targetID === state.targetID)?.recipes ?? []).map(
                            (item) => ({
                              title: `${item.logicalID} · ${text("revision")} ${item.revision}`,
                              value: `recipe:${item.logicalID}`,
                            }),
                          ),
                          { title: text("back"), value: "form-back" },
                        ]
                      : state.pick.startsWith("parameter:")
                        ? [
                            ...(
                              recipe()?.parameters.find((parameter) => `parameter:${parameter.key}` === state.pick)
                                ?.choices ?? []
                            ).map((value) => ({ title: value || "—", value: `choice:${value}` })),
                            { title: text("back"), value: "form-back" },
                          ]
                        : [
                            ...(state.pending ? [{ title: text("retry"), value: "retry" }] : []),
                            ...(state.captured
                              ? [{ title: text("save"), value: "save", disabled: !!state.pending }]
                              : [
                                  { title: text("chooseTarget"), value: "pick-target", disabled: !!state.pending },
                                  { title: text("chooseRecipe"), value: "pick-recipe", disabled: !!state.pending },
                                  ...(recipe()?.parameters ?? []).map((parameter) => ({
                                    title: `${parameter.key}: ${state.parameters[parameter.key] ?? ""}`,
                                    value: `parameter:${parameter.key}`,
                                    disabled: !!state.pending,
                                  })),
                                  { title: text("watch"), value: "edit:watch", disabled: !!state.pending },
                                  { title: text("maxRuns"), value: "edit:maxRuns", disabled: !!state.pending },
                                  { title: text("hours"), value: "edit:hours", disabled: !!state.pending },
                                  { title: text("preview"), value: "capture", disabled: !recipe() || !!state.pending },
                                ]),
                            { title: text("back"), value: "form-close", disabled: !!state.pending },
                          ]
                  : state.confirm
                    ? [
                        { title: text("confirm"), value: "confirm", disabled: !controlReady(state.confirm) },
                        { title: text("back"), value: "back" },
                      ]
                    : [
                        { title: text("refresh"), value: "refresh" },
                        { title: text("new"), value: "new", disabled: !!state.pending },
                        ...(state.pending ? [{ title: text("retry"), value: "retry" }] : []),
                        ...(state.detail && selected()
                          ? [
                              { title: text("back"), value: "back" },
                              ...(["enable", "verify", "pause", "cancel", "revoke"] as const)
                                .filter((action) =>
                                  action === "enable"
                                    ? ["disabled", "paused"].includes(selected()!.state)
                                    : action === "pause" || action === "verify"
                                      ? selected()!.state === "enabled"
                                      : action === "cancel"
                                        ? !!selected()!.currentRunID
                                        : selected()!.state !== "revoked",
                                )
                                .map((action) => ({
                                  title: text(action),
                                  value: `action:${action}`,
                                  disabled: !controlReady(action),
                                })),
                              { title: text("investigation.title"), value: "investigation" },
                              ...state.runs.map((run) => ({
                                title: `${text("contentRevision")} ${run.record.contentRevision} · ${text(`run.${run.record.state}`)} · ${run.record.outcome ? text(`outcome.${run.record.outcome}`) : text("noResult")}`,
                                value: `run:${run.record.runID}`,
                                category: text("history"),
                              })),
                            ]
                          : state.rules.map((rule) => ({
                              title: `${rule.configuration.recipe.logicalID} · ${text(`state.${rule.state}`)}`,
                              description: rule.configuration.scope.canonicalRoot,
                              value: `rule:${rule.ruleID}`,
                            }))),
                      ]
            }
            onSelect={(option) => {
              if (!current()) return
              if (option.value === "investigation") {
                setState({ investigationView: true, investigationPick: false, report: "" })
                return
              }
              if (option.value === "investigation-back") {
                setState({ investigationView: false, investigationPick: false, report: "" })
                return
              }
              if (option.value === "investigation-refresh") {
                void readInvestigation()
                return
              }
              if (option.value === "investigation-pick") {
                setState("investigationPick", true)
                return
              }
              if (option.value === "investigation-pick-back") {
                setState("investigationPick", false)
                return
              }
              if (option.value.startsWith("investigation-target:")) {
                const targetID = option.value.slice(21)
                if (state.investigation?.targets.some((target) => target.targetID === targetID))
                  setState({ investigationTarget: targetID, investigationCaptured: undefined })
                setState("investigationPick", false)
                return
              }
              if (option.value === "investigation-capture") {
                void captureInvestigation()
                return
              }
              if (option.value === "investigation-enable" || option.value === "investigation-disable") {
                controlInvestigation(option.value === "investigation-enable" ? "enable" : "disable")
                return
              }
              if (option.value.startsWith("investigation-report:")) {
                setState("report", option.value.slice(21))
                return
              }
              if (option.value === "investigation-open") {
                const report = state.reports.find((item) => item.receiptID === state.report)
                if (report) openReport(report)
                return
              }
              if (option.value === "new") {
                void begin()
                return
              }
              if (option.value === "capture") {
                void capture()
                return
              }
              if (option.value === "save") {
                save()
                return
              }
              if (option.value === "form-close") {
                if (!state.pending) setState({ form: false, captured: undefined, pick: "" })
                return
              }
              if (option.value === "form-back") {
                setState("pick", "")
                return
              }
              if (option.value === "pick-target") {
                setState("pick", "target")
                return
              }
              if (option.value === "pick-recipe") {
                setState("pick", "recipe")
                return
              }
              if (option.value.startsWith("target:")) {
                const target = state.targets.find((target) => target.targetID === option.value.slice(7))
                if (target) chooseRecipe(target.targetID, target.recipes[0]?.logicalID ?? "")
                setState("pick", "")
                return
              }
              if (option.value.startsWith("recipe:")) {
                chooseRecipe(state.targetID, option.value.slice(7))
                setState("pick", "")
                return
              }
              if (option.value.startsWith("parameter:")) {
                setState("pick", `parameter:${option.value.slice(10)}`)
                return
              }
              if (option.value.startsWith("choice:") && state.pick.startsWith("parameter:")) {
                const parameter = recipe()?.parameters.find((parameter) => `parameter:${parameter.key}` === state.pick)
                const choice = option.value.slice(7)
                if (parameter?.choices.includes(choice)) setState("parameters", parameter.key, choice)
                setState("pick", "")
                return
              }
              const edit = (["watch", "maxRuns", "hours", "investigationHours"] as const).find(
                (name) => option.value === `edit:${name}`,
              )
              if (edit) {
                setState("edit", edit)
                return
              }
              if (option.value === "refresh") {
                void refresh()
                return
              }
              if (option.value === "retry") {
                retry()
                return
              }
              if (option.value === "confirm") {
                if (state.confirm) control(state.confirm)
                return
              }
              if (option.value === "back") {
                if (state.confirm) {
                  setState("confirm", undefined)
                  return
                }
                setState({ detail: false, compared: "" })
                return
              }
              if (option.value.startsWith("rule:")) {
                setState("detail", true)
                void refresh(option.value.slice(5))
                return
              }
              if (option.value.startsWith("run:")) {
                setState("compared", option.value.slice(4))
                return
              }
              const action = (["enable", "verify", "pause", "cancel", "revoke"] as const).find(
                (action) => option.value === `action:${action}`,
              )
              if (action && permitControl(action)) setState("confirm", action)
            }}
          />
        }
      >
        {(editing) => (
          <DialogPrompt
            title={text(editing === "investigationHours" ? "investigation.hours" : editing)}
            value={state[editing]}
            description={
              <text fg={appearance.theme.text} wrapMode="word">
                {text(editing === "watch" ? "watchHint" : "description")}
              </text>
            }
            onCancel={() => setState("edit", undefined)}
            onConfirm={(value) => {
              if (!current() || state.busy || state.pending) return
              setState(editing, value)
              setState({ edit: undefined, captured: undefined, investigationCaptured: undefined })
            }}
          />
        )}
      </Show>
    </box>
  )
}
