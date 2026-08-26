import { describe, expect, test } from "bun:test"
import { LocationIndexCoordination } from "@deepagent-code/core/context-federation/coordination"
import { LocationIdentity, type Identity } from "@deepagent-code/core/context-federation/identity"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { LocationChangeJournal } from "@deepagent-code/core/location-index/change-journal"
import { LocationCommitLock } from "@deepagent-code/core/location-index/commit-lock"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect, Exit, Layer } from "effect"
import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import { Service, layer } from "../../src/location-index/coordinator"
import { open } from "#location-index-sqlite"
import { tmpdir } from "../fixture/fixture"

describe("LocationIndexCoordinator", () => {
  test("builds, incrementally deletes Documents, reconciles watcher loss, and publishes trusted rename aliases", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "repo"))
    const root = path.join(tmp.path, "repo")
    await Bun.write(path.join(root, "old.ts"), "export function oldName() { return 1 }\n")
    await Bun.write(path.join(root, "README.md"), "# Initial Architecture\nold design\n")
    const harness = await makeHarness(tmp.path, root)

    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* Service
        yield* coordinator.initialize()
        expect((yield* coordinator.searchCode({ query: "oldName", limit: 10 })).revision?.generation).toBe(1)
        expect((yield* coordinator.searchDocuments({ query: "architecture", limit: 10 })).hits).toHaveLength(1)

        yield* Effect.promise(() => Bun.write(path.join(root, "README.md"), "# Revised Contract\nnew document body\n"))
        yield* coordinator.observe({ file: path.join(root, "README.md"), event: "change" })
        yield* coordinator.drain("repo_documents")
        expect((yield* coordinator.searchDocuments({ query: "architecture", limit: 10 })).hits).toEqual([])
        expect((yield* coordinator.searchDocuments({ query: "contract", limit: 10 })).revision?.generation).toBe(2)
        expect((yield* coordinator.searchCode({ query: "oldName", limit: 10 })).revision?.generation).toBe(1)

        yield* Effect.promise(() => rename(path.join(root, "old.ts"), path.join(root, "renamed.ts")))
        yield* coordinator.observeRename({
          previousFile: path.join(root, "old.ts"),
          file: path.join(root, "renamed.ts"),
          correlationId: "git-rename-proof",
          source: "git",
        })
        yield* coordinator.drain("code")
        expect((yield* coordinator.searchCode({ query: "oldName", limit: 10 })).revision?.generation).toBe(2)

        yield* Effect.promise(() => Bun.write(path.join(root, "new.ts"), "export const watcherRecovery = true\n"))
        yield* coordinator.requestReconciliation({ reason: "overflow", source: "watcher" })
        yield* coordinator.drain("code")
        yield* coordinator.drain("repo_documents")
        expect((yield* coordinator.searchCode({ query: "watcherRecovery", limit: 10 })).hits).not.toHaveLength(0)
        expect((yield* coordinator.searchDocuments({ query: "contract", limit: 10 })).revision?.generation).toBe(3)
      }),
    )

    const database = open(codeLocator(tmp.path, harness.identity))
    try {
      expect(database.all<{ reason: string; evidence: string }>("SELECT reason, evidence FROM code_entity_alias")).toEqual([
        { reason: "git_rename", evidence: "git-rename-proof" },
      ])
    } finally {
      database.close()
    }
  })

  test("retains dirty work across commit-before-ack crash and rejects a stale writer after takeover", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "repo"))
    const root = path.join(tmp.path, "repo")
    await Bun.write(path.join(root, "source.ts"), "export const beforeCrash = true\n")
    const fault = { enabled: false }
    const harness = await makeHarness(tmp.path, root, {
      afterCommit: () => fault.enabled ? Effect.die("crash-after-commit") : Effect.void,
    })

    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* Service
        const journal = yield* LocationChangeJournal.Service
        const coordination = yield* LocationIndexCoordination.Service
        yield* coordinator.initialize()
        yield* Effect.promise(() => Bun.write(path.join(root, "source.ts"), "export const afterCrash = true\n"))
        yield* coordinator.observe({ file: path.join(root, "source.ts"), event: "change" })
        fault.enabled = true
        expect(Exit.isFailure(yield* coordinator.drain("code").pipe(Effect.exit))).toBe(true)
        fault.enabled = false
        expect((yield* coordinator.searchCode({ query: "afterCrash", limit: 10 })).revision?.generation).toBe(2)
        expect((yield* journal.capture({ indexSpaceId: harness.identity.indexSpaceId, projectionKind: "code" })).dirty).not.toHaveLength(0)
        yield* coordinator.drain("code")
        expect((yield* coordinator.searchCode({ query: "afterCrash", limit: 10 })).revision?.generation).toBe(3)
        expect((yield* journal.capture({ indexSpaceId: harness.identity.indexSpaceId, projectionKind: "code" })).dirty).toEqual([])

        yield* coordination.acquire({
          identity: harness.identity,
          projectionKind: "code",
          ownerId: "replacement-writer",
          leaseMs: 30_000,
          now: Date.now() + 31_000,
        })
        yield* Effect.promise(() => Bun.write(path.join(root, "source.ts"), "export const staleWriterMustFail = true\n"))
        yield* coordinator.observe({ file: path.join(root, "source.ts"), event: "change" })
        const stale = yield* coordinator.drain("code").pipe(Effect.flip)
        expect(stale._tag).toBe("LocationIndexCoordination.StaleWriterError")
        expect((yield* coordinator.searchCode({ query: "staleWriterMustFail", limit: 10 })).hits).toEqual([])
      }),
    )
  })

  test("keeps two Location index spaces isolated", async () => {
    await using tmp = await tmpdir()
    const firstRoot = path.join(tmp.path, "first")
    const secondRoot = path.join(tmp.path, "second")
    await mkdir(firstRoot)
    await mkdir(secondRoot)
    await Bun.write(path.join(firstRoot, "same.ts"), "export const firstLocationOnly = true\n")
    await Bun.write(path.join(secondRoot, "same.ts"), "export const secondLocationOnly = true\n")
    const first = await makeHarness(path.join(tmp.path, "first-state"), firstRoot)
    const second = await makeHarness(path.join(tmp.path, "second-state"), secondRoot)
    expect(first.identity.locationKey).not.toBe(second.identity.locationKey)
    await first.run(
      Effect.gen(function* () {
        const coordinator = yield* Service
        yield* coordinator.initialize()
        expect((yield* coordinator.searchCode({ query: "firstLocationOnly", limit: 10 })).hits).not.toHaveLength(0)
        expect((yield* coordinator.searchCode({ query: "secondLocationOnly", limit: 10 })).hits).toEqual([])
      }),
    )
    await second.run(
      Effect.gen(function* () {
        const coordinator = yield* Service
        yield* coordinator.initialize()
        expect((yield* coordinator.searchCode({ query: "secondLocationOnly", limit: 10 })).hits).not.toHaveLength(0)
        expect((yield* coordinator.searchCode({ query: "firstLocationOnly", limit: 10 })).hits).toEqual([])
      }),
    )
  })

  test("replaces a corrupt projection with a complete versioned database", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "repo"))
    const root = path.join(tmp.path, "repo")
    await Bun.write(path.join(root, "source.ts"), "export const survivesCorruption = true\n")
    const harness = await makeHarness(tmp.path, root)

    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* Service
        yield* coordinator.initialize()
        expect((yield* coordinator.searchCode({ query: "survivesCorruption", limit: 10 })).hits).not.toHaveLength(0)
      }),
    )

    const original = codeLocator(tmp.path, harness.identity)
    await Bun.write(original, "corrupt-current-database")

    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* Service
        const coordination = yield* LocationIndexCoordination.Service
        yield* coordinator.initialize()
        const record = yield* coordination.get({ identity: harness.identity, projectionKind: "code" })
        expect(record.indexIncarnation).toBe(2)
        expect(record.dbLocator).not.toBe(original)
        expect(record.dbLocator).toContain("-v2-")
        expect((yield* coordinator.searchCode({ query: "survivesCorruption", limit: 10 })).revision?.indexIncarnation).toBe(2)
      }),
    )
    expect(await Bun.file(original).text()).toBe("corrupt-current-database")
  })
})

