import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { FSUtil } from "../../src/fs-util"
import { AbsolutePath } from "../../src/schema"
import { LocationIdentity } from "../../src/context-federation/identity"
import { LocationIndexCoordination } from "../../src/context-federation/coordination"
import { IndexSpaceID } from "../../src/context-federation/reference"
import { LocationIndexCoordinationTable } from "../../src/context-federation/sql"
import { tmpdir } from "../fixture/tmpdir"

describe("Location identity and persistent index coordination", () => {
  test("isolates security namespaces and Project.global roots while sharing a git project scope", async () => {
    await using tmp = await tmpdir()
    const roots = await makeRoots(tmp.path, ["worktree-a", "worktree-b", "plain-a", "plain-b"])

    await run(
      Effect.gen(function* () {
        const identities = yield* LocationIdentity.Service
        const local = { kind: "implicit_local" as const }
        const tenantA = { kind: "workspace" as const, tenantId: "tenant-a", workspaceId: "workspace" }
        const tenantB = { kind: "workspace" as const, tenantId: "tenant-b", workspaceId: "workspace" }
        const gitA = yield* identities.resolve({
          boundary: local,
          directory: AbsolutePath.make(roots["worktree-a"]),
          project: { kind: "git", observedProjectId: "project-stable" },
        })
        const gitB = yield* identities.resolve({
          boundary: local,
          directory: AbsolutePath.make(roots["worktree-b"]),
          project: { kind: "git", observedProjectId: "project-stable" },
        })
        expect(gitB.projectScopeKey).toBe(gitA.projectScopeKey)
        expect(gitB.locationKey).not.toBe(gitA.locationKey)
        expect(gitB.indexSpaceId).not.toBe(gitA.indexSpaceId)

        const plainA = yield* identities.resolve({
          boundary: local,
          directory: AbsolutePath.make(roots["plain-a"]),
          project: { kind: "registered_root", observedProjectId: "global" },
        })
        const plainB = yield* identities.resolve({
          boundary: local,
          directory: AbsolutePath.make(roots["plain-b"]),
          project: { kind: "registered_root", observedProjectId: "global" },
        })
        expect(plainB.projectScopeKey).not.toBe(plainA.projectScopeKey)

        const scopedA = yield* identities.resolve({
          boundary: tenantA,
          directory: AbsolutePath.make(roots["worktree-a"]),
          project: { kind: "git", observedProjectId: "project-stable" },
        })
        const scopedB = yield* identities.resolve({
          boundary: tenantB,
          directory: AbsolutePath.make(roots["worktree-a"]),
          project: { kind: "git", observedProjectId: "project-stable" },
        })
        expect(scopedA.securityNamespaceId).not.toBe(scopedB.securityNamespaceId)
        expect(scopedA.locationKey).not.toBe(scopedB.locationKey)
        expect(scopedA.projectScopeKey).not.toBe(scopedB.projectScopeKey)

        const separatorA = yield* identities.resolveNamespace({
          kind: "workspace",
          tenantId: "a:b",
          workspaceId: "c",
        })
        const separatorB = yield* identities.resolveNamespace({
          kind: "workspace",
          tenantId: "a",
          workspaceId: "b:c",
        })
        expect(separatorA).not.toBe(separatorB)

        const repeated = yield* identities.resolve({
          boundary: local,
          directory: AbsolutePath.make(roots["worktree-a"]),
          project: { kind: "git", observedProjectId: "project-stable" },
        })
        expect(repeated).toEqual(gitA)
      }),
    )
  })

  test("preserves Location and Project scope identity only through explicit verified migrations", async () => {
    await using tmp = await tmpdir()
    const roots = await makeRoots(tmp.path, ["old-root", "new-root", "new-worktree", "legacy-worktree"])

    await run(
      Effect.gen(function* () {
        const identities = yield* LocationIdentity.Service
        const boundary = { kind: "workspace" as const, tenantId: "tenant", workspaceId: "workspace" }
        const original = yield* identities.resolve({
          boundary,
          directory: AbsolutePath.make(roots["old-root"]),
          project: { kind: "git", observedProjectId: "old-project-id" },
        })
        const moved = yield* identities.migrateLocation({
          securityNamespaceId: original.securityNamespaceId,
          locationKey: original.locationKey,
          nextDirectory: AbsolutePath.make(roots["new-root"]),
          reason: "verified filesystem move",
        })
        expect(moved.locationKey).toBe(original.locationKey)
        expect(moved.projectScopeKey).toBe(original.projectScopeKey)
        expect(moved.canonicalRoot).toBe(AbsolutePath.make(roots["new-root"]))

        yield* identities.migrateProjectIdentity({
          securityNamespaceId: original.securityNamespaceId,
          projectScopeKey: original.projectScopeKey,
          nextObservedProjectId: "new-project-id",
          reason: "verified remote identity correction",
        })
        const corrected = yield* identities.resolve({
          boundary,
          directory: AbsolutePath.make(roots["new-worktree"]),
          project: { kind: "git", observedProjectId: "new-project-id" },
        })
        const legacyAlias = yield* identities.resolve({
          boundary,
          directory: AbsolutePath.make(roots["legacy-worktree"]),
          project: { kind: "git", observedProjectId: "old-project-id" },
        })
        expect(corrected.projectScopeKey).toBe(original.projectScopeKey)
        expect(legacyAlias.projectScopeKey).toBe(original.projectScopeKey)

        const otherNamespace = yield* identities.resolveNamespace({
          kind: "workspace",
          tenantId: "other-tenant",
          workspaceId: "workspace",
        })
        const denied = yield* identities
          .migrateLocation({
            securityNamespaceId: otherNamespace,
            locationKey: original.locationKey,
            nextDirectory: AbsolutePath.make(roots["old-root"]),
            reason: "cross-namespace attempt",
          })
          .pipe(Effect.flip)
        expect(denied._tag).toBe("LocationIdentity.NotFoundError")
      }),
    )
  })

  test("keeps fencing and incarnation monotonic across takeover and database replacement", async () => {
    await using tmp = await tmpdir()
    const roots = await makeRoots(tmp.path, ["repository"])

    await run(
      Effect.gen(function* () {
        const identity = yield* (yield* LocationIdentity.Service).resolve({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(roots.repository),
          project: { kind: "registered_root" },
        })
        const coordination = yield* LocationIndexCoordination.Service
        const forged = yield* coordination
          .ensure({
            identity: { ...identity, indexSpaceId: IndexSpaceID.make("forged-index-space") },
            projectionKind: "code",
            dbLocator: "derived/forged.sqlite",
            now: 0,
          })
          .pipe(Effect.flip)
        expect(forged._tag).toBe("LocationIndexCoordination.InvalidIdentityError")
        const initial = yield* coordination.ensure({
          identity,
          projectionKind: "code",
          dbLocator: "derived/code-v1.sqlite",
          now: 0,
        })
        expect(initial).toMatchObject({ indexIncarnation: 1, fencingToken: 0 })

        const first = yield* coordination.acquire({
          identity,
          projectionKind: "code",
          ownerId: "writer-a",
          leaseMs: 10,
          now: 0,
        })
        expect(first.fencingToken).toBe(1)
        const held = yield* coordination
          .acquire({ identity, projectionKind: "code", ownerId: "writer-b", leaseMs: 10, now: 5 })
          .pipe(Effect.flip)
        expect(held._tag).toBe("LocationIndexCoordination.LeaseHeldError")

        const takeover = yield* coordination.acquire({
          identity,
          projectionKind: "code",
          ownerId: "writer-b",
          leaseMs: 10,
          now: 11,
        })
        expect(takeover.fencingToken).toBe(2)
        const stale = yield* coordination
          .replaceDatabase({ lease: first, dbLocator: "derived/stale.sqlite", now: 12 })
          .pipe(Effect.flip)
        expect(stale._tag).toBe("LocationIndexCoordination.StaleWriterError")

        const replaced = yield* coordination.replaceDatabase({
          lease: takeover,
          dbLocator: "derived/code-v2.sqlite",
          now: 12,
        })
        expect(replaced).toMatchObject({ indexIncarnation: 2, fencingToken: 3, dbLocator: "derived/code-v2.sqlite" })
        const repeatedEnsure = yield* coordination.ensure({
          identity,
          projectionKind: "code",
          dbLocator: "derived/must-not-reset.sqlite",
          now: 13,
        })
        expect(repeatedEnsure).toMatchObject({
          indexIncarnation: 2,
          fencingToken: 3,
          dbLocator: "derived/code-v2.sqlite",
        })

        const documents = yield* coordination.ensure({
          identity,
          projectionKind: "repo_documents",
          dbLocator: "derived/documents-v1.sqlite",
          now: 13,
        })
        expect(documents).toMatchObject({ indexIncarnation: 1, fencingToken: 0 })

        const db = (yield* Database.Service).db
        const rows = yield* db.select().from(LocationIndexCoordinationTable).all().pipe(Effect.orDie)
        expect(rows).toHaveLength(2)
      }),
    )
  })
})

async function makeRoots(base: string, names: readonly string[]) {
  const entries = await Promise.all(
    names.map(async (name) => {
      const directory = path.join(base, name)
      await fs.mkdir(directory, { recursive: true })
      return [name, await fs.realpath(directory)] as const
    }),
  )
  return Object.fromEntries(entries) as Record<string, string>
}

function run<A>(
  effect: Effect.Effect<A, unknown, LocationIdentity.Service | LocationIndexCoordination.Service | Database.Service>,
) {
  const database = Database.layerFromPath(":memory:")
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer)),
          LocationIndexCoordination.layer.pipe(Layer.provide(database)),
          database,
        ),
      ),
      Effect.scoped,
    ),
  )
}
