import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { PRQueue } from "../../src/agent/pr-queue"

let home: string
const previousHome = process.env.DEEPAGENT_CODE_HOME
const previousTestHome = process.env.DEEPAGENT_CODE_TEST_HOME

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-pr-queue-test-"))
  process.env.DEEPAGENT_CODE_TEST_HOME = home
  process.env.DEEPAGENT_CODE_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = previousHome
  if (previousTestHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  else process.env.DEEPAGENT_CODE_TEST_HOME = previousTestHome
  await fs.rm(home, { recursive: true, force: true })
})

const run = <A>(effect: Effect.Effect<A, PRQueue.PRQueueError, PRQueue.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.fresh(PRQueue.layer))))

const entry = (id: string, overrides: Partial<PRQueue.CreateInput> = {}): PRQueue.CreateInput => ({
  id,
  parentID: "parent-1",
  workerID: `worker-${id}`,
  reviewerID: "reviewer-1",
  sha: `sha-${id}`,
  ...overrides,
})

const approve = (queue: PRQueue.Interface, id: string, sha: string) =>
  Effect.gen(function* () {
    expect((yield* queue.claimForReview("parent-1"))?.id).toBe(id)
    expect((yield* queue.verdict({ id, reviewerID: "reviewer-1", sha, verdict: "approved" }))?.status).toBe("approved")
  })

