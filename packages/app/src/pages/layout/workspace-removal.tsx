import { createContext, onCleanup, useContext } from "solid-js"
import { pathKey } from "@/utils/path-key"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { isFilesystemRootDir } from "@/utils/filesystem-root"

type WorkspaceProject = { id: string; worktree: string }

export function createWorkspaceRemoval(input: {
  scope: () => string
  project: (directory: string) => WorkspaceProject | undefined
  client: () => DeepAgentCodeClient
  currentDir: () => string
  lastSession: (root: string) => { directory: string } | undefined
  clearLastSession: (root: string) => void
  removeSandbox: (project: WorkspaceProject, directory: string) => void
  removeOrder: (root: string, directory: string) => void
  closeProject: (directory: string) => void
  openProject: (root: string) => void
  navigate: (root: string) => void
}) {
  let disposed = false
  onCleanup(() => (disposed = true))

  const complete = (project: WorkspaceProject, directory: string, retained = project.worktree) => {
    if (pathKey(input.lastSession(project.worktree)?.directory ?? "") === pathKey(directory)) {
      input.clearLastSession(project.worktree)
    }
    input.removeSandbox(project, directory)
    if (pathKey(project.worktree) === pathKey(directory) && pathKey(retained) !== pathKey(directory)) {
      input.removeSandbox(project, retained)
    }
    input.removeOrder(project.worktree, directory)
    input.closeProject(directory)
    input.openProject(retained)
  }

  return {
    complete,
    capture(directory: string) {
      const scope = input.scope()
      const current = () => !disposed && input.scope() === scope
      return {
        current,
        async resolve(signal: AbortSignal) {
          const ready = () => current() && !signal.aborted && pathKey(input.currentDir()) === pathKey(directory)
          if (!ready()) return
          const known = input.project(directory)
          const client = input.client()
          const metadata =
            known && pathKey(known.worktree) !== pathKey(directory)
              ? known
              : await client.project
                  .current({ directory }, { signal })
                  .then((result) => (result.data?.vcs === "git" ? result.data : undefined))
          if (!ready() || !metadata?.id || metadata.id === "global" || !metadata.worktree) return
          // A fresh linked-first project may legitimately name the opened sandbox as its worktree.
          // Keep that Project unchanged; only the registered default-branch checkout is retained.
          const project = { id: metadata.id, worktree: metadata.worktree }
          const root =
            pathKey(project.worktree) !== pathKey(directory)
              ? project.worktree
              : await client.worktree
                  .summary({ directory, worktreeRemoveInput: { directory } }, { signal })
                  .then((result) => result.data?.defaultCheckout)
          if (!ready() || !root || isFilesystemRootDir(root) || pathKey(root) === pathKey(directory)) return
          return {
            root,
            complete(onLeave: () => void) {
              if (!current()) return false
              const leave = pathKey(input.currentDir()) === pathKey(directory)
              if (leave) onLeave()
              complete(project, directory, root)
              if (leave) input.navigate(root)
              return leave
            },
          }
        },
      }
    },
  }
}

const WorkspaceRemovalContext = createContext<ReturnType<typeof createWorkspaceRemoval>>()
export const WorkspaceRemovalProvider = WorkspaceRemovalContext.Provider

export function useWorkspaceRemoval() {
  const value = useContext(WorkspaceRemovalContext)
  if (!value) throw new Error("WorkspaceRemovalProvider is required")
  return value
}
