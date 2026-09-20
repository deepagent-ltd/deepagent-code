import type { TuiPlugin } from "@deepagent-code/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { pluginTranslator } from "../../i18n/standalone"
import { SessionSwitcherDialog } from "./dialog"

const id = "internal:session-switcher"

const tui: TuiPlugin = async (api) => {
  const t = pluginTranslator(api.kv)
  api.keymap.registerLayer({
    priority: 1000,
    commands: [
      {
        name: "session.list",
        title: t("tui.app.switchSession"),
        category: t("tui.category.session"),
        namespace: "palette",
        suggested: () => api.state.session.count() > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run() {
          api.ui.dialog.replace(() => <SessionSwitcherDialog />)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
