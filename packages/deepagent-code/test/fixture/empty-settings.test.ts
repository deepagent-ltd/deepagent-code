import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import { WindowsSettingsStorage } from "../../src/installation/windows-settings-storage"
import { EmptySettingsFixture } from "./empty-settings"

for (const name of ["settings.json", ".settings-operation.json", ".settings-receipt.json"])
  test(`empty settings boundary refuses an actual ${name} before and after context creation`, async () => {
    const port = await Effect.runPromise(
      WindowsSettingsStorage.Current.pipe(Effect.provide(EmptySettingsFixture.layer)),
    )
    if (!port) throw new Error("Empty settings test context was not provided")
    expect(await Effect.runPromise(port.read(name))).toBeUndefined()
    const file = path.join(Global.Path.config, name)
    const created = { value: false }
    try {
      await fs.writeFile(file, "owned fixture private state", { flag: "wx", mode: 0o600 })
      created.value = true
      for (const effect of [
        port.read(name).pipe(Effect.asVoid),
        WindowsSettingsStorage.Current.pipe(Effect.provide(EmptySettingsFixture.layer), Effect.asVoid),
      ]) {
        const exit = await Effect.runPromiseExit(effect)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain(`found private state: ${name}`)
      }
      expect(await Bun.file(file).text()).toBe("owned fixture private state")
    } finally {
      if (created.value) await fs.rm(file, { force: true })
    }
  })

test("empty settings context cannot publish, prepare storage, or read an unrecognized leaf", async () => {
  const port = await Effect.runPromise(WindowsSettingsStorage.Current.pipe(Effect.provide(EmptySettingsFixture.layer)))
  if (!port) throw new Error("Empty settings test context was not provided")
  for (const effect of [
    port.publish("settings.json", "forbidden", null).pipe(Effect.asVoid),
    port.parent,
    port.read("foreign.json").pipe(Effect.asVoid),
  ])
    expect((await Effect.runPromiseExit(effect))._tag).toBe("Failure")
  expect(
    await Promise.all(
      ["settings.json", ".settings-operation.json", ".settings-receipt.json"].map((name) =>
        Bun.file(path.join(Global.Path.config, name)).exists(),
      ),
    ),
  ).toEqual([false, false, false])
})
