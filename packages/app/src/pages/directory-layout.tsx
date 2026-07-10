import { DataProvider } from "@deepagent-code/ui/context"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { LocalProvider } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { isFilesystemRootDir, recoverFilesystemRootRoute } from "@/utils/filesystem-root"
import { formatServerError } from "@/utils/server-errors"
import { Schema } from "effect"

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const slug = createMemo(() => base64Encode(props.directory))

  createEffect(() => {
    const next = sync.data.path.directory
    if (!next || next === props.directory) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createResource(
    () => params.id,
    (id) => sync.session.sync(id).catch(() => {}),
  )

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) => navigate(`/${slug()}/session/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/${slug()}/session/${sessionID}`}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  let invalid = ""
  let recovering = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decodeDirectory(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  createEffect(() => {
    const directory = resolved()
    if (!directory || !isFilesystemRootDir(directory)) return
    const dataDir = serverSync.data.path.data
    if (!dataDir) return
    const key = `${params.dir}/${params.id ?? ""}`
    if (recovering === key) return
    recovering = key

    void recoverFilesystemRootRoute({
      dataDir,
      sessionID: params.id,
      getSession: (sessionID) =>
        serverSDK.client.session
          .get({ sessionID })
          .then((response) => response.data)
          .catch(() => undefined),
      mkdir: async (destination) => {
        await serverSDK.createClient({ directory: destination, throwOnError: true }).file.mkdir({ path: "." })
      },
      moveSession: async (sessionID, destination) => {
        await serverSDK.client.experimental.controlPlane.moveSession({
          sessionID,
          destination: { directory: destination },
        })
      },
    })
      .then((result) => {
        layout.projects.open(result.directory)
        server.projects.touch(result.directory)
        const session = result.sessionID ? `/session/${result.sessionID}` : "/session"
        navigate(`/${base64Encode(result.directory)}${session}`, { replace: true })
      })
      .catch((error) => {
        showToast({
          variant: "error",
          title: language.t("toast.project.rootRecoveryFailed.title"),
          description: formatServerError(error, language.t),
        })
        navigate("/", { replace: true })
      })
  })

  return (
    <Show when={resolved() && !isFilesystemRootDir(resolved()) ? resolved() : undefined} keyed>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
