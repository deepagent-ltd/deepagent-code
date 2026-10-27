export * as EmptySettingsFixture from "./empty-settings"

import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@deepagent-code/core/global"
import { WindowsSettingsStorage } from "../../src/installation/windows-settings-storage"

const names = ["settings.json", ".settings-operation.json", ".settings-receipt.json"]

// Permission/config and event-schedule tests need an explicitly empty first-party
// store, not a fabricated Native DACL witness. Any private leaf or write is a failure.
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    yield* Effect.promise(requireAbsent)
    return Context.make(WindowsSettingsStorage.Current, {
      read: (name) =>
        Effect.promise(async () => {
          if (!names.includes(name)) throw new Error(`Unexpected private settings leaf: ${name}`)
          await requireAbsent()
          return undefined
        }),
      publish: () => Effect.die(new Error("Empty settings fixture cannot publish private state")),
      parent: Effect.die(new Error("Empty settings fixture cannot prepare private storage")),
    })
  }),
)

async function requireAbsent() {
  const home = process.env.DEEPAGENT_CODE_TEST_HOME
  if (!home || !path.isAbsolute(home)) throw new Error("Empty settings fixture requires an isolated test home")
  const directory = await fs.realpath(Global.Path.config)
  const relative = path.relative(await fs.realpath(home), directory)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Empty settings fixture is outside its isolated config directory")
  for (const name of names) {
    const exists = await fs.lstat(path.join(directory, name)).then(
      () => true,
      (error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
        throw error
      },
    )
    if (exists) throw new Error(`Empty settings fixture found private state: ${name}`)
  }
}
