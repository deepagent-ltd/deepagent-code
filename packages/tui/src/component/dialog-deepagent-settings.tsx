import { createMemo, createResource, createSignal, onMount } from "solid-js"
import type { Config } from "@deepagent-code/sdk"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { useLocal } from "../context/local"
import { useRoute } from "../context/route"
import {
  configuredCollaborationMode,
  isSelectableCollaborationMode,
} from "@deepagent-code/core/session/collaboration-mode"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"

// DeepAgent settings face — the agentMode / self-learning / subagent-intensity / prompt-mode
// selectors the GUI settings-v2 General tab owns. Writes send only the changed options through
// global.config.update; its SettingsTransaction preserves the other providers, options, and models.
// The server recomputes routing from the next config read.

type DeepAgentMode = "general" | "high" | "xhigh" | "max" | "ultra"
type SelfLearning = "manual" | "auto"
type SubagentIntensity = "inherit" | "downgrade"
type PromptMode = "direct" | "intelligence"

const MODES: DeepAgentMode[] = ["general", "high", "xhigh", "max", "ultra"]

const isMode = (value: unknown): value is DeepAgentMode => MODES.includes(value as DeepAgentMode)
const isLearning = (value: unknown): value is SelfLearning => value === "manual" || value === "auto"
const isIntensity = (value: unknown): value is SubagentIntensity => value === "inherit" || value === "downgrade"
const isPromptMode = (value: unknown): value is PromptMode => value === "direct" || value === "intelligence"

