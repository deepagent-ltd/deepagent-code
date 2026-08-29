import type { ComponentProps } from "solid-js"
import { Icon } from "@deepagent-code/ui/icon"
import type { DockPanelID } from "@/context/layout"

export const PANEL_VIEW_META: Record<DockPanelID, { icon: ComponentProps<typeof Icon>["name"]; titleKey: string }> = {
  terminal: { icon: "terminal-active", titleKey: "session.panel.terminal" },
  "debug-console": { icon: "code-lines", titleKey: "session.panel.debugConsole" },
  problems: { icon: "warning", titleKey: "session.panel.problems" },
}
