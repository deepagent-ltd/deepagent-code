import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Button } from "@deepagent-code/ui/button"
import { TextField } from "@deepagent-code/ui/text-field"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import {
  listPending,
  setStatus,
  listEnvFacts,
  decideEnvFact,
  modifyEnvFact,
  type KnowledgeItem,
  type ReviewClient,
  type EnvFactItem,
} from "./dialog-review.api"
import "../settings-v2/settings-v2.css"

// Re-export the pure client API (defined in dialog-review.api.ts, kept UI-import-free so the route
// contract test can load it server-side) for back-compat with existing importers.
export {
  listPending,
  setStatus,
  listEnvFacts,
  decideEnvFact,
  modifyEnvFact,
  type KnowledgeItem,
  type ReviewClient,
  type EnvFactBody,
  type EnvFactItem,
  type EnvFactList,
  type EnvFactModifyInput,
} from "./dialog-review.api"

export const DialogReview: Component<{ client: ReviewClient }> = (props) => {
  const language = useLanguage()
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = createSignal(false)
  const [items, { refetch }] = createResource(async () => listPending(props.client))
  const [envFacts, { refetch: refetchEnv }] = createResource(async () => listEnvFacts(props.client))
  const [envBusy, setEnvBusy] = createSignal<string | null>(null)

  const decideEnv = async (factId: string, decision: "adopt" | "reject") => {
    if (envBusy()) return
    setEnvBusy(factId)
    try {
      await decideEnvFact(props.client, factId, decision)
      await refetchEnv()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("review.envFacts.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setEnvBusy(null)
    }
  }

  // §G.5 inline edit form. `editing` holds the fact_id whose card is expanded into an edit form; the
  // draft mirrors the editable fields (credentials are never editable here — only secret_ref
  // pointers, which stay untouched). Submitting posts modify() with the chosen mode then re-adopts.
  type EnvDraft = {
    description: string
    host: string
    port: string
    container: string
    purpose: string
    notes: string
    mode: "global" | "project"
  }
  const [editing, setEditing] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal<EnvDraft | null>(null)

  const openEdit = (fact: EnvFactItem) => {
    const b = fact.body
    setDraft({
      description: fact.description,
      host: b?.host ?? "",
      port: b?.port !== undefined ? String(b.port) : "",
      container: b?.container ?? "",
      purpose: b?.purpose ?? "",
      notes: b?.notes ?? "",
      mode: "global",
    })
    setEditing(fact.fact_id)
  }
  const cancelEdit = () => {
    setEditing(null)
    setDraft(null)
  }
  const patchDraft = (patch: Partial<EnvDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const submitEdit = async (fact: EnvFactItem) => {
    const d = draft()
    if (!d || envBusy()) return
    const portNum = d.port.trim() === "" ? undefined : Number(d.port)
    if (portNum !== undefined && (!Number.isFinite(portNum) || portNum < 0)) {
      showToast({
        variant: "error",
        title: language.t("review.envFacts.title"),
        description: language.t("review.envFacts.portInvalid"),
      })
      return
    }
    setEnvBusy(fact.fact_id)
    try {
      await modifyEnvFact(props.client, {
        factId: fact.fact_id,
        description: d.description.trim() || fact.description,
        body: {
          ...(d.host.trim() ? { host: d.host.trim() } : {}),
          ...(portNum !== undefined ? { port: portNum } : {}),
          ...(d.container.trim() ? { container: d.container.trim() } : {}),
          ...(d.purpose.trim() ? { purpose: d.purpose.trim() } : {}),
          ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
          // Preserve the credential pointers and confirmation stamp from the original fact.
          ...(fact.body?.secret_refs ? { secret_refs: fact.body.secret_refs } : {}),
          last_confirmed_at: fact.body?.last_confirmed_at ?? new Date().toISOString(),
        },
        mode: d.mode,
      })
      cancelEdit()
      await refetchEnv()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("review.envFacts.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setEnvBusy(null)
    }
  }

  // Free-text filter across summary + type + evidence refs. Empty query = show everything.
  const [query, setQuery] = createSignal("")
  const matchesQuery = (item: KnowledgeItem) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    if (item.summary.toLowerCase().includes(q)) return true
    if (item.type.toLowerCase().includes(q)) return true
    if (language.t(`review.type.${item.type}`).toLowerCase().includes(q)) return true
    return item.evidence_refs.some((ref) => ref.toLowerCase().includes(q))
  }

  // Rejected (and superseded, which the backend already excludes) are noise — hide them.
  // Pending is grouped by knowledge type (one collapsible box per type); approved gets its own box.
  const pending = createMemo(() => (items() ?? []).filter((i) => i.approval_status === "pending" && matchesQuery(i)))
  const approved = createMemo(() => (items() ?? []).filter((i) => i.approval_status === "approved" && matchesQuery(i)))

  // Stable display order for the type boxes. Any unknown type falls back into "other".
  const TYPE_ORDER = ["memory", "failure_dossier", "knowledge", "strategy", "methodology", "skill"] as const
  const typeLabel = (type: string) =>
    (TYPE_ORDER as readonly string[]).includes(type)
      ? language.t(`review.type.${type}`)
      : language.t("review.type.other")

  // Group pending items by type, preserving TYPE_ORDER; trailing "other" bucket for unknown types.
  const pendingGroups = createMemo(() => {
    const byType = new Map<string, KnowledgeItem[]>()
    for (const item of pending()) {
      const key = (TYPE_ORDER as readonly string[]).includes(item.type) ? item.type : "other"
      const list = byType.get(key)
      if (list) list.push(item)
      else byType.set(key, [item])
    }
    const ordered: Array<{ type: string; items: KnowledgeItem[] }> = []
    for (const type of TYPE_ORDER) {
      const list = byType.get(type)
      if (list?.length) ordered.push({ type, items: list })
    }
    const other = byType.get("other")
    if (other?.length) ordered.push({ type: "other", items: other })
    return ordered
  })

  // Which boxes are expanded. Default: all pending type boxes open, approved collapsed.
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set(["approved"]))
  const isOpen = (key: string) => !collapsed().has(key)
  const toggleGroup = (key: string) => {
    const next = new Set(collapsed())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setCollapsed(next)
  }

  const toggle = (id: string) => {
    const next = new Set<string>(selected())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const selectAll = () => setSelected(new Set(pending().map((i) => i.id)))
  const invert = () => {
    const cur = selected()
    setSelected(
      new Set(
        pending()
          .map((i) => i.id)
          .filter((id) => !cur.has(id)),
      ),
    )
  }

  const apply = async (action: "approve" | "reject-ids") => {
    const ids = [...selected()]
    if (ids.length === 0 || busy()) return
    setBusy(true)
    try {
      await setStatus(props.client, action, ids)
      setSelected(new Set<string>())
      await refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("review.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const Row = (item: KnowledgeItem) => {
    const checked = createMemo(() => selected().has(item.id))
    return (
      <label
        data-action="review-item"
        data-status={item.approval_status}
        class="flex cursor-pointer items-start gap-3 border-b border-v2-border-border-muted px-3 py-2.5 last:border-b-0 hover:bg-v2-background-bg-layer-01"
      >
        <input type="checkbox" class="mt-0.5" checked={checked()} onChange={() => toggle(item.id)} />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="break-words text-13-medium text-v2-text-text-base">{item.summary}</span>
          <span class="break-words text-11-regular text-v2-text-text-faint">
            {item.type}
            {" · "}
            {language.t("review.strength", { value: language.t(`review.strength.${item.evidence_strength}`) })}
            <Show when={item.evidence_refs.length > 0}>
              {" · "}
              {language.t("review.evidence", { count: item.evidence_refs.length })}
            </Show>
          </span>
        </div>
      </label>
    )
  }

  // §G.5 use-gate card: a provisional environment fact awaiting this project's decision. Endpoint /
  // container / purpose are shown plainly (no credentials — those are secret_ref pointers), plus the
  // last-confirmed timestamp so the user can judge staleness, and a degraded warning (§G.6).
  const EnvFactCard = (fact: EnvFactItem, kind: "pending" | "adopted") => {
    const endpoint = () => {
      const b = fact.body
      if (!b) return ""
      const hostPort = b.host ? (b.port ? `${b.host}:${b.port}` : b.host) : ""
      return [hostPort, b.container ? `(${b.container})` : ""].filter(Boolean).join(" ")
    }
    const busy = createMemo(() => envBusy() === fact.fact_id)
    const isEditing = createMemo(() => editing() === fact.fact_id)
    return (
      <div
        data-action="env-fact-item"
        data-kind={kind}
        class="flex flex-col border-b border-v2-border-border-muted last:border-b-0"
      >
        <div class="flex items-start gap-3 px-3 py-2.5">
          <Icon name="server" size="small" class="mt-0.5 text-v2-text-text-faint" />
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="break-words text-13-medium text-v2-text-text-base">{fact.description}</span>
            <span class="break-words text-11-regular text-v2-text-text-faint">
              <Show when={endpoint()}>{endpoint()}</Show>
              <Show when={fact.body?.purpose}>
                {" · "}
                {fact.body!.purpose}
              </Show>
              <Show when={fact.body?.last_confirmed_at}>
                {" · "}
                {language.t("review.envFacts.lastConfirmed", { value: fact.body!.last_confirmed_at })}
              </Show>
            </span>
            <Show when={fact.degraded}>
              <span class="break-words text-11-regular text-v2-state-fg-danger">
                {language.t("review.envFacts.degraded")}
              </span>
            </Show>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="small"
              data-action="env-fact-edit"
              onClick={() => (isEditing() ? cancelEdit() : openEdit(fact))}
              disabled={busy()}
            >
              {language.t(isEditing() ? "review.envFacts.cancel" : "review.envFacts.edit")}
            </Button>
            <Show when={kind === "pending"}>
              <Button
                variant="secondary"
                size="small"
                data-action="env-fact-reject"
                onClick={() => void decideEnv(fact.fact_id, "reject")}
                disabled={busy()}
              >
                {language.t("review.envFacts.reject")}
              </Button>
              <Button
                variant="primary"
                size="small"
                data-action="env-fact-adopt"
                onClick={() => void decideEnv(fact.fact_id, "adopt")}
                disabled={busy()}
              >
                {language.t("review.envFacts.adopt")}
              </Button>
            </Show>
          </div>
        </div>

        {/* §G.5 inline edit form: edit non-credential fields, choose global-correction vs
            project-override, then save (which also adopts the edited fact for this project). */}
        <Show when={isEditing() && draft()}>
          {(() => {
            const d = draft()!
            return (
              <div
                data-action="env-fact-edit-form"
                class="flex flex-col gap-3 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-3"
              >
                <TextField
                  label={language.t("review.envFacts.field.description")}
                  value={d.description}
                  onChange={(v) => patchDraft({ description: v })}
                />
                <div class="flex gap-3">
                  <div class="flex-1">
                    <TextField
                      label={language.t("review.envFacts.field.host")}
                      value={d.host}
                      onChange={(v) => patchDraft({ host: v })}
                    />
                  </div>
                  <div class="w-24">
                    <TextField
                      label={language.t("review.envFacts.field.port")}
                      value={d.port}
                      inputMode="numeric"
                      onChange={(v) => patchDraft({ port: v })}
                    />
                  </div>
                </div>
                <TextField
                  label={language.t("review.envFacts.field.container")}
                  value={d.container}
                  onChange={(v) => patchDraft({ container: v })}
                />
                <TextField
                  label={language.t("review.envFacts.field.purpose")}
                  value={d.purpose}
                  onChange={(v) => patchDraft({ purpose: v })}
                />
                <TextField
                  label={language.t("review.envFacts.field.notes")}
                  value={d.notes}
                  multiline
                  rows={2}
                  onChange={(v) => patchDraft({ notes: v })}
                />
                <div class="flex flex-col gap-1">
                  <span class="text-11-medium text-v2-text-text-base">{language.t("review.envFacts.field.scope")}</span>
                  <div class="flex gap-4">
                    <label class="flex cursor-pointer items-center gap-1.5 text-11-regular text-v2-text-text-faint">
                      <input
                        type="radio"
                        name={`env-scope-${fact.fact_id}`}
                        checked={d.mode === "global"}
                        onChange={() => patchDraft({ mode: "global" })}
                      />
                      {language.t("review.envFacts.scope.global")}
                    </label>
                    <label class="flex cursor-pointer items-center gap-1.5 text-11-regular text-v2-text-text-faint">
                      <input
                        type="radio"
                        name={`env-scope-${fact.fact_id}`}
                        checked={d.mode === "project"}
                        onChange={() => patchDraft({ mode: "project" })}
                      />
                      {language.t("review.envFacts.scope.project")}
                    </label>
                  </div>
                  <span class="text-11-regular text-v2-text-text-faint">
                    {language.t(d.mode === "global" ? "review.envFacts.scope.globalHint" : "review.envFacts.scope.projectHint")}
                  </span>
                </div>
                <div class="flex items-center justify-end gap-2">
                  <Button variant="secondary" size="small" onClick={cancelEdit} disabled={busy()}>
                    {language.t("review.envFacts.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    data-action="env-fact-save"
                    onClick={() => void submitEdit(fact)}
                    disabled={busy()}
                  >
                    {language.t("review.envFacts.save")}
                  </Button>
                </div>
              </div>
            )
          })()}
        </Show>
      </div>
    )
  }

  // One collapsible box: a header (chevron + label + count) that toggles a body of Rows.
  // One collapsible box. Height hugs its content — the single scroll container is the wrapper below,
  // so a collapsed box is just its header row (no empty filler).
  const GroupBox = (input: { boxKey: string; label: string; items: KnowledgeItem[] }) => (
    <div class="shrink-0 overflow-hidden rounded-lg border border-v2-border-border-muted">
      <button
        type="button"
        data-action="review-group-toggle"
        data-group={input.boxKey}
        class="flex w-full items-center gap-2 bg-v2-background-bg-layer-01 px-3 py-2.5 text-left hover:bg-v2-background-bg-layer-02"
        onClick={() => toggleGroup(input.boxKey)}
      >
        <Icon name={isOpen(input.boxKey) ? "chevron-down" : "chevron-right"} size="small" />
        <span class="flex-1 text-13-medium text-v2-text-text-base">{input.label}</span>
        <span class="text-11-regular text-v2-text-text-faint">{input.items.length}</span>
      </button>
      <Show when={isOpen(input.boxKey)}>
        <div class="border-t border-v2-border-border-muted">
          <For each={input.items}>{(item) => Row(item)}</For>
        </div>
      </Show>
    </div>
  )

  return (
    <Dialog size="x-large" variant="settings" title={language.t("review.title")}>
      <div class="settings-v2-panel" data-component="review-dialog">
        <div class="settings-v2-tab-body deepagent-dialog-body">
          <p class="text-12-regular text-v2-text-text-faint">{language.t("review.description")}</p>

          {/* Top bar: search on the left, batch actions on the right. */}
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-v2-border-border-muted px-3 py-2">
              <Icon name="magnifying-glass" size="small" class="text-v2-text-text-faint" />
              <input
                type="text"
                data-action="review-search"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder={language.t("review.search")}
                aria-label={language.t("review.search")}
                class="min-w-0 flex-1 bg-transparent text-13-regular text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
              />
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="small" onClick={selectAll} disabled={pending().length === 0}>
                {language.t("review.selectAll")}
              </Button>
              <Button variant="secondary" size="small" onClick={invert} disabled={pending().length === 0}>
                {language.t("review.invertSelection")}
              </Button>
              <Show when={selected().size > 0}>
                <span class="text-11-regular text-v2-text-text-faint">
                  {language.t("review.selected", { count: selected().size })}
                </span>
              </Show>
              <Button
                variant="secondary"
                size="small"
                data-action="review-reject"
                onClick={() => void apply("reject-ids")}
                disabled={selected().size === 0 || busy()}
              >
                {language.t("review.reject")}
              </Button>
              <Button
                variant="primary"
                size="small"
                data-action="review-approve"
                onClick={() => void apply("approve")}
                disabled={selected().size === 0 || busy()}
              >
                {language.t("review.approve")}
              </Button>
            </div>
          </div>

          {/* §G use-gate: provisional environment facts awaiting this project's decision. Only shown
              when there is something pending or already adopted, so it stays out of the way. */}
          <Show when={(envFacts()?.pending.length ?? 0) > 0 || (envFacts()?.adopted.length ?? 0) > 0}>
            <div class="flex flex-col gap-1">
              <span class="text-12-medium text-v2-text-text-base">{language.t("review.envFacts.title")}</span>
              <span class="text-11-regular text-v2-text-text-faint">{language.t("review.envFacts.description")}</span>
            </div>
            <div class="deepagent-dialog-scroll rounded-lg border border-v2-border-border-muted">
              <For each={envFacts()?.pending ?? []}>{(fact) => EnvFactCard(fact, "pending")}</For>
              <For each={envFacts()?.adopted ?? []}>{(fact) => EnvFactCard(fact, "adopted")}</For>
            </div>
          </Show>

          {/* Single scroll container holds the type boxes; each box hugs its own content. */}
          <div class="deepagent-dialog-scroll flex flex-col gap-2">
            <Show
              when={!items.loading}
              fallback={
                <div class="rounded-lg border border-v2-border-border-muted p-4 text-13-regular text-v2-text-text-faint">
                  {language.t("review.loading")}
                </div>
              }
            >
              <Show
                when={pendingGroups().length > 0 || approved().length > 0}
                fallback={
                  <div class="rounded-lg border border-v2-border-border-muted p-4 text-13-regular text-v2-text-text-faint">
                    {query().trim() ? language.t("review.searchEmpty") : language.t("review.empty")}
                  </div>
                }
              >
                <For each={pendingGroups()}>
                  {(group) => GroupBox({ boxKey: group.type, label: typeLabel(group.type), items: group.items })}
                </For>
                <Show when={approved().length > 0}>
                  {GroupBox({ boxKey: "approved", label: language.t("review.status.approved"), items: approved() })}
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