export function DialogDeepAgentSettings() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const i18n = useTuiI18n()
  const toast = useToast()
  const local = useLocal()
  const route = useRoute()
  const [busy, setBusy] = createSignal(false)

  const [config, { refetch }] = createResource(async () => {
    const result = await sdk.client.config.get(undefined, { throwOnError: true })
    return result.data
  })

  const current = createMemo<Config>(() => config.latest ?? sync.data.config)
  const deepagent = createMemo(() => current().provider?.deepagent ?? {})
  const options = createMemo(() => deepagent().options ?? {})

  const agentMode = createMemo<DeepAgentMode>(() => {
    const value = options().agentMode
    return isMode(value) ? value : "high"
  })
  const selfLearning = createMemo<SelfLearning>(() => {
    const value = options().selfLearning
    return isLearning(value) ? value : "manual"
  })
  const subagentIntensity = createMemo<SubagentIntensity>(() => {
    const value = options().subagentIntensity
    return isIntensity(value) ? value : "inherit"
  })
  // Legacy-compat: "wish" is the pre-rename value for "intelligence" (same normalization as the GUI).
  const promptMode = createMemo<PromptMode>(() => {
    const raw = options().promptMode === "wish" ? "intelligence" : options().promptMode
    return isPromptMode(raw) ? raw : "intelligence"
  })

  const patch = async (
    update: Partial<Record<"agentMode" | "selfLearning" | "subagentIntensity" | "promptMode", string>>,
  ) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await sdk.client.global.config.update({
        config: {
          provider: {
            deepagent: {
              // The read DTO includes facade defaults that Core V2 cannot consume.
              // The global update routes this option into the authoritative settings store.
              options: update,
            },
          },
        },
      })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.deepagent.updated"), duration: 4000 })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const cycle = {
    agentMode: (): string => {
      // Match the GUI: direct cannot newly select ultra; an existing value remains visible.
      const modes = MODES.filter((mode) => mode !== "ultra" || promptMode() !== "direct")
      return modes[(modes.indexOf(agentMode()) + 1) % modes.length]
    },
    selfLearning: (): string => (selfLearning() === "manual" ? "auto" : "manual"),
    subagentIntensity: (): string => (subagentIntensity() === "inherit" ? "downgrade" : "inherit"),
    promptMode: (): string => (promptMode() === "direct" ? "intelligence" : "direct"),
  }

  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const editable = () => {
    const id = sessionID()
    if (!id) return false
    const session = sync.session.get(id)
    if (session && "ordinaryEligible" in session && session.ordinaryEligible === false) return false
    const goal = sync.data.session_goal[id]
    const control = goal?.control
    return (
      !goal ||
      (!!control &&
        (GoalClient.confirmedTerminal(control) ||
          (control.requestedPhase === "paused" &&
            !control.inFlight &&
            !control.recoveryRequired &&
            control.preparation === "ready")))
    )
  }
  const [historicalPanel, panelActions] = createResource(
    () => (sessionID() ? ([sdk.client, sdk.url, sdk.directory, sessionID()!] as const) : undefined),
    async ([client, _url, _directory, id]) => {
      return (client as unknown as GoalClient.Client).client
        .request<{ armed: boolean; explicit: boolean }>({
          method: "GET",
          url: `/deepagent/panel/status?sessionID=${encodeURIComponent(id)}`,
          throwOnError: false,
        })
        .then((result) => (result.error ? undefined : result.data))
        .catch(() => undefined)
    },
  )
  const stopHistoricalPanel = async () => {
    const id = sessionID()
    if (busy() || !id || !historicalPanel()?.armed) return
    const captured = { client: sdk.client, url: sdk.url, directory: sdk.directory, sessionID: id }
    setBusy(true)
    try {
      const result = await (captured.client as unknown as GoalClient.Client).client.request<{
        sessionID: string
        armed: boolean
      }>({
        method: "POST",
        url: "/deepagent/panel/arm",
        body: { sessionID: id, armed: false },
        throwOnError: false,
      })
      if (
        sdk.client !== captured.client ||
        sdk.url !== captured.url ||
        sdk.directory !== captured.directory ||
        sessionID() !== id
      )
        return
      if (result.error || result.data?.sessionID !== id || result.data.armed !== false)
        throw new Error("Historical panel stop was not confirmed")
      toast.show({ variant: "success", message: i18n.t("tui.panel.stopped"), duration: 4000 })
      await panelActions.refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }
  const chooseMode = (defaultOnly: boolean) => {
    const captured = { client: sdk.client, url: sdk.url, sessionID: sessionID(), directory: sdk.directory }
    dialog.replace(() => (
      <DialogSelect
        title={i18n.t(defaultOnly ? "tui.mode.default" : "tui.mode.next")}
        current={defaultOnly ? configuredCollaborationMode(current().default_agent) : local.agent.current()?.name}
        options={local.agent
          .list()
          .filter(isSelectableCollaborationMode)
          .map((mode) => ({
            value: mode.name,
            title: i18n.t(`tui.mode.${mode.name as "auto" | "plan" | "loop" | "design"}`),
            description: mode.description,
          }))}
        onSelect={(mode) => {
          if (captured.client !== sdk.client || captured.url !== sdk.url || captured.directory !== sdk.directory) return
          if (!defaultOnly) {
            if (captured.sessionID !== sessionID() || !editable()) return
            local.agent.set(mode.value)
            dialog.clear()
            return
          }
          void sdk.client.global.config
            .update({ config: { default_agent: mode.value } })
            .then((result) => {
              if (result.error) throw result.error
              if (captured.client !== sdk.client || captured.url !== sdk.url) return
              toast.show({ variant: "success", message: i18n.t("tui.deepagent.updated"), duration: 4000 })
              dialog.replace(() => <DialogDeepAgentSettings />)
            })
            .catch((error: unknown) => toast.show({ variant: "error", message: errorMessage(error), duration: 6000 }))
        }}
      />
    ))
  }

  const entries = () => [
    ...(historicalPanel()?.armed
      ? [
          {
            title: i18n.t("tui.panel.stopHistory"),
            value: "panelHistory",
            category: "Session",
            description: i18n.t("tui.panel.history"),
            disabled: busy(),
          },
        ]
      : []),
    {
      title: i18n.t("tui.mode.default"),
      value: "defaultAgent",
      category: "Session",
      footer: configuredCollaborationMode(current().default_agent),
    },
    ...(sessionID()
      ? [
          {
            title: i18n.t("tui.mode.next"),
            value: "nextAgent",
            category: "Session",
            footer: `${local.agent.current()?.name ?? "—"} · ${i18n.t("tui.mode.effective")}: ${local.agent.effective()?.name ?? "—"}`,
            disabled: !editable(),
          },
        ]
      : []),
    {
      title: i18n.t("tui.deepagent.agentMode"),
      value: "agentMode",
      category: "DeepAgent",
      footer: agentMode(),
    },
    {
      title: i18n.t("tui.deepagent.selfLearning"),
      value: "selfLearning",
      category: "DeepAgent",
      footer: selfLearning(),
    },
    {
      title: i18n.t("tui.deepagent.subagentIntensity"),
      value: "subagentIntensity",
      category: "DeepAgent",
      footer: subagentIntensity(),
    },
    {
      title: i18n.t("tui.deepagent.promptMode"),
      value: "promptMode",
      category: "DeepAgent",
      footer: promptMode(),
    },
  ]

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.deepagent.title")}
      options={entries()}
      current={undefined}
      onSelect={(option) => {
        if (option.value === "panelHistory") {
          void stopHistoricalPanel()
          return
        }
        if (option.value === "defaultAgent" || option.value === "nextAgent") {
          chooseMode(option.value === "defaultAgent")
          return
        }
        void patch({ [String(option.value)]: cycle[option.value as keyof typeof cycle]() })
      }}
    />
  )
}
