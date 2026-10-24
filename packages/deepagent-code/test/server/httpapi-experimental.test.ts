import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AccountV2 } from "@deepagent-code/core/account"
import { AccountTable } from "@deepagent-code/core/account/sql"
import * as Log from "@deepagent-code/core/util/log"
import { Worktree } from "../../src/worktree"
import { Git } from "../../src/git"
import { Project } from "../../src/project/project"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, FSUtil.defaultLayer, Git.defaultLayer, httpApiLayer),
)
const testWorktreeMutations = process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount(serverURL: string) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: serverURL,
          token_expiry: Date.now() + 3600000,
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function withCreatedWorktree(
  directory: string,
  use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })

      expect(created.status).toBe(200)
      const info = yield* json<Worktree.Info>(created)
      expect(info).toMatchObject({ name, branch: "deepagent-code/api-test" })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ directory: info.directory }),
        })
        if (removed.status !== 200) return yield* Effect.fail(new Error(`failed to remove worktree: ${removed.status}`))
        const ok = yield* json<boolean>(removed)
        if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  testWorktreeMutations("persists retained checkout adoption after linked-first safe removal", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const service = yield* Git.Service
      const git = (directory: string, args: string[]) =>
        service.run(args, { cwd: directory }).pipe(
          Effect.map((result) => {
            if (result.exitCode !== 0) throw new Error(`fixture git failed: ${result.stderr.toString("utf8")}`)
            return result.text().trim()
          }),
        )
      yield* Effect.forEach(["retained", "live", "removed"] as const, (mode) =>
        Effect.gen(function* () {
          const main = yield* tmpdirScoped({ git: true })
          const linked = yield* tmpdirScoped()
          yield* git(main, ["branch", "-M", "main"])
          yield* git(main, ["worktree", "add", "-b", "http-linked", linked, "main"])
          const first = yield* request("/project/current", mode === "live" ? main : linked)
          expect(first.status).toBe(200)
          const original = yield* json<Project.Info>(first)
          expect(original.worktree).toBe(mode === "live" ? main : linked)
          const directory = mode === "removed" ? linked : main
          const current = yield* request("/project/current", directory)
          expect(current.status).toBe(200)
          expect((yield* json<Project.Info>(current)).id).toBe(original.id)
          const updated: Project.Info[] = []
          const on = (event: GlobalEvent) => {
            if (event.payload.type === Project.Event.Updated.type && event.payload.properties.id === original.id)
              updated.push(event.payload.properties)
          }
          GlobalBus.on("event", on)
          yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
          const removed = yield* request(ExperimentalPaths.worktreeSafeRemove, directory, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ directory: linked }),
          })
          expect(removed.status).toBe(200)
          expect(yield* json(removed)).toBe(true)
          expect(yield* fs.exists(linked)).toBe(false)
          expect((yield* git(main, ["branch", "--list", "http-linked"])).trim()).toBe("")
          if (mode === "removed") {
            expect(updated).toHaveLength(1)
            expect(updated[0].worktree).toBe(linked)
            return
          }
          const listed = yield* request("/project", main)
          const persisted = (yield* json<Project.Info[]>(listed)).find((item) => item.id === original.id)
          expect(persisted?.worktree).toBe(main)
          expect(persisted?.sandboxes).not.toContain(linked)
          expect(persisted?.sandboxes).not.toContain(main)
          if (mode === "live") expect(updated).toHaveLength(1)
          if (mode === "retained") expect(updated.at(-1)?.worktree).toBe(main)
        }),
      )
    }),
  )

  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=deepagent-code&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktrees are only supported for git projects" },
      })
    }),
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const requests: string[] = []
        const current = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: (request) => {
                requests.push(new URL(request.url).pathname)
                if (request.headers.get("authorization") !== "Bearer access") return new Response(null, { status: 401 })
                if (new URL(request.url).pathname === "/api/user")
                  return Response.json({ id: "account-test", email: "test@example.com" })
                if (new URL(request.url).pathname === "/api/orgs")
                  return Response.json([{ id: "org-test", name: "fixture org" }])
                return new Response(null, { status: 404 })
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const accountID = yield* insertAccount(current.url.origin)
        const denied = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-not-authorized" }),
        })
        expect(denied.status).toBe(400)
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
        expect(requests.filter((value) => value === "/api/orgs").length).toBeGreaterThanOrEqual(2)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const reset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: info.directory }),
            })

            expect(reset.status).toBe(200)
            expect(yield* json(reset)).toBe(true)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
