import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fsNode from "fs/promises"
import path from "path"
import { cliIt, testModelID } from "../lib/cli-process"

// W10: `deepagent docs sync` — explicit project docs write path. Each test runs real CLI
// subprocesses: `run` creates a session in the fixture project, `docs sync` scans the session
// store for that directory and generates docs/deepagent/{HANDOFF,DESIGN,PLAN,LOG}.md.
//
// test/preload.ts pins DEEPAGENT_CODE_DB=:memory:, which gives every spawned process its own
// DB. Point the whole flow at a shared file DB so the session created by `run` is visible to
// the later `docs sync` processes.
describe("deepagent docs sync (subprocess)", () => {
  cliIt.concurrent(
    "generates the four documents with revision stamps and is idempotent per session",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const project = path.join(home, "project")
        const dbEnv = { DEEPAGENT_CODE_DB: path.join(home, "docs-cli.db") }
        yield* Effect.promise(() => fsNode.mkdir(project, { recursive: true }))

        const first = yield* deepagentCode.run("implement the project docs suite", {
          model: testModelID,
          env: dbEnv,
          extraArgs: ["--dir", project],
        })
        deepagentCode.expectExit(first, 0, "run: first session")

        const sync = yield* deepagentCode.spawn(["docs", "sync", "--dir", project], { env: dbEnv })
        deepagentCode.expectExit(sync, 0, "docs sync")

        const docsDir = path.join(project, "docs", "deepagent")
        for (const name of ["HANDOFF", "DESIGN", "PLAN", "LOG"]) {
          const content = yield* Effect.promise(() => fsNode.readFile(path.join(docsDir, `${name}.md`), "utf8"))
          expect(content).toMatch(/^> revision: \d{4}-\d{2}-\d{2}T/)
          expect(content).toMatch(new RegExp(`# ${name}`, "i"))
        }
        const log = yield* Effect.promise(() => fsNode.readFile(path.join(docsDir, "LOG.md"), "utf8"))
        expect(log.match(/<!-- session: /g)).toHaveLength(1)

        // Idempotent: a second sync must not append the same session again.
        const again = yield* deepagentCode.spawn(["docs", "sync", "--dir", project], { env: dbEnv })
        deepagentCode.expectExit(again, 0, "docs sync (idempotent)")
        const logAfter = yield* Effect.promise(() => fsNode.readFile(path.join(docsDir, "LOG.md"), "utf8"))
        expect(logAfter.match(/<!-- session: /g)).toHaveLength(1)
      }),
    180_000,
  )

  cliIt.concurrent(
    "appends a new session entry ahead of older ones",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const project = path.join(home, "project")
        const dbEnv = { DEEPAGENT_CODE_DB: path.join(home, "docs-cli.db") }
        yield* Effect.promise(() => fsNode.mkdir(project, { recursive: true }))

        const first = yield* deepagentCode.run("first task", {
          model: testModelID,
          env: dbEnv,
          extraArgs: ["--dir", project],
        })
        deepagentCode.expectExit(first, 0, "run: first session")
        const sync1 = yield* deepagentCode.spawn(["docs", "sync", "--dir", project], { env: dbEnv })
        deepagentCode.expectExit(sync1, 0, "docs sync")
        const log1 = yield* Effect.promise(() =>
          fsNode.readFile(path.join(project, "docs", "deepagent", "LOG.md"), "utf8"),
        )
        const firstMarker = log1.match(/<!-- session: [^ ]+ -->/)?.[0]
        expect(firstMarker).toBeDefined()

        const second = yield* deepagentCode.run("second task", {
          model: testModelID,
          env: dbEnv,
          extraArgs: ["--dir", project],
        })
        deepagentCode.expectExit(second, 0, "run: second session")
        const sync2 = yield* deepagentCode.spawn(["docs", "sync", "--dir", project], { env: dbEnv })
        deepagentCode.expectExit(sync2, 0, "docs sync (append)")

        const log2 = yield* Effect.promise(() =>
          fsNode.readFile(path.join(project, "docs", "deepagent", "LOG.md"), "utf8"),
        )
        const markers = [...log2.matchAll(/<!-- session: [^ ]+ -->/g)].map((m) => m[0])
        expect(markers).toHaveLength(2)
        expect(log2).toContain(firstMarker!)
        // newest first: the second session entry sits above the first one
        expect(markers[0]).not.toBe(firstMarker)
        expect(log2.indexOf(markers[0]!)).toBeLessThan(log2.indexOf(firstMarker!))
      }),
    180_000,
  )

  cliIt.concurrent(
    "a single sync over two fresh sessions orders the LOG newest-first (High-1)",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const project = path.join(home, "project")
        const dbEnv = { DEEPAGENT_CODE_DB: path.join(home, "docs-cli.db") }
        yield* Effect.promise(() => fsNode.mkdir(project, { recursive: true }))

        const first = yield* deepagentCode.run("first task", {
          model: testModelID,
          env: dbEnv,
          extraArgs: ["--dir", project],
        })
        deepagentCode.expectExit(first, 0, "run: first session")
        const second = yield* deepagentCode.run("second task", {
          model: testModelID,
          env: dbEnv,
          extraArgs: ["--dir", project],
        })
        deepagentCode.expectExit(second, 0, "run: second session")
        // ONE sync processes both fresh sessions together — the LOG must come out newest-first
        // (the old DESC traversal prepended each entry and inverted the order).
        const sync = yield* deepagentCode.spawn(["docs", "sync", "--dir", project], { env: dbEnv })
        deepagentCode.expectExit(sync, 0, "docs sync (one shot, two sessions)")

        const log = yield* Effect.promise(() =>
          fsNode.readFile(path.join(project, "docs", "deepagent", "LOG.md"), "utf8"),
        )
        expect(log.match(/<!-- session: /g)).toHaveLength(2)
        const stamps = [...log.matchAll(/^## (\S+) · /gm)].map((m) => m[1])
        expect(stamps).toHaveLength(2)
        // newest first: the top entry carries the strictly newer timestamp
        expect(Date.parse(stamps[0])).toBeGreaterThan(Date.parse(stamps[1]))
      }),
    180_000,
  )
})
