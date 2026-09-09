import * as Log from "@deepagent-code/core/util/log"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    process.env.DEEPAGENT_CODE_CLIENT = "acp"
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))
    let cleanupInput = () => {}
    let cleanupAgent = () => {}

    return yield* Effect.gen(function* () {
      const sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
        headers: ServerAuth.headers(),
      })

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
                return
              }
              resolve()
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          const onData = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk))
          const onEnd = () => {
            cleanupInput()
            controller.close()
          }
          const onError = (error: Error) => {
            cleanupInput()
            controller.error(error)
          }
          cleanupInput = () => {
            process.stdin.off("data", onData)
            process.stdin.off("end", onEnd)
            process.stdin.off("error", onError)
          }
          process.stdin.on("data", onData)
          process.stdin.on("end", onEnd)
          process.stdin.on("error", onError)
        },
        cancel() {
          cleanupInput()
        },
      })

      const stream = ndJsonStream(input, output)
      const agent = ACP.init({ sdk })
      cleanupAgent = agent.dispose

      new AgentSideConnection((conn) => {
        ACPProfile.mark("cli.acp.connection.create")
        return agent.create(conn)
      }, stream)

      log.info("setup connection")
      process.stdin.resume()
      yield* Effect.callback<void>((resume) => {
        const onEnd = () => resume(Effect.void)
        const onError = (error: Error) => resume(Effect.die(error))
        process.stdin.once("end", onEnd)
        process.stdin.once("error", onError)
        return Effect.sync(() => {
          process.stdin.off("end", onEnd)
          process.stdin.off("error", onError)
        })
      })
    }).pipe(
      Effect.ensuring(Effect.sync(() => cleanupInput())),
      Effect.ensuring(Effect.sync(() => cleanupAgent())),
      Effect.ensuring(Effect.promise(() => server.stop(true))),
    )
  }),
})
