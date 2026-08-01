import { describe, expect, test } from "bun:test"
import { EditorBufferSnapshot } from "@deepagent-code/core/code-intelligence/editor-buffer"
import { LocationKey } from "@deepagent-code/core/context-federation/reference"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect } from "effect"
import path from "node:path"
import { Controller, layer } from "../../src/code-intelligence/editor-buffer-snapshot"
import { materialize } from "../../src/code-intelligence/live-source"
import { tmpdir } from "../fixture/fixture"

const location = LocationKey.make("loc_buffer_one")
const otherLocation = LocationKey.make("loc_buffer_two")

describe("EditorBufferSnapshot", () => {
  test("uses an aligned unsaved buffer without publishing it to other Sessions", async () => {
    await using tmp = await tmpdir()
    const disk = "export const value = 'disk'\n"
    const buffer = "export const value = 'buffer'\n"
    await Bun.write(path.join(tmp.path, "src.ts"), disk)
    await Effect.runPromise(
      Effect.gen(function* () {
        const controller = yield* Controller
        yield* controller.publish({
          locationKey: location,
          path: "src.ts",
          content: buffer,
          contentSha: Hash.sha256(buffer),
          documentVersion: 7,
          observedAt: 10,
          visibility: "session",
          sessionId: "session-a",
        })
        const own = yield* materialize({
          root: tmp.path,
          locationKey: location,
          path: "src.ts",
          sessionId: "session-a",
          graphContentSha: Hash.sha256(disk),
          lsp: { documentVersion: 7, contentSha: Hash.sha256(buffer) },
        })
        expect(own).toMatchObject({
          content: buffer,
          contentSource: "editor_buffer",
          documentVersion: 7,
          graph: "stale",
          editorOverlay: "ready",
        })
        const other = yield* materialize({
          root: tmp.path,
          locationKey: location,
          path: "src.ts",
          sessionId: "session-b",
          graphContentSha: Hash.sha256(disk),
        })
        expect(other).toMatchObject({ content: disk, contentSource: "filesystem", graph: "current" })
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })

  test("falls back to disk when LSP version cannot be aligned and enforces monotonic versions", async () => {
    await using tmp = await tmpdir()
    const disk = "const source = 'disk truth'\n"
    const buffer = "const source = 'unsaved buffer'\n"
    await Bun.write(path.join(tmp.path, "source.ts"), disk)
    await Effect.runPromise(
      Effect.gen(function* () {
        const controller = yield* Controller
        yield* controller.publish({
          locationKey: location,
          path: "source.ts",
          content: buffer,
          contentSha: Hash.sha256(buffer),
          documentVersion: 4,
          visibility: "workspace",
        })
        const result = yield* materialize({
          root: tmp.path,
          locationKey: location,
          path: "source.ts",
          sessionId: "session",
          graphContentSha: "old-graph-sha",
          lsp: { documentVersion: 3 },
        })
        expect(result).toMatchObject({
          content: disk,
          contentSource: "filesystem",
          graph: "stale",
          editorOverlay: "unavailable",
          reasonCode: "buffer_lsp_mismatch",
        })
        const stale = yield* controller
          .publish({
            locationKey: location,
            path: "source.ts",
            content: buffer,
            contentSha: Hash.sha256(buffer),
            documentVersion: 3,
            visibility: "workspace",
          })
          .pipe(Effect.flip)
        expect(stale).toMatchObject({ _tag: "EditorBufferSnapshot.InvalidSnapshotError", reason: "stale_version" })
        expect(
          yield* (yield* EditorBufferSnapshot.Service).get({
            locationKey: otherLocation,
            path: "source.ts",
            sessionId: "session",
          }),
        ).toBeUndefined()
        yield* controller.markSaved({ locationKey: location, path: "source.ts", contentSha: Hash.sha256(buffer) })
        expect(
          yield* (yield* EditorBufferSnapshot.Service).get({
            locationKey: location,
            path: "source.ts",
            sessionId: "session",
          }),
        ).toBeUndefined()
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })

  test("rejects forged path and content hashes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const controller = yield* Controller
        const pathError = yield* controller
          .publish({
            locationKey: location,
            path: "../escape.ts",
            content: "content",
            contentSha: Hash.sha256("content"),
            documentVersion: 1,
            visibility: "workspace",
          })
          .pipe(Effect.flip)
        expect(pathError).toMatchObject({ _tag: "EditorBufferSnapshot.InvalidSnapshotError", reason: "path" })
        const hashError = yield* controller
          .publish({
            locationKey: location,
            path: "safe.ts",
            content: "content",
            contentSha: "forged",
            documentVersion: 1,
            visibility: "workspace",
          })
          .pipe(Effect.flip)
        expect(hashError).toMatchObject({ _tag: "EditorBufferSnapshot.InvalidSnapshotError", reason: "contract" })
      }).pipe(Effect.provide(layer()), Effect.scoped),
    )
  })
})
