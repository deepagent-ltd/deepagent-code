import type { Session } from "@deepagent-code/sdk/v2/client"
import { createMemo } from "solid-js"
import { produce } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"

// Sidebar-level delete confirmation. Unlike the timeline's DialogDeleteSession (bound to the open
// session via useSDK/useSync), this operates on ANY session by directory + id using serverSDK and the
// per-directory serverSync child store — the sidebar lists sessions across directories.
export function DialogDeleteSession(props: { session: Session }): ReturnType<typeof Dialog> {
  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const name = createMemo(() => sessionTitle(props.session.title) ?? language.t("command.session.new"))

  const handleDelete = async () => {
    const session = props.session
    const [store, setStore] = serverSync.child(session.directory, { bootstrap: false })

    // Compute the neighbour to navigate to if we're deleting the session currently open.
    const roots = (store.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = roots.findIndex((s) => s.id === session.id)
    const nextSession = index === -1 ? undefined : (roots[index + 1] ?? roots[index - 1])

    const ok = await serverSDK.client.session
      .delete({ directory: session.directory, sessionID: session.id })
      .then(() => true)
      .catch((err: unknown) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: err instanceof Error ? err.message : String(err),
        })
        return false
      })
    if (!ok) {
      dialog.close()
      return
    }

    // Optimistically drop the deleted session and its whole descendant subtree from the store.
    const removed = new Set<string>([session.id])
    const byParent = new Map<string, string[]>()
    for (const item of store.session ?? []) {
      if (!item.parentID) continue
      const existing = byParent.get(item.parentID)
      if (existing) existing.push(item.id)
      else byParent.set(item.parentID, [item.id])
    }
    const stack = [session.id]
    while (stack.length) {
      const id = stack.pop()!
      for (const child of byParent.get(id) ?? []) {
        if (removed.has(child)) continue
        removed.add(child)
        stack.push(child)
      }
    }
    setStore(
      produce((draft) => {
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    // If the active route points at a removed session, navigate to a neighbour (or the new-session view).
    if (params.id && removed.has(params.id)) {
      const dir = base64Encode(session.directory)
      navigate(nextSession ? `/${dir}/session/${nextSession.id}` : `/${dir}/session`)
    }

    dialog.close()
  }

  return (
    <Dialog title={language.t("session.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("session.delete.confirm", { name: name() })}
          </span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={handleDelete}>
            {language.t("session.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
