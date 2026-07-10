import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@deepagent-code/core/control-plane/move-session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Database } from "@deepagent-code/core/database/database"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const input = MoveSession.Input.make({
  sessionID: SessionV2.ID.make("ses_move"),
  destination: { directory: AbsolutePath.make("/destination") },
  moveChanges: true,
})
const called = Ref.makeUnsafe<MoveSession.Input | undefined>(undefined)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    Layer.mock(MoveSession.Service)({
      moveSession: (value) => Ref.set(called, value),
    }),
  ),
  Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "deepagent-code" })),
  Layer.provide(Database.layerFromPath(":memory:")),
  Layer.provide(RuntimeFlags.layer({})),
)
const it = testEffect(apiLayer)

describe("control-plane HttpApi", () => {
  it.live("moves a session through the root control-plane route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(input)),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(yield* Ref.get(called)).toEqual(input)
    }),
  )
})
