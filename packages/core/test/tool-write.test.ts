import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as SessionState from "@deepagent-code/core/deepagent/session-state"
import { FileMutation } from "@deepagent-code/core/file-mutation"
import { FileLock } from "@deepagent-code/core/file-lock"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Location } from "@deepagent-code/core/location"
import { LocationMutation } from "@deepagent-code/core/location-mutation"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { WriteTool } from "@deepagent-code/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_write_tool_test")
// The write leaf's freshness precondition records its observation on the session's DeepAgent state;
// production always has one, a bare tool harness must seed it.
SessionState.getOrCreate(sessionID, "high")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  writes.length = 0
  denyAction = undefined
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
    })
  }),
).pipe(Layer.provide(FSUtil.defaultLayer))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const resolution = LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))
  const mutation = FileMutation.layer.pipe(Layer.provide(filesystem))
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const write = WriteTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(permission),
    Layer.provide(resolution),
    Layer.provide(mutation),
    Layer.provide(FileLock.layer),
    // The write leaf's freshness precondition stats the target through the shared fs service.
    Layer.provide(filesystem),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(Layer.mergeAll(registry, resolution, mutation, filesystem, write)))
}

const call = (input: typeof WriteTool.Input.Type, id = "call-write") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "write", input },
})

const it = testEffect(Layer.empty)

describe("WriteTool", () => {
  it.live("registers and creates a relative file through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["write"])
            const settled = yield* settleTool(registry, call({ path: "src/new.txt", content: "created" }))
            expect(settled).toEqual({
              result: { type: "text", value: "Created file successfully: src/new.txt" },
              output: {
                structured: {
                  operation: "write",
                  target: path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
                  resource: "src/new.txt",
                  existed: false,
                },
                content: [{ type: "text", text: "Created file successfully: src/new.txt" }],
              },
            })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src", "new.txt"), "utf8"))).toBe(
              "created",
            )
            expect(assertions).toMatchObject([{ sessionID, action: "edit", resources: ["src/new.txt"], save: ["*"] }])
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("overwrites a relative existing file and reports that it wrote the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "existing.txt"), "before")).pipe(
          Effect.andThen(
            // `overwrite: true` is the explicit "replace this unread file" declaration the freshness
            // precondition requires; the guard's own tests cover the refusal path.
            withTool(tmp.path, (registry) =>
              settleTool(registry, call({ path: "existing.txt", content: "after", overwrite: true })),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "text", value: "Wrote file successfully: existing.txt" })
              expect(settled.output?.structured).toMatchObject({ resource: "existing.txt", existed: true })
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe(
                "after",
              )
              expect(writes).toHaveLength(1)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves exactly one BOM when overwriting existing files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const preserved = path.join(tmp.path, "preserved.txt")
        const deduplicated = path.join(tmp.path, "deduplicated.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(preserved, "\uFEFFbefore"), fs.writeFile(deduplicated, "\uFEFFbefore")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                yield* settleTool(
                  registry,
                  call({ path: "preserved.txt", content: "after", overwrite: true }, "call-preserved"),
                )
                yield* settleTool(
                  registry,
                  call({ path: "deduplicated.txt", content: "\uFEFFafter", overwrite: true }, "call-deduplicated"),
                )

                expect(yield* Effect.promise(() => fs.readFile(preserved, "utf8"))).toBe("\uFEFFafter")
                expect(yield* Effect.promise(() => fs.readFile(deduplicated, "utf8"))).toBe("\uFEFFafter")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // The freshness precondition `edit` gets for free from its `oldString` match but which `write`
  // had no equivalent of: an agent must not silently clobber a file it never read, nor overwrite a
  // file that changed since it read it. The failure is an ordinary tool error naming the recovery
  // step — nothing is retried for the model (the same posture as the reference agents).
  it.live("refuses to replace an existing file the session never read", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "unread.txt"), "someone else's work")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => settleTool(registry, call({ path: "unread.txt", content: "mine" }))),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({
                type: "error",
                value:
                  "File unread.txt already exists and has not been read in this session. Read it first, or pass overwrite: true if replacing it is intended.",
              })
              // Nothing was written: the guard fails before the mutation.
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "unread.txt"), "utf8"))).toBe(
                "someone else's work",
              )
              expect(writes).toHaveLength(0)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("a write is itself an observation: the session may write again without re-reading", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const first = yield* settleTool(registry, call({ path: "owned.txt", content: "one" }, "call-1"))
            expect(first.result).toEqual({ type: "text", value: "Created file successfully: owned.txt" })
            // No `overwrite` needed: this session wrote the file, so it knows the version.
            const second = yield* settleTool(registry, call({ path: "owned.txt", content: "two" }, "call-2"))
            expect(second.result).toEqual({ type: "text", value: "Wrote file successfully: owned.txt" })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "owned.txt"), "utf8"))).toBe("two")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses a write when the file changed after this session observed it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* settleTool(registry, call({ path: "contested.txt", content: "mine" }, "call-1"))
            // Another writer (the user, a linter, a parallel task) changes it after our observation.
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "contested.txt"), "theirs, and longer"))
            const settled = yield* settleTool(
              registry,
              call({ path: "contested.txt", content: "mine again" }, "call-2"),
            )
            expect(settled.result).toEqual({
              type: "error",
              value:
                "File contested.txt was modified since it was read (by you, the user, or a linter). Read it again before attempting to write it.",
            })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "contested.txt"), "utf8"))).toBe(
              "theirs, and longer",
            )
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "absolute.txt")
        return withTool(tmp.path, (registry) => executeTool(registry, call({ path: target, content: "inside" }))).pipe(
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({ type: "text", value: "Created file successfully: absolute.txt" })
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("inside")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an explicit external absolute path before edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return withTool(active.path, (registry) =>
          settleTool(registry, call({ path: target, content: "external" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const canonicalTarget = path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "external.txt")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
              expect(assertions[0]).toMatchObject({
                resources: [
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ],
              })
              expect(assertions[1]).toMatchObject({ resources: [canonicalTarget.replaceAll("\\", "/")], save: ["*"] })
              expect(settled.output?.structured).toMatchObject({
                target: canonicalTarget,
                resource: canonicalTarget.replaceAll("\\", "/"),
                existed: false,
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("external")
              expect(writes).toEqual([canonicalTarget])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not write when external_directory or edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value:
              "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []",
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: "denied.txt", content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value:
              "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []",
          })
          expect(assertions.map((input) => input.action)).toEqual(["edit"])
          expect(writes).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})

test("keeps the locked write schema, semantics docstring, and deferred UX TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/write.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const tool = definition[0]
  expect(tool?.type).toBe("function")
  if (!tool || tool.type !== "function") throw new Error("write must register as a function tool")
  const schema = tool.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["content", "overwrite", "path"])
  expect(source).toContain(
    "Named project references\n * are read-oriented and deliberately are not accepted by mutation tools.",
  )
  for (const todo of [
    "Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.",
    "Add formatter integration after V2 formatter runtime exists.",
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
    "Add LSP notification and diagnostics after V2 LSP runtime exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
