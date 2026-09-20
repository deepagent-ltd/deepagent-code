import { createResource, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"

type BackupInfo = { fileName: string; filePath: string; sizeBytes: number; sha256: string; createdAt: number }

// W4-4b — the TUI backup/maintenance face: bootstrap status + backup list + verify. Restore is
// deliberately GUI-side (it restarts the server surface); the TUI observes and verifies.
export function DialogBackup() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()

  const [status] = createResource(async () => {
    const result = await sdk.client.maintenance.bootstrap.status().catch(() => undefined)
    return result?.data
  })

  const [backups, { refetch }] = createResource(async () => {
    const result = await sdk.client.maintenance.backup.list({}).catch(() => undefined)
    return (result?.data?.backups ?? []) as BackupInfo[]
  })

  const verify = async (path: string) => {
    try {
      const result = await sdk.client.maintenance.backup.verify({ manifest_path: path })
      if (result.error) throw result.error
      const data = result.data as { ok?: boolean; checked?: number; problems?: string[] }
      dialog.replace(() => (
        <DialogAlert
          title={i18n.t("tui.backup.verify")}
          message={[
            data.ok ? "OK" : "PROBLEMS",
            `checked: ${data.checked ?? 0}`,
            ...(data.problems ?? []).slice(0, 10),
          ].join("\n")}
        />
      ))
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    }
  }

  const options = () =>
    (backups.latest ?? []).map((backup) => ({
      title: backup.fileName,
      value: backup.filePath,
      category: i18n.t("tui.backup.backups"),
      footer: `${Locale.time(backup.createdAt)} · ${(backup.sizeBytes / 1024 / 1024).toFixed(1)}MB · ${backup.sha256.slice(0, 12)}`,
    }))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={`${i18n.t("tui.backup.title")}${status.latest ? ` · ${status.latest}` : ""}`}
      options={options()}
      current={undefined}
      onSelect={() => {}}
      actions={[
        {
          command: "backup.verify",
          title: i18n.t("tui.backup.verify"),
          onTrigger: (option: { value: string }) => {
            void verify(String(option.value))
          },
        },
      ]}
    />
  )
}
