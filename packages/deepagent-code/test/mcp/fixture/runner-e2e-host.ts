// Private integration host. This uses the production HTTP graph, including its real
// SessionExecutionLocal owner. DEV_MINT is enabled only by the fixture launcher.
import { createInterface } from "node:readline"
import { createServer } from "node:net"
import { Effect, Exit, Cause } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"

const root = process.argv[2]!
const phase = process.argv[3]!
// Server.listen(0) prefers the product default port. Reserve an ephemeral port instead,
// so the fixture never attempts to bind a user's default listener.
const probe = createServer()
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
const address = probe.address()
if (!address || typeof address === "string") throw new Error("Missing private host port")
await new Promise<void>((resolve) => probe.close(() => resolve()))
await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: address.port })
await Bun.write(
  `${root}/host-${phase}-ready.json`,
  JSON.stringify({
    url: listener.url.href,
    pid: process.pid,
    fixtureDevMint: process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT === "1",
  }),
)
const input = createInterface({ input: process.stdin })
try {
  for await (const line of input) {
    const command = JSON.parse(line) as { type: "resume" | "wait" | "stop"; sessionID?: string; id: string }
    if (command.type === "stop") break
    const result = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const id = SessionSchema.ID.make(command.sessionID!)
        return yield* command.type === "wait" ? sessions.wait(id) : sessions.resume(id)
      }).pipe(Effect.exit),
    )
    await Bun.write(
      `${root}/command-${command.id}.json`,
      JSON.stringify({ status: result._tag, ...(Exit.isFailure(result) ? { cause: Cause.pretty(result.cause) } : {}) }),
    )
  }
} finally {
  input.close()
  await Bun.write(`${root}/host-${phase}-stopping.json`, JSON.stringify({ phase: "listener" }))
  await listener.stop(true)
  await Bun.write(`${root}/host-${phase}-stopping.json`, JSON.stringify({ phase: "default" }))
  await Server.disposeDefault()
  await Bun.write(`${root}/host-${phase}-stopping.json`, JSON.stringify({ phase: "runtime" }))
  await AppRuntime.dispose()
  await Bun.write(`${root}/host-${phase}-stopped.json`, JSON.stringify({ pid: process.pid }))
}
// readline leaves stdin referenced on some Bun versions even after close(). All owned
// production finalizers have completed before this fixture-only process termination.
process.exit(0)
