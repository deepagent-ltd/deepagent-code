import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import { useTuiI18n } from "../../context/i18n"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()
  const i18n = useTuiI18n()

  return (
    <DialogSelect
      title="Subagent Actions"
      options={[
        {
          title: i18n.t("tui.subagent.open"),
          value: "subagent.view",
          description: "the subagent's session",
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
