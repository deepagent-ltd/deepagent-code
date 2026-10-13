// Goal command receipts and complete status come from the instance HTTP API.
// CLI retries retain the original Goal identity; they never retarget the latest Goal.
import type { Argv } from "yargs"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { Effect, Schema } from "effect"
import { GoalPlanRebaseSchema } from "@deepagent-code/core/deepagent/goal-plan-rebase.schema"
import { cmd } from "./cmd"
import { CliError, effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { UI } from "../ui"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const GoalCommand = cmd({
  command: "goal",
  describe: "inspect and control the goal loop of a session",
  builder: (yargs: Argv) =>
    yargs
      .command(GoalStatusCommand)
      .command(GoalPauseCommand)
      .command(GoalResumeCommand)
      .command(GoalStopCommand)
      .command(GoalPlanRebaseCommand)
      .demandCommand(),
  async handler() {},
})

export const GoalPlanRebaseCommand = effectCmd({
  command: "plan-rebase <action> <requestFile>",
  standalone: true,
  instance: false,
  describe: "edit a paused Goal plan using an exact JSON request file and authenticated server",
  builder: (yargs: Argv) => attachOptions(yargs
    .positional("action", { type: "string", choices: ["begin", "apply", "cancel", "get", "reconcile"], demandOption: true })
    .positional("requestFile", { type: "string", describe: "path to the original bounded JSON request", demandOption: true })),
  handler: Effect.fn("Cli.goal.planRebase")(function* (rawArgs) {
    const args = rawArgs as unknown as QueryFormatArgs & { action: "begin" | "apply" | "cancel" | "get" | "reconcile"; requestFile: string }
    const directory = process.cwd()
    yield* Effect.tryPromise({
      try: async () => {
        if (!args.attach) throw new CliError({ message: "Plan rebase currently requires --attach to an authenticated server; local operator bootstrap is unavailable", exitCode: 1 })
        const { ServerAuth } = await import("@/server/auth")
        const { open } = await import("node:fs/promises")
        const headers = ServerAuth.headers(args)
        if (!headers) throw new CliError({ message: "AUTH_REQUIRED: plan rebase requires the server operator password", exitCode: 1 })
        const file = await open(args.requestFile, "r")
        const content = await (async () => {
          try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.size < 1 || stat.size > 131072) throw new Error("Request file must be a regular file of at most 128 KiB")
            const buffer = Buffer.alloc(131073)
            const progress = { bytes: 0 }
            while (progress.bytes < buffer.length) {
              const read = await file.read(buffer, progress.bytes, buffer.length - progress.bytes, null)
              if (!read.bytesRead) break
              progress.bytes += read.bytesRead
            }
            if (progress.bytes > 131072 || progress.bytes !== stat.size) throw new Error("Request file changed or exceeded its byte limit")
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, progress.bytes))
          } finally { await file.close() }
        })()
        const schema = args.action === "begin" ? GoalPlanRebaseSchema.Begin : args.action === "apply" ? GoalPlanRebaseSchema.Apply : GoalPlanRebaseSchema.Target
        const request = Schema.decodeUnknownSync(Schema.fromJsonString(schema), { onExcessProperty: "error" })(content)
        const base = new URL(args.attach)
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
          throw new Error("Attach URL must identify an HTTP server without embedded credentials")
        const suffix = args.action === "get" || args.action === "reconcile"
          ? `/${encodeURIComponent((request as GoalPlanRebaseSchema.Target).editID)}${args.action === "reconcile" ? "/reconcile" : ""}` : `/${args.action}`
        const url = new URL(`/deepagent/goal/plan-rebase${suffix}`, base)
        url.searchParams.set("directory", directory)
        if (args.action === "get") for (const key of ["sessionID", "goalID", "requestID"] as const) url.searchParams.set(key, request[key])
        UI.println(`Goal plan rebase ${args.action}: requestID=${request.requestID}, goalID=${request.goalID}`)
        const response = await fetch(url, { method: args.action === "get" ? "GET" : "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          ...(args.action === "get" ? {} : { body: JSON.stringify(request) }) })
        const value: unknown = await response.json()
        if (!response.ok) throw new CliError({ message: JSON.stringify(value), exitCode: 1 })
        const receipt = Schema.decodeUnknownSync(GoalPlanRebaseSchema.Response, { onExcessProperty: "error" })(value)
        console.log(JSON.stringify(receipt, null, 2))
      },
      catch: (error) => new CliError({ message: `${formatSdkError(args, error)}. Retry only the unchanged request file after an unknown response.`, exitCode: 1 }),
    })
  }),
})

type GoalSessionArgs = QueryFormatArgs & {
  sessionID: string
  "request-id"?: string
  "goal-id"?: string
  "expected-revision"?: number
}

function sessionBuilder(yargs: Argv) {
  return attachOptions(
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  )
}

