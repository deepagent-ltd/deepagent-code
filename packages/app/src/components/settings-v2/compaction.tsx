import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsRowV2 } from "./parts/row"

const modes = ["adaptive", "long", "extreme"] as const

export function SettingsCompaction() {
  const language = useLanguage()
  const server = useServerSync()
  return (
    <SettingsRowV2
      title={language.t("settings.compaction.title")}
      description={language.t("settings.compaction.description")}
    >
      <SelectV2
        appearance="inline"
        data-action="settings-compaction-mode"
        options={[...modes]}
        placement="bottom-end"
        current={server.data.config.compaction?.mode ?? "adaptive"}
        value={(mode) => mode}
        label={(mode) => language.t(`settings.compaction.${mode}`)}
        onSelect={(mode) => {
          if (mode && mode !== (server.data.config.compaction?.mode ?? "adaptive"))
            void server.updateConfig({ compaction: { ...server.data.config.compaction, mode } })
        }}
      />
    </SettingsRowV2>
  )
}
