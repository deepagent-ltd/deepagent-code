import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import fs from "fs/promises"
import os from "os"

type InstallMethod = "curl" | "npm" | "pnpm" | "bun" | "yarn" | "brew" | "choco" | "scoop" | "unknown"

export default Runtime.handler(Commands.commands.uninstall, (input) =>
  Effect.gen(function* () {
    const { Installation } = yield* Effect.promise(() => import("deepagent-code/installation/index"))
    const method = (yield* Effect.promise(() => Installation.method())) as InstallMethod
    console.log(`Installation method: ${method}`)

    const dirs = [
      { path: Global.Path.data, label: "Data", keep: input["keep-data"] },
      { path: Global.Path.cache, label: "Cache", keep: false },
      { path: Global.Path.config, label: "Config", keep: input["keep-config"] },
      { path: Global.Path.state, label: "State", keep: false },
    ]

    console.log("\nThe following will be removed:")
    for (const dir of dirs) {
      const exists = yield* Effect.promise(() => fs.access(dir.path).then(() => true).catch(() => false))
      if (!exists) continue
      const status = dir.keep ? " (keeping)" : ""
      console.log(`  ${dir.keep ? "○" : "✓"} ${dir.label}: ${shortenPath(dir.path)}${status}`)
    }

    if (input["dry-run"]) {
      console.log("\nDry run - no changes made")
      return
    }

    if (!input.force) {
      const { createInterface } = yield* Effect.promise(() => import("node:readline"))
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            rl.question("Are you sure? (y/N) ", (a) => {
              rl.close()
              resolve(a)
            })
          }),
      )
      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled")
        return
      }
    }

    for (const dir of dirs) {
      if (dir.keep) continue
      const exists = yield* Effect.promise(() => fs.access(dir.path).then(() => true).catch(() => false))
      if (!exists) continue
      yield* Effect.promise(() => fs.rm(dir.path, { recursive: true, force: true }))
      console.log(`Removed ${dir.label}`)
    }

    if (method !== "curl" && method !== "unknown") {
      const cmds: Record<string, string[]> = {
        npm: ["npm", "uninstall", "-g", "deepagent-code"],
        pnpm: ["pnpm", "uninstall", "-g", "deepagent-code"],
        bun: ["bun", "remove", "-g", "deepagent-code"],
        brew: ["brew", "uninstall", "deepagent-code"],
        choco: ["choco", "uninstall", "deepagent-code", "-y", "-r"],
        scoop: ["scoop", "uninstall", "deepagent-code"],
      }
      const cmd = cmds[method]
      if (cmd) {
        const { spawn } = yield* Effect.promise(() => import("node:child_process"))
        console.log(`Running ${cmd.join(" ")}...`)
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" })
              child.on("close", () => resolve())
            }),
        )
      }
    }

    console.log("\nThank you for using DeepAgent Code!")
  }),
)

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) return p.replace(home, "~")
  return p
}
