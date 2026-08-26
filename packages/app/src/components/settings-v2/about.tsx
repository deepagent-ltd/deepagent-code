import { Component, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Link } from "../link"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// DeepAgent Code is licensed under AGPL-3.0-or-later.
// Surfaced here so the license and upstream attribution travel with the
// distributed app (AGPL §13 / §4 obligation).
const LICENSE_NOTICE = `DeepAgent Code — AGPL-3.0-or-later

Copyright (c) 2026 DeepAgent Code contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
Affero General Public License for more details.

Source code is available at:
  https://github.com/lessweb/deepagent-code

──────────────────────────────────────────────────────────
Upstream Attribution
──────────────────────────────────────────────────────────
DeepAgent Code is derived from opencode (https://github.com/sst/opencode).
The upstream opencode project is licensed under the MIT License.
Copyright (c) 2025 Anomaly Innovations Inc.
See the NOTICE file in the source repository for the full MIT license text.`

export const SettingsAboutV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.about")}</h2>
      </div>

      <div class="settings-v2-tab-body">
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
              title={language.t("settings.about.attribution.title")}
              description={language.t("settings.about.attribution.description")}
            >
              <Link href="https://github.com/lessweb/deepagent-code">deepagent-code</Link>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.about.license.title")}</h3>
          <pre class="settings-v2-about-license">{LICENSE_NOTICE}</pre>
        </div>
      </div>
    </>
  )
}
