import { Component, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog, DialogFooter } from "@deepagent-code/ui/v2/dialog-v2"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { FieldV2 } from "@deepagent-code/ui/v2/field-v2"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@deepagent-code/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { TextareaV2 } from "@deepagent-code/ui/v2/textarea-v2"
import { Switch } from "@deepagent-code/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { useMcpAdd, useMcpCatalog, useMcpCatalogEnable } from "@/context/mcp"
import { showToast } from "@/utils/toast"
import type { McpLocalConfig, McpRemoteConfig, McpCatalogResponses } from "@deepagent-code/sdk/client"
import "./dialog-add-mcp.css"

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

  const [state, setState] = createStore({
    tab: "manual" as "manual" | "catalog",
    type: "local" as "local" | "remote",
    name: "",
    command: "",
    url: "",
    oauthDisabled: false,
  })

  const valid = createMemo(() => {
    if (!state.name.trim()) return false
    return state.type === "local" ? state.command.trim().length > 0 : state.url.trim().length > 0
  })

  const submit = async () => {
    if (!valid() || add.isPending) return
    const config: McpLocalConfig | McpRemoteConfig =
      state.type === "local"
        ? { type: "local", command: state.command.trim().split(/\s+/), enabled: true }
        : { type: "remote", url: state.url.trim(), enabled: true, ...(state.oauthDisabled ? { oauth: false } : {}) }
    await add.mutateAsync({ name: state.name.trim(), config })
    dialog.close()
  }

  return (
    <Dialog title={language.t("dialog.mcp.add.title")} fit class="mcp-add-dialog">
      <div class="mcp-add-mode">
        <SegmentedControlV2
          value={state.tab}
          aria-label={language.t("dialog.mcp.add.title")}
          onChange={(value) => {
            if (value === "manual" || value === "catalog") setState("tab", value)
          }}
        >
          <SegmentedControlItemV2 value="manual">{language.t("dialog.mcp.add.tabManual")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="catalog">{language.t("dialog.mcp.add.tabCatalog")}</SegmentedControlItemV2>
        </SegmentedControlV2>
      </div>

      <Show when={state.tab === "manual"}>
        <ManualForm
          name={state.name}
          type={state.type}
          command={state.command}
          url={state.url}
          oauthDisabled={state.oauthDisabled}
          pending={add.isPending}
          valid={valid()}
          onName={(value) => setState("name", value)}
          onType={(value) => setState("type", value)}
          onCommand={(value) => setState("command", value)}
          onUrl={(value) => setState("url", value)}
          onOauthDisabled={(value) => setState("oauthDisabled", value)}
          onSubmit={submit}
          onCancel={() => dialog.close()}
        />
      </Show>

      <Show when={state.tab === "catalog"}>
        <CatalogPicker onDone={() => dialog.close()} />
      </Show>
    </Dialog>
  )
}

