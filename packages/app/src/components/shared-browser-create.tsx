import { createEffect, onCleanup, Show } from "solid-js"
import { createStore, unwrap, type SetStoreFunction, type Store } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { TextField } from "@deepagent-code/ui/text-field"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import type { SharedBrowserPlatform, SharedBrowserView } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { SharedBrowserGrantEditor, type SharedBrowserGrantDraft } from "./shared-browser-grant-editor"
import { prepareBrowserScriptGrant } from "./browser-script-grant"

type State = {
  origin: string
  origins: string
  resolverPolicy: SharedBrowserSchema.Policy["resolverPolicy"]
  duration: 5 | 15 | 30
  grant: SharedBrowserGrantDraft
  busy: boolean
  error: string
  request?: SharedBrowserSchema.Create
  view?: SharedBrowserView
}
const requests = new WeakMap<SharedBrowserPlatform, Map<string, [Store<State>, SetStoreFunction<State>]>>()

export function SharedBrowserCreate(props: {
  bridge: SharedBrowserPlatform
  sessionID: string
  directory: string
  scope: string
  onUse?: (resourceID: string) => void
  advancedGrants?: boolean
}) {
  const language = useLanguage()
  const text = (key: string) => language.t(`browser.shared.${key}` as Parameters<typeof language.t>[0])
  const bridge = props.bridge
  const sessionID = props.sessionID
  const directory = props.directory
  const scope = props.scope
  const entries = requests.get(bridge) ?? new Map<string, [Store<State>, SetStoreFunction<State>]>()
  requests.set(bridge, entries)
  const key = JSON.stringify([scope, directory, sessionID])
  const [state, setState] =
    entries.get(key) ??
    createStore<State>({
      origin: "https://example.com",
      origins: "",
      resolverPolicy: "system",
      duration: 5,
      grant: {
        source: "",
        argsJSON: "null",
        scriptMode: "readonly",
        programOperations: [],
        programSteps: "4",
        filePolicy: { upload: false, download: false },
      },
      busy: false,
      error: "",
    })
  if (entries.size < 64 || entries.has(key)) entries.set(key, [state, setState])
  const owner = crypto.randomUUID()
  let disposed = false
  const current = () =>
    !disposed &&
    props.bridge === bridge &&
    props.sessionID === sessionID &&
    props.directory === directory &&
    props.scope === scope
  onCleanup(() => {
    disposed = true
  })
  createEffect(() => {
    if (
      props.bridge !== bridge ||
      props.sessionID !== sessionID ||
      props.directory !== directory ||
      props.scope !== scope
    )
      setState("error", text("scopeChanged"))
  })
  const create = async () => {
    if (!current() || state.busy) return
    // Capture every editable byte before imports/hashing; an unknown create retries this same request.
    const draft = {
      origin: state.origin,
      origins: state.origins,
      resolverPolicy: state.resolverPolicy,
      duration: state.duration,
      advanced: props.advancedGrants === true,
      grant: {
        ...unwrap(state.grant),
        programOperations: [...state.grant.programOperations],
        filePolicy: { ...state.grant.filePolicy },
      },
    }
    setState({ busy: true, error: "" })
    try {
      if (!entries.has(key)) throw new Error(text("capacity"))
      if (!state.request) {
        const { SharedBrowserSchema } = await import("@deepagent-code/core/browser/shared-schema")
        const { Option, Schema } = await import("effect")
        if (!current()) return
        const script = draft.advanced
          ? await prepareBrowserScriptGrant(draft.grant, {
              script: language.t("browser.control.scriptInvalid"),
              program: language.t("browser.control.program.invalid"),
            })
          : undefined
        if (!current() || (draft.advanced && !props.advancedGrants)) return
        const origin = draft.origin.trim()
        const origins = [
          ...new Set([
            origin,
            ...draft.origins
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean),
          ]),
        ]
        const request = Schema.decodeUnknownOption(SharedBrowserSchema.Create, { onExcessProperty: "error" })({
          version: 2,
          profile: SharedBrowserSchema.PROFILE,
          inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
          requestID: crypto.randomUUID(),
          sessionID,
          expiresAt: Date.now() + draft.duration * 60_000,
          policy: {
            origin,
            approvedOrigins: origins,
            manualApprovedOrigins: origins,
            resolverPolicy: draft.resolverPolicy,
            postGrants: [],
            ...(script ? { scriptContext: "snapshot-json-v1" as const } : {}),
            ...(script?.mode === "program"
              ? {
                  programGrants: [
                    {
                      scriptHash: script.scriptHash,
                      argsHash: script.argsHash,
                      operations: script.operations!,
                      maxSteps: script.maxSteps!,
                    },
                  ],
                }
              : script
                ? {
                    scriptGrants: [
                      { scriptHash: script.scriptHash, argsHash: script.argsHash, readOnly: true as const },
                    ],
                  }
                : {}),
            ...(draft.advanced && (draft.grant.filePolicy.upload || draft.grant.filePolicy.download)
              ? { filePolicy: draft.grant.filePolicy }
              : {}),
          },
        })
        if (Option.isNone(request)) throw new Error(text("invalidPolicy"))
        setState("request", request.value)
      }
      const view = await bridge.create(unwrap(state.request!))
      if (!current()) return
      if (
        view.resource.rootSessionID !== sessionID ||
        view.resource.scope.sessionID !== sessionID ||
        view.resource.scope.directory !== directory
      )
        throw new Error(text("scopeChanged"))
      setState("view", view)
    } catch (error) {
      if (current()) setState("error", error instanceof Error ? error.message : text("requestFailed"))
    } finally {
      setState("busy", false)
    }
  }

  return (
    <section class="flex flex-col gap-3" aria-label={text("title")}>
      <p class="text-13-regular text-text-weak">{text("createHint")}</p>
      <TextField
        label={text("origin")}
        value={state.origin}
        disabled={state.busy || !!state.request}
        onChange={(value) => setState("origin", value)}
      />
      <TextField
        label={text("origins")}
        description={text("originsHint")}
        value={state.origins}
        multiline
        rows={3}
        disabled={state.busy || !!state.request}
        onChange={(value) => setState("origins", value)}
      />
      <div class="flex flex-col gap-2">
        <span id="shared-browser-resolver" class="text-13-regular">
          {language.t("browser.control.resolver")}
        </span>
        <SelectV2
          aria-labelledby="shared-browser-resolver"
          options={["system", "cloudflare_doh_v1", "alidns_doh_v1"] as const}
          current={state.resolverPolicy}
          disabled={state.busy || !!state.request}
          label={(value) =>
            language.t(
              value === "system"
                ? "browser.control.resolverSystem"
                : value === "alidns_doh_v1"
                  ? "browser.control.resolverAliDNS"
                  : "browser.control.resolverCloudflare",
            )
          }
          onSelect={(value) => {
            if (value && !state.busy && !state.request) setState("resolverPolicy", value)
          }}
        />
      </div>
      <p class="text-13-regular text-text-weak">{language.t("browser.control.resolverHint")}</p>
      <div class="flex flex-col gap-2">
        <span id="shared-browser-duration" class="text-13-regular">
          {language.t("browser.control.duration")}
        </span>
        <SelectV2
          aria-labelledby="shared-browser-duration"
          options={[5, 15, 30] as const}
          current={state.duration}
          disabled={state.busy || !!state.request}
          label={(value) => language.t(`browser.control.duration${value}`)}
          onSelect={(value) => {
            if (value && !state.busy && !state.request) setState("duration", value)
          }}
        />
      </div>
      <Show when={props.advancedGrants}>
        <details class="rounded-lg border border-border-base p-3">
          <summary class="cursor-pointer text-13-medium">{language.t("settings.general.section.advanced")}</summary>
          <div class="pt-3">
            <SharedBrowserGrantEditor
              draft={state.grant}
              id={owner}
              disabled={state.busy || !!state.request}
              onChange={(value) => {
                if (!state.busy && !state.request) setState("grant", value)
              }}
            />
          </div>
        </details>
      </Show>
      <Show when={state.error}>
        <p role="alert" class="text-13-regular text-text-danger-base">
          {state.error}
        </p>
      </Show>
      <Show
        when={!state.view}
        fallback={
          <Button
            disabled={!current()}
            onClick={() => {
              if (current() && state.view) props.onUse?.(state.view.resource.resourceID)
            }}
          >
            {text("open")}
          </Button>
        }
      >
        <Button disabled={state.busy || !current()} onClick={() => void create()}>
          {text(state.request ? "retryCreate" : "create")}
        </Button>
      </Show>
    </section>
  )
}
