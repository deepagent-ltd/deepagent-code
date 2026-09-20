import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionRuntime } from "@deepagent-code/core/session/runtime"
import { Delegation } from "@deepagent-code/core/tool/delegation"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"

const databaseLayer = Database.defaultLayer
const eventLayer = EventV2.defaultLayer.pipe(Layer.provide(databaseLayer))

/** The single bare-Core runtime used by every lildax/server adapter. Reusing this exact Layer
 * object lets Effect's memo map preserve one Database/Event/Location identity even when an outer
 * transport must satisfy the route layer's inferred requirements. */
export const runtimeLayer = Layer.mergeAll(
  databaseLayer,
  eventLayer,
  LocationServiceMap.layer.pipe(Layer.provide(databaseLayer), Layer.provide(eventLayer)),
  ProjectV2.defaultLayer,
  PermissionSaved.defaultLayer,
  Delegation.delegationSlotLayer,
)

export function createRoutes(password?: string) {
  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(SessionRuntime.productionLayer.pipe(Layer.provide(runtimeLayer))),
    Layer.provide(
      password
        ? ServerAuth.Config.layer({ username: "deepagent-code", password: Option.some(password) })
        : ServerAuth.Config.defaultLayer,
    ),
    Layer.provide(runtimeLayer),
    Layer.provide(FetchHttpClient.layer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )
