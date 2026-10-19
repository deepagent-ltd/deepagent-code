import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { submitFacadeName } from "@/pages/session/im-panel-helpers"
import { useIMClient, type IMResolveResult } from "@/utils/im-client"
import { facadeFailureText, type FacadeFailureLike } from "./facade-errors"
import type { IMGroup } from "./types"

export function IMContactsPage(props: {
  active: boolean
  available: boolean
  account: string | undefined
  groups: readonly IMGroup[]
  openGroup: (id: string) => void
  openDirect: (name: string) => Promise<boolean>
}) {
  const language = useLanguage()
  const client = useIMClient()
  const [state, setState] = createStore({
    query: "",
    busy: false,
    result: undefined as IMResolveResult | undefined,
    failure: undefined as FacadeFailureLike | undefined,
  })
  const lifetime = { generation: 0, disposed: false, abort: new AbortController() }
  createEffect(() => {
    props.active
    props.available
    props.account
    client.scope()
    lifetime.generation++
    lifetime.abort.abort()
    lifetime.abort = new AbortController()
    setState({ result: undefined, failure: undefined, busy: false })
  })
  onCleanup(() => {
    lifetime.disposed = true
    lifetime.abort.abort()
  })
  const lookup = async () => {
    if (!props.active || !props.available || state.busy) return
    const generation = ++lifetime.generation
    const scope = client.scope()
    const account = props.account
    setState({ busy: true, result: undefined, failure: undefined })
    const result = await submitFacadeName(state.query, (name) => client.facadeResolve(name, lifetime.abort.signal))
    if (
      lifetime.disposed ||
      generation !== lifetime.generation ||
      scope !== client.scope() ||
      account !== props.account
    )
      return
    setState("busy", false)
    if ("skipped" in result) return
    if ("errorCode" in result) {
      setState("failure", result)
      return
    }
    if (
      !result.value ||
      typeof result.value.uuid !== "string" ||
      !result.value.uuid ||
      result.value.uuid.length > 128 ||
      typeof result.value.name !== "string" ||
      !validateIMName(result.value.name).ok
    ) {
      setState("failure", { errorCode: "invalid_response", errorMessage: "Invalid contact response" })
      return
    }
    setState("result", { uuid: result.value.uuid, name: result.value.name })
  }
  const send = async () => {
    const result = state.result
    if (!result || !props.active || !props.available || state.busy) return
    const generation = ++lifetime.generation
    setState("busy", true)
    await props
      .openDirect(result.name)
      .catch((error: unknown) => {
        if (lifetime.disposed || generation !== lifetime.generation) return
        const code =
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "transport_error"
        setState("failure", {
          errorCode: code,
          errorMessage: error instanceof Error ? error.message : "Contact unavailable",
        })
      })
      .finally(() => {
        if (!lifetime.disposed && generation === lifetime.generation) setState("busy", false)
      })
  }
  return (
    <section class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4" data-slot="im-contacts-page">
      <form
        class="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void lookup()
        }}
      >
        <label class="text-12-medium text-text-strong" for="im-contact-name">
          {language.t("im.contacts.find")}
        </label>
        <div class="flex gap-2">
          <input
            id="im-contact-name"
            class="min-w-0 flex-1 rounded-lg bg-surface-raised-base px-3 py-2 text-13-regular outline-none focus-visible:ring-2 focus-visible:ring-border-interactive-base"
            value={state.query}
            placeholder={language.t("im.contacts.placeholder")}
            disabled={!props.available || state.busy}
            onInput={(event) => setState({ query: event.currentTarget.value, result: undefined, failure: undefined })}
          />
          <Button
            type="submit"
            size="small"
            variant="secondary"
            disabled={!props.available || state.busy || !state.query.trim()}
          >
            {state.busy ? language.t("im.loading") : language.t("im.contacts.find")}
          </Button>
        </div>
        <p class="text-11-regular text-text-weak">{language.t("im.contacts.exact")}</p>
      </form>
      <Show when={!props.available}>
        <p role="status" class="text-12-regular text-text-weak">
          {language.t("im.contacts.unavailable")}
        </p>
      </Show>
      <Show when={state.failure}>
        {(failure) => (
          <p role="alert" class="text-12-regular text-text-critical">
            {facadeFailureText(language.t, failure())}
          </p>
        )}
      </Show>
      <Show when={state.result}>
        {(result) => (
          <div class="flex items-center gap-3 rounded-xl bg-surface-raised-base p-3">
            <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-panel text-text-weak">
              {Array.from(result().name)[0] ?? "?"}
            </div>
            <span class="min-w-0 flex-1 truncate text-13-medium">{result().name}</span>
            <Button
              size="small"
              variant="primary"
              disabled={state.busy || !props.available}
              onClick={() => void send()}
            >
              {language.t("im.contacts.message")}
            </Button>
          </div>
        )}
      </Show>
      <div class="flex flex-col gap-2">
        <h3 class="text-12-medium text-text-weak">{language.t("im.contacts.recent")}</h3>
        <For
          each={props.groups.filter((group) => group.type === "direct")}
          fallback={<p class="py-4 text-center text-12-regular text-text-weak">{language.t("im.contacts.empty")}</p>}
        >
          {(group) => (
            <button
              type="button"
              class="flex min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-surface-raised-base-hover"
              onClick={() => props.openGroup(group.id)}
            >
              <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-raised-base text-13-medium text-text-weak">
                {Array.from(group.name)[0] ?? "?"}
              </span>
              <span class="min-w-0 flex-1 truncate text-13-regular">{group.name}</span>
              <Icon name="chevron-right" size="small" />
            </button>
          )}
        </For>
      </div>
    </section>
  )
}
