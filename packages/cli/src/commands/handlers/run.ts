import { EOL } from "os"
import { Effect, Option } from "effect"
import { createOpencodeClient } from "@deepagent-code/sdk/v2/client"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"
import { SessionClient } from "../../services/session-client"

type Client = ReturnType<typeof createOpencodeClient>
type ModelInput = { providerID: string; modelID: string }

export default Runtime.handler(Commands.commands.run, (input) =>
  Effect.gen(function* () {
    const message = input.message.join(" ")
    const piped = process.stdin.isTTY ? undefined : yield* Effect.promise(() => Bun.stdin.text())
    const fullMessage = [message, piped].filter(Boolean).join("\n")

    if (!fullMessage.trim()) {
      return yield* Effect.fail(new Error("You must provide a message"))
    }

    if (input.fork && !input.continue && Option.isNone(input.session)) {
      return yield* Effect.fail(new Error("--fork requires --continue or --session"))
    }

    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const sessionID = yield* resolveSession(input)

    const events = yield* Effect.tryPromise(() => client.event.subscribe())

    const model = pickModel(input.model)
    const promptResult = yield* SessionClient.promptAsync({
      sessionID,
      parts: [{ type: "text", text: fullMessage }],
      model,
      agent: Option.getOrElse(input.agent, () => undefined),
      variant: Option.getOrElse(input.variant, () => undefined),
    })

    if (promptResult.error) {
      yield* Effect.tryPromise(() => events.stream.return(undefined)).pipe(Effect.ignore)
      return yield* Effect.fail(new Error(formatError(promptResult.error)))
    }

    yield* consumeEvents(client, events, sessionID, input.format, input["dangerously-skip-permissions"])
  }),
)

function pickModel(value: Option.Option<string>): ModelInput | undefined {
  if (Option.isNone(value)) return undefined
  const [providerID, ...rest] = value.value.split("/")
  return { providerID, modelID: rest.join("/") }
}

function resolveSession(input: {
  session: Option.Option<string>
  continue: boolean
  fork: boolean
  model: Option.Option<string>
  agent: Option.Option<string>
  variant: Option.Option<string>
}) {
  if (Option.isSome(input.session)) {
    return resolveExistingSession(input.session.value, input.fork)
  }
  if (input.continue) {
    return resolveContinueSession(input.fork)
  }
  return createNewSession(input.model, input.agent, input.variant)
}

function resolveExistingSession(sessionID: string, fork: boolean) {
  return Effect.gen(function* () {
    const result = yield* SessionClient.get({ sessionID })
    if (!result.data) return yield* Effect.fail(new Error("Session not found"))
    if (fork) {
      const forked = yield* SessionClient.fork({ sessionID })
      const id = forked.data?.id
      if (!id) return yield* Effect.fail(new Error("Failed to fork session"))
      return id
    }
    return sessionID
  })
}

function resolveContinueSession(fork: boolean) {
  return Effect.gen(function* () {
    const result = yield* SessionClient.list({})
    const base = result.data?.find((s) => !s.parentID)
    if (!base) return yield* Effect.fail(new Error("No session to continue"))
    if (fork) {
      const forked = yield* SessionClient.fork({ sessionID: base.id })
      const id = forked.data?.id
      if (!id) return yield* Effect.fail(new Error("Failed to fork session"))
      return id
    }
    return base.id
  })
}

function createNewSession(
  modelFlag: Option.Option<string>,
  agent: Option.Option<string>,
  variant: Option.Option<string>,
) {
  return Effect.gen(function* () {
    const model = pickModel(modelFlag)
    const result = yield* SessionClient.create({
      agent: Option.getOrElse(agent, () => undefined),
      model: model
        ? { providerID: model.providerID, id: model.modelID, variant: Option.getOrElse(variant, () => undefined) }
        : undefined,
    })
    const id = result.data?.id
    if (!id) return yield* Effect.fail(new Error("Failed to create session"))
    return id
  })
}

function consumeEvents(
  client: Client,
  events: Awaited<ReturnType<Client["event"]["subscribe"]>>,
  sessionID: string,
  format: string,
  skipPermissions: boolean,
) {
  return Effect.promise(async () => {
    let error: string | undefined

    try {
      for await (const event of events.stream as AsyncIterable<any>) {
        if (format === "json") {
          process.stdout.write(
            JSON.stringify({ type: event.type, timestamp: Date.now(), sessionID, ...event.properties }) + EOL,
          )
        }

        if (event.type === "message.part.updated") {
          const part = event.properties.part
          if (part.sessionID !== sessionID) continue

          if (format !== "json") {
            if (part.type === "text" && part.time?.end) {
              const text = part.text.trim()
              if (text) process.stdout.write(text + EOL)
            }
            if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
              process.stderr.write(`[tool] ${part.tool}${EOL}`)
            }
          }
        }

        if (event.type === "session.error") {
          const props = event.properties
          if (props.sessionID !== sessionID || !props.error) continue
          const err = formatError(props.error)
          error = error ? error + EOL + err : err
          if (format !== "json") process.stderr.write(err + EOL)
        }

        if (
          event.type === "session.status" &&
          event.properties.sessionID === sessionID &&
          event.properties.status.type === "idle"
        ) {
          break
        }

        if (event.type === "permission.asked") {
          const permission = event.properties
          if (permission.sessionID !== sessionID) continue

          if (skipPermissions) {
            await client.permission.reply({ requestID: permission.id, reply: "once" })
          } else {
            process.stderr.write(
              `permission requested: ${permission.permission} (${permission.patterns?.join(", ")}); auto-rejecting${EOL}`,
            )
            await client.permission.reply({ requestID: permission.id, reply: "reject" })
          }
        }
      }
    } finally {
      await events.stream.return(undefined)
    }

    if (error) throw new Error(error)
  })
}

function formatError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error)
  const obj = error as Record<string, unknown>
  if (typeof obj.data === "object" && obj.data !== null && "message" in obj.data) {
    return String((obj.data as Record<string, unknown>).message)
  }
  if (typeof obj.name === "string") return obj.name
  return String(error)
}

type RunInput = {
  message: ReadonlyArray<string>
  model: Option.Option<string>
  agent: Option.Option<string>
  format: string
  continue: boolean
  session: Option.Option<string>
  fork: boolean
  variant: Option.Option<string>
}
