// PARITY-004 long-tail: oversight approval queue read-side for the CLI.
// Query-only template: SDK client + table/json output, no direct DB access.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const OversightCommand = cmd({
  command: "oversight",
  describe: "inspect the agent oversight plane (approvals, metrics)",
  builder: (yargs: Argv) => yargs.command(OversightListCommand).command(OversightMetricsCommand).demandCommand(),
  async handler() {},
})

export const OversightListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list pending approval queue items",
  builder: (yargs) => attachOptions(yargs),
  handler: Effect.fn("Cli.oversight.list")(function* (rawArgs) {
    const args = rawArgs as unknown as QueryFormatArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.oversight.approvals({}).catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const items = result.data?.items ?? []
    if (args.format === "json") {
      console.log(JSON.stringify(items, null, 2))
      return
    }
    console.log(
      formatTable(
        ["ID", "Event", "Status", "Decision", "Summary"],
        items.map((item) => [
          item.id,
          item.eventType,
          item.status,
          item.decision ?? "-",
          item.summary.length > 60 ? item.summary.slice(0, 57) + "..." : item.summary,
        ]),
      ),
    )
  }),
})

type OversightMetricsArgs = QueryFormatArgs & { from?: string; to?: string }

export const OversightMetricsCommand = effectCmd({
  command: "metrics",
  describe: "show oversight metrics (DLQ, success rate, conflict rate)",
  builder: (yargs) =>
    attachOptions(yargs)
      .option("from", { describe: "window start (epoch ms)", type: "string" })
      .option("to", { describe: "window end (epoch ms)", type: "string" }),
  handler: Effect.fn("Cli.oversight.metrics")(function* (rawArgs) {
    const args = rawArgs as unknown as OversightMetricsArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.oversight
        .metrics({ ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) })
        .catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const metrics = result.data
    if (!metrics) return yield* fail("Oversight metrics returned no data")
    if (args.format === "json") {
      console.log(JSON.stringify(metrics, null, 2))
      return
    }
    console.log(
      formatTable(
        ["Metric", "Value"],
        [
          ["DLQ events total", String(metrics.dlqEventsTotal)],
          ["Agent task success rate", String(metrics.agentTaskSuccessRate)],
          ["Agent tasks completed", String(metrics.agentTaskCompleted)],
          ["Agent tasks failed", String(metrics.agentTaskFailed)],
          ["Agent conflict rate", String(metrics.agentConflictRate)],
          ["Agent push rejected total", String(metrics.agentPushRejectedTotal)],
        ],
      ),
    )
  }),
})
