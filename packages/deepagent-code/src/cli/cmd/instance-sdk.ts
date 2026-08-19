// Shared SDK bootstrap + output helpers for the PARITY-004 long-tail query &
// control commands (goal/worktree/oversight/panel/review/wiki/packs).
//
// Same two channels as `run`:
// - default: in-process Server.Default().app.fetch (no server needed)
// - `--attach <url>`: a live server, authenticated via ServerAuth headers
// Commands never touch the DB directly — everything goes through the httpapi.
import { createOpencodeClient, type OpencodeClient } from "@deepagent-code/sdk/v2"
import type { Argv } from "yargs"
import { EOL } from "os"

export type AttachArgs = {
  attach?: string
  password?: string
  username?: string
}

export type QueryFormatArgs = AttachArgs & { format: "table" | "json" }

// Standard option block for every query/control command in this batch.
export function attachOptions<T>(yargs: Argv<T>) {
  return yargs
    .option("attach", {
      describe: "attach to a running server (e.g. http://localhost:4096)",
      type: "string",
    })
    .option("password", {
      describe: "password for the attached server",
      type: "string",
    })
    .option("username", {
      describe: "username for the attached server",
      type: "string",
    })
    .option("format", {
      describe: "output format",
      type: "string",
      choices: ["table", "json"],
      default: "table",
    })
}

export async function createInstanceSDK(args: AttachArgs, directory: string): Promise<OpencodeClient> {
  if (args.attach) {
    const { ServerAuth } = await import("@/server/auth")
    return createOpencodeClient({
      baseUrl: args.attach,
      directory,
      headers: ServerAuth.headers({ password: args.password, username: args.username }),
    })
  }
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { Server } = await import("@/server/server")
    const request = new Request(input, init)
    return Server.Default().app.fetch(request)
  }) as typeof globalThis.fetch
  return createOpencodeClient({
    baseUrl: "http://deepagent-code.internal",
    fetch: fetchFn,
    directory,
  })
}

// Friendly message for SDK call failures. `--attach` against a stopped server
// surfaces as a fetch/connection error; tell the user what to do about it.
export function formatSdkError(args: AttachArgs, error: unknown): string {
  let message: string
  if (error instanceof Error) message = error.message
  else if (typeof error === "object" && error !== null && "message" in error && typeof (error as { message: unknown }).message === "string")
    message = (error as { message: string }).message
  else message = String(error)
  if (args.attach && /fetch failed|ECONNREFUSED|connect|network/i.test(message)) {
    return `Could not reach the server at ${args.attach} — is it running? Start one with: deepagent-code serve`
  }
  return message
}

// Minimal padded table renderer (no dependencies). Rows are pre-stringified.
export function formatTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(empty)"
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  )
  const render = (cells: string[]) => cells.map((cell, index) => (cell ?? "").padEnd(widths[index]!)).join("  ")
  return [render(headers), widths.map((width) => "─".repeat(width)).join("  "), ...rows.map(render)].join(EOL)
}
