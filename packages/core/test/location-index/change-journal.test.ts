import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { IndexSpaceID } from "../../src/context-federation/reference"
import { Database } from "../../src/database/database"
import { LocationChangeJournal } from "../../src/location-index/change-journal"
import { ChangeEventTable, ProjectionDirtyPathTable } from "../../src/location-index/sql"

const first = IndexSpaceID.make("idx_change_first")
const second = IndexSpaceID.make("idx_change_second")

describe("LocationChangeJournal", () => {
  test("fans out atomically and preserves rename continuity through later edits", async () => {
    await run(
      Effect.gen(function* () {
        const journal = yield* LocationChangeJournal.Service
        yield* journal.register({ indexSpaceId: first, projectionKind: "code", now: 1 })
        yield* journal.register({ indexSpaceId: first, projectionKind: "repo_documents", now: 1 })
        yield* journal.markReconciled({ indexSpaceId: first, projectionKind: "code", capturedEventSeq: 0, now: 2 })
        yield* journal.markReconciled({ indexSpaceId: first, projectionKind: "repo_documents", capturedEventSeq: 0, now: 2 })

        const renamed = yield* journal.append({
          indexSpaceId: first,
          path: "src/new.ts",
          previousPath: "src/old.ts",
          renameCorrelationId: "git-rename-1",
          changeKind: "rename",
          observedSha: "sha:new",
          source: "git",
          observedAt: 3,
        })
        const edited = yield* journal.append({
          indexSpaceId: first,
          path: "src/new.ts",
          changeKind: "update",
          observedSha: "sha:edited",
          source: "watcher",
          observedAt: 4,
        })
        const code = yield* journal.capture({ indexSpaceId: first, projectionKind: "code" })
        const documents = yield* journal.capture({ indexSpaceId: first, projectionKind: "repo_documents" })
        expect(code.capturedEventSeq).toBe(edited.eventSeq)
        expect(code.dirty).toEqual([
          {
            path: "src/new.ts",
            latestEventSeq: edited.eventSeq,
            changeKind: "update",
            observedSha: "sha:edited",
          },
        ])
        expect(code.events.map((event) => [event.eventSeq, event.changeKind, event.previousPath])).toEqual([
          [renamed.eventSeq, "rename", "src/old.ts"],
          [edited.eventSeq, "update", undefined],
        ])
        expect(documents.dirty).toEqual(code.dirty)
        expect(documents.events).toEqual(code.events)

        yield* journal.acknowledge({
          indexSpaceId: first,
          projectionKind: "code",
          capturedEventSeq: code.capturedEventSeq,
          now: 5,
        })
        expect(
          (yield* (yield* Database.Service).db.select().from(ProjectionDirtyPathTable).all()).map((row) =>
            row.projection_kind,
          ),
        ).toEqual(["repo_documents"])
      }),
    )
  })

  test("marks lagging paused consumers for reconciliation and keeps the journal bounded", async () => {
    await run(
      Effect.gen(function* () {
        const journal = yield* LocationChangeJournal.Service
        yield* journal.register({ indexSpaceId: first, projectionKind: "code", now: 1 })
        yield* journal.register({ indexSpaceId: first, projectionKind: "repo_documents", now: 1 })
        yield* journal.markReconciled({ indexSpaceId: first, projectionKind: "code", capturedEventSeq: 0, now: 2 })
        yield* journal.markReconciled({ indexSpaceId: first, projectionKind: "repo_documents", capturedEventSeq: 0, now: 2 })
        yield* journal.setState({ indexSpaceId: first, projectionKind: "repo_documents", state: "paused", now: 3 })

        for (const index of [1, 2, 3, 4, 5]) {
          yield* journal.append({
            indexSpaceId: first,
            path: `src/${index}.ts`,
            changeKind: "update",
            source: "watcher",
            observedAt: 3 + index,
          })
        }
        const code = yield* journal.capture({ indexSpaceId: first, projectionKind: "code" })
        yield* journal.acknowledge({
          indexSpaceId: first,
          projectionKind: "code",
          capturedEventSeq: code.capturedEventSeq,
          now: 10,
        })
        expect(yield* journal.compact({ indexSpaceId: first, maxRetainedEvents: 2, now: 11 })).toEqual({
          deleted: 3,
          highWater: 5,
        })
        const blocked = yield* journal
          .capture({ indexSpaceId: first, projectionKind: "repo_documents" })
          .pipe(Effect.flip)
        expect(blocked).toMatchObject({ _tag: "LocationChangeJournal.RegistrationError", reason: "reconcile_required" })
        const rows = yield* (yield* Database.Service).db.select().from(ChangeEventTable).all()
        expect(rows.map((row) => row.event_seq)).toEqual([4, 5])

        yield* journal.setState({ indexSpaceId: first, projectionKind: "repo_documents", state: "retired", now: 12 })
        expect(yield* journal.compact({ indexSpaceId: first, maxRetainedEvents: 1, now: 13 })).toEqual({
          deleted: 1,
          highWater: 5,
        })
      }),
    )
  })

  test("rejects unproven renames and isolates index spaces", async () => {
    await run(
      Effect.gen(function* () {
        const journal = yield* LocationChangeJournal.Service
        yield* journal.register({ indexSpaceId: first, projectionKind: "code" })
        yield* journal.register({ indexSpaceId: second, projectionKind: "code" })
        yield* journal.markReconciled({ indexSpaceId: first, projectionKind: "code", capturedEventSeq: 0 })
        yield* journal.markReconciled({ indexSpaceId: second, projectionKind: "code", capturedEventSeq: 0 })
        expect(
          (
            yield* journal
              .append({
                indexSpaceId: first,
                path: "src/new.ts",
                changeKind: "rename",
                source: "watcher",
              })
              .pipe(Effect.flip)
          )._tag,
        ).toBe("LocationChangeJournal.InvalidChangeError")
        yield* journal.append({
          indexSpaceId: second,
          path: "src/second.ts",
          changeKind: "create",
          source: "tool",
        })
        expect((yield* journal.capture({ indexSpaceId: first, projectionKind: "code" })).dirty).toEqual([])
        expect((yield* journal.capture({ indexSpaceId: second, projectionKind: "code" })).dirty).toHaveLength(1)
      }),
    )
  })
})

function run<A, E>(effect: Effect.Effect<A, E, Database.Service | LocationChangeJournal.Service>) {
  const database = Database.layerFromPath(":memory:")
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(LocationChangeJournal.layer.pipe(Layer.provideMerge(database))),
      Effect.scoped,
    ),
  )
}
