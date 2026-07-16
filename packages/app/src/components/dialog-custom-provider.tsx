import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { ProviderIcon } from "@deepagent-code/ui/provider-icon"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@deepagent-code/ui/text-field"
import { showToast } from "@/utils/toast"
import { batch, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import {
  type FormState,
  type ProviderProtocol,
  deriveProviderIdentity,
  formStateFromProvider,
  headerRow,
  modelRow,
  validateCustomProvider,
} from "./dialog-custom-provider-form"
import { DialogSelectProvider } from "./dialog-select-provider"
import { Select } from "@deepagent-code/ui/select"
import { Switch } from "@deepagent-code/ui/switch"

// "auto" keeps the zero-config behavior (probe openai-compatible then anthropic and persist whichever
// answered). The explicit choices let the user pin the protocol when auto-detection is wrong or the
// endpoint doesn't implement /models. The choice decides both the discovery probe `kind` and the SDK
// npm persisted to config.
type ProtocolChoice = "auto" | ProviderProtocol
const PROTOCOL_CHOICES: ProtocolChoice[] = ["auto", "openai-compatible", "anthropic"]

type Props = {
  back?: "providers" | "close"
  // Edit mode: the id of an existing custom provider to load and edit. When set, the dialog prefills
  // from config + resolved provider data and persists spec overrides (keeping discovery on if it was).
  edit?: string
}

export function DialogCustomProvider(props: Props) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const editConfig = () => (props.edit ? serverSync.data.config.provider?.[props.edit] : undefined)
  const editResolved = () => (props.edit ? serverSync.data.provider.all.get(props.edit) : undefined)
  // A provider persisted with `discovery: true`: on save we keep discovery on and layer the spec
  // overrides, so runtime model refresh survives the edit.
  const isEditDiscovery = () => props.edit != null && editConfig()?.discovery === true

  const initialForm = (): FormState => {
    const cfg = editConfig()
    if (props.edit && cfg) return formStateFromProvider({ config: cfg, resolved: editResolved() })
    return {
      providerID: "",
      name: "",
      baseURL: "",
      apiKey: "",
      models: [modelRow()],
      headers: [headerRow()],
      err: {},
    }
  }

  const [form, setForm] = createStore<FormState>(initialForm())

  // Advanced section (provider id / display name / headers / manual models) is collapsed by default:
  // the zero-config path only needs Base URL + API key. In edit mode we open it so the user sees the
  // model rows they came to edit. Protocol detected during discovery decides which SDK npm persists.
  const [showAdvanced, setShowAdvanced] = createSignal(!!props.edit)
  // In edit mode, seed the detected protocol from the persisted SDK npm so a save that skips
  // re-discovery still writes the correct npm.
  const [detectedProtocol, setDetectedProtocol] = createSignal<ProviderProtocol | undefined>(
    editConfig()?.npm === "@ai-sdk/anthropic" ? "anthropic" : props.edit ? "openai-compatible" : undefined,
  )
  // User's explicit protocol choice. "auto" (default) preserves auto-detection; an explicit choice
  // pins both the discovery probe kind and the persisted npm.
  const [protocolChoice, setProtocolChoice] = createSignal<ProtocolChoice>("auto")

  // The protocol persisted to config: an explicit choice wins; otherwise the detected one (or
  // openai-compatible default when nothing was detected).
  const resolvedProtocol = (): ProviderProtocol | undefined =>
    protocolChoice() === "auto" ? detectedProtocol() : (protocolChoice() as ProviderProtocol)

  const goBack = () => {
    if (props.back === "close") {
      dialog.close()
      return
    }
    dialog.show(() => <DialogSelectProvider />)
  }

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name" | "context", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      const errKey = key === "context" ? "context" : key
      setForm("models", index, "err", errKey, undefined)
    })
  }

  const setModelBool = (index: number, key: "reasoning" | "temperature", value: boolean) => {
    setForm("models", index, key, value)
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const headerConfig = () =>
    Object.fromEntries(
      form.headers
        .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
        .filter((h) => !!h.key && !!h.value)
        .map((h) => [h.key, h.value]),
    )

  const validate = (nextForm: FormState = form, discovery = false) => {
    const output = validateCustomProvider({
      form: nextForm,
      t: language.t,
      disabledProviders: serverSync.data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(serverSync.data.provider.all.keys()),
      protocol: resolvedProtocol(),
      discovery,
      editDiscovery: isEditDiscovery(),
      editingProviderID: props.edit,
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      const disabledProviders = serverSync.data.config.disabled_providers ?? []
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

      await serverSync.updateConfig({
        provider: { [result.providerID]: result.config },
        disabled_providers: nextDisabled,
      })
      return result
    },
    onSuccess: (result) => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
        description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return

    void (async () => {
      let nextForm: FormState = form
      const baseURL = form.baseURL.trim()
      const key = form.apiKey.trim()
      const env = key.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
      // Whether the user already typed at least one model id by hand.
      const hasManualModels = form.models.some((m) => m.id.trim().length > 0)
      // providerID is optional now (derived from URL when blank); discovery only needs URL + key.
      // Pass a best-effort id so the backend has something to label the request with.
      const discoverID = form.providerID.trim() || deriveProviderIdentity({
        baseURL,
        existingProviderIDs: new Set(serverSync.data.provider.all.keys()),
        disabledProviders: serverSync.data.config.disabled_providers ?? [],
      }).providerID
      // Runtime discovery mode: when the user provides only URL+key (no manual models) and the
      // endpoint answers discovery, persist `discovery: true` with an empty model list so the backend
      // refreshes models on every load instead of freezing this snapshot into config.
      let discoveryMode = false
      // Edit mode never re-runs discovery: we're persisting spec overrides for an already-connected
      // provider. editDiscovery in the validator keeps `discovery: true` when it was set originally.
      if (!props.edit && baseURL && key && !env) {
        // Model discovery is a convenience, not a requirement: many OpenAI-compatible servers
        // (some vLLM setups, local runtimes) don't implement GET /v1/models and return 400/404.
        // Treat discovery as best-effort — probe to detect the protocol (→ SDK npm) and confirm the
        // endpoint works. If it fails we fall back to manual models and let validation handle the
        // empty case instead of blocking save on a missing endpoint.
        // Auto (kind omitted) lets the backend probe openai-compatible then anthropic and report which
        // protocol answered. An explicit choice pins the probe to that protocol.
        const choice = protocolChoice()
        // Defensive client-side timeout: the backend already caps its /models fetch, but guard the
        // whole round-trip too so a stalled request can never leave the submit button hung. On
        // timeout (or any error) we fall through to manual/validation handling instead of blocking.
        const res = await Promise.race([
          serverSDK.client.provider.models
            .discover(
              {
                providerID: discoverID,
                baseURL,
                apiKey: key,
                headers: headerConfig(),
                ...(choice === "auto" ? {} : { kind: choice }),
              },
              { throwOnError: true },
            )
            .then((res) => res.data),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20_000)),
        ]).catch(() => undefined)
        if (res?.kind) setDetectedProtocol(res.kind)
        const discovered = res?.models ?? []
        if (discovered.length > 0 && !hasManualModels) {
          // Backend owns the model list at runtime, so we leave the form's manual-model rows empty
          // and persist `discovery: true` instead of freezing this snapshot. (nextForm stays the
          // empty-models form, keeping the validator in discovery mode.)
          discoveryMode = true
        }
      }

      const result = validate(nextForm, discoveryMode)
      if (!result) return
      saveMutation.mutate(result)
    })().catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    })
  }

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">
            {language.t(props.edit ? "provider.custom.edit.title" : "provider.custom.title")}
          </div>
        </div>

        <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
          <p class="text-14-regular text-text-base">
            {language.t("provider.custom.description.prefix")}
            <Link href="https://deepagent-code.ai/docs/providers/#custom-provider" tabIndex={-1}>
              {language.t("provider.custom.description.link")}
            </Link>
            {language.t("provider.custom.description.suffix")}
          </p>

          <p class="text-12-regular text-text-base rounded-md border border-border-warning-base bg-surface-warning-base/20 px-3 py-2">
            {language.t("provider.custom.specWarning")}
          </p>

          <div class="flex flex-col gap-4">
            <TextField
              autofocus
              label={language.t("provider.custom.field.baseURL.label")}
              placeholder={language.t("provider.custom.field.baseURL.placeholder")}
              value={form.baseURL}
              onChange={(v) => setField("baseURL", v)}
              validationState={form.err.baseURL ? "invalid" : undefined}
              error={form.err.baseURL}
            />
            <TextField
              label={language.t("provider.custom.field.apiKey.label")}
              placeholder={language.t("provider.custom.field.apiKey.placeholder")}
              description={language.t("provider.custom.field.apiKey.description")}
              value={form.apiKey}
              onChange={(v) => setField("apiKey", v)}
            />
            <div class="flex flex-col gap-1.5">
              <label class="text-12-medium text-text-weak">{language.t("provider.custom.field.protocol.label")}</label>
              <Select
                size="normal"
                options={PROTOCOL_CHOICES}
                current={protocolChoice()}
                value={(o) => o}
                label={(o) => language.t(`provider.custom.field.protocol.option.${o}`)}
                onSelect={(o) => o && setProtocolChoice(o)}
                class="max-w-[220px] text-text-base"
                variant="secondary"
              />
              <p class="text-12-regular text-text-weak">
                {language.t("provider.custom.field.protocol.description")}
              </p>
            </div>
          </div>

          <Button
            type="button"
            size="small"
            variant="ghost"
            icon={showAdvanced() ? "chevron-down" : "chevron-right"}
            onClick={() => setShowAdvanced((v) => !v)}
            class="self-start"
          >
            {language.t("provider.custom.advanced.toggle")}
          </Button>

          <Show when={showAdvanced()}>
          <div class="flex flex-col gap-4">
            <TextField
              label={language.t("provider.custom.field.providerID.label")}
              placeholder={language.t("provider.custom.field.providerID.placeholder")}
              description={language.t("provider.custom.field.providerID.autoDescription")}
              value={form.providerID}
              onChange={(v) => setField("providerID", v)}
              validationState={form.err.providerID ? "invalid" : undefined}
              error={form.err.providerID}
            />
            <TextField
              label={language.t("provider.custom.field.name.label")}
              placeholder={language.t("provider.custom.field.name.placeholder")}
              value={form.name}
              onChange={(v) => setField("name", v)}
              validationState={form.err.name ? "invalid" : undefined}
              error={form.err.name}
            />
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
            <p class="text-12-regular text-text-weak">{language.t("provider.custom.models.autoHint")}</p>
            <For each={form.models}>
              {(m, i) => (
                <div class="flex flex-col gap-1.5 border-b border-border-weak pb-3 last:border-b-0 last:pb-0" data-row={m.row}>
                  <div class="flex gap-2 items-start">
                    <div class="flex-1">
                      <TextField
                        label={language.t("provider.custom.models.id.label")}
                        hideLabel
                        placeholder={language.t("provider.custom.models.id.placeholder")}
                        value={m.id}
                        onChange={(v) => setModel(i(), "id", v)}
                        validationState={m.err.id ? "invalid" : undefined}
                        error={m.err.id}
                      />
                    </div>
                    <div class="flex-1">
                      <TextField
                        label={language.t("provider.custom.models.name.label")}
                        hideLabel
                        placeholder={language.t("provider.custom.models.name.placeholder")}
                        value={m.name}
                        onChange={(v) => setModel(i(), "name", v)}
                        validationState={m.err.name ? "invalid" : undefined}
                        error={m.err.name}
                      />
                    </div>
                    <IconButton
                      type="button"
                      icon="trash"
                      variant="ghost"
                      class="mt-1.5"
                      onClick={() => removeModel(i())}
                      disabled={form.models.length <= 1}
                      aria-label={language.t("provider.custom.models.remove")}
                    />
                  </div>
                  <div class="flex gap-3 items-center flex-wrap pr-9">
                    <div class="w-[140px]">
                      <TextField
                        label={language.t("provider.custom.models.context.label")}
                        hideLabel
                        inputmode="numeric"
                        placeholder={language.t("provider.custom.models.context.placeholder")}
                        value={m.context}
                        onChange={(v) => setModel(i(), "context", v)}
                        validationState={m.err.context ? "invalid" : undefined}
                        error={m.err.context}
                      />
                    </div>
                    <label class="flex gap-1.5 items-center text-12-regular text-text-base">
                      <Switch checked={m.reasoning} onChange={(v) => setModelBool(i(), "reasoning", v)} />
                      {language.t("provider.custom.models.reasoning.label")}
                    </label>
                    <label class="flex gap-1.5 items-center text-12-regular text-text-base">
                      <Switch checked={m.temperature} onChange={(v) => setModelBool(i(), "temperature", v)} />
                      {language.t("provider.custom.models.temperature.label")}
                    </label>
                  </div>
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
              {language.t("provider.custom.models.add")}
            </Button>
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
            <For each={form.headers}>
              {(h, i) => (
                <div class="flex gap-2 items-start" data-row={h.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.key.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.key.placeholder")}
                      value={h.key}
                      onChange={(v) => setHeader(i(), "key", v)}
                      validationState={h.err.key ? "invalid" : undefined}
                      error={h.err.key}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.value.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.value.placeholder")}
                      value={h.value}
                      onChange={(v) => setHeader(i(), "value", v)}
                      validationState={h.err.value ? "invalid" : undefined}
                      error={h.err.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
              {language.t("provider.custom.headers.add")}
            </Button>
          </div>
          </Show>

          <Button
            class="w-auto self-start"
            type="submit"
            size="large"
            variant="primary"
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
