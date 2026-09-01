import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fsNode from "fs/promises"
import path from "path"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Location } from "@deepagent-code/core/location"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ProjectDocs } from "@deepagent-code/core/system-context/project-docs"
import { ProjectDocsSync } from "@deepagent-code/core/deepagent/project-docs-sync"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.defaultLayer)

const docs = {
  HANDOFF: "# Handoff 交接文档\n\n> revision: 2026-09-01T00:00:00.000Z\n\n## Index 索引\n\n- HANDOFF.md — 交接文档\n",
  DESIGN: "# Design 设计文档\n\n> revision: 2026-09-01T00:00:00.000Z\n\n## Goal 目标\n\n构建 W10 项目文档体系。\n",
  PLAN: "# Plan 实施方案\n\n> revision: 2026-09-01T00:00:00.000Z\n\n## Steps 步骤\n\n- [ ] 实现读取源\n- [ ] 实现写入端\n",
  LOG: "# Log 工程日志\n\n> revision: 2026-09-01T00:00:00.000Z\n\n<!-- session: ses_abc123 -->\n## 2026-09-01T00:00:00.000Z · First\n- progress 进展: 完成读取源\n",
} as const

const writeFixture = async (root: string, files: Partial<Record<ProjectDocs.DocName, string>>) => {
  const dir = path.join(root, ProjectDocs.DOCS_DIRECTORY)
  await fsNode.mkdir(dir, { recursive: true })
  for (const name of ProjectDocs.DOC_NAMES) {
    const content = files[name]
    if (content !== undefined) await fsNode.writeFile(path.join(dir, `${name}.md`), content)
  }
  return dir
}