export const GoalStatusCommand = effectCmd({
  command: "status <sessionID>",
  describe: "show the active goal of a session",
  builder: sessionBuilder,
  handler: Effect.fn("Cli.goal.status")(function* (rawArgs) {
    const args = rawArgs as unknown as GoalSessionArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const goal = yield* Effect.tryPromise({
      try: async () =>
        GoalClient.status(
          (await createInstanceSDK(args, ctx.worktree)) as unknown as GoalClient.Client,
          args.sessionID,
        ),
      catch: (error) => new CliError({ message: formatSdkError(args, error), exitCode: 1 }),
    })
    if (args.format === "json") {
      console.log(JSON.stringify({ sessionID: args.sessionID, goal }, null, 2))
      return
    }
    if (!goal) {
      UI.println(`No active goal for session ${args.sessionID}`)
      return
    }
    console.log(
      formatTable(
        ["Goal", "Revision", "Preparation", "Observed phase", "Requested", "In flight", "Recovery", "Wake"],
        [
          [
            goal.goalId,
            String(goal.revision),
            goal.preparation,
            goal.phase,
            goal.requestedPhase,
            goal.inFlight ? "yes" : "no",
            goal.recoveryRequired ? "required" : "no",
            goal.wakeState,
          ],
        ],
      ),
    )
  }),
})

function goalControl(action: GoalClient.Action) {
  return effectCmd({
    command: `${action} <sessionID>`,
    describe: `${action} the goal loop of a session`,
    builder: (yargs: Argv) =>
      sessionBuilder(yargs)
        .option("request-id", {
          type: "string",
          describe: "original command ID for an exact retry (requires explicit Goal and revision)",
        })
        .option("goal-id", { type: "string", describe: "original Goal ID for an exact retry" })
        .option("expected-revision", { type: "number", describe: "original Goal revision for an exact retry" }),
    handler: Effect.fn(`Cli.goal.${action}`)(function* (rawArgs) {
      const args = rawArgs as unknown as GoalSessionArgs
      const ctx = yield* InstanceRef
      if (!ctx) return yield* Effect.die("InstanceRef not provided")
      yield* Effect.tryPromise({
        try: async () => {
          const explicit = [args["request-id"], args["goal-id"], args["expected-revision"]]
          if (explicit.some((value) => value !== undefined) && !explicit.every((value) => value !== undefined))
            throw new CliError({
              message: "Exact retry requires --request-id, --goal-id and --expected-revision together",
              exitCode: 1,
            })
          const client = (await createInstanceSDK(args, ctx.worktree)) as unknown as GoalClient.Client
          const current = explicit.every((value) => value !== undefined)
            ? undefined
            : await GoalClient.status(client, args.sessionID)
          if (current !== undefined && !GoalClient.canControl(current, action))
            throw new CliError({
              message: `Could not ${action} the goal for session ${args.sessionID} — inspect its complete status; no eligible current Goal`,
              exitCode: 1,
            })
          const request = GoalClient.capture(
            client,
            {
              server: args.attach ?? "http://deepagent-code.internal",
              directory: ctx.worktree,
              sessionID: args.sessionID,
            },
            action,
            {
              sessionID: args.sessionID,
              goalId: args["goal-id"] ?? current!.goalId,
              expectedRevision: args["expected-revision"] ?? current!.revision,
              requestID: args["request-id"] ?? crypto.randomUUID(),
            },
          )
          // Print the immutable identity before dispatch, including when a process is interrupted
          // before an HTTP response. Keep JSON stdout a single complete result payload.
          UI.println(`Goal command ${action}: ${JSON.stringify(request.body)}`)
          const result = await GoalClient.send(request).then(
            (goal) => ({ goal }),
            (error: unknown) => ({ error }),
          )
          if ("error" in result) {
            const error = result.error
            const latest =
              error instanceof GoalClient.RequestError && error.status === 409
                ? await GoalClient.status(client, args.sessionID).then(
                    (goal) => ({ goal }),
                    (error: unknown) => ({ error: formatSdkError(args, error) }),
                  )
                : undefined
            const unknownOutcome = !(error instanceof GoalClient.RequestError) || error.unknownOutcome
            if (args.format === "json")
              console.log(
                JSON.stringify(
                  {
                    sessionID: args.sessionID,
                    action,
                    request: request.body,
                    outcome: unknownOutcome ? "unknown" : "rejected",
                    error: {
                      message: formatSdkError(args, error),
                      code: error instanceof GoalClient.RequestError ? error.code : "request_failed",
                    },
                    latest,
                  },
                  null,
                  2,
                ),
              )
            throw new CliError({
              message: `${formatSdkError(args, error)}. ${unknownOutcome ? "Command outcome is unknown; this does not confirm execution stopped. Retry only the same --request-id, --goal-id and --expected-revision shown above." : "Command rejected; no automatic retarget or retry was sent."}`,
              exitCode: 1,
            })
          }
          if (args.format === "json") {
            console.log(
              JSON.stringify(
                {
                  sessionID: args.sessionID,
                  action,
                  request: request.body,
                  outcome: "accepted",
                  goal: result.goal,
                  terminalConfirmed: GoalClient.confirmedTerminal(result.goal),
                },
                null,
                2,
              ),
            )
            return
          }
          UI.println(
            `Goal ${result.goal.goalId}: ${action} requested (revision ${result.goal.revision}); observed ${result.goal.phase}; in-flight ${result.goal.inFlight ? "yes" : "no"}; recovery ${result.goal.recoveryRequired ? "required" : "no"}.`,
          )
          if (action === "stop" && !GoalClient.confirmedTerminal(result.goal))
            UI.println("Stopping is not yet confirmed; inspect goal status before assuming work has ended.")
        },
        catch: (error) =>
          error instanceof CliError ? error : new CliError({ message: formatSdkError(args, error), exitCode: 1 }),
      })
    }),
  })
}

export const GoalPauseCommand = goalControl("pause")
export const GoalResumeCommand = goalControl("resume")
export const GoalStopCommand = goalControl("stop")
