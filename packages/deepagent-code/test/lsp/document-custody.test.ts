import { expect, test } from "bun:test"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { LSPClient } from "@/lsp/client"
import { tmpdir, withTestInstance } from "../fixture/fixture"

const fixture = path.join(import.meta.dir, "fixture/owned-diagnostics-server.ts")

test("actual LSP didClose permanently retires its observation and unopened project diagnostics remain visible", async () => {
  await using temp = await tmpdir()
  await withTestInstance({
    directory: temp.path,
    fn: async (instance) => {
      const file = path.join(temp.path, "code.ts")
      const other = path.join(temp.path, "project.ts")
      await Bun.write(file, "same text")
      const client = await LSPClient.create({
        serverID: "owned-fixture",
        root: temp.path,
        directory: temp.path,
        instance,
        server: {
          process: spawn(process.execPath, [fixture, "pull"], { stdio: "pipe", env: { PATH: process.env.PATH } }),
        },
      })
      try {
        await client.connection.sendRequest("fixture/push", { uri: pathToFileURL(other).href })
        expect(client.diagnostics.get(other)?.[0]?.message).toBe("original project diagnostic")
        const old = await client.observeChecked({ path: file, text: "same text" })
        expect(LSPClient.inspectChecked(old!)).toBeDefined()
        await client.notify.close({ path: file })
        expect(LSPClient.inspectChecked(old!)).toBeUndefined()
        const current = await client.observeChecked({ path: file, text: "same text" })
        expect(LSPClient.inspectChecked(current!)).toBeDefined()
        expect(LSPClient.inspectChecked(old!)).toBeUndefined()
        await client.shutdown()
        expect(LSPClient.inspectChecked(current!)).toBeUndefined()
      } finally {
        await client.shutdown()
      }
    },
  })
})

test("actual LSP owns at most 4096 document generations and a real didClose releases only that slot", async () => {
  await using temp = await tmpdir()
  await withTestInstance({
    directory: temp.path,
    fn: async (instance) => {
      const client = await LSPClient.create({
        serverID: "owned-fixture",
        root: temp.path,
        directory: temp.path,
        instance,
        server: {
          process: spawn(process.execPath, [fixture, "hold"], { stdio: "pipe", env: { PATH: process.env.PATH } }),
        },
      })
      const first = path.join(temp.path, "file-0.ts")
      const next = path.join(temp.path, "new.ts")
      try {
        for (const index of Array.from({ length: 4096 }, (_, index) => index)) {
          const file = path.join(temp.path, `file-${index}.ts`)
          await Bun.write(file, "")
          await client.notify.open({ path: file })
        }
        await Bun.write(next, "")
        await expect(client.notify.open({ path: next })).rejects.toThrow("observation capacity exceeded")
        expect((await client.connection.sendRequest<{ changes: number }>("fixture/current")).changes).toBe(4096)
        await client.notify.open({ path: first })
        await client.notify.close({ path: first })
        await client.notify.open({ path: next })
        expect((await client.connection.sendRequest<{ changes: number }>("fixture/current")).changes).toBe(4098)
      } finally {
        await client.shutdown()
      }
    },
  })
}, 20_000)
