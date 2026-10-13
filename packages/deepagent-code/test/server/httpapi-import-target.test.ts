import { GlobalRuntimeFixture } from "./fixture/global-runtime"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { resolveConfigPath, resolveDataPath } from "@deepagent-code/core/global-path"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { MoveSession } from "@deepagent-code/core/control-plane/move-session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ServerAuth } from "@/server/auth"
import { RootHttpApi } from "@/server/routes/instance/httpapi/api"
import { controlHandlers } from "@/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "@/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "@/server/routes/instance/httpapi/handlers/global"
import { workRecoveryHandlers } from "@/server/routes/instance/httpapi/handlers/work-recovery"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import type { ImportTarget } from "@/import/target"
import type { ImportReport } from "@/import/types"
import { sessionID } from "@/import/util/ids"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(NodeServices.layer)

function server(filename: string) {
  const database = Database.layerFromPath(filename)
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, workRecoveryHandlers()]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(database),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(GlobalRuntimeFixture.layer),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(Layer.mock(Installation.Service)({})),
    Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "deepagent-code" })),
    Layer.provide(RuntimeFlags.layer({})),
  )
}

function post(payload: Record<string, unknown>) {
  return HttpClientRequest.post("/global/import").pipe(
    HttpClientRequest.setBody(HttpBody.text(JSON.stringify(payload), "application/json")),
    HttpClient.execute,
  )
}

function events(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map(
      (line) =>
        JSON.parse(line.slice(5)) as {
          phase: string
          target?: ImportTarget
          report?: ImportReport & { target: ImportTarget }
          message?: string
        },
    )
}

async function readDatabase(filename: string) {
  const { Database } = await import("bun:sqlite")
  const db = new Database(filename, { readonly: true, create: false })
  try {
    return {
      sessions: db.query("SELECT id FROM session").all() as { id: string }[],
      sentinel: db.query("SELECT value FROM import_sentinel").get() as { value: string },
    }
  } finally {
    db.close()
  }
}

