export * as RestrictedSelectionFixture from "./restricted-selection"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { FSUtil } from "../../src/fs-util"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { LocationIdentity } from "../../src/context-federation/identity"
import { ProductionV2Sources, type ProductionV2AdapterInput } from "../../src/context-federation/production-adapters"
import { SessionContext } from "../../src/context-federation/session-context"
import { SessionExecution } from "../../src/session/execution"
import { SessionInput } from "../../src/session/input"
import { SessionProjector } from "../../src/session/projector"
import { SessionSchema } from "../../src/session/schema"
import { SessionStore } from "../../src/session/store"
import { SessionRunnerCanonical } from "../../src/session/runner/canonical-turn"
import { WorkAdmission } from "../../src/session/work-admission"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { WorkAuthorityFixture } from "./work-authority"
import { projectLayer } from "./project-layer"

export type Services =
  | Database.Service
  | SessionContext.Service
  | SessionV2.Service
  | EventV2.Service
  | FSUtil.Service
  | Scope.Scope
export type State = { sources: number; filesystem: number }
export type Fixture = { binding: WorkAuthoritySchema.Binding; identity: LocationIdentity.Identity; state: State }

export async function isolated<A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, Services>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-restricted-selection-")))
  const directory = path.join(root, "project")
  await fs.mkdir(directory)
  const database = WorkAuthorityFixture.database(path.join(root, "authority.sqlite"))
  await Effect.runPromise(WorkAuthorityFixture.initialize().pipe(Effect.provide(database), Effect.scoped))
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(Layer.mergeAll(database, events, store, SessionExecution.noopLayer, projectLayer(database))),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(Layer.mergeAll(events, database)))
  const contexts = SessionContext.layer.pipe(
    Layer.provide(Layer.mergeAll(database, SessionRunnerCanonical.degradedArtifactStore)),
  )
  const identities = LocationIdentity.layer.pipe(Layer.provide(Layer.mergeAll(database, FSUtil.defaultLayer)))
  const services = Layer.mergeAll(
    database,
    events,
    sessions,
    projector,
    contexts,
    identities,
    FSUtil.defaultLayer,
    WorkAuthorityFixture.verifier,
  )
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* (yield* LocationIdentity.Service).resolve({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(directory),
          project: { kind: "registered_root", observedProjectId: "global" },
        })
        const base = WorkAuthorityFixture.binding("restricted-selection")
        const binding = {
          ...base,
          location: { directory },
          scope: {
            ...base.scope,
            securityNamespaceID: identity.securityNamespaceId,
            projectScopeKey: identity.projectScopeKey,
          },
          deadline: Date.now() + 120_000,
        }
        return yield* body({ binding, identity, state: { sources: 0, filesystem: 0 } })
      }).pipe(Effect.provide(services), Effect.scoped),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

export const admit = Effect.fn("RestrictedSelectionFixture.admit")(function* (fixture: Fixture, promote = true) {
  yield* WorkAdmission.admitOnly({ binding: fixture.binding, auditedText: WorkAuthorityFixture.TEXT })
  if (promote)
    yield* SessionInput.promoteNextQueued(
      (yield* Database.Service).db,
      yield* EventV2.Service,
      SessionSchema.ID.make(fixture.binding.sessionID),
    )
})

export const select = Effect.fn("RestrictedSelectionFixture.select")(function* (
  fixture: Fixture,
  patch: Partial<{ workID: string; expectedRevision: number; sessionID: SessionSchema.ID }> = {},
) {
  const fs = yield* FSUtil.Service
  const sources = new Proxy<ProductionV2AdapterInput>(
    {},
    {
      get() {
        fixture.state.sources++
        throw new Error("Restricted selection accessed production sources")
      },
    },
  )
  return yield* SessionRunnerCanonical.admitRestrictedSelection({
    db: (yield* Database.Service).db,
    contexts: yield* SessionContext.Service,
    sessionID: SessionSchema.ID.make(fixture.binding.sessionID),
    workID: fixture.binding.workID,
    expectedRevision: 1,
    ...patch,
  }).pipe(
    Effect.provideService(ProductionV2Sources, sources),
    Effect.provideService(
      FSUtil.Service,
      new Proxy(fs, {
        get() {
          fixture.state.filesystem++
          throw new Error("Restricted selection accessed filesystem")
        },
      }),
    ),
  )
})

export const facts = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const tables = [
    "session_activity_admission",
    "session_activity",
    "session_activity_input",
    "session_context_selection",
    "session_context_validation",
    "session_context_epoch",
    "session_provider_attempt",
    "session_v2_provider_turn_receipt",
  ]
  return yield* Effect.forEach(tables, (table) =>
    db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`)).pipe(Effect.map((rows) => ({ table, rows }))),
  )
})
