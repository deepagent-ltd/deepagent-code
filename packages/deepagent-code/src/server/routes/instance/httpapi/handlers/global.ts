import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed, disposeInstancesForDirectories } from "@/server/global-lifecycle"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { Flag } from "@deepagent-code/core/flag/flag"
import { IM_PROTOCOL_VERSION } from "@deepagent-code/core/im/protocol"
import * as Log from "@deepagent-code/core/util/log"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput, ImportRequestSchema } from "../groups/global"
import { runImport } from "@/import"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectDirectoryTable, ProjectTable } from "@deepagent-code/core/project/sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { resolveDataPath } from "@deepagent-code/core/global-path"
import { eq } from "drizzle-orm"

const log = Log.create({ service: "server" })
const runtimeId = crypto.randomUUID()

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  log.info("global event connected")
  const events = Stream.callback<GlobalBusEvent>((queue) => {
    const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
  )

  return HttpServerResponse.stream(
    Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => log.info("global event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    const { db } = yield* Database.Service
    const flags = yield* RuntimeFlags.Service

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion, runtimeId }
    })

    const capabilities = Effect.fn("GlobalHttpApi.capabilities")(function* () {
      return {
        protocolVersion: IM_PROTOCOL_VERSION,
        version: InstallationVersion,
        commit: Flag.DEEPAGENT_CODE_COMMIT,
        features: {
          im: true,
          sessions: true,
          pty: true,
          workspaces: true,
          // V3.9 §C/§D: advertise the independently-gated experimental subsystems so the client can
          // gate their UI (panel button / goal mode) WITHOUT a proxy signal. Sourced from the same
          // env-backed RuntimeFlags the routes fail-close on, so UI availability == route availability.
          expertPanel: flags.experimentalExpertPanel,
          goalLoop: flags.experimentalGoalLoop,
          wiki: flags.experimentalWiki,
          // V4.0 §H3 — advertise the event-driven Agent-OS flags (all default OFF) so UI availability
          // == route availability. The routes fail-close on the same flags.
          v4EventDrivenIm: flags.v4EventDrivenIm,
          v4AgentPushEnabled: flags.v4AgentPushEnabled,
          v4MultiAgentRuntime: flags.v4MultiAgentRuntime,
          v4ThreadEnabled: flags.v4ThreadEnabled,
          v4FileUploadEnabled: flags.v4FileUploadEnabled,
        },
      }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const projects = Effect.fn("GlobalHttpApi.projects")(function* () {
      const rows = yield* db.select({ id: ProjectTable.id, worktree: ProjectTable.worktree, name: ProjectTable.name }).from(ProjectTable).all().pipe(Effect.orDie)
      return rows.map((row) => ({ id: row.id, worktree: row.worktree, name: row.name ?? undefined }))
    })

    const projectDelete = Effect.fn("GlobalHttpApi.projectDelete")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
    }) {
      const projectID = ctx.params.projectID
      // Dispose any live instances rooted at this project's known directories first, so a
      // running instance does not keep writing to a row that is about to be deleted. The
      // worktree column plus every project_directory row (main / root / git_worktree) covers
      // all directories an instance could have booted against.
      const worktreeRow = yield* db
        .select({ worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectID))
        .get()
        .pipe(Effect.orDie)
      const directoryRows = yield* db
        .select({ directory: ProjectDirectoryTable.directory })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .all()
        .pipe(Effect.orDie)
      const directories = new Set<string>()
      if (worktreeRow?.worktree) directories.add(worktreeRow.worktree)
      for (const row of directoryRows) if (row.directory) directories.add(row.directory)
      yield* disposeInstancesForDirectories([...directories])

      // Delete the project row. Sessions, messages, parts, project_directory rows and every
      // other table that references the project cascade automatically (onDelete: "cascade").
      // Idempotent: deleting an unknown project affects zero rows and still succeeds.
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie)
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    const importRaw = Effect.fn("GlobalHttpApi.importRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ error: "Invalid request body: not valid JSON", body: body.slice(0, 200) }, { status: 400 })
      }
      const decoded = yield* Schema.decodeUnknownEffect(ImportRequestSchema)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload, error: "" as string })),
        Effect.catch((err) =>
          Effect.succeed({
            valid: false as const,
            payload: null,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!decoded.valid || decoded.payload === null) {
        return HttpServerResponse.jsonUnsafe({ error: "Invalid request body: schema decode failed", detail: decoded.error }, { status: 400 })
      }
      const opts = decoded.payload
      const queue = yield* Queue.unbounded<unknown>()
      // Hot-import: write into the SAME database + knowledge root this sidecar
      // actually uses. `Database.path()` is channel-aware (dev vs prod use
      // different `Global.Path.data` + a `deepagent-code-<channel>.db` file), so
      // hardcoding a path would write to a DB the running app never reads — the
      // root cause of "imported sessions invisible". Forcing live-write (not a
      // snapshot copy) because a copy the app doesn't open defeats hot-import.
      void runImport({
        source: opts.source,
        sourcePath: opts.sourcePath,
        scopes: opts.scopes ? [...opts.scopes] : undefined,
        dryRun: opts.dryRun ?? false,
        copyLiveDb: false,
        outputDbPath: Database.path(),
        outputDataRoot: resolveDataPath(),
        cwdFilter: opts.cwdFilter,
        onProgress: (event) => {
          Queue.offerUnsafe(queue, event)
        },
      })
        .then((report) => {
          Queue.offerUnsafe(queue, { phase: "done", report })
          Queue.shutdown(queue)
        })
        .catch((err: unknown) => {
          Queue.offerUnsafe(queue, {
            phase: "error",
            message: err instanceof Error ? err.message : String(err),
          })
          Queue.shutdown(queue)
        })
      return HttpServerResponse.stream(
        Stream.fromQueue(queue).pipe(
          Stream.map(eventData),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
        ),
        {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        },
      )
    })

    return handlers
      .handle("health", health)
      .handle("capabilities", capabilities)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("projects", projects)
      .handle("projectDelete", projectDelete)
      .handleRaw("upgrade", upgradeRaw)
      .handleRaw("import", importRaw)
  }),
)
