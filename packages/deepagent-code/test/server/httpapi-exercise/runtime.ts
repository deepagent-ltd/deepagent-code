import path from "node:path"

export type Runtime = {
  PublicApi: (typeof import("../../../src/server/routes/instance/httpapi/public"))["PublicApi"]
  HttpApiApp: (typeof import("../../../src/server/routes/instance/httpapi/server"))["HttpApiApp"]
  AppLayer: (typeof import("../../../src/effect/app-runtime"))["AppLayer"]
  memoMap: import("effect").Layer.MemoMap
  InstanceRef: (typeof import("../../../src/effect/instance-ref"))["InstanceRef"]
  InstanceStore: (typeof import("../../../src/project/instance-store"))["InstanceStore"]
  Session: (typeof import("../../../src/session/session"))["Session"]
  SessionExecution: (typeof import("@deepagent-code/core/session/execution"))["SessionExecution"]
  Todo: (typeof import("../../../src/session/todo"))["Todo"]
  Worktree: (typeof import("../../../src/worktree"))["Worktree"]
  Project: (typeof import("../../../src/project/project"))["Project"]
  tmpdir: (typeof import("../../fixture/fixture"))["tmpdir"]
}

let runtimePromise: Promise<Runtime> | undefined

export function runtime() {
  return (runtimePromise ??= (async () => {
    await import("../../fixture/cli-secret-store")
    const publicApi = await import("../../../src/server/routes/instance/httpapi/public")
    const httpApiServer = await import("../../../src/server/routes/instance/httpapi/server")
    const appRuntime = await import("../../../src/effect/app-runtime")
    const { Layer } = await import("effect")
    const instanceRef = await import("../../../src/effect/instance-ref")
    const instanceStore = await import("../../../src/project/instance-store")
    const session = await import("../../../src/session/session")
    const { SessionExecution } = await import("@deepagent-code/core/session/execution")
    const todo = await import("../../../src/session/todo")
    const worktree = await import("../../../src/worktree")
    const project = await import("../../../src/project/project")
    const fixture = await import("../../fixture/fixture")
    const { IMDeviceStore } = await import("../../../src/im/device-store")
    const { exerciseDataDirectory } = await import("./environment")
    // HTTP contracts exercise unavailable custody explicitly. A test HOME does
    // not isolate the OS Keychain, and no device/Native qualification is minted.
    const deviceStore = Layer.succeed(
      IMDeviceStore.Service,
      IMDeviceStore.make({
        directory: path.join(exerciseDataDirectory, "im-device"),
        backend: {
          id: "httpapi-custody-unavailable",
          available: async () => false,
          get: async () => {
            throw new Error("HTTP exerciser must not read device custody")
          },
          put: async () => {
            throw new Error("HTTP exerciser must not write device custody")
          },
          remove: async () => {
            throw new Error("HTTP exerciser must not remove device custody")
          },
        },
      }),
    )
    return {
      PublicApi: publicApi.PublicApi,
      HttpApiApp: {
        ...httpApiServer.HttpApiApp,
        routes: httpApiServer.HttpApiApp.createRoutes(undefined, undefined, {
          imRuntime: httpApiServer.HttpApiApp.createIMRuntimeLayer(undefined, deviceStore),
        }),
      },
      AppLayer: appRuntime.AppLayer,
      memoMap: Layer.makeMemoMapUnsafe(),
      InstanceRef: instanceRef.InstanceRef,
      InstanceStore: instanceStore.InstanceStore,
      Session: session.Session,
      SessionExecution,
      Todo: todo.Todo,
      Worktree: worktree.Worktree,
      Project: project.Project,
      tmpdir: fixture.tmpdir,
    }
  })())
}
