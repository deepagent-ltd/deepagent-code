/**
 * Regression test for the same bug class as #26574 (sibling of #26566 and
 * #26553). The Desktop app calls GET /session/<id>/diff; before #26574
 * the response was Schema-encoded against `Snapshot.FileDiff` with
 * `patch: Schema.String` (required), so any session whose stored
 * `summary_diffs` had a row without `patch` returned HTTP 400 and the
 * session never loaded. Legacy session-level diffs are no longer surfaced,
 * but the endpoint remains compatible and must still return successfully.
 *
 * This test inserts a session row with a missing-patch diff entry and
 * asserts that GET /session/<id>/diff returns 200 with empty data.
 */
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { MessageID } from "@/session/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { Database } from "@deepagent-code/core/database/database"
import { MessageTable } from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as Log from "@deepagent-code/core/util/log"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Storage.defaultLayer, Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function pathFor(template: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), template)
}

const withSession = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.acquireRelease(Session.use.create(input), (created) => Session.use.remove(created.id).pipe(Effect.ignore))

describe("session diff with missing patch (#26574)", () => {
  it.instance(
    "GET /session/<id>/diff ignores legacy session-level diff storage",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "missing-patch" })

        // Mimic legacy/imported on-disk shape: a diff entry with no
        // `patch` text. Pre-fix the typed response encoder rejects
        // this and returns 400.
        yield* Storage.Service.use((storage) =>
          storage.write(["session_diff", session.id], [{ file: "legacy.txt", additions: 1, deletions: 0 }]),
        )

        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )

        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // Wide ceiling only: the full-suite load can push these server-backed diffs past 15s.
    30_000,
  )

  it.instance(
    "GET /session/<id>/diff returns requested turn diffs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "turn-diff" })
        const messageID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: [{ file: "turn.ts", additions: 1, deletions: 0, status: "modified" }],
          },
        } satisfies SessionV1.User)

        const response = yield* requestInDirectory(
          `${pathFor(SessionPaths.diff, { sessionID: session.id })}?messageID=${messageID}`,
          test.directory,
        )

        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([{ file: "turn.ts", additions: 1, deletions: 0, status: "modified" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // Wide ceiling only: the full-suite load can push these server-backed diffs past 15s.
    30_000,
  )

  it.instance(
    "message endpoints bound legacy inline patches without rewriting storage",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "legacy-inline-patch" })
        const messageID = MessageID.ascending()
        const patch = "x".repeat(32 * 1024)
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: Array.from({ length: MessageV2.ClientDiffLimits.files + 10 }, (_, index) => ({
              file: `legacy-${index}.ts`,
              patch,
              additions: 1,
              deletions: 0,
              status: "modified" as const,
            })),
          },
        } satisfies SessionV1.User)

        const list = yield* requestInDirectory(
          `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=20`,
          test.directory,
        )
        const listed = (yield* list.json) as SessionV1.WithParts[]
        const projected = listed.find((item) => item.info.id === messageID)?.info
        expect(projected?.role === "user" ? projected.summary?.diffs : undefined).toHaveLength(
          MessageV2.ClientDiffLimits.files,
        )
        expect(
          projected?.role === "user" ? projected.summary?.diffs.every((item) => item.patch === undefined) : false,
        ).toBe(true)

        const { db } = yield* Database.Service
        const stored = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(and(eq(MessageTable.session_id, session.id), eq(MessageTable.id, messageID)))
          .get()
          .pipe(Effect.orDie)
        const original =
          stored?.data.role === "user" && typeof stored.data.summary === "object"
            ? stored.data.summary
            : undefined
        expect(original?.diffs).toHaveLength(
          MessageV2.ClientDiffLimits.files + 10,
        )
        expect(original?.diffs[0]?.patch).toBe(patch)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // Wide ceiling only: the full-suite load can push these server-backed diffs past 15s.
    30_000,
  )

  it.instance(
    "GET /session/<id>/diff strips legacy inline patch bodies",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "giant-inline-turn-diff" })
        const messageID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: [
              {
                file: "legacy-giant.ts",
                patch: "x".repeat(2 * 1024 * 1024),
                additions: 1,
                deletions: 0,
                status: "modified",
              },
            ],
          },
        } satisfies SessionV1.User)

        const response = yield* requestInDirectory(
          `${pathFor(SessionPaths.diff, { sessionID: session.id })}?messageID=${messageID}`,
          test.directory,
        )

        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([
          { file: "legacy-giant.ts", additions: 1, deletions: 0, status: "modified" },
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // Wide ceiling only: the full-suite load can push these server-backed diffs past 15s.
    30_000,
  )
})
