import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect } from "effect"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(Commands.commands.pr, (input) =>
  Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("node:child_process"))
    const prNumber = input.number
    const localBranch = `pr/${prNumber}`

    console.log(`Fetching and checking out PR #${prNumber}...`)

    const checkoutResult = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) => {
          const child = spawn("gh", ["pr", "checkout", String(prNumber), "--branch", localBranch, "--force"], {
            stdio: "inherit",
          })
          child.on("close", resolve)
        }),
    )
    if (checkoutResult !== 0) {
      yield* Effect.fail(
        new Error(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`),
      )
    }

    const prInfoResult = yield* Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          const child = spawn(
            "gh",
            ["pr", "view", String(prNumber), "--json", "body"],
            { stdio: ["pipe", "pipe", "inherit"] },
          )
          let output = ""
          child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
          child.on("close", () => resolve(output))
        }),
    )

    let sessionID: string | undefined
    try {
      const prInfo = JSON.parse(prInfoResult)
      if (prInfo?.body) {
        const match = prInfo.body.match(/https:\/\/opncd\.ai\/s\/([a-zA-Z0-9_-]+)/)
        if (match) sessionID = match[1]
      }
    } catch {}

    console.log(`Successfully checked out PR #${prNumber} as branch '${localBranch}'`)
    console.log("\nStarting DeepAgent Code...\n")

    const daemon = yield* Daemon.Service
    const transport = yield* daemon.transport()
    const { runTui } = yield* Effect.promise(() => import("../../tui"))
    yield* runTui(transport, sessionID ? { sessionID } : {})
  }),
)
