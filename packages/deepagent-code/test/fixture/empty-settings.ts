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
  const root = await fs.realpath(home)
  const relative = path.relative(home, Global.Path.config)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Empty settings fixture is outside its isolated config directory")
  const directory = { path: root }
  // A repointed test home can lack the entire config directory. Only an absent
  // component below the verified home is empty; dangling links and other IO fail.
  for (const name of relative.split(path.sep)) {
    const next = path.join(directory.path, name)
    if (!await exists(next)) return
    directory.path = await fs.realpath(next)
    const current = path.relative(root, directory.path)
    if (current.startsWith("..") || path.isAbsolute(current))
      throw new Error("Empty settings fixture is outside its isolated config directory")
  }
  if (directory.path === root) throw new Error("Empty settings fixture is outside its isolated config directory")
  for (const name of names) {
    if (await exists(path.join(directory.path, name))) throw new Error(`Empty settings fixture found private state: ${name}`)
  }
}

function exists(file: string) {
  return fs.lstat(file).then(
    () => true,
    (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
}