const ManualForm: Component<{
  name: string
  type: "local" | "remote"
  command: string
  url: string
  oauthDisabled: boolean
  pending: boolean
  valid: boolean
  onName: (v: string) => void
  onType: (v: "local" | "remote") => void
  onCommand: (v: string) => void
  onUrl: (v: string) => void
  onOauthDisabled: (v: boolean) => void
  onSubmit: () => void
  onCancel: () => void
}> = (props) => {
  const language = useLanguage()
  return (
    <>
      <div class="mcp-add-fields">
        <FieldV2>
          <FieldV2.Label>{language.t("dialog.mcp.add.name")}</FieldV2.Label>
          <TextInputV2
            appearance="large"
            value={props.name}
            placeholder={language.t("dialog.mcp.add.namePlaceholder")}
            onInput={(e) => props.onName(e.currentTarget.value)}
          />
        </FieldV2>

        <div class="mcp-add-field">
          <span class="mcp-add-label">{language.t("dialog.mcp.add.type")}</span>
          <SegmentedControlV2
            value={props.type}
            aria-label={language.t("dialog.mcp.add.type")}
            onChange={(value) => {
              if (value === "local" || value === "remote") props.onType(value)
            }}
          >
            <SegmentedControlItemV2 value="local">{language.t("dialog.mcp.add.typeLocal")}</SegmentedControlItemV2>
            <SegmentedControlItemV2 value="remote">{language.t("dialog.mcp.add.typeRemote")}</SegmentedControlItemV2>
          </SegmentedControlV2>
        </div>

        <Show when={props.type === "local"}>
          <FieldV2>
            <FieldV2.Label>{language.t("dialog.mcp.add.command")}</FieldV2.Label>
            <TextInputV2
              appearance="large"
              value={props.command}
              placeholder={language.t("dialog.mcp.add.commandPlaceholder")}
              onInput={(e) => props.onCommand(e.currentTarget.value)}
            />
          </FieldV2>
        </Show>

        <Show when={props.type === "remote"}>
          <FieldV2>
            <FieldV2.Label>{language.t("dialog.mcp.add.url")}</FieldV2.Label>
            <TextInputV2
              appearance="large"
              value={props.url}
              placeholder={language.t("dialog.mcp.add.urlPlaceholder")}
              onInput={(e) => props.onUrl(e.currentTarget.value)}
            />
          </FieldV2>
          <div class="mcp-add-oauth">
            <span class="mcp-add-description">
              {props.oauthDisabled
                ? language.t("dialog.mcp.configure.oauthDisabled")
                : language.t("dialog.mcp.configure.oauthAuto")}
            </span>
            <Switch checked={!props.oauthDisabled} onChange={(value) => props.onOauthDisabled(!value)}>
              {language.t("dialog.mcp.configure.oauth")}
            </Switch>
          </div>
        </Show>
      </div>

      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={props.onCancel}>
          {language.t("dialog.mcp.add.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!props.valid || props.pending} onClick={props.onSubmit}>
          {language.t("dialog.mcp.add.submit")}
        </ButtonV2>
      </DialogFooter>
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
  const catalog = useMcpCatalog()
  const [state, setState] = createStore({ selected: null as CatalogEntry | null })

  return (
    <Show
      when={state.selected}
      fallback={
        <CatalogList query={catalog} onSelect={(entry) => setState("selected", entry)} onCancel={props.onDone} />
      }
    >
      {(entry) => <CatalogEntryForm entry={entry()} onBack={() => setState("selected", null)} onDone={props.onDone} />}
    </Show>
  )
}

const CatalogList: Component<{
  query: ReturnType<typeof useMcpCatalog>
  onSelect: (entry: CatalogEntry) => void
  onCancel: () => void
}> = (props) => {
  const language = useLanguage()
  return (
    <>
      <div class="mcp-add-fields mcp-add-catalog">
        <Show
          when={!props.query.isLoading}
          fallback={<span class="mcp-add-description">{language.t("dialog.mcp.catalog.loading")}</span>}
        >
          <Show
            when={(props.query.data ?? []).length > 0}
            fallback={<span class="mcp-add-description">{language.t("dialog.mcp.catalog.empty")}</span>}
          >
            <For each={props.query.data ?? []}>
              {(entry) => (
                <button type="button" class="mcp-add-catalog-entry" onClick={() => props.onSelect(entry)}>
                  <span class="mcp-add-catalog-heading">
                    <span class="mcp-add-label">{entry.title}</span>
                    <span class="mcp-add-risk">{riskLabel(entry.riskTier, language.t)}</span>
                  </span>
                  <span class="mcp-add-description">{entry.description}</span>
                </button>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={props.onCancel}>
          {language.t("dialog.mcp.add.cancel")}
        </ButtonV2>
      </DialogFooter>
    </>
  )
}

const CatalogEntryForm: Component<{ entry: CatalogEntry; onBack: () => void; onDone: () => void }> = (props) => {
  const language = useLanguage()
  const enable = useMcpCatalogEnable()
  // Param + credential values are keyed by their spec key. multi params are entered one-per-line.
  const [state, setState] = createStore({ params: {} as Record<string, string>, creds: {} as Record<string, string> })

  const setParam = (key: string, v: string) => setState("params", key, v)
  const setCred = (key: string, v: string) => setState("creds", key, v)

  const valid = createMemo(() => {
    for (const p of props.entry.params) if (p.required && !state.params[p.key]?.trim()) return false
    for (const c of props.entry.credentials) if (c.required && !state.creds[c.key]?.trim()) return false
    return true
  })

  const submit = async () => {
    if (!valid() || enable.isPending) return
    // Expand multi params (one-per-line) into string[]; single params stay strings.
    const paramPayload: Record<string, string | string[]> = {}
    for (const p of props.entry.params) {
      const raw = state.params[p.key]?.trim()
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
      const raw = state.creds[c.key]?.trim()
      if (raw) credRefs[c.key] = raw
    }
    await enable.mutateAsync({ id: props.entry.id, params: paramPayload, credentialRefs: credRefs })
    showToast({ variant: "success", title: language.t("dialog.mcp.catalog.enabled", { title: props.entry.title }) })
    props.onDone()
  }

  return (
    <>
      <div class="mcp-add-fields">
        <div class="mcp-add-field">
          <span class="mcp-add-label">{props.entry.title}</span>
          <span class="mcp-add-description">{props.entry.description}</span>
          <Show when={props.entry.repo}>
            <span class="mcp-add-description">{props.entry.repo}</span>
          </Show>
        </div>

        <Show when={props.entry.params.length > 0}>
          <div class="mcp-add-section">
            <span class="mcp-add-section-title">{language.t("dialog.mcp.catalog.paramsTitle")}</span>
            <For each={props.entry.params}>
              {(p) => (
                <FieldV2>
                  <FieldV2.Label>
                    {p.key}
                    <Show when={!p.required}> ({language.t("dialog.mcp.catalog.optional")})</Show>
                    <Show when={p.multi}> · {language.t("dialog.mcp.catalog.multiHint")}</Show>
                  </FieldV2.Label>
                  <Show
                    when={p.multi}
                    fallback={
                      <TextInputV2
                        appearance="large"
                        value={state.params[p.key] ?? ""}
                        placeholder={p.description}
                        onInput={(e) => setParam(p.key, e.currentTarget.value)}
                      />
                    }
                  >
                    {/* multi-value params are one-per-line, so they need a multi-line input */}
                    <TextareaV2
                      value={state.params[p.key] ?? ""}
                      placeholder={p.description}
                      onInput={(e) => setParam(p.key, e.currentTarget.value)}
                    />
                  </Show>
                </FieldV2>
              )}
            </For>
          </div>
        </Show>

        <Show when={props.entry.credentials.length > 0}>
          <div class="mcp-add-section">
            <span class="mcp-add-section-title">{language.t("dialog.mcp.catalog.credentialsTitle")}</span>
            <For each={props.entry.credentials}>
              {(c) => (
                <FieldV2>
                  <FieldV2.Label>
                    {c.key}
                    <Show when={!c.required}> ({language.t("dialog.mcp.catalog.optional")})</Show>
                  </FieldV2.Label>
                  <TextInputV2
                    appearance="large"
                    type="password"
                    value={state.creds[c.key] ?? ""}
                    placeholder={c.description}
                    onInput={(e) => setCred(c.key, e.currentTarget.value)}
                  />
                  <FieldV2.Suffix>{language.t("dialog.mcp.catalog.credentialSecret")}</FieldV2.Suffix>
                </FieldV2>
              )}
            </For>
          </div>
        </Show>
      </div>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={props.onBack}>
          {language.t("dialog.mcp.catalog.back")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!valid() || enable.isPending} onClick={submit}>
          {enable.isPending ? language.t("dialog.mcp.catalog.enabling") : language.t("dialog.mcp.catalog.enable")}
        </ButtonV2>
      </DialogFooter>
    </>
  )
}
