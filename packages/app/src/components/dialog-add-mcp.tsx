import { Component, createMemo, createSignal, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Button } from "@deepagent-code/ui/button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { useLanguage } from "@/context/language"
import { useMcpAdd, useMcpCatalog, useMcpCatalogEnable } from "@/context/mcp"
import { showToast } from "@/utils/toast"
import type { McpLocalConfig, McpRemoteConfig, McpCatalogResponses } from "@deepagent-code/sdk/v2/client"

type CatalogEntry = McpCatalogResponses[200][number]

// U8 + M1 (S1-v3.4): "add MCP server" form with two tabs.
//  - Manual: Local (stdio command[]) or Remote (URL); OAuth handled by the existing connect flow.
//  - From catalog: vetted preset servers; pick one, fill its params + credential references, enable.
//    The backend instantiates a cfg.mcp entry with default-safe templates (read-only paths, isolated
//    browser, restricted DB). Credentials are by key-name only and stored securely, never in config.
export const DialogAddMcp: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const add = useMcpAdd()

  const [tab, setTab] = createSignal<"manual" | "catalog">("manual")
  const [type, setType] = createSignal<"local" | "remote">("local")
  const [name, setName] = createSignal("")
  const [command, setCommand] = createSignal("")
  const [url, setUrl] = createSignal("")

  const valid = createMemo(() => {
    if (!name().trim()) return false
    return type() === "local" ? command().trim().length > 0 : url().trim().length > 0
  })

  const submit = async () => {
    if (!valid() || add.isPending) return
    const config: McpLocalConfig | McpRemoteConfig =
      type() === "local"
        ? { type: "local", command: command().trim().split(/\s+/), enabled: true }
        : { type: "remote", url: url().trim(), enabled: true }
    await add.mutateAsync({ name: name().trim(), config })
    dialog.close()
  }

  return (
    <Dialog title={language.t("dialog.mcp.add.title")}>
      <div class="flex flex-col gap-3 px-3 pb-3">
        <div class="flex gap-2">
          <Button variant={tab() === "manual" ? "primary" : "secondary"} onClick={() => setTab("manual")}>
            {language.t("dialog.mcp.add.tabManual")}
          </Button>
          <Button variant={tab() === "catalog" ? "primary" : "secondary"} onClick={() => setTab("catalog")}>
            {language.t("dialog.mcp.add.tabCatalog")}
          </Button>
        </div>

        <Show when={tab() === "manual"}>
          <ManualForm
            name={name()}
            type={type()}
            command={command()}
            url={url()}
            pending={add.isPending}
            valid={valid()}
            onName={setName}
            onType={setType}
            onCommand={setCommand}
            onUrl={setUrl}
            onSubmit={submit}
            onCancel={() => dialog.close()}
          />
        </Show>

        <Show when={tab() === "catalog"}>
          <CatalogPicker onDone={() => dialog.close()} />
        </Show>
      </div>
    </Dialog>
  )
}

// MANUAL_FORM_PLACEHOLDER

const ManualForm: Component<{
  name: string
  type: "local" | "remote"
  command: string
  url: string
  pending: boolean
  valid: boolean
  onName: (v: string) => void
  onType: (v: "local" | "remote") => void
  onCommand: (v: string) => void
  onUrl: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}> = (props) => {
  const language = useLanguage()
  return (
    <>
      <label class="flex flex-col gap-1">
        <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.name")}</span>
        <InlineInput
          value={props.name}
          placeholder={language.t("dialog.mcp.add.namePlaceholder")}
          onInput={(e) => props.onName(e.currentTarget.value)}
        />
      </label>

      <div class="flex flex-col gap-1">
        <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.type")}</span>
        <div class="flex gap-2">
          <Button variant={props.type === "local" ? "primary" : "secondary"} onClick={() => props.onType("local")}>
            {language.t("dialog.mcp.add.typeLocal")}
          </Button>
          <Button variant={props.type === "remote" ? "primary" : "secondary"} onClick={() => props.onType("remote")}>
            {language.t("dialog.mcp.add.typeRemote")}
          </Button>
        </div>
      </div>

      <Show when={props.type === "local"}>
        <label class="flex flex-col gap-1">
          <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.command")}</span>
          <InlineInput
            value={props.command}
            placeholder={language.t("dialog.mcp.add.commandPlaceholder")}
            onInput={(e) => props.onCommand(e.currentTarget.value)}
          />
        </label>
      </Show>

      <Show when={props.type === "remote"}>
        <label class="flex flex-col gap-1">
          <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.add.url")}</span>
          <InlineInput
            value={props.url}
            placeholder={language.t("dialog.mcp.add.urlPlaceholder")}
            onInput={(e) => props.onUrl(e.currentTarget.value)}
          />
        </label>
      </Show>

      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={props.onCancel}>
          {language.t("dialog.mcp.add.cancel")}
        </Button>
        <Button variant="primary" disabled={!props.valid || props.pending} onClick={props.onSubmit}>
          {language.t("dialog.mcp.add.submit")}
        </Button>
      </div>
    </>
  )
}

const riskLabel = (tier: CatalogEntry["riskTier"], t: ReturnType<typeof useLanguage>["t"]) =>
  tier === "read_only"
    ? t("dialog.mcp.catalog.readOnly")
    : tier === "write_guarded"
      ? t("dialog.mcp.catalog.writeGuarded")
      : t("dialog.mcp.catalog.externalFetch")

