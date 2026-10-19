import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@deepagent-code/sdk/client"
import { Button } from "@deepagent-code/ui/button"
import { Collapsible } from "@deepagent-code/ui/collapsible"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { List, type ListRef } from "@deepagent-code/ui/list"
import { ProviderIcon } from "@deepagent-code/ui/provider-icon"
import { Spinner } from "@deepagent-code/ui/spinner"
import { TextField } from "@deepagent-code/ui/text-field"
import { showToast } from "@/utils/toast"
import { createEffect, createMemo, createResource, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { isOfficialProvider } from "@deepagent-code/core/provider-official"
import { providerPreset } from "@deepagent-code/core/provider-presets"

// Recommended/official providers ship a fixed protocol (npm) tied to a canonical endpoint. Letting
// users point one of these at a relay/local server silently breaks because the protocol no longer
// matches the endpoint — those users must add a custom provider instead. So the connect dialog hides
// the baseURL field for these and only exposes it for ad-hoc config/custom providers. Google and xAI
// resolve their real endpoint from the bundled SDK; the URL here only satisfies form validation and
// the placeholder. Keys must exist for every official id (see OFFICIAL_PROVIDER_IDS in core).
const providerBaseURL = (providerID: string) => providerPreset(providerID)?.api

// Official = first-party in the backend (key store credentials, fixed protocol). This must match the
// backend's OFFICIAL_PROVIDER_IDS exactly so the connect flow routes credentials the same way the
// loader reads them (auth for official, config options.apiKey for third-party).
const isBuiltinProvider = (providerID: string) => isOfficialProvider(providerID)

type DiscoveredProviderModel = { id: string; name: string }

export function DialogConnectProvider(props: { provider: string; onBack?: () => void }) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const providers = useProviders()

  const all = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const alive = { value: true }
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  onCleanup(() => {
    alive.value = false
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const provider = createMemo(
    () => providers.all().get(props.provider) ?? serverSync.data.provider.all.get(props.provider)!,
  )
  const fallback = createMemo<ProviderAuthMethod[]>(() => [
    {
      type: "api" as const,
      label: language.t("provider.connect.method.apiKey"),
    },
  ])
  const [auth] = createResource(
    () => props.provider,
    async () => {
      const cached = serverSync.data.provider_auth[props.provider]
      if (cached) return cached
      const res = await serverSDK.client.provider.auth()
      if (!alive.value) return fallback()
      serverSync.set("provider_auth", res.data ?? {})
      return res.data?.[props.provider] ?? fallback()
    },
  )
  const loading = createMemo(() => auth.loading && !serverSync.data.provider_auth[props.provider])
  const methods = createMemo(() => auth.latest ?? serverSync.data.provider_auth[props.provider] ?? fallback())
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    state: "pending" as undefined | "pending" | "complete" | "error" | "prompt",
    error: undefined as string | undefined,
  })

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.prompt" }
    | { type: "auth.pending" }
    | { type: "auth.complete"; authorization: ProviderAuthAuthorization }
    | { type: "auth.error"; error: string }

  function dispatch(action: Action) {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.prompt") {
          draft.state = "prompt"
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          return
        }
        if (action.type === "auth.complete") {
          draft.state = "complete"
          draft.authorization = action.authorization
          draft.error = undefined
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex!) : undefined))

  const methodLabel = (value?: { type?: string; label?: string }) => {
    if (!value) return ""
    if (value.type === "api") return language.t("provider.connect.method.apiKey")
    return value.label ?? ""
  }

  function formatError(value: unknown, fallback: string): string {
    if (value && typeof value === "object" && "data" in value) {
      const data = (value as { data?: { message?: unknown } }).data
      if (typeof data?.message === "string" && data.message) return data.message
    }
    if (value && typeof value === "object" && "error" in value) {
      const nested = formatError((value as { error?: unknown }).error, "")
      if (nested) return nested
    }
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message
      if (typeof message === "string" && message) return message
    }
    if (value instanceof Error && value.message) return value.message
    if (typeof value === "string" && value) return value
    return fallback
  }

  async function selectMethod(index: number, inputs?: Record<string, string>) {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    const method = methods()[index]
    dispatch({ type: "method.select", index })

    if (method.type === "oauth") {
      if (method.prompts?.length && !inputs) {
        dispatch({ type: "auth.prompt" })
        return
      }
      dispatch({ type: "auth.pending" })
      const start = Date.now()
      await serverSDK.client.provider.oauth
        .authorize(
          {
            providerID: props.provider,
            method: index,
            inputs,
          },
          { throwOnError: true },
        )
        .then((x) => {
          if (!alive.value) return
          const elapsed = Date.now() - start
          const delay = 1000 - elapsed

          if (delay > 0) {
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = undefined
              if (!alive.value) return
              dispatch({ type: "auth.complete", authorization: x.data! })
            }, delay)
            return
          }
          dispatch({ type: "auth.complete", authorization: x.data! })
        })
        .catch((e) => {
          if (!alive.value) return
          dispatch({ type: "auth.error", error: formatError(e, language.t("common.requestFailed")) })
        })
    }
  }

  function OAuthPromptsView() {
    const [formStore, setFormStore] = createStore({
      value: {} as Record<string, string>,
      index: 0,
    })

    const prompts = createMemo<NonNullable<ProviderAuthMethod["prompts"]>>(() => {
      const value = method()
      if (value?.type !== "oauth") return []
      return value.prompts ?? []
    })
    const matches = (prompt: NonNullable<ReturnType<typeof prompts>[number]>, value: Record<string, string>) => {
      if (!prompt.when) return true
      const actual = value[prompt.when.key]
      if (actual === undefined) return false
      return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
    }
    const current = createMemo(() => {
      const all = prompts()
      const index = all.findIndex((prompt, index) => index >= formStore.index && matches(prompt, formStore.value))
      if (index === -1) return
      return {
        index,
        prompt: all[index],
      }
    })
    const valid = createMemo(() => {
      const item = current()
      if (!item || item.prompt.type !== "text") return false
      const value = formStore.value[item.prompt.key] ?? ""
      return value.trim().length > 0
    })

    async function next(index: number, value: Record<string, string>) {
      if (store.methodIndex === undefined) return
      const next = prompts().findIndex((prompt, i) => i > index && matches(prompt, value))
      if (next !== -1) {
        setFormStore("index", next)
        return
      }
      await selectMethod(store.methodIndex, value)
    }

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      const item = current()
      if (!item || item.prompt.type !== "text") return
      if (!valid()) return
      await next(item.index, formStore.value)
    }

    const item = () => current()
    const text = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "text") return
      return prompt
    })
    const select = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "select") return
      return prompt
    })

    return (
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <Switch>
          <Match when={item()?.prompt.type === "text"}>
            <TextField
              type="text"
              label={text()?.message ?? ""}
              placeholder={text()?.placeholder}
              value={text() ? (formStore.value[text()!.key] ?? "") : ""}
              onChange={(value) => {
                const prompt = text()
                if (!prompt) return
                setFormStore("value", prompt.key, value)
              }}
            />
            <Button class="w-auto" type="submit" size="large" variant="primary" disabled={!valid()}>
              {language.t("common.continue")}
            </Button>
          </Match>
          <Match when={item()?.prompt.type === "select"}>
            <div class="w-full flex flex-col gap-1.5">
              <div class="text-14-regular text-text-base">{select()?.message}</div>
              <div>
                <List
                  class="px-3"
                  items={select()?.options ?? []}
                  key={(x) => x.value}
                  current={select()?.options.find((x) => x.value === formStore.value[select()!.key])}
                  onSelect={(value) => {
                    if (!value) return
                    const prompt = select()
                    if (!prompt) return
                    const nextValue = {
                      ...formStore.value,
                      [prompt.key]: value.value,
                    }
                    setFormStore("value", prompt.key, value.value)
                    void next(item()!.index, nextValue)
                  }}
                >
                  {(option) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{option.label}</span>
                      <span class="text-14-regular text-text-weak">{option.hint}</span>
                    </div>
                  )}
                </List>
              </div>
            </div>
          </Match>
        </Switch>
      </form>
    )
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  let auto = false
  createEffect(() => {
    if (auto) return
    if (loading()) return
    if (methods().length === 1) {
      auto = true
      void selectMethod(0)
    }
  })

  async function complete() {
    await serverSDK.client.global.dispose()
    serverSync.refreshProviders()
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.saved.title"),
      description: language.t("provider.connect.oauth.catalogUnverified"),
    })
  }

  function goBack() {
    if (props.onBack) {
      props.onBack()
      return
    }
    if (methods().length === 1) {
      all()
      return
    }
    if (store.authorization) {
      dispatch({ type: "method.reset" })
      return
    }
    if (store.methodIndex !== undefined) {
      dispatch({ type: "method.reset" })
      return
    }
    all()
  }

  function MethodSelection() {
    return (
      <>
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.selectMethod", { provider: provider().name })}
        </div>
        <div>
          <List
            class="px-3"
            ref={(ref) => {
              listRef = ref
            }}
            items={methods}
            key={(m) => m?.label}
            onSelect={async (selected, index) => {
              if (!selected) return
              void selectMethod(index)
            }}
          >
            {(i) => (
              <div class="w-full flex items-center gap-x-2">
                <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                  <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                </div>
                <span>{methodLabel(i)}</span>
              </div>
            )}
          </List>
        </div>
      </>
    )
  }

  function ApiAuthView() {
    const catalogModels = () =>
      Object.values(provider().models ?? {}).map((model) => ({
        id: model.id,
        name: model.name || model.id,
      }))
    // Official-provider transport settings are surfaced by the config overlay under
    // provider.<id>.options (backed by SettingsStore, not the config file). Seed the fields from there.
    const transportOption = (key: string): string => {
      const value = serverSync.data.config.provider?.[props.provider]?.options?.[key]
      if (value === false) return "0"
      return typeof value === "number" ? String(value) : ""
    }
    const [formStore, setFormStore] = createStore({
      value: "",
      baseURL:
        providerBaseURL(props.provider) ??
        (typeof serverSync.data.config.provider?.[props.provider]?.options?.baseURL === "string"
          ? serverSync.data.config.provider[props.provider]!.options!.baseURL
          : ((provider().models && Object.values(provider().models)[0]?.api?.url) ?? "")),
      error: undefined as string | undefined,
      baseURLError: undefined as string | undefined,
      discovered: [] as DiscoveredProviderModel[],
      selectedModels: [] as string[],
      discovering: false,
      saving: false,
      saved: false,
      credentialSaved: false,
      configured: false,
      manualAvailable: false,
      manual: false,
      manualID: "",
      manualConsent: false,
      headerTimeout: transportOption("headerTimeout"),
      chunkTimeout: transportOption("chunkTimeout"),
      timeout: transportOption("timeout"),
      maxRetries: transportOption("maxRetries"),
      transportError: undefined as string | undefined,
    })
    const protocol = () => {
      if (props.provider === "deepagent") return "OpenAI Responses / Chat · Anthropic Messages"
      const npm = providerPreset(props.provider)?.npm ?? Object.values(provider().models)[0]?.api?.npm
      if (npm === "@ai-sdk/anthropic") return "Anthropic Messages"
      if (npm === "@ai-sdk/openai") return "OpenAI Responses"
      if (npm === "@ai-sdk/google") return "Google Gemini"
      if (npm === "@ai-sdk/xai") return "xAI"
      if (npm === "@openrouter/ai-sdk-provider") return "OpenRouter"
      return "OpenAI-compatible"
    }

    // Parse a transport field: empty → undefined (use default); "0" for header/request timeout →
    // false (disabled); otherwise a positive integer. Returns { ok, value } so callers can reject
    // malformed input.
    function parseTransport(raw: string, allowFalse: boolean): { ok: boolean; value: number | false | undefined } {
      const trimmed = raw.trim()
      if (trimmed === "") return { ok: true, value: undefined }
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < 0) return { ok: false, value: undefined }
      if (n === 0) return allowFalse ? { ok: true, value: false } : { ok: false, value: undefined }
      return { ok: true, value: n }
    }

    // Build the SettingsStore-bound options patch for an official provider (routed via the config
    // overlay's intercept). Returns undefined when a field is malformed.
    function transportOptions(): Record<string, number | false> | undefined | "invalid" {
      const header = parseTransport(formStore.headerTimeout, true)
      const chunk = parseTransport(formStore.chunkTimeout, false)
      const request = parseTransport(formStore.timeout, true)
      const retries = parseTransport(formStore.maxRetries, false)
      if (!header.ok || !chunk.ok || !request.ok || !retries.ok) return "invalid"
      const options: Record<string, number | false> = {}
      if (header.value !== undefined) options.headerTimeout = header.value
      if (chunk.value !== undefined && chunk.value !== false) options.chunkTimeout = chunk.value
      if (request.value !== undefined) options.timeout = request.value
      if (retries.value !== undefined && retries.value !== false) options.maxRetries = retries.value
      return options
    }

    const owner = { active: true, request: undefined as AbortController | undefined }
    onCleanup(() => {
      owner.active = false
      owner.request?.abort()
    })
    const reset = () => {
      owner.request?.abort()
      owner.request = undefined
      setFormStore({
        discovered: [],
        selectedModels: [],
        error: undefined,
        saved: false,
        discovering: false,
        credentialSaved: false,
        configured: false,
        manualAvailable: false,
        manual: false,
        manualID: "",
        manualConsent: false,
      })
    }

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      if (formStore.discovering || formStore.saving) return
      const key = formStore.value.trim()
      const baseURL = providerBaseURL(props.provider) ?? (formStore.baseURL ?? "").trim()
      if (!key) {
        setFormStore("error", language.t("provider.connect.apiKey.required"))
        return
      }
      if (!baseURL || !/^https?:\/\//.test(baseURL)) {
        setFormStore("baseURLError", language.t("provider.custom.error.baseURL.format"))
        return
      }
      const transport = transportOptions()
      if (transport === "invalid") {
        setFormStore("transportError", language.t("provider.connect.transport.error.number"))
        return
      }
      reset()
      const request = new AbortController()
      owner.request = request
      setFormStore({ discovering: true, baseURLError: undefined, transportError: undefined })
      try {
        const npm = providerPreset(props.provider)?.npm ?? Object.values(provider().models)[0]?.api?.npm
        const discovered = await serverSDK.client.provider.models.discover(
          {
            providerID: props.provider,
            baseURL,
            apiKey: key,
            kind: npm === "@ai-sdk/anthropic" ? "anthropic" : npm === "@ai-sdk/google" ? "google" : "openai-compatible",
          },
          { throwOnError: true, signal: request.signal },
        )
        if (!owner.active || owner.request !== request) return
        const models = discovered.data?.models ?? []
        if (!models.length) throw new Error(language.t("provider.connect.models.empty"))
        setFormStore({
          discovered: models,
          selectedModels: models
            .filter(
              (model) => serverSync.data.config.providers?.[props.provider]?.models?.[model.id]?.disabled !== true,
            )
            .map((model) => model.id),
        })
      } catch (error) {
        if (!owner.active || owner.request !== request) return
        const message = formatError(error, language.t("common.requestFailed"))
        setFormStore({
          error: message,
          manualAvailable: providerPreset(props.provider)?.billing === "plan" && /\bHTTP (404|405|501)\b/.test(message),
        })
      } finally {
        if (owner.active && owner.request === request) setFormStore("discovering", false)
      }
    }

    const addManualModel = () => {
      const id = formStore.manualID.trim()
      if (!id || formStore.discovered.some((model) => model.id === id)) return
      setFormStore({
        discovered: [...formStore.discovered, { id, name: id }],
        selectedModels: [...formStore.selectedModels, id],
        manualID: "",
        configured: false,
      })
    }

    async function saveSelection() {
      if (formStore.saving || formStore.discovering || formStore.saved) return
      if (formStore.manual && !formStore.manualConsent) return
      if (!formStore.selectedModels.length || !formStore.discovered.length) {
        setFormStore("error", language.t("provider.connect.models.selectionRequired"))
        return
      }
      const transport = transportOptions()
      if (transport === "invalid") {
        setFormStore("transportError", language.t("provider.connect.transport.error.number"))
        return
      }
      setFormStore({ saving: true, error: undefined })
      try {
        // The probe never persists a credential. The explicit confirmation below uses the
        // existing credential/config routes only for this exact product identity.
        const key = formStore.value.trim()
        const current = serverSync.data.config.provider?.[props.provider] ?? {}
        if (isBuiltinProvider(props.provider) && key && !formStore.credentialSaved) {
          await serverSDK.client.auth.set(
            { providerID: props.provider, auth: { type: "api", key } },
            { throwOnError: true },
          )
          if (owner.active) setFormStore("credentialSaved", true)
        }
        if (!owner.active) return
        if (!formStore.configured)
          await serverSDK.client.global.config.update(
            {
              config: {
                providers: {
                  [props.provider]: {
                    models: Object.fromEntries(
                      [
                        ...new Set([
                          ...catalogModels().map((model) => model.id),
                          ...formStore.discovered.map((model) => model.id),
                        ]),
                      ].map((id) => [id, { disabled: !formStore.selectedModels.includes(id) }]),
                    ),
                  },
                },
                provider: {
                  [props.provider]: isBuiltinProvider(props.provider)
                    ? { options: transport }
                    : {
                        ...current,
                        name: current.name ?? provider().name,
                        npm: providerPreset(props.provider)?.npm ?? current.npm,
                        options: {
                          ...current.options,
                          baseURL: providerBaseURL(props.provider) ?? (formStore.baseURL ?? "").trim(),
                          ...(key ? { apiKey: key } : {}),
                        },
                        discovery: !formStore.manual,
                        ...(formStore.manual
                          ? {
                              models: {
                                ...current.models,
                                ...Object.fromEntries(
                                  formStore.discovered.map((model) => [
                                    model.id,
                                    { ...current.models?.[model.id], name: model.name },
                                  ]),
                                ),
                              },
                            }
                          : {}),
                      },
                },
                disabled_providers: (serverSync.data.config.disabled_providers ?? []).filter(
                  (id) => id !== props.provider,
                ),
              },
            },
            { throwOnError: true },
          )
        if (!owner.active) return
        setFormStore("configured", true)
        await serverSDK.client.global.dispose({ throwOnError: true })
        if (!owner.active) return
        serverSync.refreshProviders()
        setFormStore("saved", true)
        showToast({
          variant: "success",
          title: formStore.manual
            ? language.t("provider.connect.models.manualSaved")
            : language.t("provider.connect.toast.connected.title", { provider: provider().name }),
        })
      } catch (error) {
        if (owner.active) {
          const message = formatError(error, language.t("common.requestFailed"))
          setFormStore(
            "error",
            formStore.credentialSaved && !formStore.configured
              ? `${language.t("provider.connect.models.preferencesFailed")} ${message}`
              : message,
          )
        }
      } finally {
        if (owner.active) setFormStore("saving", false)
      }
    }

    return (
      <div class="flex flex-col gap-6">
        <Show when={providerPreset(props.provider)}>
          {(preset) => (
            <details
              class="grid min-w-0 gap-2 rounded-lg bg-surface-raised-base p-3 text-12-regular"
              data-component="provider-connection-metadata"
            >
              <summary class="cursor-pointer">{language.t("settings.details.title")}</summary>
              <p>
                {language.t(`settings.providers.billing.${preset().billing}`)} ·{" "}
                {language.t(`settings.providers.region.${preset().region}`)}
              </p>
              <dl class="grid min-w-0 gap-2">
                <div>
                  <dt class="text-text-weak">{language.t("provider.custom.field.protocol.label")}</dt>
                  <dd class="break-words">{protocol()}</dd>
                </div>
                <div>
                  <dt class="text-text-weak">{language.t("provider.custom.field.baseURL.label")}</dt>
                  <dd>
                    <code class="break-all select-text">{formStore.baseURL}</code>
                  </dd>
                </div>
              </dl>
            </details>
          )}
        </Show>
        <Show when={catalogModels().length === 0 && formStore.discovered.length === 0}>
          <p class="text-12-regular text-text-weak" role="status">
            {language.t("settings.providers.catalogPending")}
          </p>
        </Show>
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.apiKey.description", {
            provider: props.provider === "deepagent" ? "DeepAgent" : provider().name,
          })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <Show when={!providerPreset(props.provider)}>
            <TextField
              type="text"
              label={language.t("provider.custom.field.baseURL.label")}
              placeholder={providerBaseURL(props.provider) ?? language.t("provider.custom.field.baseURL.placeholder")}
              name="baseURL"
              value={formStore.baseURL}
              onChange={(v) => {
                reset()
                setFormStore("baseURL", v)
              }}
              validationState={formStore.baseURLError ? "invalid" : undefined}
              error={formStore.baseURLError}
            />
          </Show>
          <TextField
            autofocus
            class="w-full min-w-0"
            type="text"
            label={language.t("provider.connect.apiKey.label", {
              provider: props.provider === "deepagent" ? "DeepAgent" : provider().name,
            })}
            placeholder={language.t("provider.connect.apiKey.placeholder")}
            name="apiKey"
            value={formStore.value}
            onChange={(v) => {
              reset()
              setFormStore("value", v)
            }}
            disabled={formStore.discovering || formStore.saving || formStore.discovered.length > 0}
            validationState={formStore.discovered.length === 0 && formStore.error ? "invalid" : undefined}
          />
          <Show when={isBuiltinProvider(props.provider)}>
            <Collapsible class="w-full">
              <Collapsible.Trigger class="flex w-full items-center justify-between gap-2 text-13-medium text-text-base">
                <span>{language.t("provider.connect.transport.title")}</span>
                <Collapsible.Arrow />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div class="flex flex-col gap-4 pt-4">
                  <div class="text-12-regular text-text-weak">
                    {language.t("provider.connect.transport.description")}
                  </div>
                  <TextField
                    type="text"
                    inputmode="numeric"
                    label={language.t("provider.connect.transport.headerTimeout.label")}
                    placeholder={language.t("provider.connect.transport.headerTimeout.placeholder")}
                    value={formStore.headerTimeout}
                    onChange={(v) => setFormStore("headerTimeout", v)}
                  />
                  <TextField
                    type="text"
                    inputmode="numeric"
                    label={language.t("provider.connect.transport.chunkTimeout.label")}
                    placeholder={language.t("provider.connect.transport.chunkTimeout.placeholder")}
                    value={formStore.chunkTimeout}
                    onChange={(v) => setFormStore("chunkTimeout", v)}
                  />
                  <TextField
                    type="text"
                    inputmode="numeric"
                    label={language.t("provider.connect.transport.timeout.label")}
                    placeholder={language.t("provider.connect.transport.timeout.placeholder")}
                    value={formStore.timeout}
                    onChange={(v) => setFormStore("timeout", v)}
                  />
                  <TextField
                    type="text"
                    inputmode="numeric"
                    label={language.t("provider.connect.transport.maxRetries.label")}
                    placeholder={language.t("provider.connect.transport.maxRetries.placeholder")}
                    value={formStore.maxRetries}
                    onChange={(v) => setFormStore("maxRetries", v)}
                    validationState={formStore.transportError ? "invalid" : undefined}
                    error={formStore.transportError}
                  />
                </div>
              </Collapsible.Content>
            </Collapsible>
          </Show>
          <Show when={formStore.discovered.length === 0 && !formStore.manual}>
            <Button
              class="w-auto"
              type="submit"
              size="large"
              variant="primary"
              disabled={formStore.discovering || formStore.saving}
            >
              {language.t(
                formStore.discovering ? "provider.connect.models.discovering" : "provider.connect.models.discover",
              )}
            </Button>
          </Show>
        </form>
        <Show when={formStore.error}>
          <p role="alert" class="break-words text-12-regular text-icon-critical-base">
            {formStore.error}
          </p>
        </Show>
        <Show when={formStore.manualAvailable && !formStore.manual}>
          <Button variant="secondary" onClick={() => setFormStore({ manual: true, error: undefined })}>
            {language.t("provider.connect.models.manual")}
          </Button>
        </Show>
        <Show when={formStore.manual}>
          <div class="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-raised-base p-3">
            <p role="status" class="text-12-regular text-text-weak">
              {language.t("provider.connect.models.manualDescription")}
            </p>
            <TextField
              label={language.t("provider.custom.models.id.label")}
              placeholder={language.t("provider.custom.models.id.placeholder")}
              value={formStore.manualID}
              disabled={formStore.saving || formStore.saved}
              onChange={(value) => setFormStore("manualID", value)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key !== "Enter" || event.isComposing) return
                event.preventDefault()
                addManualModel()
              }}
            />
            <Button
              variant="secondary"
              disabled={!formStore.manualID.trim() || formStore.saving || formStore.saved}
              onClick={addManualModel}
            >
              {language.t("provider.custom.models.add")}
            </Button>
          </div>
        </Show>
        <Show when={formStore.discovered.length > 0}>
          <section
            class="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-raised-base p-3"
            aria-label={language.t("provider.connect.models.title")}
          >
            <h3 class="text-13-medium text-text-strong">{language.t("provider.connect.models.title")}</h3>
            <Show when={!formStore.manual}>
              <p class="text-12-regular text-text-weak">{language.t("provider.connect.models.description")}</p>
            </Show>
            <div class="flex max-h-56 min-w-0 flex-col gap-2 overflow-auto">
              <For each={formStore.discovered}>
                {(model) => (
                  <label class="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-12-regular">
                    <input
                      type="checkbox"
                      checked={formStore.selectedModels.includes(model.id)}
                      disabled={formStore.saving || formStore.saved}
                      onChange={(event) => {
                        setFormStore("selectedModels", (ids) =>
                          event.currentTarget.checked ? [...ids, model.id] : ids.filter((id) => id !== model.id),
                        )
                        setFormStore("configured", false)
                      }}
                    />
                    <span class="flex min-w-0 flex-col break-words">
                      <span>{model.name}</span>
                      <code class="break-all text-text-weak">{model.id}</code>
                    </span>
                  </label>
                )}
              </For>
            </div>
            <Show when={formStore.manual}>
              <label class="flex items-start gap-2 text-12-regular">
                <input
                  type="checkbox"
                  checked={formStore.manualConsent}
                  disabled={formStore.saving || formStore.saved}
                  onChange={(event) => setFormStore("manualConsent", event.currentTarget.checked)}
                />
                {language.t("provider.connect.models.consent")}
              </label>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={formStore.saving} onClick={reset}>
                {language.t("provider.connect.models.back")}
              </Button>
              <Button variant="secondary" disabled={formStore.saving} onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={
                  formStore.saving ||
                  formStore.saved ||
                  formStore.selectedModels.length === 0 ||
                  (formStore.manual && !formStore.manualConsent)
                }
                onClick={() => void saveSelection()}
              >
                {language.t(formStore.manual ? "provider.connect.models.saveManual" : "provider.connect.models.save")}
              </Button>
            </div>
          </section>
        </Show>
      </div>
    )
  }

  function OAuthCodeView() {
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const code = formData.get("code") as string

      if (!code?.trim()) {
        setFormStore("error", language.t("provider.connect.oauth.code.required"))
        return
      }

      setFormStore("error", undefined)
      const result = await serverSDK.client.provider.oauth
        .callback({
          providerID: props.provider,
          // This view only renders under an oauth method (see method()?.type gate), so methodIndex
          // is always set here; default to 0 to satisfy the required-number API type.
          method: store.methodIndex ?? 0,
          code,
        })
        .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))
      if (result.ok) {
        await complete()
        return
      }
      setFormStore("error", formatError(result.error, language.t("provider.connect.oauth.code.invalid")))
    }

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.code.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.code.visit.link")}</Link>
          {language.t("provider.connect.oauth.code.visit.suffix", { provider: provider().name })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("provider.connect.oauth.code.label", { method: method()?.label ?? "" })}
            placeholder={language.t("provider.connect.oauth.code.placeholder")}
            name="code"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthAutoView() {
    const code = createMemo(() => {
      const instructions = store.authorization?.instructions
      if (instructions?.includes(":")) {
        return instructions.split(":").pop()?.trim()
      }
      return instructions
    })

    onMount(() => {
      void (async () => {
        const result = await serverSDK.client.provider.oauth
          .callback({
            providerID: props.provider,
            // Reached only via the oauth "auto" method branch, so methodIndex is set; default to 0.
            method: store.methodIndex ?? 0,
          })
          .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
          .catch((error) => ({ ok: false as const, error }))

        if (!alive.value) return

        if (!result.ok) {
          const message = formatError(result.error, language.t("common.requestFailed"))
          dispatch({ type: "auth.error", error: message })
          return
        }

        await complete()
      })()
    })

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.auto.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.auto.visit.link")}</Link>
          {language.t("provider.connect.oauth.auto.visit.suffix", { provider: provider().name })}
        </div>
        <TextField
          label={language.t("provider.connect.oauth.auto.confirmationCode")}
          class="font-mono"
          value={code()}
          readOnly
          copyable
        />
        <div class="text-14-regular text-text-base flex items-center gap-4">
          <Spinner />
          <span>{language.t("provider.connect.status.waiting")}</span>
        </div>
      </div>
    )
  }

  return (
    <Dialog
      class="provider-connect-dialog [&_[data-slot=dialog-body]]:min-h-0"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
    >
      <div class="flex h-full min-h-0 min-w-0 flex-col gap-6 overflow-y-auto px-2.5 pb-3">
        <div class="px-2.5 flex min-w-0 shrink-0 gap-4 items-center">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
          <div class="min-w-0 break-words text-16-medium text-text-strong">
            <Switch>
              <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
                {language.t("provider.connect.title.anthropicProMax")}
              </Match>
              <Match when={true}>{language.t("provider.connect.title", { provider: provider().name })}</Match>
            </Switch>
          </div>
        </div>
        <div class="min-h-0 shrink-0 px-2.5 pb-3 flex flex-col gap-6">
          <div onKeyDown={handleKey} tabIndex={0} autofocus={store.methodIndex === undefined ? true : undefined}>
            <Switch>
              <Match when={loading()}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={store.methodIndex === undefined}>
                <MethodSelection />
              </Match>
              <Match when={store.state === "pending"}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={store.state === "prompt"}>
                <OAuthPromptsView />
              </Match>
              <Match when={store.state === "error"}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Icon name="circle-ban-sign" class="text-icon-critical-base" />
                    <span>{language.t("provider.connect.status.failed", { error: store.error ?? "" })}</span>
                  </div>
                </div>
              </Match>
              <Match when={method()?.type === "api"}>
                <ApiAuthView />
              </Match>
              <Match when={method()?.type === "oauth"}>
                <Switch>
                  <Match when={store.authorization?.method === "code"}>
                    <OAuthCodeView />
                  </Match>
                  <Match when={store.authorization?.method === "auto"}>
                    <OAuthAutoView />
                  </Match>
                </Switch>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
