import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const context = Context.empty() as Context.Context<unknown>

function request(
  route: string,
  directory: string,
  query?: Record<string, string>,
  body?: Record<string, string>,
  handler = HttpApiApp.webHandler(),
) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return handler.handler(
    new Request(url, {
      method: body ? "POST" : "GET",
      headers: {
        "x-deepagent-code-directory": directory,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("editor owner saves exact text while foreign locks and stale snapshots stay protected", async () => {
    await using tmp = await tmpdir({ git: true })
    const handler = HttpApiApp.webHandler()
    await using scope = { [Symbol.asyncDispose]: () => handler.dispose() }
    const post = (route: string, body: Record<string, string>) => request(route, tmp.path, undefined, body, handler)
    const original = " \r\nconst value = '中文'\r\n\r\n"
    await Bun.write(path.join(tmp.path, "editor.txt"), original)
    await Bun.write(path.join(tmp.path, "other.txt"), "other\n")
    const content = await request(FilePaths.content, tmp.path, { path: "editor.txt" }, undefined, handler)
    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: original })
    const acquired = await post(FilePaths.lockAcquire, { path: "editor.txt", kind: "human" })
    const owner = await acquired.json()
    expect(acquired.status).toBe(200)
    expect(owner.ok).toBe(true)
    const changed = "const value = '保存成功'\r\n"
    const expected = Buffer.from(original).toString("base64")
    const save = (lockId?: string, snapshot = expected) =>
      post(FilePaths.write, { path: "editor.txt", content: changed, expected: snapshot, ...(lockId ? { lockId } : {}) })
    expect(await (await save()).json()).toMatchObject({ ok: false, error: "locked_by_human" })
    expect(await (await save("foreign-owner")).json()).toMatchObject({ ok: false, error: "locked_by_human" })
    expect(await Bun.file(path.join(tmp.path, "editor.txt")).text()).toBe(original)
    const other = await (await post(FilePaths.lockAcquire, { path: "other.txt", kind: "human" })).json()
    expect(other.ok).toBe(true)
    expect(await (await save(other.lock.lockId)).json()).toMatchObject({ ok: false, error: "locked_by_human" })
    const saved = await save(owner.lock.lockId)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ ok: true, path: "editor.txt" })
    expect(await Bun.file(path.join(tmp.path, "editor.txt")).text()).toBe(changed)
    expect(await (await save(owner.lock.lockId)).json()).toMatchObject({ ok: false, error: "stale_content" })
    expect(await Bun.file(path.join(tmp.path, "editor.txt")).text()).toBe(changed)
    await post(FilePaths.lockRelease, { lockId: owner.lock.lockId })
    await post(FilePaths.lockRelease, { lockId: other.lock.lockId })
    const broad = await (await post(FilePaths.lockAcquire, { path: ".", kind: "human" })).json()
    expect(broad.ok).toBe(true)
    expect(await (await save(broad.lock.lockId, Buffer.from(changed).toString("base64"))).json()).toMatchObject({
      ok: false,
      error: "locked_by_human",
    })
    expect(await Bun.file(path.join(tmp.path, "editor.txt")).text()).toBe(changed)
    await post(FilePaths.lockRelease, { lockId: broad.lock.lockId })
    const unlocked = await save(undefined, Buffer.from(changed).toString("base64"))
    expect(await unlocked.json()).toMatchObject({ ok: true })
  }, 20000)

  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, files, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.status).toBe(200)
    expect(await files.json()).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
