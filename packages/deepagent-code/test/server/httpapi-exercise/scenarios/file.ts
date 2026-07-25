import { Effect } from "effect"
import path from "path"
import { array, check, isRecord, object } from "../assertions"
import { http } from "../dsl"
import type { Scenario } from "../types"

export const fileScenarios: Scenario[] = [
  http.protected
    .post("/file/create", "file.create")
    .mutating()
    .at((ctx) => ({
      path: "/file/create",
      headers: ctx.headers(),
      body: { path: "created.txt", content: "created\n" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.ok === true && body.path === "created.txt", "file create should report the created path")
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "created.txt")).text())) === "created\n",
          "file create should persist the requested content",
        )
      }),
    ),
  http.protected
    .post("/file/delete", "file.delete")
    .mutating()
    .seeded((ctx) => ctx.file("delete.txt", "delete me\n"))
    .at((ctx) => ({ path: "/file/delete", headers: ctx.headers(), body: { path: "delete.txt" } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.ok === true, "file delete should report success")
        check(
          !(yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "delete.txt")).exists())),
          "file delete should remove the target",
        )
      }),
    ),
  http.protected
    .post("/file/mkdir", "file.mkdir")
    .mutating()
    .at((ctx) => ({ path: "/file/mkdir", headers: ctx.headers(), body: { path: "nested/directory" } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.ok === true, "mkdir should report success")
        const fs = yield* Effect.promise(() => import("fs/promises"))
        check(
          (yield* Effect.promise(() => fs.stat(path.join(ctx.directory!, "nested/directory")))).isDirectory(),
          "mkdir should create the directory",
        )
      }),
    ),
  http.protected
    .post("/file/rename", "file.rename")
    .mutating()
    .seeded((ctx) => ctx.file("before.txt", "renamed\n"))
    .at((ctx) => ({
      path: "/file/rename",
      headers: ctx.headers(),
      body: { from: "before.txt", to: "after.txt" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.ok === true && body.path === "after.txt", "rename should report the destination")
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "after.txt")).text())) === "renamed\n",
          "rename should preserve file content",
        )
      }),
    ),
  http.protected
    .post("/file/write", "file.write")
    .mutating()
    .seeded((ctx) => ctx.file("write.txt", "before\n"))
    .at((ctx) => ({
      path: "/file/write",
      headers: ctx.headers(),
      body: { path: "write.txt", content: "after\n" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.ok === true, "file write should report success")
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "write.txt")).text())) === "after\n",
          "file write should replace the target content",
        )
      }),
    ),
  http.protected
    .post("/file/lock", "file.lock.acquire")
    .at((ctx) => ({ path: "/file/lock", headers: ctx.headers(), body: { path: "locked.txt", kind: "human" } }))
    .json(200, (body) => {
      object(body)
      check(body.ok === true && isRecord(body.lock), "lock acquire should return a lock")
      check(isRecord(body.lock) && body.lock.kind === "human", "lock acquire should preserve the owner kind")
    }),
  http.protected
    .post("/file/lock/renew", "file.lock.renew")
    .at((ctx) => ({ path: "/file/lock/renew", headers: ctx.headers(), body: { lockId: "lock_httpapi_missing" } }))
    .json(200, (body) => {
      object(body)
      check(body.ok === false, "renewing a missing lock should fail closed")
    }),
  http.protected
    .post("/file/lock/release", "file.lock.release")
    .at((ctx) => ({ path: "/file/lock/release", headers: ctx.headers(), body: { lockId: "lock_httpapi_missing" } }))
    .json(200, (body) => {
      object(body)
      check(body.ok === true, "releasing a missing lock should remain idempotent")
    }),
  http.protected
    .get("/file/lock/status", "file.lock.status")
    .at((ctx) => ({ path: "/file/lock/status?path=unlocked.txt", headers: ctx.headers() }))
    .json(200, (body) => check(body === null, "an unlocked path should return null")),
  http.protected
    .get("/lsp/diagnostics", "lsp.diagnostics")
    .seeded((ctx) => ctx.file("diagnostics.ts", "export const value = 1\n"))
    .at((ctx) => ({ path: "/lsp/diagnostics?path=diagnostics.ts", headers: ctx.headers() }))
    .json(200, object),
  http.protected
    .post("/lsp/hover", "lsp.hover")
    .seeded((ctx) => ctx.file("hover.ts", "export const value = 1\n"))
    .at((ctx) => ({ path: "/lsp/hover", headers: ctx.headers(), body: { file: "hover.ts", line: 0, character: 13 } }))
    .json(),
  http.protected
    .post("/lsp/definition", "lsp.definition")
    .seeded((ctx) => ctx.file("definition.ts", "export const value = 1\n"))
    .at((ctx) => ({
      path: "/lsp/definition",
      headers: ctx.headers(),
      body: { file: "definition.ts", line: 0, character: 13 },
    }))
    .json(),
  http.protected
    .post("/lsp/completion", "lsp.completion")
    .seeded((ctx) => ctx.file("completion.ts", "const value = Math.\n"))
    .at((ctx) => ({
      path: "/lsp/completion",
      headers: ctx.headers(),
      body: { file: "completion.ts", line: 0, character: 19 },
    }))
    .json(),
  http.protected
    .post("/lsp/code-action", "lsp.codeAction")
    .seeded((ctx) => ctx.file("action.ts", "export const value = 1\n"))
    .at((ctx) => ({
      path: "/lsp/code-action",
      headers: ctx.headers(),
      body: { file: "action.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 22 },
    }))
    .json(200, array),
  http.protected
    .post("/lsp/rename", "lsp.rename")
    .seeded((ctx) => ctx.file("rename.ts", "export const value = 1\n"))
    .at((ctx) => ({
      path: "/lsp/rename",
      headers: ctx.headers(),
      body: { file: "rename.ts", line: 0, character: 13, newName: "nextValue" },
    }))
    .json(),
  http.protected.get("/mcp/catalog", "mcp.catalog").json(200, array),
  http.protected
    .post("/mcp/catalog/enable", "mcp.catalogEnable")
    .at((ctx) => ({
      path: "/mcp/catalog/enable",
      headers: ctx.headers(),
      body: { id: "httpapi-missing", params: {}, credentialRefs: {} },
    }))
    .json(404, object, "status"),
]