async function writeSource(root: string, source: "codex" | "claude") {
  const cwd = path.join(root, "project")
  await fs.mkdir(cwd, { recursive: true })
  const sourcePath = path.join(root, source)
  if (source === "codex") {
    await Bun.write(
      path.join(sourcePath, "sessions", "rollout-fixture.jsonl"),
      [
        { type: "session_meta", payload: { id: "import-target-oracle", cwd } },
        { type: "response_item", payload: { type: "message", role: "user", content: "fixture import message" } },
        {
          type: "response_item",
          payload: { type: "message", role: "assistant", content: "fixture imported response" },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    )
    await Bun.write(
      path.join(sourcePath, "memories", "fixture.md"),
      "# Fixture preference\nPrefer repeatable isolated checks for fixture work.\n",
    )
    return sourcePath
  }
  await Bun.write(
    path.join(sourcePath, "projects", "fixture", "oracle.jsonl"),
    [
      {
        type: "user",
        sessionId: "import-target-oracle",
        cwd,
        message: { role: "user", content: "fixture import message" },
      },
      {
        type: "assistant",
        sessionId: "import-target-oracle",
        cwd,
        message: { role: "assistant", content: [{ type: "text", text: "fixture imported response" }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  )
  await Bun.write(
    path.join(sourcePath, "projects", "fixture", "memory", "fixture.md"),
    "# Fixture preference\nPrefer repeatable isolated checks for fixture work.\n",
  )
  await Bun.write(
    path.join(sourcePath, "skills", "import-target-fixture", "SKILL.md"),
    "# Fixture skill\nA fixture-only imported skill.\n",
  )
  return sourcePath
}

describe("global import actual target", () => {
  for (const source of ["codex", "claude"] as const) {
    it.live(
      `${source}: default copy preserves live WAL and isolates all imported output; confirmed merge uses live with verified backup`,
      () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          const filename = path.join(tmp, "live.db")
          const previous = Flag.DEEPAGENT_CODE_DB
          Flag.DEEPAGENT_CODE_DB = filename
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              Flag.DEEPAGENT_CODE_DB = previous
            }),
          )
          const sourcePath = yield* Effect.promise(() => writeSource(tmp, source))
          yield* Effect.gen(function* () {
            const db = (yield* Database.Service).db
            yield* db.run("PRAGMA wal_autocheckpoint = 0")
            yield* db.run("CREATE TABLE import_sentinel(value TEXT)")
            yield* db.run("INSERT INTO import_sentinel VALUES ('committed WAL row')")
            const liveSkill = path.join(resolveConfigPath(), "skills", "import-target-fixture", "SKILL.md")
            yield* Effect.promise(() => Bun.write(liveSkill, "existing live skill"))
            const response = yield* post({ source, sourcePath, scopes: ["session"] })
            expect(response.status).toBe(200)
            const received = events(yield* response.text)
            const report = received.find((event) => event.phase === "done")?.report
            expect(report?.warnings).toEqual([])
            expect(report?.sessions).toHaveLength(1)
            expect(report?.target.mode).toBe("copy_to_new_db")
            expect(received.find((event) => event.phase === "prepared")?.target).toEqual(report!.target)
            expect(report!.target.dbPath).not.toBe(filename)
            expect(report!.target.dataRoot).not.toBe(resolveDataPath())
            expect(report!.target.configDir).not.toBe(resolveConfigPath())
            const live = yield* Effect.promise(() => readDatabase(filename))
            const copy = yield* Effect.promise(() => readDatabase(report!.target.dbPath))
            const backup = yield* Effect.promise(() => readDatabase(report!.target.backup!.path))
            expect(live.sessions).toEqual([])
            expect(backup.sessions).toEqual([])
            expect(copy.sessions.map((row) => row.id)).toContain(sessionID(source, "import-target-oracle"))
            expect(copy.sentinel.value).toBe("committed WAL row")
            expect(backup.sentinel.value).toBe("committed WAL row")
            expect(yield* Effect.promise(() => Bun.file(liveSkill).text())).toBe("existing live skill")
            const all = yield* post({ source, sourcePath, scopes: ["session", "memory", "skill"] })
            expect(all.status).toBe(200)
            const allScopes = events(yield* all.text).find((event) => event.phase === "done")!.report!
            expect(allScopes.warnings).toEqual([])
            expect(allScopes.memory?.staged).toBe(1)
            expect(yield* Effect.promise(() => Bun.file(liveSkill).text())).toBe("existing live skill")
            expect((yield* Effect.promise(() => readDatabase(filename))).sessions).toEqual([])
            if (source === "claude") {
              expect(allScopes.skills?.written).toBe(1)
              expect(
                yield* Effect.promise(() =>
                  Bun.file(path.join(allScopes.target.configDir, "skills", "import-target-fixture", "SKILL.md")).text(),
                ),
              ).toContain("fixture-only")
            }
            const refused = yield* post({ source, sourcePath, copyLiveDb: false, scopes: ["session"] })
            expect(refused.status).toBe(400)
            expect(yield* refused.text).toContain("IMPORT_LIVE_CONFIRMATION_REQUIRED")
            const merged = yield* post({
              source,
              sourcePath,
              copyLiveDb: false,
              confirmLiveMerge: true,
              scopes: ["session"],
            })
            expect(merged.status).toBe(200)
            const mergedReport = events(yield* merged.text).find((event) => event.phase === "done")?.report
            expect(mergedReport?.warnings).toEqual([])
            expect(mergedReport?.sessions).toHaveLength(1)
            expect(mergedReport?.target.mode).toBe("merge_into_live")
            expect(mergedReport?.target.dbPath).toBe(filename)
            expect((yield* Effect.promise(() => readDatabase(filename))).sessions.map((row) => row.id)).toContain(
              sessionID(source, "import-target-oracle"),
            )
            expect((yield* Effect.promise(() => readDatabase(mergedReport!.target.backup!.path))).sessions).toEqual([])
          }).pipe(Effect.provide(server(filename)))
        }),
    )
  }

  it.live("rejects conflicting modes and unsupported live scopes before writes; dry-run creates no target", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const filename = path.join(tmp, "live.db")
      const previous = Flag.DEEPAGENT_CODE_DB
      Flag.DEEPAGENT_CODE_DB = filename
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.DEEPAGENT_CODE_DB = previous
        }),
      )
      const sourcePath = yield* Effect.promise(() => writeSource(tmp, "codex"))
      yield* Effect.gen(function* () {
        for (const input of [
          { mode: "copy_to_new_db", copyLiveDb: false },
          { mode: "merge_into_live", confirmLiveMerge: true, scopes: ["memory"] },
        ]) {
          const response = yield* post({ source: "codex", sourcePath, ...input })
          expect(response.status).toBe(400)
          expect(yield* response.text).toContain("IMPORT_")
        }
        const response = yield* post({ source: "codex", sourcePath, dryRun: true })
        const report = events(yield* response.text).find((event) => event.phase === "done")?.report
        expect(report?.dryRun).toBe(true)
        expect(report?.sessions).toHaveLength(1)
        expect(report?.sessions[0]?.targetId).toBe("(dry-run)")
        expect(report?.target.backup).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(report!.target.dbPath).exists())).toBe(false)
      }).pipe(Effect.provide(server(filename)))
    }),
  )

  it.live("a real backup destination failure prevents live writes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const filename = path.join(tmp, "live.db")
      const previous = Flag.DEEPAGENT_CODE_DB
      const previousHome = process.env.DEEPAGENT_CODE_HOME
      Flag.DEEPAGENT_CODE_DB = filename
      process.env.DEEPAGENT_CODE_HOME = path.join(tmp, "data")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.DEEPAGENT_CODE_DB = previous
          if (previousHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
          else process.env.DEEPAGENT_CODE_HOME = previousHome
        }),
      )
      const sourcePath = yield* Effect.promise(() => writeSource(tmp, "codex"))
      yield* Effect.promise(() => Bun.write(path.join(resolveDataPath(), "imports"), "blocked backup directory"))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run("CREATE TABLE import_sentinel(value TEXT)")
        yield* db.run("INSERT INTO import_sentinel VALUES ('before rejected merge')")
        const response = yield* post({
          source: "codex",
          sourcePath,
          mode: "merge_into_live",
          confirmLiveMerge: true,
          scopes: ["session"],
        })
        expect(response.status).toBe(200)
        expect(events(yield* response.text).find((event) => event.phase === "error")?.message).toContain("ENOTDIR")
        const actual = yield* Effect.promise(() => readDatabase(filename))
        expect(actual.sessions).toEqual([])
        expect(actual.sentinel.value).toBe("before rejected merge")
        // Failure releases the live-import guard; a repeated request fails for the same real I/O reason, not IMPORT_BUSY.
        const repeat = yield* post({
          source: "codex",
          sourcePath,
          mode: "merge_into_live",
          confirmLiveMerge: true,
          scopes: ["session"],
        })
        expect(repeat.status).toBe(200)
        expect(events(yield* repeat.text).find((event) => event.phase === "error")?.message).toContain("ENOTDIR")
      }).pipe(Effect.provide(server(filename)))
    }),
  )
})
