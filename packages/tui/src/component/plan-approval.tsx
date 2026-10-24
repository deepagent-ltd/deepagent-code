import { createMemo, Show } from "solid-js"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { PlanApprovalPresentation } from "@deepagent-code/core/deepagent/plan-approval-presentation"
import { Hash } from "@deepagent-code/core/util/hash"
import { useTheme } from "../context/theme"
import { useTuiI18n } from "../context/i18n"
import { useClipboard } from "../context/clipboard"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"

export function PlanApproval(props: {
  text: string
  sessionID: string
  kind: PlanApprovalPresentation.Kind
  approval?: unknown
  interactive?: boolean
  fallback: JSX.Element
}) {
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const clipboard = useClipboard()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  let details: ScrollBoxRenderable | undefined
  const view = createMemo(() =>
    PlanApprovalPresentation.readWithDigest(
      props.text,
      { sessionID: props.sessionID, kind: props.kind, approval: props.approval },
      Hash.sha256,
    ),
  )
  const copy = (body: string) => {
    if (!clipboard.write) return toast.show({ message: i18n.t("tui.planApproval.copyUnavailable"), variant: "error" })
    void clipboard.write(body).catch(toast.error)
  }
  const show = () => {
    const value = view()
    if (!value) return
    dialog.replace(() => <Snapshot body={value.body} copy={() => copy(value.body)} />)
  }
  useBindings(() => ({
    mode: "question",
    enabled: props.kind === "question" && props.interactive !== false && !!view(),
    bindings: [
      ...["pageup", "pagedown"].map((key) => ({
        key,
        desc: i18n.t("tui.planApproval.scroll"),
        group: "Question",
        cmd: () => details?.scrollBy(key === "pageup" ? -8 : 8),
      })),
      { key: "v", desc: i18n.t("tui.planApproval.view"), group: "Question", cmd: show },
      {
        key: "c",
        desc: i18n.t("tui.planApproval.copy"),
        group: "Question",
        cmd: () => {
          const value = view()
          if (value) copy(value.body)
        },
      },
    ],
  }))
  return (
    <Show when={view()} fallback={props.fallback}>
      {(approved) => (
        <box gap={1}>
          <Show
            when={props.kind === "question"}
            fallback={
              <text fg={theme.text}>
                {PlanApprovalPresentation.format(approved(), (key) => i18n.t(`tui.planApproval.${key}`))}
              </text>
            }
          >
            <scrollbox
              ref={(value) => {
                details = value
              }}
              maxHeight={Math.max(1, Math.min(20, dimensions().height - 18))}
            >
              <text fg={theme.text}>
                {PlanApprovalPresentation.format(approved(), (key) => i18n.t(`tui.planApproval.${key}`))}
              </text>
            </scrollbox>
            <text fg={theme.textMuted}>{i18n.t("tui.planApproval.scroll")} · PgUp/PgDn</text>
          </Show>
          <box gap={1}>
            <text
              fg={theme.accent}
              onMouseUp={(event) => {
                event.stopPropagation()
                show()
              }}
            >
              {i18n.t("tui.planApproval.view")}
              {props.kind === "question" ? " · v" : ""}
            </text>
            <text
              fg={theme.accent}
              onMouseUp={(event) => {
                event.stopPropagation()
                copy(approved().body)
              }}
            >
              {i18n.t("tui.planApproval.copy")}
              {props.kind === "question" ? " · c" : ""}
            </text>
          </box>
        </box>
      )}
    </Show>
  )
}

function Snapshot(props: { body: string; copy: () => void }) {
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined
  useBindings(() => ({
    bindings: [
      { key: "c", desc: i18n.t("tui.planApproval.copy"), group: "Dialog", cmd: props.copy },
      ...["up", "down", "pageup", "pagedown"].map((key) => ({
        key,
        desc: i18n.t("tui.planApproval.scroll"),
        group: "Dialog",
        cmd: () => scroll?.scrollBy((key === "up" || key === "pageup" ? -1 : 1) * (key.startsWith("page") ? 8 : 1)),
      })),
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>{i18n.t("tui.planApproval.view")}</text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(value) => {
          scroll = value
        }}
        height={Math.max(1, dimensions().height - 10)}
      >
        <text fg={theme.text}>{props.body}</text>
      </scrollbox>
      <text fg={theme.accent} onMouseUp={props.copy}>
        {i18n.t("tui.planApproval.copy")} · c
      </text>
    </box>
  )
}
