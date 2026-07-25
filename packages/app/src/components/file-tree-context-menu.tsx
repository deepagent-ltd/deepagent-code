import { createSignal, Show } from "solid-js"
import { ContextMenu } from "@deepagent-code/ui/context-menu"
import type { FileNode } from "@deepagent-code/sdk/v2"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { desktopApi, isLocalFilesystemOp } from "@/utils/desktop-api"
import { canExtract, canOpenTimeline, canPaste, parentPath } from "./file-tree-menu"

// Process-local clipboard for copy/cut → paste between file-tree nodes. Lives for the renderer
// lifetime; cut entries are cleared after a successful paste.
type Clip = { mode: "copy" | "cut"; absolute: string }
const [clip, setClip] = createSignal<Clip | null>(null)

export function FileTreeMenuContent(props: {
  node: FileNode
  onRename: () => void
  onOpenTimeline: (node: FileNode) => void
}) {
  const file = useFile()
  const language = useLanguage()

  // File-ops and the git timeline run in the desktop main process against the local filesystem.
  // They are only available on the desktop build AND when the connected sidecar is local
  // (loopback). On the web build or against a remote Server Edition, these menu items degrade to
  // disabled so the user never triggers an operation that would fail or touch the wrong host.
  const localFs = () => isLocalFilesystemOp({ desktop: Boolean(desktopApi()), localSidecar: file.isLocalSidecar() })
  const root = () => file.directory()

  const refresh = () => {
    void file.tree.refresh(parentPath(props.node.path))
    if (props.node.type === "directory") void file.tree.refresh(props.node.path)
  }

  const report = (
    res: { ok: boolean; error?: string } | undefined,
    okKey: string,
    errKey: string,
  ) => {
    if (!res) return
    if (res.ok) {
      showToast({ variant: "success", title: language.t(okKey) })
      refresh()
      return
    }
    showToast({ variant: "error", title: language.t(errKey), description: res.error })
  }

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() =>
      showToast({ variant: "success", title: language.t("fileTree.copied") }),
    )
  }

  const markClip = (mode: "copy" | "cut") => {
    setClip({ mode, absolute: props.node.absolute })
    showToast({ variant: "success", title: language.t(mode === "copy" ? "fileTree.copied" : "fileTree.cut") })
  }

  const paste = async () => {
    const current = clip()
    if (!current) return
    const destDir = props.node.absolute
    const res =
      current.mode === "copy"
        ? await desktopApi()?.fileOps?.copy(root(), current.absolute, destDir)
        : await desktopApi()?.fileOps?.move(root(), current.absolute, destDir)
    if (!res) return
    if (res.ok) {
      if (current.mode === "cut") setClip(null)
      showToast({ variant: "success", title: language.t("fileTree.pasted") })
      refresh()
      return
    }
    showToast({ variant: "error", title: language.t("fileTree.pasteFailed"), description: res.error })
  }

  const remove = async () => {
    if (!window.confirm(language.t("fileTree.deleteConfirm", { name: props.node.name }))) return
    report(await desktopApi()?.fileOps?.remove(root(), props.node.absolute), "fileTree.deleted", "fileTree.deleteFailed")
  }

  const archive = async () => {
    report(await desktopApi()?.fileOps?.archive(root(), props.node.absolute), "fileTree.archived", "fileTree.archiveFailed")
  }

  const extract = async () => {
    report(await desktopApi()?.fileOps?.extract(root(), props.node.absolute), "fileTree.extracted", "fileTree.extractFailed")
  }

  return (
    <>
      <ContextMenu.Item onSelect={() => copyText(props.node.path)}>
        <ContextMenu.ItemLabel>{language.t("fileTree.copyRelativePath")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => copyText(props.node.absolute)}>
        <ContextMenu.ItemLabel>{language.t("fileTree.copyAbsolutePath")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={() => markClip("copy")} disabled={!localFs()}>
        <ContextMenu.ItemLabel>{language.t("fileTree.copy")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => markClip("cut")} disabled={!localFs()}>
        <ContextMenu.ItemLabel>{language.t("fileTree.cut")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <Show when={canPaste({ nodeType: props.node.type, hasClip: Boolean(clip()), localFs: localFs() })}>
        <ContextMenu.Item onSelect={paste}>
          <ContextMenu.ItemLabel>{language.t("fileTree.paste")}</ContextMenu.ItemLabel>
        </ContextMenu.Item>
      </Show>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={remove} disabled={!localFs()}>
        <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => props.onRename()} disabled={!localFs()}>
        <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={archive} disabled={!localFs()}>
        <ContextMenu.ItemLabel>{language.t("fileTree.archive")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <Show when={canExtract({ nodeType: props.node.type, name: props.node.name })}>
        <ContextMenu.Item onSelect={extract} disabled={!localFs()}>
          <ContextMenu.ItemLabel>{language.t("fileTree.extract")}</ContextMenu.ItemLabel>
        </ContextMenu.Item>
      </Show>
      <Show when={canOpenTimeline({ nodeType: props.node.type, localFs: localFs() })}>
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={() => props.onOpenTimeline(props.node)}>
          <ContextMenu.ItemLabel>{language.t("fileTree.openTimeline")}</ContextMenu.ItemLabel>
        </ContextMenu.Item>
      </Show>
    </>
  )
}