const CatalogPicker: Component<{ onDone: () => void }> = (props) => {
  const language = useLanguage()
  const catalog = useMcpCatalog()
  const [selected, setSelected] = createSignal<CatalogEntry | null>(null)

  return (
    <Show when={selected()} fallback={<CatalogList query={catalog} onSelect={setSelected} />}>
      {(entry) => <CatalogEntryForm entry={entry()} onBack={() => setSelected(null)} onDone={props.onDone} />}
    </Show>
  )
}

const CatalogList: Component<{
  query: ReturnType<typeof useMcpCatalog>
  onSelect: (entry: CatalogEntry) => void
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-2">
      <Show
        when={!props.query.isLoading}
        fallback={<span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.catalog.loading")}</span>}
      >
        <Show
          when={(props.query.data ?? []).length > 0}
          fallback={<span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.catalog.empty")}</span>}
        >
          <For each={props.query.data ?? []}>
            {(entry) => (
              <button
                type="button"
                class="flex flex-col items-start gap-0.5 rounded-md border border-border-weak px-3 py-2 text-left hover:bg-surface-hover"
                onClick={() => props.onSelect(entry)}
              >
                <span class="flex w-full items-center justify-between gap-2">
                  <span class="text-12-medium text-text">{entry.title}</span>
                  <span class="text-10-regular text-text-weaker">{riskLabel(entry.riskTier, language.t)}</span>
                </span>
                <span class="text-11-regular text-text-weaker">{entry.description}</span>
              </button>
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}

const CatalogEntryForm: Component<{ entry: CatalogEntry; onBack: () => void; onDone: () => void }> = (props) => {
  const language = useLanguage()
  const enable = useMcpCatalogEnable()
  // Param + credential values are keyed by their spec key. multi params are entered one-per-line.
  const [params, setParams] = createSignal<Record<string, string>>({})
  const [creds, setCreds] = createSignal<Record<string, string>>({})

  const setParam = (key: string, v: string) => setParams((p) => ({ ...p, [key]: v }))
  const setCred = (key: string, v: string) => setCreds((c) => ({ ...c, [key]: v }))

  const valid = createMemo(() => {
    for (const p of props.entry.params) if (p.required && !params()[p.key]?.trim()) return false
    for (const c of props.entry.credentials) if (c.required && !creds()[c.key]?.trim()) return false
    return true
  })

  const submit = async () => {
    if (!valid() || enable.isPending) return
    // Expand multi params (one-per-line) into string[]; single params stay strings.
    const paramPayload: Record<string, string | string[]> = {}
    for (const p of props.entry.params) {
      const raw = params()[p.key]?.trim()
      if (!raw) continue
      paramPayload[p.key] = p.multi
        ? raw
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : raw
    }
    const credRefs: Record<string, string> = {}
    for (const c of props.entry.credentials) {
      const raw = creds()[c.key]?.trim()
      if (raw) credRefs[c.key] = raw
    }
    await enable.mutateAsync({ id: props.entry.id, params: paramPayload, credentialRefs: credRefs })
    showToast({ variant: "success", title: language.t("dialog.mcp.catalog.enabled", { title: props.entry.title }) })
    props.onDone()
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-0.5">
        <span class="text-12-medium text-text">{props.entry.title}</span>
        <span class="text-11-regular text-text-weaker">{props.entry.description}</span>
        <Show when={props.entry.repo}>
          <span class="text-10-regular text-text-weaker">{props.entry.repo}</span>
        </Show>
      </div>

      <Show when={props.entry.params.length > 0}>
        <div class="flex flex-col gap-2">
          <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.catalog.paramsTitle")}</span>
          <For each={props.entry.params}>
            {(p) => (
              <label class="flex flex-col gap-1">
                <span class="text-11-regular text-text-weaker">
                  {p.key}
                  <Show when={!p.required}> ({language.t("dialog.mcp.catalog.optional")})</Show>
                  <Show when={p.multi}> · {language.t("dialog.mcp.catalog.multiHint")}</Show>
                </span>
                <Show
                  when={p.multi}
                  fallback={
                    <InlineInput
                      value={params()[p.key] ?? ""}
                      placeholder={p.description}
                      onInput={(e) => setParam(p.key, e.currentTarget.value)}
                    />
                  }
                >
                  {/* multi-value params are one-per-line, so they need a multi-line input */}
                  <textarea
                    class="min-h-16 resize-y rounded-md border border-border-weak bg-surface px-2 py-1 text-12-regular text-text"
                    value={params()[p.key] ?? ""}
                    placeholder={p.description}
                    onInput={(e) => setParam(p.key, e.currentTarget.value)}
                  />
                </Show>
              </label>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.entry.credentials.length > 0}>
        <div class="flex flex-col gap-2">
          <span class="text-11-regular text-text-weaker">{language.t("dialog.mcp.catalog.credentialsTitle")}</span>
          <For each={props.entry.credentials}>
            {(c) => (
              <label class="flex flex-col gap-1">
                <span class="text-11-regular text-text-weaker">
                  {c.key}
                  <Show when={!c.required}> ({language.t("dialog.mcp.catalog.optional")})</Show>
                </span>
                <InlineInput
                  type="password"
                  value={creds()[c.key] ?? ""}
                  placeholder={c.description}
                  onInput={(e) => setCred(c.key, e.currentTarget.value)}
                />
                <span class="text-10-regular text-text-weaker">
                  {language.t("dialog.mcp.catalog.credentialSecret")}
                </span>
              </label>
            )}
          </For>
        </div>
      </Show>

      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={props.onBack}>
          {language.t("dialog.mcp.catalog.back")}
        </Button>
        <Button variant="primary" disabled={!valid() || enable.isPending} onClick={submit}>
          {enable.isPending ? language.t("dialog.mcp.catalog.enabling") : language.t("dialog.mcp.catalog.enable")}
        </Button>
      </div>
    </div>
  )
}
