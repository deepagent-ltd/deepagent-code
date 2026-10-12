import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk"

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
// Only explicit command identities survive a dialog reopen. This is not authority,
// a cold execution queue, or permission to retry without a user action.
const requests = new WeakMap<object, Map<string, Command>>()

// DialogProvider has an independent root, so its originating command owner must
// invalidate it explicitly even when route and SDK snapshots no longer change.
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
  const language = useLanguage()
  const dialog = useDialog()
  const client = sdk.client
  const scope = sdk.scope
  const directory = sdk.directory
  const sessionID = props.sessionID
  const key = JSON.stringify([scope, directory, sessionID])
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
  })
  let disposed = false
  let reads = 0
  let investigationReads = 0
  const text = (name: string) => language.t(`eventValidation.${name}` as Parameters<typeof language.t>[0])
  const current = () =>
    !disposed &&
    props.active?.() !== false &&
    sdk.client === client &&
    sdk.scope === scope &&
    sdk.directory === directory &&
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
      sdk.scope !== scope ||
      sdk.directory !== directory ||
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
      dialog.close()
    }
  })
  const investigationReady = () => current() && actionable() && !state.investigationLoading && !!state.investigation
  const ruleExpired = () => !!selected() && selected()!.configuration.expiresAt <= state.checkedAt
  const runBudgetExhausted = () => !!selected() && selected()!.runCount >= selected()!.configuration.maxRuns
  const controlReady = (action: Control["action"]) =>
    current() && actionable() && ((action !== "enable" && action !== "verify") || (!ruleExpired() && !runBudgetExhausted()))
  const permitControl = (action: Control["action"]) => {
    if (!current() || !actionable()) return false
    const now = Date.now()
    setState("checkedAt", now)
    if ((action === "enable" || action === "verify") && selected()!.configuration.expiresAt <= now) {
      setState({ error: text("reason.expired"), confirm: undefined })
      return false
    }
    if ((action === "enable" || action === "verify") && runBudgetExhausted()) {
      setState({ error: text("reason.budget_exhausted"), confirm: undefined })
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
      setState({ rules: [], selected: "", compared: "", error: text("unavailable"), loading: false })
      return
    }
    setState("checkedAt", Date.now())
    const chosen = response.data.some((rule) => rule.ruleID === id) ? id : (response.data[0]?.ruleID ?? "")
    setState({ rules: response.data, selected: chosen, compared: "" })
    if (!chosen) {
      setState("loading", false)
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
          if (current()) setState("error", text(status === 409 ? "conflict" : status === 429 ? "capacity" : "unavailable"))
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
  const captureFailure = (error: unknown, status?: number) => {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      [
        "VALIDATION_INVALID",
        "VALIDATION_NOT_FOUND",
        "VALIDATION_CONFLICT",
        "VALIDATION_AUTH_REQUIRED",
        "VALIDATION_SCOPE_CHANGED",
        "VALIDATION_UNAVAILABLE",
        "VALIDATION_CAPACITY",
        "VALIDATION_RECOVERY_REQUIRED",
        "VALIDATION_CAPTURE_EXPIRED",
      ].some((value) => value === error.code)
        ? error.code
        : undefined
    const reason =
      code === "VALIDATION_INVALID"
        ? "invalid"
        : code === "VALIDATION_CONFLICT" ||
            code === "VALIDATION_RECOVERY_REQUIRED" ||
            code === "VALIDATION_CAPTURE_EXPIRED"
          ? "conflict"
          : code
            ? "unavailable"
            : "invalid"
    const http = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined
    setState(
      "error",
      `${text(reason)}${code || http ? ` · capture${http ? ` · HTTP ${http}` : ""}${code ? ` · ${code}` : ""}` : ""}`,
    )
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
        { throwOnError: false },
      )
      if (!current()) return
      if (response.error) {
        captureFailure(response.error, response.response?.status)
        console.warn("[event-validation] capture-refused", {
          phase: "capture",
          status: response.response?.status,
          directoryMatchesCaptured:
            response.request?.headers.get("x-deepagent-code-directory") === encodeURIComponent(directory),
        })
        return
      }
      if (!response.data || response.data.expiresAt <= Date.now()) throw new Error("expired")
      setState("captured", response.data)
    } catch (error) {
      if (current()) captureFailure(error)
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
  return (
    <Dialog title={text("title")}>
      <div class="flex flex-col gap-4 p-5 max-h-[80vh] overflow-y-auto">
        <p class="text-13-regular text-text-weak">{text("description")}</p>
        <p class="text-12-regular text-text-weak break-all">{directory}</p>
        <div class="flex gap-2 flex-wrap">
          <Button disabled={state.loading || state.busy} onClick={() => void refresh()}>
            {text("refresh")}
          </Button>
          <Button disabled={state.loading || state.busy || !!state.pending} onClick={() => void begin()}>
            {text("new")}
          </Button>
        </div>
        <Show when={state.pending} keyed>
          {(pending) => (
            <div role="status" class="flex flex-col gap-2">
              <p>{text(state.busy ? "sending" : "unknown")}</p>
              <p>
                {text("confirmAction")}:{" "}
                {text(
                  pending.kind === "control"
                    ? pending.input.action
                    : pending.kind === "configure"
                      ? "save"
                      : `investigation.${pending.input.operation}`,
                )}
              </p>
              <p class="break-all">
                {directory} · {pending.input.ruleID} ·{" "}
                {pending.kind === "investigation"
                  ? `${text("investigation.epoch")} ${pending.input.expectedEpoch} · ${text("investigation.operatorRevision")} ${pending.input.expectedOperatorRevision} · ${pending.input.targetID ?? "—"} · ${pending.input.expiresAt ?? "—"}`
                  : `${text("revision")} ${pending.input.expectedRevision}`}
              </p>
              <Show when={pending.kind === "investigation" && pending.preview}>
                {(preview) => <pre class="whitespace-pre-wrap break-words">{targetSummary(preview().target)}</pre>}
              </Show>
              <code class="break-all">{pending.input.requestID}</code>
              <Button disabled={state.busy || state.loading} onClick={() => retry()}>
                {text("retry")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <Show when={state.notice}>
          <p role="status">{state.notice}</p>
        </Show>
        <Show when={state.loading}>
          <p>{text("loading")}</p>
        </Show>
        <Show when={!state.loading && !state.error && state.rules.length === 0}>
          <p>{text("empty")}</p>
        </Show>
        <For each={state.rules}>
          {(rule) => (
            <Button
              variant={state.selected === rule.ruleID ? "secondary" : "ghost"}
              disabled={state.busy || state.loading}
              onClick={() => void refresh(rule.ruleID)}
            >
              {rule.configuration.recipe.logicalID} · {text(`state.${rule.state}`)} ·{" "}
              {rule.configuration.scope.canonicalRoot}
            </Button>
          )}
        </For>
        <Show when={state.form}>
          <section class="border border-border-weak-base rounded-lg p-3 flex flex-col gap-3" aria-label={text("new")}>
            <Show
              when={state.captured}
              fallback={
                <>
                  <label class="flex flex-col gap-1">
                    {text("chooseTarget")}
                    <select
                      aria-label={text("chooseTarget")}
                      disabled={state.busy}
                      value={state.targetID}
                      onChange={(event) => {
                        const target = state.targets.find((target) => target.targetID === event.currentTarget.value)
                        chooseRecipe(target?.targetID ?? "", target?.recipes[0]?.logicalID ?? "")
                      }}
                    >
                      <For each={state.targets}>
                        {(target) => <option value={target.targetID}>{target.targetID}</option>}
                      </For>
                    </select>
                  </label>
                  <label class="flex flex-col gap-1">
                    {text("chooseRecipe")}
                    <select
                      aria-label={text("chooseRecipe")}
                      disabled={state.busy}
                      value={state.recipeID}
                      onChange={(event) => chooseRecipe(state.targetID, event.currentTarget.value)}
                    >
                      <For each={state.targets.find((target) => target.targetID === state.targetID)?.recipes ?? []}>
                        {(item) => (
                          <option value={item.logicalID}>
                            {item.logicalID} · {text("revision")} {item.revision}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <Show when={!state.targets.length && !state.busy && !state.error}>
                    <p>{text("noTargets")}</p>
                  </Show>
                  <For each={recipe()?.parameters ?? []}>
                    {(parameter) => (
                      <label class="flex flex-col gap-1">
                        {parameter.key}
                        <select
                          aria-label={parameter.key}
                          disabled={state.busy}
                          value={state.parameters[parameter.key]}
                          onChange={(event) => setState("parameters", parameter.key, event.currentTarget.value)}
                        >
                          <For each={parameter.choices}>{(value) => <option value={value}>{value}</option>}</For>
                        </select>
                      </label>
                    )}
                  </For>
                  <label class="flex flex-col gap-1">
                    {text("watch")}
                    <textarea
                      rows={5}
                      aria-label={text("watch")}
                      disabled={state.busy}
                      value={state.watch}
                      onInput={(event) => setState("watch", event.currentTarget.value)}
                    />
                  </label>
                  <p>{text("watchHint")}</p>
                  <label>
                    {text("maxRuns")}{" "}
                    <input
                      aria-label={text("maxRuns")}
                      type="number"
                      min="1"
                      max="10000"
                      disabled={state.busy}
                      value={state.maxRuns}
                      onInput={(event) => setState("maxRuns", event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    {text("hours")}{" "}
                    <input
                      aria-label={text("hours")}
                      type="number"
                      min="0.01"
                      step="0.01"
                      disabled={state.busy}
                      value={state.hours}
                      onInput={(event) => setState("hours", event.currentTarget.value)}
                    />
                  </label>
                  <Button disabled={state.busy || !!state.pending || !recipe()} onClick={() => void capture()}>
                    {text("preview")}
                  </Button>
                </>
              }
            >
              {(captured) => (
                <>
                  <h3>{text("preview")}</h3>
                  <p>
                    {directory} · {state.targetID}
                  </p>
                  <p>
                    {captured().preview.recipe.logicalID} · {text("revision")} {captured().preview.recipe.revision}
                  </p>
                  <p>{text("command")}: installed-bun-v1</p>
                  <pre class="whitespace-pre-wrap break-words max-h-32 overflow-auto">
                    {captured()
                      .preview.recipe.argv.map((argument) =>
                        argument.kind === "literal"
                          ? JSON.stringify(argument.value)
                          : `${argument.parameter}=${JSON.stringify(captured().preview.parameters.find((value) => value.key === argument.parameter)?.value ?? "")}`,
                      )
                      .join(" ")}
                  </pre>
                  <p>
                    {text("outputs")}: {captured().preview.recipe.outputs.join(", ") || "—"}
                  </p>
                  <p>
                    {text("timeout")}: {captured().preview.recipe.timeoutMs} · {text("sandbox")}
                  </p>
                  <p>
                    {text("parameters")}:{" "}
                    {captured()
                      .preview.parameters.map((item) => `${item.key}=${item.value}`)
                      .join(", ") || "—"}
                  </p>
                  <p class="break-all">
                    {text("watch")}: {captured().preview.watch.join(", ")}
                  </p>
                  <p>
                    {text("maxRuns")}: {captured().preview.maxRuns} · {text("expires")}:{" "}
                    {new Date(captured().preview.ruleExpiresAt).toLocaleString()}
                  </p>
                  <p>
                    {text("previewExpires")}: {new Date(captured().expiresAt).toLocaleTimeString()}
                  </p>
                  <p>{text("noInvestigation")}</p>
                  <Button disabled={state.busy || !!state.pending} onClick={save}>
                    {text("save")}
                  </Button>
                </>
              )}
            </Show>
            <Button
              variant="ghost"
              disabled={state.busy || !!state.pending}
              onClick={() => setState({ form: false, captured: undefined })}
            >
              {text("back")}
            </Button>
          </section>
        </Show>
        <Show when={selected()}>
          {(rule) => (
            <section class="flex flex-col gap-3" aria-label={text("rule")}>
              <h3>{rule().configuration.recipe.logicalID}</h3>
              <p class="break-all">{rule().configuration.scope.canonicalRoot}</p>
              <p>
                {text("revision")}: {rule().revision} · {text("contentRevision")}: {rule().contentRevision}
              </p>
              <p>
                {text("runs")}: {rule().runCount}/{rule().configuration.maxRuns} · {text("expires")}:{" "}
                {new Date(rule().configuration.expiresAt).toLocaleString()}
              </p>
              <p>
                {text("reason")}:{" "}
                {ruleExpired() && rule().lastReason === "ready"
                  ? `${text("reason.expired")} · ${text("historical")}: ${text("reason.ready")}`
                  : text(`reason.${rule().lastReason}`)}
              </p>
              <p>
                {text("watch")}: {rule().configuration.watch.join(", ")}
              </p>
              <p>{text("noInvestigation")}</p>
              <div class="flex gap-2 flex-wrap">
                <For
                  each={(["enable", "verify", "pause", "cancel", "revoke"] as const).filter((action) =>
                    action === "enable"
                      ? ["disabled", "paused"].includes(rule().state)
                      : action === "pause" || action === "verify"
                        ? rule().state === "enabled"
                        : action === "cancel"
                          ? !!rule().currentRunID
                          : rule().state !== "revoked",
                  )}
                >
                  {(action) => (
                    <Button
                      disabled={!controlReady(action)}
                      onClick={() => {
                        if (permitControl(action)) setState("confirm", action)
                      }}
                    >
                      {text(action)}
                    </Button>
                  )}
                </For>
              </div>
              <Show when={state.confirm}>
                {(action) => (
                  <div class="flex gap-2 items-center flex-wrap">
                    <span>
                      {text("confirmAction")}: {text(action())}
                    </span>
                    <Button disabled={!controlReady(action())} onClick={() => control(action())}>
                      {text("confirm")}
                    </Button>
                    <Button variant="ghost" onClick={() => setState("confirm", undefined)}>
                      {text("back")}
                    </Button>
                  </div>
                )}
              </Show>
              <section
                class="border border-border-weak-base rounded-lg p-3 flex flex-col gap-3"
                aria-label={text("investigation.title")}
              >
                <h3>{text("investigation.title")}</h3>
                <p>{text("investigation.description")}</p>
                <p role="status">
                  {investigationState()} · {text("investigation.autoFixOff")}
                </p>
                <p>
                  {text("investigation.epoch")}: {rule().investigationAuthority?.epoch ?? 0}
                </p>
                <Show when={rule().investigationAuthority?.grant}>
                  {(grant) => (
                    <p>
                      {text("expires")}: {new Date(grant().expiresAt).toLocaleString()}
                    </p>
                  )}
                </Show>
                <p>{text("investigation.candidateNotice")}</p>
                <Show when={investigationExpired() || previewExpired()}>
                  <p role="status">{text("reason.expired")}</p>
                </Show>
                <Button
                  disabled={state.busy || state.loading || state.investigationLoading}
                  onClick={() => void readInvestigation()}
                >
                  {text("investigation.refresh")}
                </Button>
                <Show when={state.investigationLoading}>
                  <p>{text("loading")}</p>
                </Show>
                <Show when={state.investigationError}>
                  <p role="alert">{state.investigationError}</p>
                </Show>
                <Show when={state.investigation}>
                  {(candidates) => (
                    <>
                      <p>
                        {text("investigation.epoch")}: {candidates().epoch} · {text("investigation.operatorRevision")}:{" "}
                        {candidates().operatorRevision}
                      </p>
                      <p>
                        {text("investigation.maxExpiry")}: {new Date(candidates().maxExpiresAt).toLocaleString()}
                      </p>
                      <Show when={!candidates().targets.length}>
                        <p>{text("investigation.noTargets")}</p>
                      </Show>
                      <Show when={!state.investigationCaptured}>
                        <label class="flex flex-col gap-1">
                          {text("investigation.target")}
                          <select
                            aria-label={text("investigation.target")}
                            value={state.investigationTarget}
                            disabled={!investigationFresh()}
                            onChange={(event) =>
                              setState({
                                investigationTarget: event.currentTarget.value,
                                investigationCaptured: undefined,
                              })
                            }
                          >
                            <For each={candidates().targets}>
                              {(target) => <option value={target.targetID}>{target.targetID}</option>}
                            </For>
                          </select>
                        </label>
                        <label>
                          {text("investigation.hours")}{" "}
                          <input
                            aria-label={text("investigation.hours")}
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={state.investigationHours}
                            disabled={!investigationFresh()}
                            onInput={(event) => setState("investigationHours", event.currentTarget.value)}
                          />
                        </label>
                        <Button
                          disabled={!investigationFresh() || !state.investigationTarget}
                          onClick={() => void captureInvestigation()}
                        >
                          {text("investigation.preview")}
                        </Button>
                      </Show>
                      <Button disabled={!investigationReady()} onClick={() => controlInvestigation("disable")}>
                        {text("investigation.disable")}
                      </Button>
                    </>
                  )}
                </Show>
                <Show when={state.investigationCaptured}>
                  {(captured) => (
                    <>
                      <h4>{text("investigation.preview")}</h4>
                      <pre class="whitespace-pre-wrap break-words">{targetSummary(captured().preview.target)}</pre>
                      <p>
                        {text("investigation.epoch")}: {captured().preview.epoch} ·{" "}
                        {text("investigation.operatorRevision")}: {captured().preview.operatorRevision}
                      </p>
                      <p>
                        {text("expires")}: {new Date(captured().preview.grantExpiresAt).toLocaleString()}
                      </p>
                      <p>
                        {text("previewExpires")}: {new Date(captured().expiresAt).toLocaleTimeString()}
                      </p>
                      <p>{text("investigation.autoFixOff")}</p>
                      <Button
                        disabled={!investigationFresh() || previewExpired()}
                        onClick={() => controlInvestigation("enable")}
                      >
                        {text("investigation.enable")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={state.busy || !!state.pending}
                        onClick={() => setState("investigationCaptured", undefined)}
                      >
                        {text("back")}
                      </Button>
                    </>
                  )}
                </Show>
                <h4>{text("investigation.reports")}</h4>
                <Show when={state.reportsError}>
                  <p role="alert">{state.reportsError}</p>
                </Show>
                <Show when={!state.investigationLoading && !state.reportsError && !state.reports.length}>
                  <p>{text("investigation.noReports")}</p>
                </Show>
                <For each={state.reports}>
                  {(report) => (
                    <div class="border-t border-border-weak-base pt-2 flex flex-col gap-1">
                      <p class="break-all">
                        {text("contentRevision")}: {report.contentRevision} · {report.contentHash}
                      </p>
                      <p class="break-all">
                        {report.runID} · {report.receiptID} · {text("investigation.epoch")}: {report.grantEpoch}
                      </p>
                      <p>
                        {text("investigation.work")}: {text(`investigation.admission.${report.work.admissionState}`)} /{" "}
                        {text(`investigation.control.${report.work.controlState}`)} /{" "}
                        {text(`investigation.outcome.${report.work.outcome}`)}
                      </p>
                      <p>
                        {text("revision")}: {report.work.controlRevision} · {text("expires")}:{" "}
                        {new Date(report.deadline).toLocaleString()}
                      </p>
                      <Button
                        variant="ghost"
                        disabled={state.busy || !props.onOpenSession}
                        onClick={() => openReport(report)}
                      >
                        {text("investigation.open")}
                      </Button>
                    </div>
                  )}
                </For>
              </section>
              <h3>{text("history")}</h3>
              <Show when={state.runsError}>
                <p role="alert">{state.runsError}</p>
              </Show>
              <Show when={!state.loading && !state.runsError && !state.runs.length}>
                <p>{text("noRuns")}</p>
              </Show>
              <For each={state.runs}>
                {(run) => (
                  <div class="border-t border-border-weak-base pt-2 flex flex-col gap-1">
                    <Button
                      variant="ghost"
                      onClick={() => setState("compared", state.compared === run.record.runID ? "" : run.record.runID)}
                    >
                      {text("contentRevision")} {run.record.contentRevision} · {text(`run.${run.record.state}`)} ·{" "}
                      {run.record.outcome ? text(`outcome.${run.record.outcome}`) : text("noResult")}
                    </Button>
                    <p>
                      {text(run.current ? "current" : "historical")} · {text(`observation.${run.observation}`)}
                    </p>
                    <Show when={state.compared === run.record.runID}>
                      <p>
                        {text("revision")}: {run.record.ruleRevision} · {text("currentVersion")}:{" "}
                        {rule().contentRevision}
                      </p>
                      <p>
                        {text("cancelRequested")}: {text(run.record.cancelRequested ? "yes" : "no")} ·{" "}
                        {text("stopConfirmed")}: {text(run.record.result?.stopConfirmed ? "yes" : "no")}
                      </p>
                      <p>
                        {text("exitCode")}: {run.record.result?.exitCode ?? "—"}
                      </p>
                      <For each={run.record.result ? [run.record.result.stdout, run.record.result.stderr] : []}>
                        {(stream) => (
                          <div>
                            <p>
                              {stream.bytes} B ·{" "}
                              {text(stream.truncated || stream.excerptTruncated ? "truncated" : "complete")}
                            </p>
                            <pre class="whitespace-pre-wrap break-words max-h-48 overflow-auto">{stream.excerpt}</pre>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                )}
              </For>
            </section>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
