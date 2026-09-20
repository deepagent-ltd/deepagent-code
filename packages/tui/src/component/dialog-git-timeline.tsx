import { createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { useProject } from "../context/project"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { execFile } from "node:child_process"

type FileCommit = {
  hash: string
  author: string
  date: string
  subject: string
}

// W4-4a — the TUI git-timeline face. The GUI version is desktop-only (Electron main runs local
// git); the TUI IS the local process, so this runs `git log --follow` over the tracked file
// directly. Accessed from the message tool-part context in a follow-up; here the file is chosen
// from the session's changed-file set or entered directly.
export function DialogGitTimeline(props: { file?: string }) {
  const dialog = useDialog()
  const project = useProject()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [commits, setCommits] = createSignal<FileCommit[] | undefined>(undefined)

  const git = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd: project.data.instance.path.worktree || undefined, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })

  const loadTimeline = (file: string) => {
    // Field order pinned by the pretty format; \x1f separates fields, \x1e separates records.
    void git(["log", "--follow", "--date=short", `--pretty=format:%h\x1f%an\x1f%ad\x1f%s\x1e`, "--", file])
      .then((output) => {
        const records = output
          .split("\x1e")
          .map((record) => record.trim())
          .filter(Boolean)
          .map((record) => {
            const [hash = "", author = "", date = "", subject = ""] = record.split("\x1f")
            return { hash, author, date, subject }
          })
        setCommits(records)
      })
      .catch(() => {
        setCommits([])
        toast.show({ variant: "warning", message: i18n.t("tui.git.noHistory"), duration: 4000 })
      })
  }

  onMount(() => {
    dialog.setSize("large")
    if (props.file) {
      loadTimeline(props.file)
      return
    }
    // No file preselected: list recently changed files from the working tree.
    void git(["diff", "--name-only", "HEAD~20", "--"])
      .catch(() => git(["ls-files"]))
      .then((output) => {
        const files = output.split("\n").filter(Boolean)
        if (files.length === 0) return
        setCommits(undefined)
        dialog.replace(() => (
          <DialogSelect
            title={i18n.t("tui.git.pickFile")}
            options={files.slice(0, 200).map((file) => ({ title: file, value: file, category: "Files" }))}
            current={undefined}
            onSelect={(option) => {
              loadTimeline(String(option.value))
              dialog.replace(() => <DialogGitTimeline file={String(option.value)} />)
            }}
          />
        ))
      })
      .catch(() => undefined)
  })

  if (props.file && commits() !== undefined) {
    return (
      <DialogSelect
        title={`${i18n.t("tui.git.timeline")} — ${props.file}`}
        options={(commits() ?? []).map((commit) => ({
          title: `${commit.hash} ${commit.subject}`.slice(0, 120),
          value: commit.hash,
          category: commit.date,
          footer: commit.author,
        }))}
        current={undefined}
        onSelect={(option) => {
          const commit = (commits() ?? []).find((item) => item.hash === String(option.value))
          if (!commit) return
          dialog.replace(() => (
            <DialogAlert title={commit.hash} message={`${commit.author} · ${commit.date}\n\n${commit.subject}`} />
          ))
        }}
      />
    )
  }

  return (
    <DialogSelect
      title={i18n.t("tui.git.timeline")}
      options={[{ title: props.file ?? i18n.t("tui.git.loading"), value: "loading", category: "…" }]}
      current={undefined}
      onSelect={() => {}}
    />
  )
}
