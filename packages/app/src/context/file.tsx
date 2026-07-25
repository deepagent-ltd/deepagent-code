import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@deepagent-code/ui/context"
import { showToast } from "@/utils/toast"
import { useParams } from "@solidjs/router"
import { getFilename } from "@deepagent-code/core/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { useServerSDK } from "./server-sdk"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const serverSDK = useServerSDK()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const path = createPathHelpers(scope)
    // The desktop file-ops/git bridge runs in the local main process, so it is only valid when the
    // connected sidecar is on the loopback (a remote Server Edition connection must not let the
    // local bridge touch paths that only exist on the remote host).
    const isLocalSidecar = createMemo(() => {
      try {
        const url = new URL(serverSDK.url)
        return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      } catch {
        return false
      }
    })
    const tabs = layout.tabs(() =>
      SessionStateKey.from(serverSDK.scope, SessionRouteKey.fromRoute(params.dir, params.id)),
    )

    const inflight = new Map<string, Promise<void>>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) => sdk.client.file.list({ path: dir }).then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      inflight.clear()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache(serverSDK.scope)
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk.client.file
        .read({ path: file })
        .then((x) => {
          if (scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const stop = sdk.event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      directory: () => scope(),
      isLocalSidecar,
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),

      // ── V3.6 Phase 1B mutation helpers ──────────────────────────────────
      // These wrap sdk.client.file mutations and avoid the DOM-File naming
      // conflict that arises when components import the SDK client directly.

      writeFile: (
        filePath: string,
        content: string,
        expected?: string,
      ): Promise<{ ok: boolean; error?: string }> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.write({ path: path.normalize(filePath), content, expected }) as any).then(
          (r: any) => (r.data as { ok: boolean; error?: string } | undefined) ?? { ok: false, error: "no_response" },
        ),

      createFile: (filePath: string, content = ""): Promise<{ ok: boolean; error?: string }> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.createFile({ path: path.normalize(filePath), content }) as any).then(
          (r: any) => (r.data as { ok: boolean; error?: string } | undefined) ?? { ok: false, error: "no_response" },
        ),

      deleteFile: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.deleteFile({ path: path.normalize(filePath) }) as any).then(
          (r: any) => (r.data as { ok: boolean; error?: string } | undefined) ?? { ok: false, error: "no_response" },
        ),

      renameFile: (from: string, to: string): Promise<{ ok: boolean; error?: string }> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.rename({ from: path.normalize(from), to: path.normalize(to) }) as any).then(
          (r: any) => (r.data as { ok: boolean; error?: string } | undefined) ?? { ok: false, error: "no_response" },
        ),

      mkdir: (dirPath: string): Promise<{ ok: boolean; error?: string }> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.mkdir({ path: path.normalize(dirPath) }) as any).then(
          (r: any) => (r.data as { ok: boolean; error?: string } | undefined) ?? { ok: false, error: "no_response" },
        ),

      // ── V3.7 Phase 4.1D 编辑锁方法 ──────────────────────────────────────────

      /** 获取文件编辑锁（human 锁可抢占 agent 锁）。返回 lockId 或 error。 */
      acquireLock: (filePath: string): Promise<{ ok: boolean; lockId?: string; error?: string }> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.lockAcquire({ path: path.normalize(filePath), kind: "human" }) as any).then(
          (r: any) => {
            const d = r.data as { ok: boolean; lock?: { lockId: string }; error?: string } | undefined
            if (!d?.ok) return { ok: false, error: d?.error ?? "no_response" }
            return { ok: true, lockId: d.lock?.lockId }
          },
        ),

      /** 续租锁（心跳，每15s调一次）。lockId 不匹配时静默失败。 */
      renewLock: (lockId: string): Promise<boolean> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.lockRenew({ lockId }) as any).then(
          (r: any) => (r.data as { ok: boolean } | undefined)?.ok ?? false,
        ).catch(() => false),

      /** 释放锁（关闭编辑器时调用）。 */
      releaseLock: (lockId: string): Promise<void> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sdk.client.file.lockRelease({ lockId }) as any).catch(() => undefined),
    }
  },
})
