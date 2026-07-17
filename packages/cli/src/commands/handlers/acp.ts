import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect, Option } from "effect"
import { ServerAuth } from "@deepagent-code/server/auth"

export default Runtime.handler(Commands.commands.acp, (input) =>
  Effect.gen(function* () {
    const { Server } = yield* Effect.promise(() => import("deepagent-code/server/server"))
    const { ACP } = yield* Effect.promise(() => import("deepagent-code/acp/agent"))
    process.env.DEEPAGENT_CODE_CLIENT = "acp"

    const port = Option.getOrElse(input.port as Option.Option<number>, () => 0)

    const server = yield* Effect.promise(() => Server.listen({ hostname: input.hostname, port }))

    const { createOpencodeClient } = yield* Effect.promise(() => import("@deepagent-code/sdk/v2/client"))
    const sdk = createOpencodeClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: ServerAuth.headers(),
    })

    const { AgentSideConnection, ndJsonStream } = yield* Effect.promise(() =>
      import("@agentclientprotocol/sdk"),
    )

    const acpInput = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()))
        })
      },
    })
    const acpOutput = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(acpInput, acpOutput)
    const agent = ACP.init({ sdk })

    new AgentSideConnection((conn: unknown) => agent.create(conn as never), stream)
    process.stdin.resume()

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
  }),
)