describe("ProjectDocs", () => {
  it.live("discovers the four documents and renders index + environment before excerpts", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFixture(tmp.path, docs))
          const fs = yield* FSUtil.Service
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          const baseline = ProjectDocs.renderBaseline(observed)
          expect(baseline).toContain("Project documents (docs/deepagent):")
          expect(baseline).toContain("Index:")
          expect(baseline).toContain("- HANDOFF.md — # Handoff 交接文档")
          // index + environment quick facts come before the per-document excerpts
          expect(baseline.indexOf("Environment quick facts:")).toBeLessThan(baseline.indexOf("Document excerpts:"))
          expect(baseline.indexOf("branch: unknown")).toBeGreaterThan(-1)
          expect(baseline).toContain("──── HANDOFF.md ────")
          expect(baseline).toContain("recent changes (LOG.md)")
        }),
      ),
    ),
  )

  it.live("truncates oversized documents in the baseline", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
          yield* Effect.promise(() => writeFixture(tmp.path, docs))
          yield* Effect.promise(() =>
            fsNode.writeFile(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY, "LOG.md"), long),
          )
          const fs = yield* FSUtil.Service
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          expect(ProjectDocs.renderBaseline(observed)).toContain("… (truncated)")
        }),
      ),
    ),
  )

  it.live("observes a partial set and lists the missing documents in the baseline", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          yield* Effect.promise(() =>
            writeFixture(tmp.path, { ...docs, PLAN: undefined } as Partial<Record<ProjectDocs.DocName, string>>),
          )
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          expect(observed.contents.HANDOFF).toBe(docs.HANDOFF)
          expect(observed.contents.PLAN).toBeUndefined()
          const baseline = ProjectDocs.renderBaseline(observed)
          expect(baseline).toContain("- PLAN.md — (missing)")
          expect(baseline).toContain("missing: PLAN.md")
          expect(baseline).toContain("──── HANDOFF.md ────")
          expect(baseline).not.toContain("──── PLAN.md ────")
        }),
      ),
    ),
  )

  it.live("observes an empty set when the docs directory is missing and renders the not-set-up state", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          const baseline = ProjectDocs.renderBaseline(observed)
          expect(baseline).toContain("未建立项目文档（运行 `deepagent docs sync` 可生成）")
          expect(baseline).not.toContain("Document excerpts:")
          expect(observed.contents.HANDOFF).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("accepts flexible file name spellings while preferring the literal NAME.md", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            const dir = path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY)
            await fsNode.mkdir(dir, { recursive: true })
            await fsNode.writeFile(path.join(dir, "handoff.md"), "# Handoff\n")
            await fsNode.writeFile(path.join(dir, "DESIGN.markdown"), "# Design\n")
            await fsNode.writeFile(path.join(dir, "PLAN"), "# Plan\n")
            await fsNode.writeFile(path.join(dir, "LOG.md"), "# Log\n")
          })
          const fs = yield* FSUtil.Service
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          expect(observed.contents.HANDOFF).toBe("# Handoff\n")
          expect(observed.contents.DESIGN).toBe("# Design\n")
          expect(observed.contents.PLAN).toBe("# Plan\n")
          expect(observed.contents.LOG).toBe("# Log\n")
        }),
      ),
    ),
  )

  it.live("emits an update naming the changed documents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFixture(tmp.path, docs))
          const fs = yield* FSUtil.Service
          const observe = ProjectDocs.observeFor(tmp.path, fs).pipe(
            Effect.catch(() => Effect.succeed(SystemContext.unavailable)),
          )
          const context = ProjectDocs.source(observe)
          const initialized = yield* SystemContext.initialize(context)

          yield* Effect.promise(() =>
            fsNode.writeFile(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY, "PLAN.md"), "# Plan 实施方案\n\nnew plan\n"),
          )
          const result = yield* SystemContext.reconcile(ProjectDocs.source(observe), initialized.snapshot)
          expect(result._tag).toBe("Updated")
          if (result._tag === "Updated") {
            expect(result.text).toContain("Project documents updated (PLAN.md):")
            expect(result.text).toContain("──── PLAN.md ────")
            expect(result.text).toContain("new plan")
          }
        }),
      ),
    ),
  )

  it.live("does not block initialization when the docs are missing and renders the not-set-up baseline", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const context = ProjectDocs.source(
            ProjectDocs.observeFor(tmp.path, fs).pipe(
              Effect.catch(() => Effect.succeed(SystemContext.unavailable)),
            ),
          )
          const generation = yield* SystemContext.initialize(context)
          expect(generation.baseline).toContain("未建立项目文档（运行 `deepagent docs sync` 可生成）")
          expect(generation.snapshot[ProjectDocs.registryKey]).toBeDefined()
        }),
      ),
    ),
  )

  it.live("emits the not-set-up update when previously present documents are all removed", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFixture(tmp.path, docs))
          const fs = yield* FSUtil.Service
          const context = ProjectDocs.source(
            ProjectDocs.observeFor(tmp.path, fs).pipe(
              Effect.catch(() => Effect.succeed(SystemContext.unavailable)),
            ),
          )
          const initialized = yield* SystemContext.initialize(context)

          yield* Effect.promise(() =>
            fsNode.rm(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY), { recursive: true, force: true }),
          )
          const result = yield* SystemContext.reconcile(context, initialized.snapshot)
          expect(result._tag).toBe("Updated")
          if (result._tag === "Updated") {
            expect(result.text).toBe("Project documents not set up yet — run `deepagent docs sync`")
          }
        }),
      ),
    ),
  )

  it.live("registers a ready project-docs source for a no-docs project through the location layer", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          // Mirrors the production wiring (location-layer.ts): the project docs source is merged
          // with the registry unconditionally, so a project without docs must stay ready.
          const stack = Layer.mergeAll(ProjectDocs.layer).pipe(
            Layer.provideMerge(SystemContextRegistry.layer),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(
              Location.layer({ directory: AbsolutePath.make(tmp.path) }).pipe(Layer.provide(Project.defaultLayer)),
            ),
          )
          const baseline = yield* Effect.gen(function* () {
            const registry = yield* SystemContextRegistry.Service
            const generation = yield* SystemContext.initialize(yield* registry.load())
            return generation.baseline
          }).pipe(Effect.provide(stack))
          expect(baseline).toContain("未建立项目文档（运行 `deepagent docs sync` 可生成）")
        }),
      ),
    ),
  )

  it.live("writes generated docs with a revision stamp and the source reads them back", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const generated = ProjectDocsSync.renderDocs({
            root: tmp.path,
            revision: "2026-09-05T10:00:00.000Z",
            branch: "main",
            session: {
              sessionID: "ses_abc123",
              title: "First",
              updated: "2026-09-05T09:00:00.000Z",
              prompts: ["实现项目文档体系"],
              progress: ["完成读取源实现"],
              toolCalls: 3,
              errors: 0,
            },
            goal: {
              objective: "构建 W10 项目文档体系",
              criteria: ["tests pass: bun test"],
              steps: [
                { title: "实现读取源", status: "done" },
                { title: "实现写入端", status: "pending" },
              ],
            },
            existing: {},
          })
          for (const name of ProjectDocs.DOC_NAMES) expect(generated[name]).toContain("> revision: 2026-09-05T10:00:00.000Z")
          expect(generated.LOG).toContain("<!-- session: ses_abc123 -->")
          expect(generated.PLAN).toContain("- [x] 实现读取源")
          expect(generated.PLAN).toContain("- [ ] 实现写入端")
          expect(generated.DESIGN).toContain("### Goal 目标".replace("### ", "## "))
          expect(generated.HANDOFF).toContain("branch: main")

          // placeholder when no goal doc exists
          const placeholder = ProjectDocsSync.renderDocs({
            root: tmp.path,
            revision: "2026-09-05T10:00:00.000Z",
            session: {
              sessionID: "ses_abc123",
              title: "First",
              updated: "2026-09-05T09:00:00.000Z",
              prompts: ["实现项目文档体系"],
              progress: ["完成读取源实现"],
              toolCalls: 3,
              errors: 0,
            },
            goal: undefined,
            existing: {},
          })
          expect(placeholder.DESIGN).toContain("未建立 goal 文档")
          expect(placeholder.PLAN).toContain("未建立 goal 文档")

          // write → read-back contract: the System Context source sees the generated documents
          yield* ProjectDocsSync.writeDocs(tmp.path, generated)
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          expect(observed.contents.LOG).toContain("<!-- session: ses_abc123 -->")
          expect(observed.contents.PLAN).toContain("- [x] 实现读取源")
          expect(ProjectDocs.renderBaseline(observed)).toContain("Project documents (docs/deepagent):")
        }),
      ),
    ),
  )

  it.effect("logs a session at most once (idempotent append) and prepends newer sessions", () =>
    Effect.gen(function* () {
      const base = {
        root: "/repo",
        revision: "2026-09-05T10:00:00.000Z",
        goal: undefined,
        existing: {},
      }
      const first = {
        sessionID: "ses_one",
        title: "One",
        updated: "2026-09-05T09:00:00.000Z",
        prompts: ["one"],
        progress: ["done one"],
        toolCalls: 1,
        errors: 0,
      }
      const second = {
        sessionID: "ses_two",
        title: "Two",
        updated: "2026-09-06T09:00:00.000Z",
        prompts: ["two"],
        progress: ["done two"],
        toolCalls: 2,
        errors: 0,
      }
      const once = ProjectDocsSync.renderDocs({ ...base, session: first, existing: {} })
      const again = ProjectDocsSync.renderDocs({ ...base, session: first, existing: { LOG: once.LOG } })
      expect(again.LOG).toBe(once.LOG)
      expect(once.LOG.split("<!-- session: ses_one -->")).toHaveLength(2)

      const withSecond = ProjectDocsSync.renderDocs({ ...base, session: second, existing: { LOG: once.LOG } })
      expect(withSecond.LOG.split("<!-- session: ses_two -->")).toHaveLength(2)
      expect(withSecond.LOG.split("<!-- session: ses_one -->")).toHaveLength(2)
      // newest first: the second session entry appears before the first
      expect(withSecond.LOG.indexOf("ses_two")).toBeLessThan(withSecond.LOG.indexOf("ses_one"))
      expect(withSecond.LOG).toContain("> revision: 2026-09-05T10:00:00.000Z")
    }),
  )

  it.effect("writing is opt-in: env flag or docs_sync config, default off", () =>
    Effect.gen(function* () {
      expect(ProjectDocsSync.envEnabled({})).toBe(false)
      expect(ProjectDocsSync.envEnabled({ [ProjectDocsSync.SYNC_ENV_FLAG]: "true" })).toBe(true)
      expect(ProjectDocsSync.envEnabled({ [ProjectDocsSync.SYNC_ENV_FLAG]: "1" })).toBe(true)
      expect(ProjectDocsSync.writingEnabled(undefined)).toBe(false)
      expect(ProjectDocsSync.writingEnabled(false)).toBe(false)
      expect(ProjectDocsSync.writingEnabled(true)).toBe(true)
    }),
  )
})
