export * as SourceEmptySettingsRoot from "./source-empty-settings-root"

import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { makeMemoMap } from "@deepagent-code/core/effect/memo-map"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"
import { NativeWindowsBootstrap } from "../../src/installation/windows-native-bootstrap"
import { EmptySettingsFixture } from "./empty-settings"

// A request Context does not supply the independent handler's layer build.
// Keep real routes and the caller's root map, defaulting to a private root.
const emptySettings = Layer.unwrap(
  Effect.gen(function* () {
    if (yield* NativeWindowsBootstrap.Registered)
      return yield* Effect.die(new Error("Empty settings HTTP fixture cannot replace registered Native storage"))
    return EmptySettingsFixture.layer
  }),
)

export function webHandler(routes = HttpApiApp.createRoutes(), memoMap = makeMemoMap()) {
  return Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(process.platform === "win32" ? routes.pipe(Layer.provideMerge(emptySettings)) : routes, {
        disableLogger: true,
        memoMap,
        middleware: disposeMiddleware,
      }),
    ),
    (handler) => Effect.promise(() => handler.dispose()),
  )
}
