export * as EventWorkManagementHost from "./event-work-management"

import { Context, Effect, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventWorkManagement } from "@deepagent-code/core/deepagent/event-work-management"
import { EventWorkSource } from "@deepagent-code/core/deepagent/event-work-source"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { Service } from "@/installation/work-execution-profile"

type Management = Effect.Success<ReturnType<typeof EventWorkManagement.make>>
type Candidates = ReturnType<Management["candidates"]>

/** Capture the production Root once. HTTP supplies the authenticated operator and actual routed
 * Location on each call; neither a Session hint nor an installed service mints a mutation witness. */
export const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const locations = yield* LocationServiceMap
  const execution = yield* SessionExecution.Service
  const installed = yield* Effect.serviceOption(Service)
  const withVerifier = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isSome(installed)
      ? effect.pipe(Effect.provideService(WorkAuthority.Verifier, installed.value.verifier))
      : Effect.fail(EventWorkSource.failure("EVENT_WORK_UNAVAILABLE"))
  const interrupt = <A extends { interruptedSessionIDs: readonly string[] }, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const result = yield* withVerifier(effect)
      // This follows the committed control receipt. Interruption never admits another input or
      // asserts a provider stopped; the process-global original coordinator owns that fact.
      yield* Effect.forEach(result.interruptedSessionIDs, (id) => execution.interrupt(SessionSchema.ID.make(id)), { discard: true })
      return result
    })
  const open = Effect.fn("EventWorkManagementHost.open")(function* (input: {
    readonly sourceSessionID: string
    readonly directory: string
    readonly workspaceID?: string
  }) {
    if (Option.isNone(installed)) return yield* EventWorkSource.failure("EVENT_WORK_UNAVAILABLE")
    const session = yield* database.db.select().from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(input.sourceSessionID))).get()
      .pipe(Effect.mapError(() => EventWorkSource.failure("EVENT_WORK_UNAVAILABLE")))
    if (!session || !session.v2_authority || session.time_archived !== null || session.directory !== input.directory ||
      session.workspace_id !== (input.workspaceID ?? null)) return yield* EventWorkSource.failure("EVENT_WORK_AUTH_REQUIRED")
    const context = yield* locations.contextEffect({ directory: AbsolutePath.make(input.directory),
      ...(input.workspaceID ? { workspaceID: WorkspaceV2.ID.make(input.workspaceID) } : {}) })
    const location = Context.get(context, Location.Service)
    if (location.directory !== session.directory || (location.workspaceID ?? null) !== session.workspace_id || location.project.id !== session.project_id)
      return yield* EventWorkSource.failure("EVENT_WORK_AUTH_REQUIRED")
    const management = yield* EventWorkManagement.make(database.db, { sourceSessionID: session.id })
      .pipe(Effect.provideService(Location.Service, location))
    return {
      candidates: (): Effect.Effect<Effect.Success<Candidates>, Effect.Error<Candidates>, Exclude<Effect.Services<Candidates>, WorkAuthority.Verifier>> =>
        withVerifier(management.candidates()),
      rules: (input: Parameters<typeof management.rules>[0]) => withVerifier(management.rules(input)),
      roots: (input: Parameters<typeof management.roots>[0]) => withVerifier(management.roots(input)),
      ruleControl: (input: Parameters<typeof management.ruleControl>[0]) => interrupt(management.ruleControl(input)),
      rootControl: (input: Parameters<typeof management.rootControl>[0]) => interrupt(management.rootControl(input)),
      session: (input: Parameters<typeof management.session>[0]) => withVerifier(management.session(input)),
    }
  })
  return { open }
})
export type Interface = Effect.Success<typeof make>
