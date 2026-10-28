import { GlobalRuntimeFixture } from "../server/fixture/global-runtime"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Layer, Option } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { Database } from "@deepagent-code/core/database/database"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { MoveSession } from "@deepagent-code/core/control-plane/move-session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ServerAuth } from "@/server/auth"
import { RootHttpApi } from "@/server/routes/instance/httpapi/api"
import { controlHandlers } from "@/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "@/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "@/server/routes/instance/httpapi/handlers/global"
import { workRecoveryHandlers } from "@/server/routes/instance/httpapi/handlers/work-recovery"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"

export function importServer(filename: string, password?: string) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, workRecoveryHandlers()]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    // Published fixture URLs must be usable by the SDK and browser clients.
    Layer.provideMerge(HttpServer.layerTestClient.pipe(
      Layer.provide(Layer.fresh(FetchHttpClient.layer).pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
      )),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    )),
    Layer.provideMerge(Database.layerFromPath(filename)),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(GlobalRuntimeFixture.layer),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(Layer.mock(Installation.Service)({})),
    Layer.provide(ServerAuth.Config.layer({ password: Option.fromUndefinedOr(password), username: "deepagent-code" })),
    Layer.provide(RuntimeFlags.layer({})),
  )
}

export async function importSource(root: string, source: "codex" | "claude", count = 1) {
  const cwd = path.join(root, "project")
  const sourcePath = path.join(root, source)
  await fs.mkdir(cwd, { recursive: true })
  for (let index = 0; index < count; index++) {
    const id = `durable-import-${index}`
    const content =
      source === "codex"
        ? [
            { type: "session_meta", payload: { id, cwd } },
            { type: "response_item", payload: { type: "message", role: "user", content: `question ${index}` } },
            { type: "response_item", payload: { type: "message", role: "assistant", content: `answer ${index}` } },
          ]
        : [
            { type: "user", sessionId: id, cwd, message: { role: "user", content: `question ${index}` } },
            {
              type: "assistant",
              sessionId: id,
              cwd,
              message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
            },
          ]
    await Bun.write(
      path.join(
        sourcePath,
        source === "codex" ? "sessions" : "projects/fixture",
        `rollout-${String(index).padStart(5, "0")}.jsonl`,
      ),
      content.map((line) => JSON.stringify(line)).join("\n"),
    )
  }
  return sourcePath
}
