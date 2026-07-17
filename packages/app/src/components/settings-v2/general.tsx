import { Component, For, Show, createMemo, createResource, onMount } from "solid-js"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { Icon } from "@deepagent-code/ui/icon"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { Switch } from "@deepagent-code/ui/v2/switch-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useTheme, type ColorScheme } from "@deepagent-code/ui/theme/context"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { usePlatform, type DisplayBackend } from "@/context/platform"
import { ZOOM_LEVELS } from "@/zoom-levels"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useUpdaterAction } from "../updater-action"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "../link"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { ImportSection } from "./import-history"
import "./settings-v2.css"
import {
  deepAgentModeFromConfig,
  deepAgentPromptModeFromConfig,
  deepAgentIntelligenceModelFromConfig,
  deepAgentSelfLearningFromConfig,
  deepAgentSubagentIntensityFromConfig,
  type DeepAgentMode,
  type DeepAgentPromptMode,
  type DeepAgentSelfLearning,
  type DeepAgentSubagentIntensity,
  updateDeepAgentOptions,
} from "@/utils/deepagent-settings"
import { useModels } from "@/context/models"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

type ShellSelectOption = {
  id: string
  value: string
  label: string
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneralV2: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const permission = usePermission()
  const platform = usePlatform()
  const params = useParams()
  const settings = useSettings()
  const models = useModels()

  const updater = useUpdaterAction()

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const dir = createMemo(() => decode64(params.dir))
  const accepting = createMemo(() => {
    const value = dir()
    if (!value) return false
    if (!params.id) return permission.isAutoAcceptingDirectory(value)
    return permission.isAutoAccepting(params.id, value)
  })

  const toggleAccept = (checked: boolean) => {
    const value = dir()
    if (!value) return

    if (!params.id) {
      if (permission.isAutoAcceptingDirectory(value) === checked) return
      permission.toggleAutoAcceptDirectory(value)
      return
    }

    if (checked) {
      permission.enableAutoAccept(params.id, value)
      return
    }

    permission.disableAutoAccept(params.id, value)
  }
  const desktop = createMemo(() => platform.platform === "desktop")

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const serverSync = useServerSync()
  const serverSdk = useServerSDK()

  const [shells] = createResource(
    () =>
      serverSdk.client.pty
        .shells()
        .then((res) => res.data ?? [])
        .catch(() => [] as ShellOption[]),
    { initialValue: [] as ShellOption[] },
  )

  const [displayBackend, { refetch: refetchDisplayBackend }] = createResource(
    () => (linux() && platform.getDisplayBackend ? true : false),
    () => Promise.resolve(platform.getDisplayBackend?.() ?? null).catch(() => null as DisplayBackend | null),
    { initialValue: null as DisplayBackend | null },
  )

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => (desktop() && platform.getPinchZoomEnabled ? true : false),
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  onMount(() => {
    void theme.loadThemes()
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  const currentShell = createMemo(() => serverSync.data.config.shell ?? "")

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.latest
    const current = serverSync.data.config.shell

    const nameCounts = new Map<string, number>()
    for (const s of list) {
      nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }

    const options = [
      autoOption,
      ...list.map((s) => {
        const ambiguousName = (nameCounts.get(s.name) || 0) > 1
        const text = ambiguousName ? s.path : s.name
        const label = s.acceptable ? text : `${text} (${language.t("settings.general.row.shell.terminalOnly")})`
        return {
          id: s.path,
          // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
          value: ambiguousName ? s.path : s.name,
          label,
        }
      }),
    ]

    if (current && !options.some((o) => o.value === current)) {
      options.push({ id: current, value: current, label: current })
    }

    return options
  })
  const deepAgentMode = createMemo(() => deepAgentModeFromConfig(serverSync.data.config))
  const deepAgentPromptMode = createMemo(() => deepAgentPromptModeFromConfig(serverSync.data.config))
  const scenarioModeCards = createMemo<{ value: DeepAgentPromptMode; label: string; description: string }[]>(() => [
    {
      value: "direct",
      label: language.t("settings.general.deepagent.prompt.direct"),
      description: language.t("settings.general.deepagent.prompt.direct.description"),
    },
    {
      value: "intelligence",
      label: language.t("settings.general.deepagent.prompt.intelligence"),
      description: language.t("settings.general.deepagent.prompt.intelligence.description"),
    },
  ])
  const scenarioModeDescription = createMemo(
    () => scenarioModeCards().find((card) => card.value === deepAgentPromptMode())?.description ?? "",
  )
  // #3: `ultra` requires the intelligence scenario; it cannot run under `direct`. Gate against the
  // config-level scenario mode (this selector is a session/config-level setting, not per-turn).
  // When the scenario is `direct`, drop `ultra` from the selectable options (unless it is somehow
  // already the current value, so the control still reflects state) and surface an explanatory
  // hint on the row.
  const ultraDisabled = createMemo(() => deepAgentPromptMode() === "direct")
  const deepAgentModeOptions = createMemo<{ value: DeepAgentMode; label: string }[]>(() => {
    const options: { value: DeepAgentMode; label: string }[] = [
      { value: "general", label: language.t("settings.general.deepagent.mode.general") },
      { value: "high", label: language.t("settings.general.deepagent.mode.high") },
      { value: "xhigh", label: language.t("settings.general.deepagent.mode.xhigh") },
      { value: "max", label: language.t("settings.general.deepagent.mode.max") },
    ]
    if (!ultraDisabled() || deepAgentMode() === "ultra") {
      options.push({ value: "ultra", label: language.t("settings.general.deepagent.mode.ultra") })
    }
    return options
  })
  const deepAgentSubagentIntensity = createMemo(() => deepAgentSubagentIntensityFromConfig(serverSync.data.config))
  const subagentIntensityOptions = createMemo<{ value: DeepAgentSubagentIntensity; label: string }[]>(() => [
    { value: "inherit", label: language.t("settings.general.deepagent.subagentMode.inherit") },
    { value: "downgrade", label: language.t("settings.general.deepagent.subagentMode.downgrade") },
  ])
  const deepAgentIntelligenceModel = createMemo(
    () => deepAgentIntelligenceModelFromConfig(serverSync.data.config) ?? "",
  )
  const intelligenceModelOptions = createMemo(() =>
    models.list().map((model) => ({
      value: `${model.provider.id}/${model.id}`,
      label: model.name,
      description: model.provider.name,
    })),
  )

  const deepAgentSelfLearning = createMemo(() => deepAgentSelfLearningFromConfig(serverSync.data.config))
  const selfLearningCards = createMemo<{ value: DeepAgentSelfLearning; label: string; description: string }[]>(() => [
    {
      value: "manual",
      label: language.t("settings.general.deepagent.selfLearning.manual"),
      description: language.t("settings.general.deepagent.selfLearning.manual.description"),
    },
    {
      value: "auto",
      label: language.t("settings.general.deepagent.selfLearning.auto"),
      description: language.t("settings.general.deepagent.selfLearning.auto.description"),
    },
  ])
  const selfLearningDescription = createMemo(
    () => selfLearningCards().find((card) => card.value === deepAgentSelfLearning())?.description ?? "",
  )

  const onDisplayBackendChange = (checked: boolean) => {
    const update = platform.setDisplayBackend?.(checked ? "wayland" : "auto")
    if (!update) return
    void update.finally(() => {
      void refetchDisplayBackend()
    })
  }

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const zoomOptions = createMemo(() =>
    ZOOM_LEVELS.map((level) => ({ value: String(level), label: `${Math.round(level * 100)}%` })),
  )

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
  })

  const GeneralSection = () => (
    <div class="settings-v2-section">
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-language"
            options={languageOptions()}
            placement="bottom-end"
            gutter={6}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const DeepAgentSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.deepagent")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.deepagent.mode.title")}
          description={
            <>
              {language.t("settings.general.deepagent.mode.description")}
              <Show when={ultraDisabled()}>
                {" "}
                <span class="text-text-weak">
                  {language.t("settings.general.deepagent.mode.ultraRequiresIntelligence")}
                </span>
              </Show>
            </>
          }
        >
          <SelectV2
            appearance="inline"
            data-action="settings-deepagent-mode"
            options={deepAgentModeOptions()}
            placement="bottom-end"
            gutter={6}
            current={deepAgentModeOptions().find((o) => o.value === deepAgentMode())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === deepAgentMode()) return
              if (option.value === "ultra" && ultraDisabled()) return
              void updateDeepAgentOptions(serverSync, { agentMode: option.value })
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.deepagent.subagentMode.title")}
          description={language.t("settings.general.deepagent.subagentMode.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-deepagent-subagent-intensity"
            options={subagentIntensityOptions()}
            placement="bottom-end"
            gutter={6}
            current={subagentIntensityOptions().find((o) => o.value === deepAgentSubagentIntensity())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === deepAgentSubagentIntensity()) return
              void updateDeepAgentOptions(serverSync, { subagentIntensity: option.value })
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.deepagent.prompt.title")}
          description={language.t("settings.general.deepagent.prompt.description")}
        >
          <div data-action="settings-deepagent-prompt-mode" class="settings-v2-choice-control">
            <SelectV2
              appearance="inline"
              options={scenarioModeCards()}
              placement="bottom-end"
              gutter={6}
              current={scenarioModeCards().find((option) => option.value === deepAgentPromptMode())}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => {
                if (!option) return
                if (option.value === deepAgentPromptMode()) return
                void updateDeepAgentOptions(serverSync, { promptMode: option.value })
              }}
            />
            <div class="settings-v2-choice-description">{scenarioModeDescription()}</div>
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.deepagent.intelligenceModel.title")}
          description={language.t("settings.general.deepagent.intelligenceModel.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-deepagent-intelligence-model"
            options={intelligenceModelOptions()}
            placement="bottom-end"
            gutter={6}
            current={
              intelligenceModelOptions().find((option) => option.value === deepAgentIntelligenceModel()) ??
              intelligenceModelOptions()[0]
            }
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === deepAgentIntelligenceModel()) return
              void updateDeepAgentOptions(serverSync, { intelligenceModel: option.value })
            }}
          >
            {(o) => (
              <span class="flex items-center gap-2">
                <span>{o.label}</span>
                <Show when={o.description}>
                  <span class="rounded-sm bg-background-strong px-1.5 py-0.5 text-11-regular text-text-weak">
                    {o.description}
                  </span>
                </Show>
              </span>
            )}
          </SelectV2>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.deepagent.selfLearning.title")}
          description={language.t("settings.general.deepagent.selfLearning.description")}
        >
          <div data-action="settings-deepagent-self-learning" class="settings-v2-choice-control">
            <SelectV2
              appearance="inline"
              options={selfLearningCards()}
              placement="bottom-end"
              gutter={6}
              current={selfLearningCards().find((option) => option.value === deepAgentSelfLearning())}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => {
                if (!option) return
                if (option.value === deepAgentSelfLearning()) return
                void updateDeepAgentOptions(serverSync, { selfLearning: option.value })
              }}
            />
            <div class="settings-v2-choice-description">{selfLearningDescription()}</div>
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.shell.title")}
          description={language.t("settings.general.row.shell.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-shell"
            options={shellOptions()}
            current={shellOptions().find((o) => o.value === currentShell()) ?? autoOption}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === currentShell()) return
              serverSync.updateConfig({ shell: option.value })
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t("toast.permissions.autoaccept.on.description")}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const FeedSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.feed")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showSessionProgressBar.title")}
          description={language.t("settings.general.row.showSessionProgressBar.description")}
        >
          <div data-action="settings-show-session-progress-bar">
            <Switch
              checked={settings.general.showSessionProgressBar()}
              onChange={(checked) => settings.general.setShowSessionProgressBar(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.expertPanelDefault.title")}
          description={language.t("settings.general.row.expertPanelDefault.description")}
        >
          <div data-action="settings-expert-panel-default">
            <Switch
              checked={settings.general.expertPanelDefault()}
              onChange={(checked) => settings.general.setExpertPanelDefault(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const AppearanceSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.appearance")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            onHighlight={(option) => {
              if (!option) return
              theme.previewColorScheme(option.value)
              return () => theme.cancelPreview()
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <Link class="settings-v2-link" href="https://deepagent-code.ai/docs/themes/">
                {language.t("common.learnMore")}
              </Link>
            </>
          }
        >
          <SelectV2
            appearance="inline"
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            onHighlight={(option) => {
              if (!option) return
              theme.previewTheme(option.id)
              return () => theme.cancelPreview()
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.uiFont.title")}
          description={language.t("settings.general.row.uiFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-ui-font"
              type="text"
              appearance="base"
              value={sans()}
              onInput={(event) => settings.appearance.setUIFont(event.currentTarget.value)}
              placeholder={sansDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.uiFont.title")}
              style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-code-font"
              type="text"
              appearance="base"
              value={mono()}
              onInput={(event) => settings.appearance.setFont(event.currentTarget.value)}
              placeholder={monoDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.font.title")}
              style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.terminalFont.title")}
          description={language.t("settings.general.row.terminalFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-terminal-font"
              type="text"
              appearance="base"
              value={terminal()}
              onInput={(event) => settings.appearance.setTerminalFont(event.currentTarget.value)}
              placeholder={terminalDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.terminalFont.title")}
              style={{ "font-family": terminalFontFamily(settings.appearance.terminalFont()) }}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const NotificationsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const SoundsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const UpdatesSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.updates")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <ButtonV2 size="normal" variant="neutral" disabled={!updater.action().run} onClick={updater.run}>
            {language.t(updater.action().label)}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const shareUrl = createMemo(() => serverSync.data.config.share_url ?? "")

  const onShareUrlChange = (value: string) => {
    const next = value.trim()
    const current = serverSync.data.config.share_url ?? ""
    if (next === current) return
    // An empty field means "use the default", so drop the key entirely rather than persisting "".
    serverSync.updateConfig({ share_url: next === "" ? undefined : next })
  }

  const SharingSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sharing")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.shareUrl.title")}
          description={language.t("settings.general.row.shareUrl.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-share-url"
              type="text"
              appearance="base"
              value={shareUrl()}
              onChange={(event) => onShareUrlChange(event.currentTarget.value)}
              placeholder={language.t("settings.general.row.shareUrl.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.shareUrl.title")}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.general.section.display")}</h3>

        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.general.row.zoom.title")}
            description={language.t("settings.general.row.zoom.description")}
          >
            <SelectV2
              appearance="inline"
              data-action="settings-zoom"
              options={zoomOptions()}
              current={zoomOptions().find((o) => o.value === String(platform.webviewZoom?.()))}
              placement="bottom-end"
              gutter={6}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && platform.setWebviewZoom?.(Number(option.value))}
            />
          </SettingsRowV2>

          <Show when={linux()}>
            <SettingsRowV2
              title={
                <div class="flex items-center gap-2">
                  <span>{language.t("settings.general.row.wayland.title")}</span>
                  <Tooltip value={language.t("settings.general.row.wayland.tooltip")} placement="top">
                    <span class="text-text-weak">
                      <Icon name="help" size="small" />
                    </span>
                  </Tooltip>
                </div>
              }
              description={language.t("settings.general.row.wayland.description")}
            >
              <div data-action="settings-wayland">
                <Switch checked={displayBackend.latest === "wayland"} onChange={onDisplayBackendChange} />
              </div>
            </SettingsRowV2>
          </Show>
        </SettingsListV2>
      </div>
    </Show>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.general")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <GeneralSection />

        <DeepAgentSection />

        <FeedSection />

        <AppearanceSection />

        <NotificationsSection />

        <SoundsSection />

        <SharingSection />

        <UpdatesSection />

        <DisplaySection />

        <ImportSection />
      </div>
    </>
  )
}
