import { describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "node:url"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Option } from "effect"
import { LLM } from "@deepagent-code/llm"
import { Auth, LLMClient } from "@deepagent-code/llm/route"
import { AnthropicMessages, OpenAIChat } from "@deepagent-code/llm/protocols"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { rehydrateToolArtifacts } from "@deepagent-code/core/session/runner/tool-artifacts"
import { toLLMMessages } from "@deepagent-code/core/session/runner/to-llm-message"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { Config } from "@deepagent-code/core/config"
import { ConfigToolOutput } from "@deepagent-code/core/config/tool-output"
import { SessionV2 } from "@deepagent-code/core/session"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { ToolArtifact } from "@deepagent-code/core/tool-artifact"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_tool_output_store")

const withStore = <A, E, R>(
  body: (input: { root: string; store: ToolOutputStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty
      const store = ToolOutputStore.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
        Layer.provide(configured),
      )
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* ToolOutputStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(Layer.mergeAll(store, FSUtil.defaultLayer)))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ToolOutputStore", () => {
  it.live("bounds the provider-facing text channel with one managed file", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = "HEAD-" + "x".repeat(30_000)
        const second = "y".repeat(30_000) + "-TAIL"
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-aggregate",
          output: {
            structured: { kind: "report" },
            content: [
              { type: "text", text: first },
              { type: "text", text: second },
            ],
          },
        })
        expect(result.output.structured).toEqual({ kind: "report" })
        expect(result.outputPaths).toHaveLength(1)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(first + second)
        if (result.output.content[0]?.type !== "text") throw new Error("expected text preview")
        expect(Buffer.byteLength(result.output.content[0].text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      }),
    ),
  )

  it.live("uses bounded text for oversized structured-only output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const structured = { text: "x".repeat(ToolOutputStore.MAX_BYTES) }
        const result = yield* store.bound({ sessionID, toolCallID: "call-json", output: { structured, content: [] } })
        expect(result.output.structured).toEqual(structured)
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(structured)
        expect(result.output.content).toHaveLength(1)
      }),
    ),
  )

  it.live("preserves native media and structured metadata within the artifact egress limit", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const data = "a".repeat(6 * 1024 * 1024)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-file",
          output: {
            structured: { caption: "pixel" },
            content: [{ type: "file", source: { type: "data", data }, mime: "image/png", name: "pixel.png" }],
          },
        })
        expect(result.outputPaths).toEqual([])
        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(result.output.content[0]).toEqual({
          type: "file",
          source: { type: "data", data },
          mime: "image/png",
          name: "pixel.png",
        })
      }),
    ),
  )

  it.live("retains remote media once and replays it without fetching again", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () => new Response("pixel", { headers: { "content-type": "image/png" } }),
        }),
      ),
      (server) =>
        withStore(({ store }) =>
          Effect.gen(function* () {
            const result = yield* store.bound({
              sessionID,
              toolCallID: "call-remote",
              output: {
                structured: {},
                content: [{ type: "file", source: { type: "url", url: server.url.toString() }, mime: "image/png" }],
              },
            })
            const file = result.output.content[0]
            if (file?.type !== "file") throw new Error("expected retained artifact")
            expect(file.source.type).toBe("file")
            if (file.source.type !== "file") throw new Error("expected artifact ref")
            expect(file.source.uri).toMatch(/^artifact:sha256:/)
            server.stop(true)
            expect(yield* store.rehydrate({ sessionID, file })).toEqual({
              type: "file",
              source: { type: "data", data: Buffer.from("pixel").toString("base64") },
              mime: "image/png",
            })
            const wrongSession = yield* store
              .rehydrate({ sessionID: SessionV2.ID.make("ses_other_location"), file })
              .pipe(Effect.flip)
            expect(wrongSession.reason).toBe("unavailable")
          }),
        ),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.live("rebuilds OpenAI and Anthropic provider bodies from one retained artifact", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () => new Response("pixel", { headers: { "content-type": "image/png" } }),
        }),
      ),
      (server) =>
        withStore(({ root, store }) =>
          Effect.gen(function* () {
            const location = { directory: AbsolutePath.make(root) }
            const retained = yield* store.bound({
              sessionID,
              toolCallID: "call-wire-artifact",
              location,
              output: {
                structured: {},
                content: [{ type: "file", source: { type: "url", url: server.url.toString() }, mime: "image/png" }],
              },
            })
            const retainedFile = retained.output.content[0]
            if (retainedFile?.type !== "file") throw new Error("expected retained file")
            if (retainedFile.source.type !== "file") throw new Error("expected retained ref")
            expect(retainedFile.source.uri).toMatch(/^artifact:sha256:[a-f0-9]{64}:/)
            server.stop(true)
            for (const route of [
              OpenAIChat.route.with({ endpoint: { baseURL: "https://openai.test/v1/" }, auth: Auth.bearer("test") }),
              AnthropicMessages.route.with({
                endpoint: { baseURL: "https://anthropic.test/v1/" },
                auth: Auth.header("x-api-key", "test"),
              }),
            ]) {
              const model = route.model({ id: "model" })
              const assistant = new SessionMessage.Assistant({
                id: SessionMessage.ID.make("msg_artifact"),
                type: "assistant",
                agent: AgentV2.ID.make("build"),
                model: {
                  id: ModelV2.ID.make(String(model.id)),
                  providerID: ProviderV2.ID.make(String(model.provider)),
                },
                content: [
                  new SessionMessage.AssistantTool({
                    type: "tool",
                    id: "call-wire-artifact",
                    name: "image_lookup",
                    state: new SessionMessage.ToolStateCompleted({
                      status: "completed",
                      input: {},
                      structured: {},
                      content: retained.output.content,
                    }),
                    time: { created: DateTime.makeUnsafe(0) },
                  }),
                ],
                time: { created: DateTime.makeUnsafe(0) },
              })
              const history = yield* rehydrateToolArtifacts([assistant], sessionID, store.rehydrate)
              const prepared = yield* LLMClient.prepare(
                LLM.request({ id: "req_artifact", model, messages: toLLMMessages(history, model) }),
              )
              const body = JSON.stringify(prepared.body)
              expect(body).toContain(Buffer.from("pixel").toString("base64"))
              expect(body).not.toContain("artifact:sha256:")
              expect(body).not.toContain(server.url.toString())
            }
          }),
        ),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.live("returns typed reasons for oversized, unavailable, and unsupported remote artifacts", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            if (new URL(request.url).pathname === "/large")
              return new Response(Buffer.alloc(ToolArtifact.MAX_BYTES + 1), {
                headers: { "content-type": "image/png" },
              })
            if (new URL(request.url).pathname === "/svg")
              return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
            return new Response("missing", { status: 404, headers: { "content-type": "image/png" } })
          },
        }),
      ),
      (server) =>
        withStore(({ store }) =>
          Effect.gen(function* () {
            const reason = (pathname: string, mime: string) =>
              store
                .bound({
                  sessionID,
                  toolCallID: `call-${pathname}`,
                  output: {
                    structured: {},
                    content: [
                      { type: "file", source: { type: "url", url: new URL(pathname, server.url).toString() }, mime },
                    ],
                  },
                })
                .pipe(
                  Effect.flip,
                  Effect.map((error) => (error._tag === "ToolArtifact.Error" ? error.reason : "storage")),
                )
            expect(yield* reason("/large", "image/png")).toBe("too_large")
            expect(yield* reason("/missing", "image/png")).toBe("unavailable")
            expect(yield* reason("/svg", "image/svg+xml")).toBe("unsupported_content_type")
          }),
        ),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.live("redacts remote text before storing and detects replay tampering", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            new Response("Bearer abcdefghijklmnopqrstuvwxyz012345", { headers: { "content-type": "text/plain" } }),
        }),
      ),
      (server) =>
        withStore(({ root, store }) =>
          Effect.gen(function* () {
            const result = yield* store.bound({
              sessionID,
              toolCallID: "call-text-artifact",
              output: {
                structured: {},
                content: [{ type: "file", source: { type: "url", url: server.url.toString() }, mime: "text/plain" }],
              },
            })
            const file = result.output.content[0]
            if (file?.type !== "file" || file.source.type !== "file") throw new Error("expected retained text")
            expect(yield* store.rehydrate({ sessionID, file })).toEqual({ type: "text", text: "«redacted»" })
            const digest = file.source.uri.split(":")[3]
            yield* Effect.promise(() =>
              Bun.write(path.join(root, "tool-artifacts", "unplaced", sessionID, `${digest}.bin`), "tampered"),
            )
            expect((yield* store.rehydrate({ sessionID, file }).pipe(Effect.flip)).reason).toBe("integrity_mismatch")
          }),
        ),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.live("materializes only files inside the managed output directory", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const managed = path.join(root, "tool-output", "image.png")
        const external = path.join(root, "external.png")
        yield* Effect.promise(() => Bun.write(managed, "pixel", { createPath: true }))
        yield* Effect.promise(() => Bun.write(external, "secret"))
        const bound = yield* store.bound({
          sessionID,
          toolCallID: "call-managed",
          output: {
            structured: {},
            content: [
              { type: "file", source: { type: "file", uri: pathToFileURL(managed).toString() }, mime: "image/png" },
            ],
          },
        })
        expect(bound.output.content[0]?.type).toBe("file")
        const refused = yield* store
          .bound({
            sessionID,
            toolCallID: "call-external",
            output: {
              structured: {},
              content: [
                { type: "file", source: { type: "file", uri: pathToFileURL(external).toString() }, mime: "image/png" },
              ],
            },
          })
          .pipe(Effect.flip)
        expect(refused._tag).toBe("ToolArtifact.Error")
        if (refused._tag === "ToolArtifact.Error") expect(refused.reason).toBe("invalid_source")
      }),
    ),
  )

  it.live("preserves structured metadata and native media when bounding text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const media = {
          type: "file" as const,
          source: { type: "data" as const, data: "aGVsbG8=" },
          mime: "image/png",
          name: "pixel.png",
        }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-text-and-media",
          output: { structured: { caption: "pixel" }, content: [{ type: "text", text }, media] },
        })

        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content[1]).toEqual(media)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(text)
      }),
    ),
  )

  it.live("does not double-count structured data duplicated in projected text", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "x".repeat(30_000)
        const output = { structured: { output: text }, content: [{ type: "text" as const, text }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-duplicated", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("fails oversized settlement when complete retention cannot be written", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "tool-output"), "not a directory")
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-lossy",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("ToolOutputStore.StorageError")
      }),
    ),
  )

  it.live("does not encode ignored structured metadata when projected content exists", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const output = { structured: { value: 1n }, content: [{ type: "text" as const, text: "readable text" }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-unencodable", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("preserves interruption while retaining complete output", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const blockedFilesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () => Effect.never,
          })
        }),
      ).pipe(Layer.provide(FSUtil.defaultLayer))
      const store = ToolOutputStore.layer.pipe(
        Layer.provide(blockedFilesystem),
        Layer.provide(Global.layerWith({ data: root.path })),
      )
      const exit = yield* Effect.gen(function* () {
        const service = yield* ToolOutputStore.Service
        const fiber = yield* service
          .bound({
            sessionID,
            toolCallID: "call-interrupted",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(store))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("honors configured limits", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 1_000 })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-config",
            output: { structured: {}, content: [{ type: "text", text: "one\ntwo\nthree" }] },
          })
          expect(result.outputPaths).toHaveLength(1)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1_000 }) }),
    ),
  )

  it.live("cleans expired managed files and preserves unrelated files", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const old = path.join(root, "tool-output", "tool_old")
        const recent = path.join(root, "tool-output", "tool_recent")
        const unrelated = path.join(root, "tool-output", "keep.txt")
        yield* fs.ensureDir(path.join(root, "tool-output"))
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "keep")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* store.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
