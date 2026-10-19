import { Component, Show } from "solid-js"
import license from "../../../../../LICENSE?raw"
import notices from "../../../../../NOTICE?raw"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Link } from "../link"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsPage } from "./parts/page"
import { SettingsMetadata } from "./metadata"
import "./settings-v2.css"

export const SettingsAboutV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <SettingsPage title={language.t("settings.tab.about")}>
      <div class="settings-v2-section">
        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.about.product.title")}
            description={language.t("settings.about.product.description")}
          >
            <span class="text-13-medium text-v2-text-text-base">
              {language.t("app.name.desktop")}
              <Show when={platform.version}> {`v${platform.version}`}</Show>
            </span>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.about.links.title")}
            description={language.t("settings.about.links.description")}
            layout="field"
          >
            <div class="settings-v2-actions">
              <Link href="https://ai.deepagent.ltd/">{language.t("settings.about.homepage")}</Link>
              <Link href="https://github.com/deepagent-ltd/deepagent-code#readme">
                {language.t("settings.about.help.title")}
              </Link>
              <Link href="https://github.com/deepagent-ltd/deepagent-code">{language.t("settings.about.source")}</Link>
              <Link href="https://github.com/deepagent-ltd/deepagent-code/issues">
                {language.t("settings.about.support")}
              </Link>
            </div>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.about.upstream.title")}
            description={language.t("settings.about.upstream.description")}
            layout="field"
          >
            <Link href="https://github.com/sst/opencode">OpenCode</Link>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.about.license.title")}
            description={language.t("settings.about.license.description")}
          >
            <span class="text-13-medium">AGPL-3.0-or-later</span>
          </SettingsRowV2>
        </SettingsListV2>
      </div>
      <div class="settings-v2-section" data-component="settings-product-licenses">
        <SettingsMetadata title="LICENSE" value={license} />
        <SettingsMetadata title="NOTICE" value={notices} />
      </div>
    </SettingsPage>
  )
}
