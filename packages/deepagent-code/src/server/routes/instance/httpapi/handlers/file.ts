import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@deepagent-code/core/filesystem"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { Ripgrep } from "@deepagent-code/core/filesystem/ripgrep"
import { Search } from "@deepagent-code/core/filesystem/search"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { FileMutation } from "@deepagent-code/core/file-mutation"
import { FileLock } from "@deepagent-code/core/file-lock"
import { AbsolutePath, RelativePath } from "@deepagent-code/core/schema"
import { LSP } from "@/lsp/lsp"
import { Effect, Layer } from "effect"
import fsNode from "fs/promises"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const search = yield* Search.Service
    const locations = yield* LocationServiceMap
    const mutation = yield* FileMutation.Service
    const lsp = yield* LSP.Service
    const fileLock = yield* FileLock.Service

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(locations.get({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
      )
    })

    /** Resolve and validate a relative path against the workspace root. */
    const resolveSafe = Effect.fnUntraced(function* (
      directory: string,
      rel: string,
    ): Generator<
      Effect.Effect<any, any, any>,
      | { readonly ok: true; readonly abs: string }
      | { readonly ok: false; readonly error: "path_escape" }
    > {
      const abs = path.resolve(directory, rel)
      if (!FSUtil.contains(directory, abs)) {
        return { ok: false as const, error: "path_escape" as const }
      }
      return { ok: true as const, abs }
    })

    // ── read handlers (unchanged) ────────────────────────────────────────────

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .search({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).items
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const kind = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : "all")
      const fff = yield* search.file({ cwd: directory, query: ctx.query.query, limit, kind }).pipe(Effect.orDie)
      if (fff !== undefined) return fff
      return (yield* filesystem(
        FileSystem.Service.use((fs) =>
          fs.find({
            query: ctx.query.query,
            limit,
            type: ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined),
          }),
        ),
      )).map((item) => item.path)
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        FileSystem.Service.use((fs) =>
          fs.list({ path: RelativePath.make(ctx.query.path) }).pipe(
            Effect.map((items) =>
              items.map((item) => ({
                name: path.basename(item.path),
                path: item.path,
                absolute: path.join(directory, item.path),
                type: item.type,
                ignored: fs.isIgnored(item.path, item.type),
              })),
            ),
          ),
        ),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.map((item) => ({
          type: item.type,
          content: item.type === "text" ? item.content.trim() : item.content,
          ...(item.type === "binary" ? { encoding: item.encoding, mimeType: item.mime } : {}),
        })),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    // ── V3.6 Phase 1A mutation handlers ─────────────────────────────────────
    // Human edits bypass the agent PermissionV2 gate but are still guarded by
    // LocationMutation path-escape checking (resolveSafe above).

    type MutOk = { readonly ok: true; readonly path: string; readonly existed?: boolean }
    type MutErr = { readonly ok: false; readonly path: string; readonly error: "stale_content" | "already_exists" | "path_escape" | "locked_by_human" }
    type MutResult = MutOk | MutErr

    /**
     * Overwrite a file. When `expected` (base64 snapshot) is provided the write
     * is a compare-and-swap: returns error:"stale_content" if on-disk bytes
     * changed since the snapshot was taken (conflict-safe save, see F4).
     * V3.7: returns error:"locked_by_human" if a human editor holds the lock.
     */
    const write = Effect.fn("FileHttpApi.write")(function* (ctx: {
      payload: { path: string; content: string; expected?: string | undefined }
    }): Generator<Effect.Effect<any, any, any>, MutResult> {
      const directory = (yield* InstanceState.context).directory
      const resolved = yield* resolveSafe(directory, ctx.payload.path)
      if (!resolved.ok) return { ok: false, path: ctx.payload.path, error: resolved.error }

      // V3.7 Phase 4.1C: block writes when a human editor holds the lock
      const lock = fileLock.status(resolved.abs)
      if (lock?.kind === "human") {
        return { ok: false, path: ctx.payload.path, error: "locked_by_human" }
      }

      const target: FileMutation.Target = { canonical: resolved.abs, resource: ctx.payload.path }

      if (ctx.payload.expected !== undefined) {
        const expectedBytes = new Uint8Array(Buffer.from(ctx.payload.expected, "base64"))
        const r: MutResult = yield* mutation
          .writeIfUnchanged({ target, content: ctx.payload.content, expected: expectedBytes })
          .pipe(
            Effect.map((res): MutResult => ({ ok: true, path: ctx.payload.path, existed: res.existed })),
            Effect.catchTag("FileMutation.StaleContentError", (): Effect.Effect<MutResult> =>
              Effect.succeed({ ok: false, path: ctx.payload.path, error: "stale_content" }),
            ),
          )
        return r
      }

      const r = yield* mutation.write({ target, content: ctx.payload.content }).pipe(Effect.orDie)
      return { ok: true, path: ctx.payload.path, existed: r.existed }
    })

    /** Create a new file; returns error:"already_exists" if target exists. */
    const createFile = Effect.fn("FileHttpApi.createFile")(function* (ctx: {
      payload: { path: string; content?: string | undefined }
    }): Generator<Effect.Effect<any, any, any>, MutResult> {
      const directory = (yield* InstanceState.context).directory
      const resolved = yield* resolveSafe(directory, ctx.payload.path)
      if (!resolved.ok) return { ok: false, path: ctx.payload.path, error: resolved.error }

      const target: FileMutation.Target = { canonical: resolved.abs, resource: ctx.payload.path }
      const r: MutResult = yield* mutation
        .create({ target, content: ctx.payload.content ?? "" })
        .pipe(
          Effect.map((res): MutResult => ({ ok: true, path: ctx.payload.path, existed: res.existed })),
          Effect.catchTag("FileMutation.TargetExistsError", (): Effect.Effect<MutResult> =>
            Effect.succeed({ ok: false, path: ctx.payload.path, error: "already_exists" }),
          ),
        )
      return r
    })

    /** Delete a file or empty directory. */
    const deleteFile = Effect.fn("FileHttpApi.deleteFile")(function* (ctx: {
      payload: { path: string }
    }): Generator<Effect.Effect<any, any, any>, MutResult> {
      const directory = (yield* InstanceState.context).directory
      const resolved = yield* resolveSafe(directory, ctx.payload.path)
      if (!resolved.ok) return { ok: false, path: ctx.payload.path, error: resolved.error }

      const target: FileMutation.Target = { canonical: resolved.abs, resource: ctx.payload.path }
      const r = yield* mutation.remove({ target }).pipe(Effect.orDie)
      return { ok: true, path: ctx.payload.path, existed: r.existed }
    })

    /**
     * Rename / move a path within the workspace.
     * Both `from` and `to` must stay inside the workspace root.
     */
    const rename = Effect.fn("FileHttpApi.rename")(function* (ctx: {
      payload: { from: string; to: string }
    }): Generator<Effect.Effect<any, any, any>, MutResult> {
      const directory = (yield* InstanceState.context).directory
      const fromR = yield* resolveSafe(directory, ctx.payload.from)
      if (!fromR.ok) return { ok: false, path: ctx.payload.from, error: fromR.error }
      const toR = yield* resolveSafe(directory, ctx.payload.to)
      if (!toR.ok) return { ok: false, path: ctx.payload.to, error: toR.error }

      yield* FSUtil.Service.use((fs) => fs.ensureDir(path.dirname(toR.abs))).pipe(Effect.orDie)
      yield* Effect.tryPromise({
        try: () => fsNode.rename(fromR.abs, toR.abs),
        catch: (err) => new Error(`rename failed: ${err}`),
      }).pipe(Effect.orDie)

      return { ok: true, path: ctx.payload.to }
    })

    /** Create a directory and any missing parents. */
    const mkdir = Effect.fn("FileHttpApi.mkdir")(function* (ctx: {
      payload: { path: string }
    }): Generator<Effect.Effect<any, any, any>, MutResult> {
      const directory = (yield* InstanceState.context).directory
      const resolved = yield* resolveSafe(directory, ctx.payload.path)
      if (!resolved.ok) return { ok: false, path: ctx.payload.path, error: resolved.error }

      yield* FSUtil.Service.use((fs) => fs.ensureDir(resolved.abs)).pipe(Effect.orDie)
      return { ok: true, path: ctx.payload.path }
    })

    // ── V3.6 Phase 2 LSP handlers ──────────────────────────────────────────
    // Files must be specified relative to the workspace root. All coordinates
    // are 0-based (raw LSP convention). LSP errors are returned as null rather
    // than crashing the request so the editor degrades gracefully.

    /** Absolute path helper — returns null when path would escape workspace. */
    const lspAbsPath = (directory: string, rel: string): string | null => {
      const abs = path.resolve(directory, rel)
      return FSUtil.contains(directory, abs) ? abs : null
    }

    // V3.7 #7 fix: the HTTP LSP path must open/sync the file with the language
    // server before querying. The agent tools all call touchFile first; the human
    // editor path did not, so the server may not have the file open (empty
    // diagnostics/hover) or may serve stale content. touchFile opens + syncs from
    // disk. Note: unsaved editor buffers are NOT yet pushed (the editor saves via
    // Cmd+S which lands on disk, then touchFile picks it up); live unsaved-buffer
    // sync is a documented boundary.
    const lspDiagnostics = Effect.fn("FileHttpApi.lspDiagnostics")(function* (ctx: {
      query: { path?: string | undefined }
    }) {
      // If a specific file was requested, make sure it's opened + diagnostics pulled.
      const directory = (yield* InstanceState.context).directory
      const rel = ctx.query.path
      if (rel) {
        const abs = lspAbsPath(directory, rel)
        if (abs) yield* lsp.touchFile(abs, "document").pipe(Effect.orElseSucceed(() => undefined))
      }
      return yield* lsp.diagnostics().pipe(Effect.orElseSucceed(() => ({})))
    })

    const lspHover = Effect.fn("FileHttpApi.lspHover")(function* (ctx: {
      payload: { file: string; line: number; character: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const abs = lspAbsPath(directory, ctx.payload.file)
      if (!abs) return null
      yield* lsp.touchFile(abs).pipe(Effect.orElseSucceed(() => undefined))
      return yield* lsp
        .hover({ file: abs, line: ctx.payload.line, character: ctx.payload.character })
        .pipe(Effect.orElseSucceed(() => null))
    })

    const lspDefinition = Effect.fn("FileHttpApi.lspDefinition")(function* (ctx: {
      payload: { file: string; line: number; character: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const abs = lspAbsPath(directory, ctx.payload.file)
      if (!abs) return []
      yield* lsp.touchFile(abs).pipe(Effect.orElseSucceed(() => undefined))
      return yield* lsp
        .definition({ file: abs, line: ctx.payload.line, character: ctx.payload.character })
        .pipe(Effect.orElseSucceed(() => []))
    })

    const lspCompletion = Effect.fn("FileHttpApi.lspCompletion")(function* (ctx: {
      payload: { file: string; line: number; character: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const abs = lspAbsPath(directory, ctx.payload.file)
      if (!abs) return null
      yield* lsp.touchFile(abs).pipe(Effect.orElseSucceed(() => undefined))
      return yield* lsp
        .completion({ file: abs, line: ctx.payload.line, character: ctx.payload.character })
        .pipe(Effect.orElseSucceed(() => null))
    })

    const lspCodeAction = Effect.fn("FileHttpApi.lspCodeAction")(function* (ctx: {
      payload: {
        file: string
        startLine: number; startCharacter: number
        endLine: number; endCharacter: number
      }
    }) {
      const directory = (yield* InstanceState.context).directory
      const abs = lspAbsPath(directory, ctx.payload.file)
      if (!abs) return []
      yield* lsp.touchFile(abs, "document").pipe(Effect.orElseSucceed(() => undefined))
      return yield* lsp
        .codeAction({
          file: abs,
          start: { line: ctx.payload.startLine, character: ctx.payload.startCharacter },
          end: { line: ctx.payload.endLine, character: ctx.payload.endCharacter },
        })
        .pipe(Effect.orElseSucceed(() => []))
    })

    /** Rename preview — returns a WorkspaceEdit object. NEVER writes to disk. */
    const lspRename = Effect.fn("FileHttpApi.lspRename")(function* (ctx: {
      payload: { file: string; line: number; character: number; newName: string }
    }) {
      const directory = (yield* InstanceState.context).directory
      const abs = lspAbsPath(directory, ctx.payload.file)
      if (!abs) return null
      return yield* lsp
        .rename({ file: abs, line: ctx.payload.line, character: ctx.payload.character, newName: ctx.payload.newName })
        .pipe(Effect.orElseSucceed(() => null))
    })

    // ── V3.7 Phase 4.1C 编辑锁 handlers ──────────────────────────────────────

    const lockAcquire = Effect.fn("FileHttpApi.lockAcquire")(function* (ctx: {
      payload: { path: string; kind: "human" | "agent" }
    }) {
      const directory = (yield* InstanceState.context).directory
      const abs = path.resolve(directory, ctx.payload.path)
      if (!FSUtil.contains(directory, abs)) {
        return { ok: false as const, error: "path_escape" as const }
      }
      const lock = fileLock.acquire(abs, ctx.payload.kind)
      if (!lock) return { ok: false as const, error: "already_locked" as const }
      return { ok: true as const, lock }
    })

    const lockRenew = Effect.fn("FileHttpApi.lockRenew")(function* (ctx: {
      payload: { lockId: string }
    }) {
      return { ok: fileLock.renew(ctx.payload.lockId) }
    })

    const lockRelease = Effect.fn("FileHttpApi.lockRelease")(function* (ctx: {
      payload: { lockId: string }
    }) {
      fileLock.release(ctx.payload.lockId)
      return { ok: true as const }
    })

    const lockStatus = Effect.fn("FileHttpApi.lockStatus")(function* (ctx: {
      query: { path: string }
    }) {
      const directory = (yield* InstanceState.context).directory
      const abs = path.resolve(directory, ctx.query.path)
      return fileLock.status(abs)
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
      // V3.6 Phase 1A mutation handlers
      .handle("write", write)
      .handle("createFile", createFile)
      .handle("deleteFile", deleteFile)
      .handle("rename", rename)
      .handle("mkdir", mkdir)
      // V3.6 Phase 2 LSP handlers
      .handle("lspDiagnostics", lspDiagnostics)
      .handle("lspHover", lspHover)
      .handle("lspDefinition", lspDefinition)
      .handle("lspCompletion", lspCompletion)
      .handle("lspCodeAction", lspCodeAction)
      .handle("lspRename", lspRename)
      // V3.7 Phase 4.1C lock handlers
      .handle("lockAcquire", lockAcquire)
      .handle("lockRenew", lockRenew)
      .handle("lockRelease", lockRelease)
      .handle("lockStatus", lockStatus)
  }),
).pipe(Layer.provide(LocationServiceMap.layer), Layer.provide(Search.defaultLayer), Layer.provide(FileMutation.layer), Layer.provide(FileLock.layer))