async function makeHarness(
  stateRoot: string,
  root: string,
  hooks?: { readonly afterCommit: (projectionKind: "code" | "repo_documents") => Effect.Effect<void, never, never> },
) {
  await mkdir(stateRoot, { recursive: true })
  const metadataPath = path.join(stateRoot, "metadata.sqlite")
  const identity = await resolveIdentity(metadataPath, root)
  const database = Database.layerFromPath(metadataPath)
  const coordination = LocationIndexCoordination.layer.pipe(Layer.provide(database))
  const journal = LocationChangeJournal.layer.pipe(Layer.provide(database))
  const commitLock = LocationCommitLock.layer({
    directory: path.join(stateRoot, "commit-locks"),
    timeoutMs: 2_000,
    staleMs: 5_000,
    pollMs: 2,
  })
  const dependencies = Layer.mergeAll(coordination, journal, commitLock)
  const services = layer({
    identity,
    ownerId: "test-writer",
    indexDirectory: path.join(stateRoot, "indexes"),
    hooks,
  }).pipe(Layer.provideMerge(dependencies))
  return {
    identity,
    run: <A, E>(effect: Effect.Effect<A, E, Service | LocationChangeJournal.Service | LocationIndexCoordination.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provide(services), Effect.scoped)),
  }
}

function resolveIdentity(metadataPath: string, root: string): Promise<Identity> {
  const database = Database.layerFromPath(metadataPath)
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* LocationIdentity.Service).resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(root),
        project: { kind: "registered_root" },
      })
    }).pipe(
      Effect.provide(LocationIdentity.layer.pipe(Layer.provideMerge(database), Layer.provide(FSUtil.defaultLayer))),
      Effect.scoped,
    ),
  )
}

function codeLocator(stateRoot: string, identity: Identity) {
  return path.join(
    stateRoot,
    "indexes",
    `${Hash.sha256(`${identity.locationKey}:code`)}-v1.sqlite`,
  )
}
