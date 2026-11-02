import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { resolveBrowserLocation } from "../../src/browser/location-binding"

async function run(body: (root: string) => Effect.Effect<void, unknown, LocationIdentity.Service | Database.Service>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-location-binding-")))
  await fs.chmod(root, 0o700)
  const database = Database.layerFromPath(path.join(root, "authority.sqlite"))
  try {
    await Promise.all(["global", "derived", "foreign", "git", "moved"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
    await Effect.runPromise(body(root).pipe(Effect.provide(Layer.mergeAll(database,
      LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer)))), Effect.scoped))
  } finally {
    await fs.rm(root, { recursive: true })
  }
}

test("original global and canonical nongit observers retain their exact current immutable identities", async () => {
  await run((root) => Effect.gen(function* () {
    const identity = yield* LocationIdentity.Service
    const db = (yield* Database.Service).db
    const boundary = { kind: "implicit_local" as const }
    for (const name of ["global", "derived"] as const) {
      const directory = AbsolutePath.make(path.join(root, name))
      const original = yield* identity.resolve({ boundary, directory,
        project: { kind: "registered_root", observedProjectId: name === "global" ? "global" : projectIdForWorkspace(directory) } })
      const before = yield* db.select().from(LocationIdentityTable)
      const beforeProjects = yield* db.select().from(ProjectScopeIdentityTable)
      if (name === "global") {
        // This is the original production request binding that returned the actual 403.
        const old = yield* identity.lookup({ boundary, directory,
          project: { kind: "registered_root", observedProjectId: projectIdForWorkspace(directory) } }).pipe(Effect.flip)
        expect(old).toBeInstanceOf(LocationIdentity.ConflictError)
      }
      expect(yield* resolveBrowserLocation({ identity, directory, projectID: "global", git: false })).toEqual(original)
      expect(yield* db.select().from(LocationIdentityTable)).toEqual(before)
      expect(yield* db.select().from(ProjectScopeIdentityTable)).toEqual(beforeProjects)
    }
  }))
})

test("foreign project observations, changed git identity and moved-root aliases cannot become browser scope", async () => {
  await run((root) => Effect.gen(function* () {
    const identity = yield* LocationIdentity.Service
    const db = (yield* Database.Service).db
    const boundary = { kind: "implicit_local" as const }
    const directory = AbsolutePath.make(path.join(root, "foreign"))
    yield* identity.resolve({ boundary, directory, project: { kind: "registered_root", observedProjectId: "foreign-project" } })
    const before = yield* db.select().from(LocationIdentityTable)
    const foreign = yield* resolveBrowserLocation({ identity, directory, projectID: "global", git: false }).pipe(Effect.flip)
    expect(foreign.code).toBe("BROWSER_SCOPE_DENIED")
    expect(foreign.message).toBe("BROWSER_CREATE_SCOPE_DENIED:location_current")
    expect(yield* db.select().from(LocationIdentityTable)).toEqual(before)
    const nongit = yield* resolveBrowserLocation({ identity, directory, projectID: "foreign-project", git: false }).pipe(Effect.flip)
    expect(nongit.message).toBe("BROWSER_CREATE_SCOPE_DENIED:project_current")

    const gitDirectory = AbsolutePath.make(path.join(root, "git"))
    const git = yield* identity.resolve({ boundary, directory: gitDirectory,
      project: { kind: "git", observedProjectId: "git-original" } })
    expect(yield* resolveBrowserLocation({ identity, directory: gitDirectory, projectID: "git-original", git: true })).toEqual(git)
    expect((yield* resolveBrowserLocation({ identity, directory: gitDirectory,
      projectID: "git-successor", git: true }).pipe(Effect.flip)).code).toBe("BROWSER_SCOPE_DENIED")

    const originalDirectory = AbsolutePath.make(path.join(root, "global"))
    const original = yield* identity.resolve({ boundary, directory: originalDirectory,
      project: { kind: "registered_root", observedProjectId: "global" } })
    yield* identity.migrateLocation({ securityNamespaceId: original.securityNamespaceId, locationKey: original.locationKey,
      nextDirectory: AbsolutePath.make(path.join(root, "moved")), reason: "explicit private fixture move" })
    const aliasBefore = yield* db.select().from(LocationIdentityTable)
    expect((yield* resolveBrowserLocation({ identity, directory: originalDirectory,
      projectID: "global", git: false }).pipe(Effect.flip)).code).toBe("BROWSER_SCOPE_DENIED")
    expect(yield* db.select().from(LocationIdentityTable)).toEqual(aliasBefore)
  }))
})

test("the original lookup still refuses changed namespace, project hash, placement and retirement", async () => {
  await run((root) => Effect.gen(function* () {
    const identity = yield* LocationIdentity.Service
    const db = (yield* Database.Service).db
    const directory = AbsolutePath.make(path.join(root, "global"))
    const original = yield* identity.resolve({ boundary: { kind: "implicit_local" }, directory,
      project: { kind: "registered_root", observedProjectId: "global" } })
    const project = (yield* db.select().from(ProjectScopeIdentityTable))[0]!
    const namespace = (yield* db.select().from(SecurityNamespaceTable))[0]!
    const denied = () => resolveBrowserLocation({ identity, directory, projectID: "global", git: false }).pipe(Effect.flip)
    yield* db.update(ProjectScopeIdentityTable).set({ project_identity_hash: "0".repeat(64) })
      .where(eq(ProjectScopeIdentityTable.project_scope_key, original.projectScopeKey)).run()
    expect((yield* denied()).code).toBe("BROWSER_SCOPE_DENIED")
    yield* db.update(ProjectScopeIdentityTable).set({ project_identity_hash: project.project_identity_hash, retired_at: 1 })
      .where(eq(ProjectScopeIdentityTable.project_scope_key, original.projectScopeKey)).run()
    expect((yield* denied()).code).toBe("BROWSER_SCOPE_DENIED")
    yield* db.update(ProjectScopeIdentityTable).set({ retired_at: null })
      .where(eq(ProjectScopeIdentityTable.project_scope_key, original.projectScopeKey)).run()
    yield* db.update(LocationIdentityTable).set({ workspace_binding: "foreign-workspace" })
      .where(eq(LocationIdentityTable.location_key, original.locationKey)).run()
    expect((yield* denied()).code).toBe("BROWSER_SCOPE_DENIED")
    yield* db.update(LocationIdentityTable).set({ workspace_binding: null, retired_at: 1 })
      .where(eq(LocationIdentityTable.location_key, original.locationKey)).run()
    expect((yield* denied()).code).toBe("BROWSER_SCOPE_DENIED")
    yield* db.update(LocationIdentityTable).set({ retired_at: null })
      .where(eq(LocationIdentityTable.location_key, original.locationKey)).run()
    yield* db.update(SecurityNamespaceTable).set({ retired_at: 1 }).where(eq(SecurityNamespaceTable.id, namespace.id)).run()
    expect((yield* denied()).code).toBe("BROWSER_SCOPE_DENIED")
  }))
})