describe("PRQueue", () => {
  test("claims a parent's draft entries in FIFO order", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("first"))
        yield* queue.create(entry("second"))
        expect((yield* queue.claimForReview("parent-1"))?.id).toBe("first")
        expect((yield* queue.claimForReview("parent-1"))?.id).toBe("second")
      }),
    )
  })

  test("claims an exact collaboration entry without consuming an older sibling", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("older"))
        yield* queue.create(entry("ready"))

        expect((yield* queue.claimForReview("parent-1", "ready"))?.id).toBe("ready")
        expect((yield* queue.get("older"))?.status).toBe("draft")
        expect((yield* queue.get("ready"))?.status).toBe("awaiting_review")
      }),
    )
  })

  test("requires the assigned worker and the exact reviewer SHA", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("change"))
        yield* queue.claimForReview("parent-1")

        expect(
          yield* queue.verdict({ id: "change", reviewerID: "other-reviewer", sha: "sha-change", verdict: "approved" }),
        ).toBeNull()
        expect(
          yield* queue.verdict({ id: "change", reviewerID: "reviewer-1", sha: "old-sha", verdict: "approved" }),
        ).toBeNull()
        expect(
          (yield* queue.verdict({
            id: "change",
            reviewerID: "reviewer-1",
            sha: "sha-change",
            verdict: "changes_requested",
          }))?.status,
        ).toBe("changes_requested")
        expect(yield* queue.resubmit({ id: "change", workerID: "other-worker", sha: "sha-next" })).toBeNull()
        expect((yield* queue.resubmit({ id: "change", workerID: "worker-change", sha: "sha-next" }))?.status).toBe(
          "draft",
        )
      }),
    )
  })

  test("rejects the fourth requested redo", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("redo"))
        let sha = "sha-redo"

        for (let redo = 1; redo <= 4; redo += 1) {
          expect((yield* queue.claimForReview("parent-1"))?.id).toBe("redo")
          const decision = yield* queue.verdict({
            id: "redo",
            reviewerID: "reviewer-1",
            sha,
            verdict: "changes_requested",
          })
          expect(decision?.redoCount).toBe(redo)
          if (redo < 4) {
            expect(decision?.status).toBe("changes_requested")
            sha = `sha-redo-${redo}`
            expect((yield* queue.resubmit({ id: "redo", workerID: "worker-redo", sha }))?.status).toBe("draft")
          } else {
            expect(decision?.status).toBe("rejected")
          }
        }
      }),
    )
  })

  test("records an explicit Reviewer rejection as terminal without consuming a redo", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create({
          id: "pr-rejected",
          parentID: "parent",
          workerID: "worker",
          reviewerID: "reviewer",
          sha: "worker-sha",
        })
        yield* queue.claimForReview("parent")

        const decision = yield* queue.verdict({
          id: "pr-rejected",
          reviewerID: "reviewer",
          sha: "worker-sha",
          verdict: "rejected",
        })

        expect(decision).toMatchObject({ status: "rejected", redoCount: 0 })
        expect(yield* queue.resubmit({ id: "pr-rejected", workerID: "worker", sha: "new-sha" })).toBeNull()
      }),
    )
  })

  test("allows one concurrent merge lease per parent", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("one", { sha: "sha-one" }))
        yield* queue.create(entry("two", { sha: "sha-two" }))
        yield* approve(queue, "one", "sha-one")
        yield* approve(queue, "two", "sha-two")

        const claims = yield* Effect.all(
          [
            queue.claimMerge({ id: "one", parentID: "parent-1" }),
            queue.claimMerge({ id: "two", parentID: "parent-1" }),
          ],
          { concurrency: "unbounded" },
        )
        expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
        const merging = claims.find((claim) => claim !== null)!
        expect(merging.status).toBe("merging")
        expect((yield* queue.completeMerge({ id: merging.id, parentID: "parent-1" }))?.status).toBe("merged")
      }),
    )
  })

  test("returns a merge conflict to the author with the shared redo counter", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("conflict", { sha: "sha-conflict" }))
        yield* approve(queue, "conflict", "sha-conflict")
        expect((yield* queue.claimMerge({ id: "conflict", parentID: "parent-1" }))?.status).toBe("merging")

        const bounced = yield* queue.bounceMerge({
          id: "conflict",
          parentID: "parent-1",
          diagnostic: "shared.txt conflicts",
        })
        expect(bounced).toMatchObject({
          status: "changes_requested",
          redoCount: 1,
          mergeDiagnostic: "shared.txt conflicts",
        })
        expect(yield* queue.claimMerge({ id: "conflict", parentID: "parent-1" })).toBeNull()
      }),
    )
  })

  test("persists entries across a fresh service layer", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("durable"))
        yield* queue.claimForReview("parent-1")
      }),
    )

    const reloaded = await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        return yield* queue.get("durable")
      }),
    )
    expect(reloaded).toMatchObject({ id: "durable", status: "awaiting_review", sha: "sha-durable" })

    const persisted = JSON.parse(await fs.readFile(PRQueue.stateFile(), "utf8"))
    expect(persisted.entries).toHaveLength(1)
  })

  test("does not lose writes from independent service handles", async () => {
    await Promise.all([
      run(PRQueue.Service.use((queue) => queue.create(entry("independent-a")))),
      run(PRQueue.Service.use((queue) => queue.create(entry("independent-b")))),
    ])

    expect((await run(PRQueue.Service.use((queue) => queue.list()))).map((item) => item.id).sort()).toEqual([
      "independent-a",
      "independent-b",
    ])
  })

  test("serializes concurrent review claims without duplicate ownership", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("a"))
        yield* queue.create(entry("b"))

        const claims = yield* Effect.all([queue.claimForReview("parent-1"), queue.claimForReview("parent-1")], {
          concurrency: "unbounded",
        })
        expect(claims.map((claim) => claim?.id).sort()).toEqual(["a", "b"])
        expect((yield* queue.list()).map((item) => item.status)).toEqual(["awaiting_review", "awaiting_review"])
      }),
    )
  })

  test("persists one Senior Reviewer state across every PR in a batch", async () => {
    await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        yield* queue.create(entry("stage-a", { metadata: { batchID: "batch-1" } }))
        yield* queue.create(entry("stage-b", { metadata: { batchID: "batch-1" } }))

        const updated = yield* queue.setStageReview({
          parentID: "parent-1",
          batchID: "batch-1",
          review: { status: "pending", reviewerID: "senior-1" },
        })
        expect(updated).toHaveLength(2)
        expect((yield* queue.list()).map((item) => item.metadata?.stageReview)).toEqual([
          { status: "pending", reviewerID: "senior-1" },
          { status: "pending", reviewerID: "senior-1" },
        ])
      }),
    )

    const reloaded = await run(
      Effect.gen(function* () {
        const queue = yield* PRQueue.Service
        return yield* queue.list()
      }),
    )
    expect(reloaded.map((item) => item.metadata?.stageReview)).toEqual([
      { status: "pending", reviewerID: "senior-1" },
      { status: "pending", reviewerID: "senior-1" },
    ])
  })
})
