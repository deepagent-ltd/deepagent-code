import { Component, For, Show, createEffect, createMemo, createUniqueId, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { CheckboxV2 } from "@deepagent-code/ui/v2/checkbox-v2"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { Icon } from "@deepagent-code/ui/icon"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { Switch } from "@deepagent-code/ui/v2/switch-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { TextareaV2 } from "@deepagent-code/ui/v2/textarea-v2"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import type { ImportJobInfo, ImportJobRequest } from "@deepagent-code/sdk"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type SourceFormat = "codex" | "claude" | "deepagent"
type SourceMode = SourceFormat | "custom"
type Scope = "session" | "memory" | "skill"
const active = (job?: ImportJobInfo) =>
  !!job && ["preflight", "ready", "running", "cancel_requested"].includes(job.state)

export const ImportSection: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const sdk = useServerSDK()

  const [state, setState] = createStore({
    mode: "codex" as SourceMode,
    customPath: "",
    customFormat: "codex" as SourceFormat,
    scopes: ["session"] as Scope[],
    dryRun: false,
    copyLiveDb: true,
    confirmLiveMerge: false,
    cwdFilter: "",
    snapshotFile: undefined as File | undefined,
    running: false,
    logs: [] as string[],
    summary: "",
    jobs: [] as ImportJobInfo[],
    job: undefined as ImportJobInfo | undefined,
    cursor: undefined as string | undefined,
    pending: undefined as ImportJobRequest | undefined,
    unresolved: undefined as string | undefined,
    capability: undefined as boolean | undefined,
    fileCapability: undefined as boolean | undefined,
    loading: false,
    loadingJob: false,
    submitting: false,
    cancelling: false,
    listError: false,
    detailError: false,
    requestUnknown: false,
    switched: false,
    notice: "",
    lastObserved: "",
    detailsOpen: false,
    copyStatus: "idle" as "idle" | "copying" | "copied" | "failed",
  })
  const detailsID = createUniqueId()
  let detailsButton: HTMLButtonElement | undefined
  let detailsElement: HTMLDivElement | undefined
  let snapshotInput: HTMLInputElement | undefined
  let generation = 0
  let listRequest = 0
  let detailRequest = 0
  let copyRequest = 0
  let pages = 1
  let disposed = false
  let abort = new AbortController()
  const connection = () =>
    JSON.stringify([
      server.key,
      server.current?.http.url,
      server.current?.http.username,
      server.current?.http.password,
      server.current?.http.bearer,
      sdk.scope,
      sdk.url,
    ])
  const mountedConnection = connection()
  const mountedClient = sdk.client
  const selectionKey = `deepagent-code.import-job:${server.key}:${server.current?.http.username ?? ""}`
  const receiptKey = `${selectionKey}:unresolved:${server.current?.http.url ?? ""}`
  const current = (epoch: number) =>
    !disposed && epoch === generation && connection() === mountedConnection && sdk.client === mountedClient
  const t = (k: string, fallback: string) => {
    const v = language.t(k)
    return v === k ? fallback : v
  }
  const push = (line: string) =>
    setState("logs", (logs) => {
      const next = [...logs, line.slice(0, 8192)].slice(-2000)
      while (next.length > 1 && new TextEncoder().encode(next.join("\n")).length > 2 * 1024 * 1024) next.shift()
      return next
    })
  const format = createMemo<SourceFormat>(() => (state.mode === "custom" ? state.customFormat : state.mode))
  const sourcePath = createMemo(() => (state.mode === "custom" ? state.customPath.trim() : ""))
  const locked = () => state.switched || state.running || state.submitting || !!state.unresolved
  const fileScopes = () => state.scopes.some((scope) => scope !== "session")
  const fileScopeAvailable = () => state.copyLiveDb && (state.dryRun || state.fileCapability === true)
  const label = (job: ImportJobInfo) => t(`settings.import.job.state.${job.state}`, job.state)
  const date = (value: number) => new Date(value).toLocaleString(language.intl())

  const receipt = (id?: string) => {
    try {
      id ? sessionStorage.setItem(receiptKey, id) : sessionStorage.removeItem(receiptKey)
    } catch {
      // Disabled storage still retains the in-memory receipt for this mounted observer.
    }
    setState("unresolved", id)
  }

  const receive = (job: ImportJobInfo, select = false) => {
    setState("jobs", (jobs) =>
      jobs.map((previous) => (previous.id === job.id && previous.revision <= job.revision ? job : previous)),
    )
    if (!select && state.job?.id !== job.id) return
    if (state.job?.id === job.id && state.job.revision > job.revision) return
    if (select) {
      try {
        sessionStorage.setItem(selectionKey, job.id)
      } catch {
        // Storage may be disabled; server-side job history remains the recovery source.
      }
    }
    if (state.job?.id !== job.id) setState("detailsOpen", false)
    if (state.job?.id !== job.id || state.job.revision !== job.revision) setState("copyStatus", "idle")
    setState({ job, running: active(job), detailError: false })
    const observed = [job.id, job.revision, job.state, job.committedBatches, job.failedBatches].join(":")
    if (observed === state.lastObserved) return
    setState("lastObserved", observed)
    push(
      `${date(job.updatedAt)} · ${label(job)} · ${job.committedBatches} ${t("settings.import.job.committed", "Committed batches")} · ${job.id}`,
    )
  }

  async function detail(id: string) {
    if (state.switched || state.capability !== true) return
    const epoch = generation
    const request = ++detailRequest
    setState("loadingJob", true)
    const result = await sdk.client.global
      .importGet({ jobID: id }, { signal: abort.signal, throwOnError: false })
      .catch(() => undefined)
    if (!current(epoch) || request !== detailRequest || state.job?.id !== id) return
    setState("loadingJob", false)
    if (!result?.data) {
      setState("detailError", true)
      return
    }
    receive(result.data)
  }

  async function refresh(append = false) {
    if (state.switched || state.capability !== true) return
    const epoch = generation
    const request = ++listRequest
    const existing = [...state.jobs]
    setState("loading", true)
    const result = await (async () => {
      const items: ImportJobInfo[] = append ? [...existing] : []
      let cursor = append ? state.cursor : undefined
      for (let page = 0; page < (append ? 1 : pages); page++) {
        const result = await sdk.client.global.importList(
          { limit: "20", cursor },
          { signal: abort.signal, throwOnError: false },
        )
        if (!current(epoch) || request !== listRequest) return
        if (!result.data) return
        items.push(...result.data.items)
        cursor = result.data.cursor
        if (!cursor) break
      }
      return { items, cursor }
    })().catch(() => undefined)
    if (!current(epoch) || request !== listRequest) return
    setState({ loading: false, listError: !result })
    if (!result) return
    const previous = new Map(state.jobs.map((job) => [job.id, job]))
    setState("jobs", [
      ...new Map(
        result.items.map((job) => [
          job.id,
          (previous.get(job.id)?.revision ?? -1) > job.revision ? previous.get(job.id)! : job,
        ]),
      ).values(),
    ])
    setState("cursor", result.cursor)
    if (append) pages++
    const accepted = state.unresolved && result.items.find((job) => job.requestID === state.unresolved)
    if (accepted) {
      receipt()
      setState({ pending: undefined, requestUnknown: false, notice: "" })
      receive(accepted, true)
    }
    if (!state.job && !state.unresolved && result.items[0]) {
      const remembered = (() => {
        try {
          return result.items.find((job) => job.id === sessionStorage.getItem(selectionKey))
        } catch {
          return undefined
        }
      })()
      receive(remembered ?? result.items[0], true)
    }
    if (state.job) await detail(state.job.id)
  }

  async function load() {
    const epoch = generation
    setState("loading", true)
    const result = await sdk.client.global
      .capabilities({ signal: abort.signal, throwOnError: false })
      .catch(() => undefined)
    if (!current(epoch)) return
    setState({
      loading: false,
      listError: !result?.data,
      capability: result?.data ? result.data.features.importJobs === true : undefined,
      fileCapability: result?.data ? result.data.features.importFileJobs === true : undefined,
    })
    if (!state.capability) return
    try {
      const id = sessionStorage.getItem(receiptKey)
      if (id && /^[a-zA-Z0-9._:-]{1,200}$/.test(id)) setState({ unresolved: id, requestUnknown: true })
    } catch {
      // Job listing remains available even when browser storage is disabled.
    }
    await refresh()
  }

  createEffect(() => {
    void [format(), sourcePath(), state.scopes.join(","), state.copyLiveDb, state.dryRun, state.cwdFilter]
    setState("confirmLiveMerge", false)
  })
  createEffect(() => {
    const switched = connection() !== mountedConnection || sdk.client !== mountedClient
    generation++
    listRequest++
    detailRequest++
    abort.abort()
    abort = new AbortController()
    setState({
      switched,
      running: false,
      jobs: [],
      job: undefined,
      pending: undefined,
      unresolved: undefined,
      capability: undefined,
      fileCapability: undefined,
      logs: [],
      summary: "",
      confirmLiveMerge: false,
      submitting: false,
      cancelling: false,
      loading: false,
      loadingJob: false,
      listError: false,
      detailError: false,
      requestUnknown: false,
      notice: "",
      lastObserved: "",
      detailsOpen: false,
      copyStatus: "idle",
    })
    if (!switched) untrack(() => void load())
  })
  createEffect(() => {
    if (!state.detailsOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node) || !detailsElement?.contains(event.target)) return
      // The dialog boundary delegates Escape to this expanded disclosure.
      // Capture before Kobalte's document listener and restore the trigger focus.
      event.preventDefault()
      event.stopPropagation()
      copyRequest++
      setState({ detailsOpen: false, copyStatus: "idle" })
      detailsButton?.focus()
    }
    window.addEventListener("keydown", escape, true)
    onCleanup(() => window.removeEventListener("keydown", escape, true))
  })
  const poll = setInterval(() => {
    if (state.capability && !state.switched && state.job && active(state.job) && !state.loadingJob)
      void detail(state.job.id)
  }, 5000)
  onCleanup(() => {
    disposed = true
    generation++
    abort.abort()
    clearInterval(poll)
  })
  const toggleScope = (scope: Scope) => {
    if (scope !== "session" && !fileScopeAvailable()) return
    setState({
      scopes: state.scopes.includes(scope) ? state.scopes.filter((item) => item !== scope) : [...state.scopes, scope],
      confirmLiveMerge: false,
    })
  }

  const modeOptions = createMemo(() => [
    { value: "codex" as const, label: t("settings.import.preset.codex", "Codex") },
    { value: "claude" as const, label: t("settings.import.preset.claude", "Claude Code") },
    { value: "deepagent" as const, label: t("settings.import.preset.deepagent", "DeepAgent Code bundle") },
    { value: "custom" as const, label: t("settings.import.preset.custom", "Custom") },
  ])
  const formatOptions = createMemo(() => [
    { value: "codex" as const, label: "Codex" },
    { value: "claude" as const, label: "Claude Code" },
  ])
  const scopeOptions: { id: Scope; icon: string }[] = [
    { id: "session", icon: "message" },
    { id: "memory", icon: "bookmark" },
    { id: "skill", icon: "bookmark" },
  ]

  // ZIP/JSON archives retain their separate read-only import endpoint. They are not durable jobs.
  async function snapshot() {
    const file = state.snapshotFile
    if (!file || locked()) return
    const epoch = generation
    setState({ running: true, summary: "", logs: [], job: undefined })
    try {
      const zip = file.name.toLowerCase().endsWith(".zip")
      const bytes = zip ? new Uint8Array(await file.arrayBuffer()) : undefined
      const bundle = bytes
        ? Array.from({ length: Math.ceil(bytes.length / 12288) }, (_, index) =>
            btoa(String.fromCharCode(...bytes.subarray(index * 12288, (index + 1) * 12288))),
          ).join("")
        : await file.text()
      if (!current(epoch)) return
      const result = zip
        ? await sdk.client.session.importBundle({ bundle }, { signal: abort.signal, throwOnError: false })
        : await sdk.client.session.importSnapshot({ bundle }, { signal: abort.signal, throwOnError: false })
      if (!current(epoch)) return
      if (!result.data)
        throw new Error(
          t("settings.import.snapshot.failed", "Archive import failed; check the server before retrying."),
        )
      setState("summary", language.t("settings.import.bundle.done"))
    } catch (error) {
      if (current(epoch))
        push(
          `${t("settings.import.snapshot.failed", "Archive import receipt unavailable. Check the server before retrying.")} ${error instanceof Error ? error.message : String(error)}`,
        )
    } finally {
      if (current(epoch)) setState("running", false)
    }
  }

  async function run(retry = false) {
    if (format() === "deepagent") return snapshot()
    if (state.switched || state.submitting || state.capability !== true) return
    if (retry && !state.pending) return
    if (
      !retry &&
      (locked() ||
        state.scopes.length === 0 ||
        (fileScopes() && (!state.copyLiveDb || (!state.dryRun && state.fileCapability !== true))) ||
        (state.mode === "custom" && !sourcePath()) ||
        (!state.dryRun && !state.copyLiveDb && !state.confirmLiveMerge))
    )
      return
    const payload: ImportJobRequest =
      retry && state.pending
        ? { ...state.pending, scopes: state.pending.scopes ? [...state.pending.scopes] : undefined }
        : {
            requestID: crypto.randomUUID(),
            source: format() as "codex" | "claude",
            sourcePath: sourcePath() || undefined,
            scopes: [...state.scopes],
            dryRun: state.dryRun,
            mode: state.copyLiveDb ? "copy_to_new_db" : "merge_into_live",
            copyLiveDb: state.copyLiveDb,
            confirmLiveMerge: state.confirmLiveMerge,
            cwdFilter: state.cwdFilter.trim() || undefined,
          }
    const epoch = generation
    detailRequest++
    receipt(payload.requestID)
    setState({ submitting: true, pending: payload, requestUnknown: false, notice: "" })
    try {
      const result = await sdk.client.global.importCreate(
        { importJobRequest: payload },
        { signal: abort.signal, throwOnError: false },
      )
      if (!current(epoch)) return
      if (!result.data) {
        if ([400, 401, 403, 409].includes(result.response?.status ?? 0)) {
          receipt()
          setState({
            pending: undefined,
            notice: t(
              "settings.import.job.rejected",
              "The server rejected this request. Review the source, target and confirmation before trying again.",
            ),
          })
          if (result.error && typeof result.error === "object" && "error" in result.error)
            push(String(result.error.error))
          return
        }
        throw new Error("import_receipt_unavailable")
      }
      receipt()
      setState({ pending: undefined, requestUnknown: false, summary: "" })
      receive(result.data, true)
      void refresh()
    } catch {
      if (current(epoch) && state.pending?.requestID === payload.requestID) setState("requestUnknown", true)
    } finally {
      if (current(epoch)) setState("submitting", false)
    }
  }

  async function cancel() {
    const id = state.job?.id
    if (!id || state.cancelling || state.switched || !active(state.job) || state.job?.state === "cancel_requested")
      return
    const epoch = generation
    setState({ cancelling: true, notice: "" })
    try {
      const result = await sdk.client.global.importCancel({ jobID: id }, { signal: abort.signal, throwOnError: false })
      if (!current(epoch)) return
      if (!result.data) throw new Error("cancel_receipt_unavailable")
      receive(result.data)
    } catch {
      if (current(epoch) && state.job?.id === id)
        setState(
          "notice",
          t(
            "settings.import.job.cancelUnknown",
            "Cancellation receipt unavailable. Refresh this job to confirm its state; it may still be writing.",
          ),
        )
    } finally {
      if (current(epoch)) setState("cancelling", false)
    }
  }

  const diagnostics = createMemo(() => {
    const job = state.job
    if (!job) return ""
    return [
      `Job: ${job.id}`,
      `Request: ${job.requestID}`,
      `Revision: ${job.revision}`,
      `State: ${job.state}`,
      `Source: ${job.source}`,
      `Updated: ${date(job.updatedAt)}`,
      `Committed batches: ${job.committedBatches}`,
      ...(job.scopes ? [`Scopes: ${job.scopes.join(", ")}`] : []),
      ...(job.fileResults ?? []).map(
        (result) =>
          `File set: ${result.scope} · ${result.fileCount} files · ${result.bytes} bytes\nManifest: ${result.manifestHash}\nPublished directory: ${result.directoryRef.area}/${result.directoryRef.relative}`,
      ),
      `Failed batches: ${job.failedBatches}`,
      job.activeBatchID ? `Unconfirmed batch: ${job.activeBatchID}` : "",
      job.sourceDigest ? `Source SHA-256: ${job.sourceDigest}` : "",
      job.error ? `${job.error.code}: ${job.error.message}` : "",
      job.target
        ? `Target: ${job.target.id}\nMode: ${job.target.mode}\nDry-run: ${job.target.dryRun}\nDB: ${job.target.dbPath}\nData: ${job.target.dataRoot}\nConfig: ${job.target.configDir}`
        : "",
      job.target?.backup
        ? `Backup: ${job.target.backup.path}\nManifest: ${job.target.backup.manifestPath}\nSHA-256: ${job.target.backup.sha256}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  })

  async function copyDetails() {
    const id = state.job?.id
    const revision = state.job?.revision
    const text = diagnostics()
    const epoch = generation
    if (!id || !text || !state.detailsOpen || state.copyStatus === "copying") return
    const request = ++copyRequest
    setState("copyStatus", "copying")
    const copied = await navigator.clipboard?.writeText(text).then(
      () => true,
      () => false,
    )
    if (
      !current(epoch) ||
      request !== copyRequest ||
      state.job?.id !== id ||
      state.job.revision !== revision ||
      !state.detailsOpen
    )
      return
    setState("copyStatus", copied ? "copied" : "failed")
  }

  function exportLog() {
    const url = URL.createObjectURL(new Blob([state.logs.join("\n")], { type: "text/plain;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `import-observation-${state.job?.id ?? "local"}.txt`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div class="settings-v2-section settings-v2-import">
      <h3 class="settings-v2-section-title">{t("settings.import.section", "Import history")}</h3>

      <Show when={state.switched}>
        <p role="alert" class="text-12-regular text-text-weak">
          {t(
            "settings.import.job.switched",
            "Connection changed. Reopen settings to load import jobs for this connection.",
          )}
        </p>
      </Show>
      <Show when={!state.switched && state.capability === false}>
        <p role="status" class="text-12-regular text-text-weak">
          {t(
            "settings.import.mode.unavailable",
            "This server does not support durable import jobs. Update the server before importing history.",
          )}
        </p>
      </Show>
      <Show when={!state.switched && state.listError}>
        <p role="alert" class="text-12-regular text-text-weak">
          {t(
            "settings.import.job.loadFailed",
            "Import jobs could not be refreshed. Previously loaded evidence may be stale.",
          )}
        </p>
        <ButtonV2 variant="ghost" onClick={() => void (state.capability ? refresh() : load())}>
          {t("settings.import.job.refresh", "Refresh jobs")}
        </ButtonV2>
      </Show>
      <Show when={state.notice}>
        <p role="alert" class="text-12-regular text-text-weak">
          {state.notice}
        </p>
      </Show>

      <SettingsListV2>
        <SettingsRowV2
          title={t("settings.import.source", "Source")}
          description={t("settings.import.source.hint", "Pick a preset, or choose Custom to type a path.")}
        >
          <SelectV2
            appearance="inline"
            disabled={locked()}
            data-action="settings-import-source"
            options={modeOptions()}
            current={modeOptions().find((o) => o.value === state.mode)}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && setState("mode", option.value)}
          />
        </SettingsRowV2>

        <Show when={state.mode === "deepagent"}>
          <SettingsRowV2
            title={language.t("settings.import.bundle.file")}
            description={t(
              "settings.import.snapshot.boundary",
              "ZIP and legacy JSON files import as read-only archives through a separate endpoint. Durable job recovery and cancellation do not apply.",
            )}
          >
            <div class="settings-v2-import-file-picker w-full sm:w-[260px]">
              <input
                ref={snapshotInput}
                aria-label={language.t("settings.import.bundle.file")}
                data-action="settings-import-snapshot-file"
                type="file"
                hidden
                accept=".zip,application/zip,.json,application/json"
                disabled={locked()}
                onChange={(e) => setState("snapshotFile", e.currentTarget.files?.[0])}
              />
              <ButtonV2
                type="button"
                variant="neutral"
                icon="folder-add-left"
                disabled={locked()}
                onClick={() => snapshotInput?.click()}
              >
                {language.t("settings.import.snapshot.choose")}
              </ButtonV2>
              <span class="settings-v2-import-file-name" title={state.snapshotFile?.name} aria-live="polite">
                {state.snapshotFile?.name ??
                  t("settings.import.snapshot.noFile", "Choose a snapshot bundle file first")}
              </span>
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={state.mode === "custom"}>
          <SettingsRowV2
            title={t("settings.import.customPath", "Path")}
            description={t("settings.import.customPath.hint", "Absolute path to the agent data directory.")}
          >
            <div class="flex flex-col gap-2 w-full sm:w-[260px]">
              <TextInputV2
                aria-label={t("settings.import.customPath", "Path")}
                data-action="settings-import-custom-path"
                type="text"
                appearance="base"
                value={state.customPath}
                onInput={(e) => setState("customPath", e.currentTarget.value)}
                disabled={locked()}
                placeholder="~/.codex_backup"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
              <SelectV2
                appearance="inline"
                disabled={locked()}
                data-action="settings-import-custom-format"
                options={formatOptions()}
                current={formatOptions().find((o) => o.value === state.customFormat)}
                placement="bottom-end"
                gutter={6}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(option) => option && setState("customFormat", option.value)}
              />
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={format() !== "deepagent"}>
          <SettingsRowV2
            title={t("settings.import.scope", "What to import")}
            description={t(
              "settings.import.scope.hint",
              "Import selected chat history, memory and skills into an isolated copy. Live merge supports chat history only.",
            )}
          >
            <div
              class="settings-v2-scope-row"
              data-action="settings-import-scope"
              role="group"
              aria-label={t("settings.import.scope", "What to import")}
            >
              <For each={scopeOptions}>
                {(opt) => (
                  <CheckboxV2
                    label={t(`settings.import.scope.${opt.id}`, opt.id)}
                    checked={state.scopes.includes(opt.id)}
                    disabled={locked() || (opt.id !== "session" && !fileScopeAvailable())}
                    onChange={() => toggleScope(opt.id)}
                  />
                )}
              </For>
            </div>
            <Show when={state.fileCapability !== true}>
              <p class="text-12-regular text-text-weak">{language.t("settings.import.fileUnavailable")}</p>
            </Show>
          </SettingsRowV2>

          <SettingsRowV2
            title={t("settings.import.dryRun", "Dry-run")}
            description={t(
              "settings.import.dryRun.hint",
              "Preview parsing and mapping without importing session data.",
            )}
          >
            <div data-action="settings-import-dry-run">
              <Switch
                hideLabel
                checked={state.dryRun}
                disabled={locked()}
                onChange={(c) =>
                  setState({
                    dryRun: c,
                    scopes: c || (state.copyLiveDb && state.fileCapability === true) ? state.scopes : ["session"],
                  })
                }
              >
                {t("settings.import.dryRun", "Dry-run")}
              </Switch>
            </div>
          </SettingsRowV2>

          <SettingsRowV2
            title={t("settings.import.copyLiveDb", "Create an isolated copy")}
            description={t(
              "settings.import.copyLiveDb.hint",
              "Copy the current database and import selected data into an isolated target. This server keeps using its current database.",
            )}
          >
            <div data-action="settings-import-copy-db">
              <Switch
                hideLabel
                checked={state.copyLiveDb}
                disabled={locked() || fileScopes()}
                onChange={(c) => setState("copyLiveDb", c)}
              >
                {t("settings.import.copyLiveDb", "Create an isolated copy")}
              </Switch>
              <Show when={fileScopes()}>
                <p class="text-12-regular text-text-weak">{language.t("settings.import.fileCopyOnly")}</p>
              </Show>
            </div>
          </SettingsRowV2>

          <Show when={!state.copyLiveDb}>
            <SettingsRowV2
              title={t("settings.import.merge", "Merge into current database")}
              description={t(
                "settings.import.merge.hint",
                "Chat history only. A verified database backup must succeed before any live write.",
              )}
            >
              <CheckboxV2
                label={t(
                  "settings.import.merge.confirm",
                  "I confirm writing imported sessions into this server's current database.",
                )}
                checked={state.confirmLiveMerge}
                disabled={locked() || state.dryRun}
                onChange={(checked) => setState("confirmLiveMerge", checked)}
              />
            </SettingsRowV2>
          </Show>

          <SettingsRowV2
            title={t("settings.import.cwdFilter", "Directory filter")}
            description={t(
              "settings.import.cwdFilter.hint",
              "Only import sessions whose directory starts with this prefix.",
            )}
          >
            <div class="w-full sm:w-[260px]">
              <TextInputV2
                aria-label={t("settings.import.cwdFilter", "Directory filter")}
                data-action="settings-import-cwd-filter"
                type="text"
                appearance="base"
                value={state.cwdFilter}
                onInput={(e) => setState("cwdFilter", e.currentTarget.value)}
                disabled={locked()}
                placeholder="~/projects/..."
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={state.unresolved}>
          {(requestID) => (
            <SettingsRowV2
              title={t("settings.import.job.request", "Request receipt")}
              description={
                state.requestUnknown
                  ? state.pending
                    ? t(
                        "settings.import.job.requestUnknown",
                        "The response was lost. This request may already have been accepted. Refresh jobs or retry the same request ID; do not create another import.",
                      )
                    : t(
                        "settings.import.job.restoredUnknown",
                        "A previous request has no confirmed receipt. Only its request ID was saved. Refresh the authorized job history to find it; reopening does not retry the import.",
                      )
                  : t("settings.import.job.submitting", "Submitting…")
              }
            >
              <div class="flex flex-col gap-2 min-w-0">
                <code class="text-12-regular break-all">{requestID()}</code>
                <Show when={state.requestUnknown}>
                  <Show when={state.pending}>
                    <ButtonV2 disabled={state.submitting} onClick={() => void run(true)}>
                      {t("settings.import.job.retryRequest", "Retry same request")}
                    </ButtonV2>
                  </Show>
                  <ButtonV2 variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
                    {t("settings.import.job.refresh", "Refresh jobs")}
                  </ButtonV2>
                  <p class="text-12-regular text-text-weak">
                    {t(
                      "settings.import.job.guardHint",
                      "Releasing this observation guard allows another import. It does not cancel the original request or prove that it stopped.",
                    )}
                  </p>
                  <ButtonV2
                    variant="ghost"
                    disabled={state.submitting}
                    onClick={() => {
                      receipt()
                      setState({
                        pending: undefined,
                        requestUnknown: false,
                        notice: t(
                          "settings.import.job.guardReleased",
                          "Observation guard released. The original request may still be running; check import history before starting another.",
                        ),
                      })
                    }}
                  >
                    {t("settings.import.job.releaseGuard", "Release observation guard")}
                  </ButtonV2>
                </Show>
              </div>
            </SettingsRowV2>
          )}
        </Show>
      </SettingsListV2>
      <div class="settings-v2-import-actions" data-action="settings-import-run">
        <ButtonV2
          data-action="settings-import-submit"
          size="normal"
          variant="neutral"
          class="settings-v2-import-run"
          disabled={
            locked() ||
            (format() === "deepagent"
              ? !state.snapshotFile
              : state.capability !== true ||
                state.scopes.length === 0 ||
                (fileScopes() && (!state.copyLiveDb || (!state.dryRun && state.fileCapability !== true))) ||
                (state.mode === "custom" && !sourcePath()) ||
                (!state.dryRun && !state.copyLiveDb && !state.confirmLiveMerge))
          }
          onClick={() => void run()}
        >
          {state.submitting
            ? t("settings.import.job.submitting", "Submitting…")
            : t("settings.import.run.btn", "Import")}
        </ButtonV2>
      </div>
      <section class="settings-v2-section" data-component="settings-import-history">
        <div class="settings-v2-section-heading">
          <h4 class="settings-v2-section-title">{t("settings.import.job.history", "Import jobs")}</h4>
          <Show when={state.capability && !state.switched}>
            <div class="settings-v2-actions">
              <ButtonV2
                data-action="settings-import-refresh"
                variant="neutral"
                disabled={state.loading}
                onClick={() => void refresh()}
              >
                {t("settings.import.job.refresh", "Refresh jobs")}
              </ButtonV2>
              <Show when={state.cursor}>
                <ButtonV2 variant="ghost" disabled={state.loading} onClick={() => void refresh(true)}>
                  {t("settings.import.job.more", "Load older jobs")}
                </ButtonV2>
              </Show>
            </div>
          </Show>
        </div>
        <SettingsListV2>
          <Show when={state.capability && !state.switched}>
            <SettingsRowV2
              title={t("settings.import.job.select", "Existing job")}
              description={t(
                "settings.import.job.historyHint",
                "Select an existing job to continue observing it. Opening or refreshing a job does not restart the import.",
              )}
            >
              <div class="flex flex-col gap-2 w-full min-w-0">
                <Show
                  when={state.jobs.length > 0}
                  fallback={
                    <p role="status" class="text-12-regular text-text-weak">
                      {state.loading
                        ? t("settings.import.job.loading", "Loading jobs…")
                        : t("settings.import.job.empty", "No import jobs yet.")}
                    </p>
                  }
                >
                  <SelectV2
                    appearance="inline"
                    data-action="settings-import-job"
                    options={state.jobs}
                    current={state.jobs.find((job) => job.id === state.job?.id)}
                    placement="bottom-end"
                    value={(job) => job.id}
                    label={(job) => `${job.source} · ${label(job)} · ${date(job.createdAt)} · ${job.id.slice(-8)}`}
                    onSelect={(job) => {
                      if (!job || job.id === state.job?.id) return
                      detailRequest++
                      setState({ loadingJob: false, notice: "" })
                      receive(job, true)
                      void detail(job.id)
                    }}
                  />
                </Show>
              </div>
            </SettingsRowV2>
          </Show>

          <Show when={state.job}>
            {(job) => (
              <SettingsRowV2 title={t("settings.import.job.current", "Selected job")} description={label(job())}>
                <div class="flex flex-col gap-2 min-w-0 w-full">
                  <dl class="settings-v2-import-summary">
                    <Show when={!job().scopes || job().scopes!.includes("session")}>
                      <div>
                        <dt>
                          {job().dryRun
                            ? t("settings.import.job.identified", "Sessions found")
                            : t("settings.import.job.imported", "Sessions imported")}
                        </dt>
                        <dd>
                          {job().dryRun
                            ? job().totalSessions
                            : `${job().committedSessions ?? (job().scopes?.some((scope) => scope !== "session") ? "—" : job().committedBatches)} / ${job().totalSessions}`}
                        </dd>
                      </div>
                    </Show>
                    <Show when={job().fileResults !== undefined}>
                      <div>
                        <dt>{language.t("settings.import.job.fileSets")}</dt>
                        <dd>{job().fileResults!.length}</dd>
                      </div>
                      <div>
                        <dt>{language.t("settings.import.job.files")}</dt>
                        <dd>{job().fileResults!.reduce((total, result) => total + result.fileCount, 0)}</dd>
                      </div>
                      <div>
                        <dt>{language.t("settings.import.job.bytes")}</dt>
                        <dd>{job().fileResults!.reduce((total, result) => total + result.bytes, 0)}</dd>
                      </div>
                    </Show>
                    <Show when={job().failedBatches > 0}>
                      <div>
                        <dt>{t("settings.import.job.failed", "Failed batches")}</dt>
                        <dd>{job().failedBatches}</dd>
                      </div>
                    </Show>
                    <div>
                      <dt>{t("settings.import.target", "Actual target")}</dt>
                      <dd>
                        {job().target
                          ? job().target!.mode === "copy_to_new_db"
                            ? t("settings.import.job.targetCopy", "Independent copy")
                            : t("settings.import.job.targetLive", "Current database")
                          : t("settings.import.job.targetPending", "Not confirmed yet")}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("settings.import.job.backup", "Backup")}</dt>
                      <dd>
                        {job().dryRun
                          ? t("settings.import.job.backupPreview", "Not needed for a preview")
                          : job().target?.backup
                            ? t("settings.import.job.backupVerified", "Verified by the server before writing")
                            : t("settings.import.job.backupPending", "No verified backup receipt yet")}
                      </dd>
                    </div>
                  </dl>
                  <Show when={job().dryRun}>
                    <p class="text-12-regular text-text-weak">
                      {t(
                        "settings.import.target.dryRun",
                        "Preview target only; no target database or backup was created.",
                      )}
                    </p>
                  </Show>
                  <Show when={job().state === "completed" && !job().dryRun && job().target?.mode === "copy_to_new_db"}>
                    <p class="settings-v2-import-copy-notice" role="status">
                      {t(
                        "settings.import.job.copyComplete",
                        "History was saved to an independent copy. This server still uses its original database, so the imported conversations have not been added to the current conversation list.",
                      )}
                    </p>
                  </Show>
                  <Show when={job().error}>
                    <p role="alert" class="text-12-regular text-text-weak">
                      {job().error!.message}
                    </p>
                  </Show>
                  <Show when={state.detailError}>
                    <p role="alert" class="text-12-regular text-text-weak">
                      {t(
                        "settings.import.job.loadFailed",
                        "Import jobs could not be refreshed. Previously loaded evidence may be stale.",
                      )}
                    </p>
                  </Show>
                  <Show when={job().cancelRequestedAt && !job().stopConfirmedAt}>
                    <p role="status" class="text-12-regular text-text-weak">
                      {t(
                        "settings.import.job.cancelPending",
                        "Cancellation requested. Waiting for the server to confirm a safe stopping boundary; writes may still be in progress.",
                      )}
                    </p>
                  </Show>
                  <Show when={job().stopConfirmedAt && ["cancelled", "cancelled_partial"].includes(job().state)}>
                    <p role="status" class="text-12-regular text-text-weak">
                      {t("settings.import.job.stopped", "Server confirmed the import stopped.")}{" "}
                      {date(job().stopConfirmedAt!)}
                    </p>
                  </Show>
                  <Show when={job().state === "recovery_required"}>
                    <p role="status" class="text-12-regular text-text-weak">
                      {t(
                        "settings.import.job.recovery",
                        "The outcome needs review. Keep this job's target and backup evidence; refreshing will not retry unknown writes.",
                      )}
                    </p>
                  </Show>
                  <Show when={job().committedBatches > 0 && job().state !== "completed"}>
                    <p class="text-12-regular text-text-weak">
                      {t(
                        "settings.import.job.partial",
                        "Committed batches remain in the recorded target. Cancellation or failure does not roll them back.",
                      )}
                    </p>
                  </Show>
                  <div class="flex flex-wrap gap-2">
                    <ButtonV2
                      variant="ghost"
                      disabled={state.loadingJob || state.switched}
                      onClick={() => void detail(job().id)}
                    >
                      {t("settings.import.job.refreshOne", "Refresh selected job")}
                    </ButtonV2>
                    <Show when={active(job()) && job().state !== "cancel_requested"}>
                      <ButtonV2 disabled={state.cancelling || state.switched} onClick={() => void cancel()}>
                        {state.cancelling
                          ? t("settings.import.job.cancelSubmitting", "Requesting cancellation…")
                          : t("settings.import.job.cancel", "Request cancellation")}
                      </ButtonV2>
                    </Show>
                  </div>
                  <div
                    class="settings-v2-import-details"
                    data-dialog-escape-boundary={state.detailsOpen ? "" : undefined}
                    ref={detailsElement}
                  >
                    <ButtonV2
                      ref={detailsButton}
                      variant="ghost"
                      aria-expanded={state.detailsOpen}
                      aria-controls={detailsID}
                      onClick={() => {
                        copyRequest++
                        setState({ detailsOpen: !state.detailsOpen, copyStatus: "idle" })
                      }}
                    >
                      <Icon name={state.detailsOpen ? "chevron-down" : "chevron-right"} size="small" />
                      {t("settings.import.job.details", "Technical details")}
                    </ButtonV2>
                    <Show when={state.detailsOpen}>
                      <div id={detailsID} class="settings-v2-import-details-body">
                        <p class="text-12-regular text-text-weak">
                          {t(
                            "settings.import.job.detailsHint",
                            "Task identifiers, target paths and verification receipts for troubleshooting.",
                          )}
                        </p>
                        <ButtonV2 disabled={state.copyStatus === "copying"} onClick={() => void copyDetails()}>
                          {t("settings.import.job.copyDetails", "Copy diagnostic details")}
                        </ButtonV2>
                        <Show when={state.copyStatus === "copied"}>
                          <p role="status" class="text-12-regular text-text-weak">
                            {t("settings.import.job.copied", "Diagnostic details copied.")}
                          </p>
                        </Show>
                        <Show when={state.copyStatus === "failed"}>
                          <p role="alert" class="text-12-regular text-text-weak">
                            {t(
                              "settings.import.job.copyFailed",
                              "Copy unavailable. Select and copy the details below.",
                            )}
                          </p>
                        </Show>
                        <TextareaV2
                          readOnly
                          rows={8}
                          aria-label={t("settings.import.job.diagnosticText", "Diagnostic details")}
                          value={diagnostics()}
                        />
                        <Show when={state.logs.length > 0}>
                          <p class="text-12-regular text-text-weak">
                            {t(
                              "settings.import.job.localLog",
                              "Local observations only; up to 2,000 lines / 2 MiB. This is not a full server audit log.",
                            )}
                          </p>
                          <ButtonV2 variant="ghost" onClick={exportLog}>
                            {t("settings.import.job.exportLog", "Export observations")}
                          </ButtonV2>
                          <pre class="settings-v2-import-log">
                            <For each={state.logs}>{(line) => line + "\n"}</For>
                          </pre>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </div>
              </SettingsRowV2>
            )}
          </Show>

          <Show when={state.summary}>
            <SettingsRowV2 title={t("settings.import.result", "Result")} description="">
              <pre class="settings-v2-import-log">{state.summary}</pre>
            </SettingsRowV2>
          </Show>

          <Show when={state.logs.length > 0 && !state.job}>
            <SettingsRowV2 title={t("settings.import.log", "Progress")} description="">
              <div class="flex flex-col gap-2 w-full sm:w-[320px] min-w-0">
                <p class="text-12-regular text-text-weak">
                  {t(
                    "settings.import.job.localLog",
                    "Local observations only; up to 2,000 lines / 2 MiB. This is not a full server audit log.",
                  )}
                </p>
                <ButtonV2 variant="ghost" onClick={exportLog}>
                  {t("settings.import.job.exportLog", "Export observations")}
                </ButtonV2>
                <pre class="settings-v2-import-log">
                  <For each={state.logs}>{(line) => line + "\n"}</For>
                </pre>
              </div>
            </SettingsRowV2>
          </Show>
        </SettingsListV2>
      </section>
    </div>
  )
}
