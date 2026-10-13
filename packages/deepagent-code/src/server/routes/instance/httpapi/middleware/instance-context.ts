import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"
import { resolveRoutedDirectory } from "../utils/workspace-context"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@deepagent-code/ExperimentalHttpApiInstanceContext") {}

export function provideInstanceContext<A, E, R>(effect: Effect.Effect<A, E, R>, store: InstanceStore.Interface) {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const ctx = yield* store.load({ directory: resolveRoutedDirectory(route.directory) })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) =>
      Effect.gen(function* () {
        const matched = yield* HttpRouter.RouteContext
        // These existing endpoints use the dedicated read model. Every other
        // route retains the normal instance bootstrap and permission boundary.
        if (matched.route.method === "GET" && ["/command", "/experimental/resource"].includes(matched.route.path))
          return yield* effect
        // Management reauthenticates the original durable request and routed
        // directory; source-offline cancellation must not wait for instance boot.
        if (
          (matched.route.method === "GET" && matched.route.path === "/api/v1/im/tasks/requests/:requestID/state") ||
          (matched.route.method === "POST" && [
            "/api/v1/im/tasks/requests/:requestID/cancel",
            "/api/v1/im/tasks/requests/:requestID/refuse",
          ].includes(matched.route.path))
        ) return yield* effect
        return yield* provideInstanceContext(effect, store)
      }),
    )
  }),
)
