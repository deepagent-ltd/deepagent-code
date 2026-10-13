import { expect, test } from "bun:test"
import path from "node:path"
import { spawn } from "node:child_process"
import { LSPClient } from "@/lsp/client"
import { tmpdir, withTestInstance } from "../fixture/fixture"

const fixture = path.join(import.meta.dir, "fixture/owned-diagnostics-server.ts")
for (const mode of ["push", "pull", "stale", "unversioned", "hold"]) {
  test(`owned diagnostics require a current actual RPC observation: ${mode}`, async () => {
    await using temp = await tmpdir()
    await withTestInstance({ directory: temp.path, fn: async (instance) => {
      const file = path.join(temp.path, "code.ts")
      await Bun.write(file, "const value = 1\n")
      const client = await LSPClient.create({
        serverID: "owned-fixture", root: temp.path, directory: temp.path, instance,
        server: { process: spawn(process.execPath, [fixture, mode], { stdio: "pipe", env: { PATH: process.env.PATH } }) },
      })
      try {
        const receipt = await client.observeChecked({ path: file, text: "const value = 1\n", timeoutMs: 150 })
        if (mode === "push" || mode === "pull") {
          expect(receipt).toBeDefined()
          const view = LSPClient.inspectChecked(receipt!)!
          expect(view.documentVersion).toBe(0)
          expect(view.count).toBe(0)
          expect(view.method).toBe(mode === "push" ? "versioned_push" : "document_pull")
          expect(LSPClient.inspectChecked({ ...receipt! })).toBeUndefined()
          expect(LSPClient.inspectChecked(JSON.parse(JSON.stringify(receipt)))).toBeUndefined()
          await client.notify.open({ path: file })
          expect(LSPClient.inspectChecked(receipt!)).toBeUndefined()
        } else expect(receipt).toBeUndefined()
      } finally { await client.shutdown() }
    } })
  })
}

test("owned RPC cannot survive didChange, abort, or client replacement", async () => {
  await using temp = await tmpdir()
  await withTestInstance({ directory: temp.path, fn: async (instance) => {
    const file = path.join(temp.path, "code.ts")
    await Bun.write(file, "first")
    const client = await LSPClient.create({
      serverID: "owned-fixture", root: temp.path, directory: temp.path, instance,
      server: { process: spawn(process.execPath, [fixture, "hold"], { stdio: "pipe", env: { PATH: process.env.PATH } }) },
    })
    try {
      const pending = client.observeChecked({ path: file, text: "first", timeoutMs: 1000 })
      for (let i = 0; ; i++) {
        const state = await client.connection.sendRequest<{ changes: number }>("fixture/current")
        if (state.changes) break
        if (i === 100) throw new Error("didOpen missing")
      }
      await Bun.write(file, "second")
      await client.notify.open({ path: file })
      await client.connection.sendRequest("fixture/release")
      expect(await pending).toBeUndefined()
      const controller = new AbortController()
      controller.abort()
      expect(await client.observeChecked({ path: file, text: "second", signal: controller.signal })).toBeUndefined()
      const receipt = await client.observeChecked({ path: file, text: "second" })
      expect(LSPClient.inspectChecked(receipt!)).toBeDefined()
      await client.shutdown()
      expect(LSPClient.inspectChecked(receipt!)).toBeUndefined()
    } finally { if (client.connection) await client.shutdown() }
  } })
})
