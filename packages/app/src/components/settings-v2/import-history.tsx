import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { Icon } from "@deepagent-code/ui/icon"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { Switch } from "@deepagent-code/ui/v2/switch-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type SourceFormat = "codex" | "claude"
type SourceMode = SourceFormat | "custom"
type Scope = "session" | "memory" | "skill"
type ProgressEvent =
  | { phase: "discover"; source: SourceFormat; count: number }
  | { phase: "write-session"; sessionId: string; turns: number; reimport: boolean }
  | { phase: "write-memory"; staged: number }
  | { phase: "write-skill"; written: number }
  | { phase: "warn"; message: string; label?: string }
  | { phase: "done"; report: any }
  | { phase: "error"; message: string }

interface HttpBase {
  url: string
  username?: string
  password?: string
  bearer?: string
}

function authHeader(http: HttpBase | undefined): Record<string, string> {
  if (!http) return {}
  if (http.bearer) return { Authorization: `Bearer ${http.bearer}` }
  if (http.password) {
    const user = http.username ?? "deepagent-code"
    return { Authorization: `Basic ${btoa(`${user}:${http.password}`)}` }
  }
  return {}
}

async function streamImport(
  baseUrl: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  onEvent: (e: ProgressEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${baseUrl}/global/import`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText)
    onEvent({ phase: "error", message: `HTTP ${res.status}: ${text.slice(0, 200)}` })
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"))
      if (!dataLine) continue
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()) as ProgressEvent)
      } catch {
        /* skip malformed */
      }
    }
  }
}

export const ImportSection: Component = () => {
  const language = useLanguage()
  const server = useServer()

  const [mode, setMode] = createSignal<SourceMode>("codex")
  const [customPath, setCustomPath] = createSignal("")
  const [customFormat, setCustomFormat] = createSignal<SourceFormat>("codex")
  const [scopes, setScopes] = createSignal<Scope[]>(["session", "memory", "skill"])
  const [dryRun, setDryRun] = createSignal(false)
  const [copyLiveDb, setCopyLiveDb] = createSignal(true)
  const [cwdFilter, setCwdFilter] = createSignal("")
  const [running, setRunning] = createSignal(false)
  const [logs, setLogs] = createSignal<string[]>([])
  const [summary, setSummary] = createSignal<string>("")

  let abort: AbortController | undefined

  const http = (): HttpBase | undefined => (server.current as { http?: HttpBase } | undefined)?.http
  const t = (k: string, fallback: string) => {
    const v = language.t(k)
    return v === k ? fallback : v
  }
  const push = (line: string) => setLogs((l) => [...l, line])
  const toggleScope = (s: Scope) => {
    const cur = scopes()
    setScopes(cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s])
  }

  const format = createMemo<SourceFormat>(() => (mode() === "custom" ? customFormat() : (mode() as SourceFormat)))
  const sourcePath = createMemo<string>(() => (mode() === "custom" ? customPath().trim() : ""))

  const modeOptions = createMemo(() => [
    { value: "codex" as const, label: t("settings.import.preset.codex", "Codex") },
    { value: "claude" as const, label: t("settings.import.preset.claude", "Claude Code") },
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

  const run = async () => {
    if (running()) return
    setLogs([])
    setSummary("")
    setRunning(true)
    abort = new AbortController()
    const h = http()
    const src = format()
    push(`→ ${src}${mode() === "custom" ? ` (custom: ${sourcePath() || "default"})` : ` (default)`} · scopes: ${scopes().join(",")}${dryRun() ? " · dry-run" : ""}`)
    try {
      await streamImport(
        h?.url ?? "",
        authHeader(h),
        {
          source: src,
          sourcePath: sourcePath() || undefined,
          scopes: scopes(),
          dryRun: dryRun(),
          copyLiveDb: copyLiveDb(),
          cwdFilter: cwdFilter().trim() || undefined,
        },
        (e) => {
          switch (e.phase) {
            case "discover":
              push(`  discovered ${e.count} session(s)`)
              break
            case "write-session":
              push(`  [session] ${e.sessionId.slice(0, 16)}… · ${e.turns} turns${e.reimport ? " · re-imported" : ""}`)
              break
            case "write-memory":
              push(`  [memory] staged ${e.staged} candidate(s) for review`)
              break
            case "write-skill":
              push(`  [skill] wrote ${e.written}`)
              break
            case "warn":
              push(`  [warn] ${e.label ?? ""} ${e.message}`)
              break
            case "error":
              push(`  [error] ${e.message}`)
              break
            case "done": {
              const r = e.report
              setSummary(
                [
                  `Done in ${r.elapsedMs}ms`,
                  `sessions=${r.sessions?.length ?? 0}`,
                  r.memory ? `memories_staged=${r.memory.staged}` : "",
                  r.skills ? `skills=${r.skills.written}` : "",
                  r.warnings?.length ? `warnings=${r.warnings.length}` : "",
                  r.dryRun ? "(dry-run)" : "",
                ]
                  .filter(Boolean)
                  .join("  ·  "),
              )
              break
            }
          }
        },
        abort.signal,
      )
    } catch (err) {
      push(`  [error] ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const cancel = () => {
    abort?.abort()
    setRunning(false)
    push("  (cancelled)")
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{t("settings.import.section", "Import history")}</h3>

      <SettingsListV2>
        <SettingsRowV2 title={t("settings.import.source", "Source")} description={t("settings.import.source.hint", "Pick a preset, or choose Custom to type a path.")}>
          <SelectV2
            appearance="inline"
            data-action="settings-import-source"
            options={modeOptions()}
            current={modeOptions().find((o) => o.value === mode())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && setMode(option.value)}
          />
        </SettingsRowV2>

        <Show when={mode() === "custom"}>
          <SettingsRowV2 title={t("settings.import.customPath", "Path")} description={t("settings.import.customPath.hint", "Absolute path to the agent data directory.")}>
            <div class="flex flex-col gap-2 w-full sm:w-[260px]">
              <TextInputV2
                data-action="settings-import-custom-path"
                type="text"
                appearance="base"
                value={customPath()}
                onInput={(e) => setCustomPath(e.currentTarget.value)}
                disabled={running()}
                placeholder="~/.codex_backup"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
              <SelectV2
                appearance="inline"
                data-action="settings-import-custom-format"
                options={formatOptions()}
                current={formatOptions().find((o) => o.value === customFormat())}
                placement="bottom-end"
                gutter={6}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(option) => option && setCustomFormat(option.value)}
              />
            </div>
          </SettingsRowV2>
        </Show>

        <SettingsRowV2 title={t("settings.import.scope", "What to import")} description={t("settings.import.scope.hint", "Click to toggle one or more categories.")}>
          <div class="settings-v2-scope-row" data-action="settings-import-scope">
            <For each={scopeOptions}>
              {(opt) => {
                const active = () => scopes().includes(opt.id)
                return (
                  <button
                    type="button"
                    class="settings-v2-scope-toggle"
                    classList={{ "settings-v2-scope-toggle--active": active() }}
                    disabled={running()}
                    onClick={() => toggleScope(opt.id)}
                  >
                    <span class="settings-v2-scope-toggle-mark">
                      <Show when={active()}>
                        <Icon name="check" size="small" />
                      </Show>
                    </span>
                    <span class="settings-v2-scope-toggle-label">{t(`settings.import.scope.${opt.id}`, opt.id)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </SettingsRowV2>

        <SettingsRowV2 title={t("settings.import.dryRun", "Dry-run")} description={t("settings.import.dryRun.hint", "Parse and map only; write nothing.")}>
          <div data-action="settings-import-dry-run">
            <Switch checked={dryRun()} onChange={(c) => setDryRun(c)} />
          </div>
        </SettingsRowV2>

        <SettingsRowV2 title={t("settings.import.copyLiveDb", "Snapshot live DB")} description={t("settings.import.copyLiveDb.hint", "Write into a copy of the live DB (recommended) instead of the live DB.")}>
          <div data-action="settings-import-copy-db">
            <Switch checked={copyLiveDb()} disabled={dryRun()} onChange={(c) => setCopyLiveDb(c)} />
          </div>
        </SettingsRowV2>

        <SettingsRowV2 title={t("settings.import.cwdFilter", "Directory filter")} description={t("settings.import.cwdFilter.hint", "Only import sessions whose directory starts with this prefix.")}>
          <div class="w-full sm:w-[260px]">
            <TextInputV2
              data-action="settings-import-cwd-filter"
              type="text"
              appearance="base"
              value={cwdFilter()}
              onInput={(e) => setCwdFilter(e.currentTarget.value)}
              disabled={running()}
              placeholder="~/projects/..."
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
            />
          </div>
        </SettingsRowV2>

        <div class="settings-v2-import-actions" data-action="settings-import-run">
          <ButtonV2
            size="large"
            variant="contrast"
            class="settings-v2-import-run"
            disabled={running() || scopes().length === 0}
            onClick={run}
          >
            {running() ? t("settings.import.running", "Importing…") : t("settings.import.run.btn", "Import")}
          </ButtonV2>
          <Show when={running()}>
            <ButtonV2 size="large" variant="ghost" onClick={cancel}>
              {t("settings.import.cancel", "Cancel")}
            </ButtonV2>
          </Show>
        </div>

        <Show when={summary()}>
          <SettingsRowV2 title={t("settings.import.result", "Result")} description="">
            <pre class="settings-v2-import-log">{summary()}</pre>
          </SettingsRowV2>
        </Show>

        <Show when={logs().length > 0}>
          <SettingsRowV2 title={t("settings.import.log", "Progress")} description="">
            <pre class="settings-v2-import-log">
              <For each={logs()}>{(line) => line + "\n"}</For>
            </pre>
          </SettingsRowV2>
        </Show>
      </SettingsListV2>
    </div>
  )
}
