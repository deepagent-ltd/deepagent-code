import { EOL } from "os"
import { spawn } from "node:child_process"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { SessionClient } from "../../../services/session-client"
import type { Session } from "@deepagent-code/sdk/v2"

export default Runtime.handler(Commands.commands.session.commands.list, (input) =>
  Effect.gen(function* () {
    const limit = Option.getOrElse(input["max-count"], () => undefined)
    const result = yield* SessionClient.list({ roots: true, limit })
    const sessions = result.data ?? []
    if (sessions.length === 0) return

    const output = input.format === "json" ? formatJSON(sessions) : formatTable(sessions)

    const shouldPaginate = process.stdout.isTTY && Option.isNone(input["max-count"]) && input.format === "table"
    if (shouldPaginate) {
      yield* paginate(output)
    } else {
      console.log(output)
    }
  }),
)

function formatTable(sessions: Session[]): string {
  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  const lines = [header, "─".repeat(header.length)]

  for (const session of sessions) {
    const truncatedTitle = session.title.length > maxTitleWidth ? session.title.slice(0, maxTitleWidth) : session.title
    const timeStr = todayTimeOrDateTime(session.time.updated)
    lines.push(`${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`)
  }

  return lines.join(EOL)
}

function formatJSON(sessions: Session[]): string {
  return JSON.stringify(
    sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updated: session.time.updated,
      created: session.time.created,
      projectId: session.projectID,
      directory: session.directory,
    })),
    null,
    2,
  )
}

function todayTimeOrDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString()
  }
  return date.toLocaleString()
}

function paginate(output: string) {
  return Effect.promise<void>(() => {
    const proc = spawn("less", ["-R", "-S"], { stdio: ["pipe", "inherit", "inherit"] })
    if (!proc.stdin) {
      console.log(output)
      return Promise.resolve()
    }
    proc.stdin.write(output)
    proc.stdin.end()
    return new Promise<void>((resolve) => proc.on("exit", () => resolve()))
  })
}
