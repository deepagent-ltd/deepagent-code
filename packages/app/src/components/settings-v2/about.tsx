import { Component, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Link } from "../link"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// Full MIT license text (retains the original opencode copyright as required by the
// MIT License, alongside the DeepAgent Code copyright). Surfaced in the About tab so
// the attribution travels with the distributed app, not just the repository.
const MIT_LICENSE = `MIT License

Copyright (c) 2025 opencode
Copyright (c) 2026 DeepAgent Code

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

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
              <Link href="https://github.com/sst/opencode">opencode</Link>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.about.license.title")}</h3>
          <pre class="settings-v2-about-license">{MIT_LICENSE}</pre>
        </div>
      </div>
    </>
  )
}
