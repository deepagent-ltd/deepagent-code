import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fsNode from "fs/promises"
import path from "path"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionTable } from "@deepagent-code/core/session/sql"
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
          // High-3: the Database layer is pinned to a hermetic in-memory DB (Database.defaultLayer
          // would resolve a real DEEPAGENT_CODE_DB path, making the test environment-dependent).
          const stack = Layer.mergeAll(ProjectDocs.layer).pipe(
            Layer.provideMerge(SystemContextRegistry.layer),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(
              Location.layer({ directory: AbsolutePath.make(tmp.path) }).pipe(
                Layer.provide(Project.layer),
                Layer.provide(Git.defaultLayer),
                Layer.provide(Database.layerFromPath(":memory:")),
              ),
            ),
          )
          const baseline = yield* Effect.gen(function* () {
            const registry = yield* SystemContextRegistry.Service
            const generation = yield* SystemContext.initialize(yield* registry.load())
            return generation.baseline
          }).pipe(Effect.provide(stack))
          expect(baseline).toContain("未建立项目文档（运行 `deepagent docs sync` 可生成）")
          // High-2: a tmp dir is not a git repo, so the project root is undetermined — the source
          // stays ready and the empty state says why (no scan above the session directory, no root).
          expect(baseline).toContain("未检测到项目根")
          expect(baseline).not.toContain("Document excerpts:")
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

  it.live("treats a directory named HANDOFF.md as an absent HANDOFF and keeps the source ready", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFixture(tmp.path, docs))
          yield* Effect.promise(async () => {
            await fsNode.rm(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY, "HANDOFF.md"))
            await fsNode.mkdir(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY, "HANDOFF.md"))
          })
          const fs = yield* FSUtil.Service
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          // Med-1: the directory colliding with the literal NAME.md is not readable as a document —
          // it is treated as ABSENT (this document only), never an observation failure.
          expect(observed.contents.HANDOFF).toBeUndefined()
          expect(observed.contents.DESIGN).toBe(docs.DESIGN)
          const baseline = ProjectDocs.renderBaseline(observed)
          expect(baseline).toContain("- HANDOFF.md — (missing)")
          expect(baseline).toContain("missing: HANDOFF.md")
          expect(baseline).toContain("──── DESIGN.md ────")
        }),
      ),
    ),
  )

  it.live("recentLogEntry cites the newest LOG entry, not the H1 title", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const log = [
            "# Log 工程日志",
            "",
            "> revision: 2026-09-01T00:00:00.000Z",
            "",
            "> 按时间倒序记录最新进展与实现日志。",
            "",
            "<!-- session: ses_newest -->",
            "## 2026-09-05T09:00:00.000Z · Second",
            "- progress 进展: done second",
            "",
            "<!-- session: ses_old -->",
            "## 2026-09-01T09:00:00.000Z · First",
            "- progress 进展: done first",
          ].join("\n")
          yield* Effect.promise(() => writeFixture(tmp.path, { ...docs, LOG: log }))
          const fs = yield* FSUtil.Service
          const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
          const baseline = ProjectDocs.renderBaseline(observed)
          // Med-3: the fact is the first H2 entry (newest session), not the `# Log` document title.
          expect(baseline).toContain("recent changes (LOG.md):\n  ## 2026-09-05T09:00:00.000Z · Second")
          expect(baseline).not.toContain("recent changes (LOG.md):\n  # Log")
        }),
      ),
    ),
  )

  it.effect("reports an environment-only change and does not re-send document excerpts", () =>
    Effect.gen(function* () {
      const contents = new ProjectDocs.Contents({
        HANDOFF: docs.HANDOFF,
        DESIGN: docs.DESIGN,
        PLAN: docs.PLAN,
        LOG: docs.LOG,
      })
      const previous = new ProjectDocs.Observed({ root: "/repo", branch: "main", contents })
      const current = new ProjectDocs.Observed({ root: "/repo", branch: "feature", contents })
      const text = ProjectDocs.renderUpdate(previous, current)
      // Med-4: branch-only change (equivalence includes branch) names the env fact change.
      expect(text).toContain("Project environment changed (branch: main → feature)")
      expect(text).toContain("- branch: main → feature")
      expect(text).not.toContain("────")
      // mixed: doc change AND env change => both sections, excerpts only for the changed doc
      const mixed = ProjectDocs.renderUpdate(
        previous,
        new ProjectDocs.Observed({
          root: "/repo",
          branch: "feature",
          contents: new ProjectDocs.Contents({ ...contents, PLAN: "# Plan\n\nnew plan\n" }),
        }),
      )
      expect(mixed).toContain("Project documents updated (PLAN.md):")
      expect(mixed).toContain("Project environment changed (branch: main → feature)")
      expect(mixed).toContain("new plan")
      expect(mixed).not.toContain("──── LOG.md ────")
    }),
  )

  it.live("bounds the observed snapshot while cataloguing a large LOG, and re-reads after a rewrite", () =>
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
          // Med-2: the durable observed value is bounded (the file on disk is not).
          expect(observed.contents.LOG!.length).toBeLessThanOrEqual(6000 + 20)
          expect(observed.contents.LOG).toContain("… (truncated)")
          expect(observed.contents.LOG!.startsWith("line 0")).toBe(true)
          // the full file is untouched on disk
          const onDisk = yield* Effect.promise(() =>
            fsNode.readFile(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY, "LOG.md"), "utf8"),
          )
          expect(onDisk).toContain("line 199")
          // mtime invalidation: a rewrite is observed fresh (no stale cache hit)
          yield* Effect.promise(() =>
            fsNode.writeFile(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY, "LOG.md"), "line fresh\n"),
          )
          const reobserved = yield* ProjectDocs.observeFor(tmp.path, fs)
          expect(reobserved.contents.LOG).toBe("line fresh\n")
        }),
      ),
    ),
  )

  it.live("settle skips subagent sessions, disabled writes, and survives a dying filesystem", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const storeLayer = SessionStore.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:")))
          yield* Effect.provide(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              yield* db
                .insert(ProjectTable)
                .values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
                .run()
                .pipe(Effect.orDie)
              const primary = SessionV2.ID.create()
              const subagent = SessionV2.ID.create()
              yield* db
                .insert(SessionTable)
                .values([
                  { id: primary, project_id: Project.ID.global, slug: primary, directory: tmp.path, title: "primary", version: "test" },
                  {
                    id: subagent,
                    project_id: Project.ID.global,
                    slug: subagent,
                    directory: tmp.path,
                    title: "sub",
                    parent_id: primary,
                    version: "test",
                  },
                ])
                .run()
                .pipe(Effect.orDie)
              const store = yield* SessionStore.Service
              const fsRoot = path.parse(tmp.path).root
              const after = (id: string, fsOverride = fs) =>
                ProjectDocsSync.afterSessionNow({
                  sessionID: SessionV2.ID.make(id),
                  root: fsRoot, // High-2: undetermined root (no git repo anywhere)
                  enabled: true,
                  store,
                  fs: fsOverride,
                })
              // subagent session: skipped, nothing written
              yield* after(subagent)
              expect(yield* fs.isDir(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY))).toBe(false)
              // disabled: skipped
              yield* ProjectDocsSync.afterSessionNow({
                sessionID: primary,
                root: fsRoot,
                enabled: false,
                store,
                fs,
              })
              expect(yield* fs.isDir(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY))).toBe(false)
              // a failing filesystem: the settle must not fail (logged + ignored)
              const failing = FSUtil.Service.of({
                ...fs,
                isDir: () => Effect.sync(() => {
                  throw new Error("boom")
                }),
              })
              yield* after(primary, failing)
              expect(yield* fs.isDir(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY))).toBe(false)
            }),
            storeLayer,
          )
        }),
      ),
    ),
  )

  it.live("settle writes into the nearest existing docs/deepagent ancestor under an undetermined root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const storeLayer = SessionStore.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:")))
          yield* Effect.provide(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              yield* db
                .insert(ProjectTable)
                .values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
                .run()
                .pipe(Effect.orDie)
              const sessionID = SessionV2.ID.create()
              yield* db
                .insert(SessionTable)
                .values({
                  id: sessionID,
                  project_id: Project.ID.global,
                  slug: sessionID,
                  directory: tmp.path,
                  title: "settle",
                  version: "test",
                })
                .run()
                .pipe(Effect.orDie)
              const store = yield* SessionStore.Service
              const fsRoot = path.parse(tmp.path).root
              // no docs/deepagent at all: skipped, and NOTHING is written (never the fs root)
              yield* ProjectDocsSync.afterSessionNow({
                sessionID,
                root: fsRoot,
                enabled: true,
                store,
                fs,
              })
              expect(yield* fs.isDir(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY))).toBe(false)
              // with docs/deepagent already present at the session dir: settle writes there
              yield* Effect.promise(() => writeFixture(tmp.path, { HANDOFF: "# old\n" }))
              yield* ProjectDocsSync.afterSessionNow({
                sessionID,
                root: fsRoot,
                enabled: true,
                store,
                fs,
              })
              const handoff = yield* Effect.promise(() =>
                fsNode.readFile(path.join(tmp.path, ProjectDocs.DOCS_DIRECTORY, "HANDOFF.md"), "utf8"),
              )
              expect(handoff).toContain("> revision: ")
              expect(handoff).toContain("Handoff 交接文档")
              // the read side agrees: the same root is observed
              const observed = yield* ProjectDocs.observeFor(tmp.path, fs)
              expect(observed.root).toBe(tmp.path)
            }),
            storeLayer,
          )
        }),
      ),
    ),
  )

  it.effect("positions LOG entries newest-first regardless of traversal order (High-1)", () =>
    Effect.gen(function* () {
      const base = { root: "/repo", revision: "2026-09-05T10:00:00.000Z", goal: undefined }
      const one = {
        sessionID: "ses_one",
        title: "One",
        updated: "2026-09-05T09:00:00.000Z",
        prompts: ["one"],
        progress: ["done one"],
        toolCalls: 1,
        errors: 0,
      }
      const two = {
        sessionID: "ses_two",
        title: "Two",
        updated: "2026-09-06T09:00:00.000Z",
        prompts: ["two"],
        progress: ["done two"],
        toolCalls: 2,
        errors: 0,
      }
      // two brand-new sessions written old→new (what the CLI does): newest ends on top
      const first = ProjectDocsSync.renderDocs({ ...base, session: one, existing: {} })
      const both = ProjectDocsSync.renderDocs({ ...base, session: two, existing: { LOG: first.LOG } })
      expect(both.LOG.indexOf("ses_two")).toBeLessThan(both.LOG.indexOf("ses_one"))
      // a LOG that only holds the NEWER entry (e.g. written by a single-session settle):
      // an older session appended later must land BELOW the newer entry, not above it
      const newerOnly = ProjectDocsSync.renderDocs({ ...base, session: two, existing: {} })
      const healed = ProjectDocsSync.renderDocs({ ...base, session: one, existing: { LOG: newerOnly.LOG } })
      expect(healed.LOG.indexOf("ses_one")).toBeGreaterThan(healed.LOG.indexOf("ses_two"))
    }),
  )

  it.effect("rebuilds a blank LOG but prepends into a heading-less LOG without dropping content (Low-1)", () =>
    Effect.gen(function* () {
      const base = { root: "/repo", revision: "2026-09-05T10:00:00.000Z", goal: undefined }
      const session = {
        sessionID: "ses_one",
        title: "One",
        updated: "2026-09-05T09:00:00.000Z",
        prompts: ["one"],
        progress: ["done one"],
        toolCalls: 1,
        errors: 0,
      }
      const blank = ProjectDocsSync.renderDocs({ ...base, session, existing: { LOG: "  \n\n" } })
      expect(blank.LOG).toContain("# Log 工程日志")
      expect(blank.LOG).toContain("<!-- session: ses_one -->")
      const headingless = ProjectDocsSync.renderDocs({
        ...base,
        session,
        existing: { LOG: "> revision: old\nlegacy notes\nmore legacy" },
      })
      expect(headingless.LOG).toContain("legacy notes")
      expect(headingless.LOG).toContain("more legacy")
      expect(headingless.LOG.indexOf("<!-- session: ses_one -->")).toBeLessThan(headingless.LOG.indexOf("legacy notes"))
      expect(headingless.LOG).toContain("> revision: 2026-09-05T10:00:00.000Z")
    }),
  )

  it.effect("rotates LOG.md at LOG_MAX_ENTRIES keeping the newest window with a tail note (Med-2)", () =>
    Effect.gen(function* () {
      const count = ProjectDocsSync.LOG_MAX_ENTRIES + 2
      let log: string | undefined
      for (let n = 0; n < count; n++) {
        const updated = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
        log = ProjectDocsSync.renderDocs({
          root: "/repo",
          revision: "2026-09-05T10:00:00.000Z",
          goal: undefined,
          session: {
            sessionID: `ses_${n}`,
            title: `T${n}`,
            updated,
            prompts: [`p${n}`],
            progress: [`d${n}`],
            toolCalls: 0,
            errors: 0,
          },
          existing: log === undefined ? {} : { LOG: log },
        }).LOG
      }
      expect(log!.match(/<!-- session: /g)).toHaveLength(ProjectDocsSync.LOG_MAX_ENTRIES)
      expect(log).toContain(`> log rotated: kept the newest ${ProjectDocsSync.LOG_MAX_ENTRIES} session entries (older entries dropped)`)
      // the newest window is kept: the very newest entry is still at the top
      expect(log!.indexOf("# Log 工程日志")).toBeGreaterThan(-1)
      expect(log!.indexOf(`ses_${count - 1}`)).toBeGreaterThan(-1)
    }),
  )
})
