import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(Commands.commands.import, (input) =>
  Effect.gen(function* () {
    if (input.source !== "codex" && input.source !== "claude") {
      return yield* Effect.fail(new Error(`--source must be "codex" or "claude", got: ${input.source}`))
    }

    const daemon = yield* Daemon.Service
    const transport = yield* daemon.transport()

    process.stderr.write(`Importing from ${input.source}: ${input.file}\n`)

    const response = yield* Effect.tryPromise(() =>
      fetch(`${transport.url}/global/import`, {
        method: "POST",
        headers: { ...transport.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ source: input.source, sourcePath: input.file }),
      }),
    )

    if (!response.ok) {
      const text = yield* Effect.tryPromise(() => response.text())
      return yield* Effect.fail(new Error(`Import failed (${response.status}): ${text}`))
    }

    if (!response.body) {
      console.log("Import completed (no progress stream)")
      return
    }

    yield* consumeSSE(response.body)
  }),
)

function consumeSSE(stream: ReadableStream<Uint8Array>) {
  return Effect.promise<void>(async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (!data) continue
          try {
            const event = JSON.parse(data)
            if (event.phase === "done") {
              if (event.report) {
                console.log(`Imported: ${event.report.sessions ?? 0} sessions, ${event.report.messages ?? 0} messages`)
              }
              return
            }
            if (event.phase === "error") {
              throw new Error(event.message ?? "Import failed")
            }
            if (event.message) {
              process.stderr.write(`${event.message}${EOL}`)
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue
            throw e
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  })
}
