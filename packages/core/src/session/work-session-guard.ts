export * as WorkSessionGuard from "./work-session-guard"

import { eq, sql } from "drizzle-orm"
import { Context, Effect, Option } from "effect"
import type { Database } from "../database/database"
import type { Location } from "../location"
import type { ModelV2 } from "../model"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkExecutionTable } from "./work-authority.sql"
import { WorkAuthority } from "./work-authority"
import { WorkExecutionProfile } from "./work-execution-profile"
import { WorkRoutePolicy } from "./work-route-policy"

type Db = Database.Interface["db"]

/** Only the internal admit-only service supplies this marker, after trusted reservation.
 * HTTP/plugin payloads and Session metadata cannot opt into the restricted execution lane. */
export const CurrentAdmission = Context.Reference<{ workID: string; bindingHash: string } | undefined>(
  "@deepagent-code/WorkSessionGuard/CurrentAdmission",
  { defaultValue: () => undefined },
)

/** Keep bound work and receipt-backed legacy work out of ordinary mutation/execution. A missing
 * binding is not ordinary authority. Metadata alone remains neither a grant nor a denial marker. */
export const requireOrdinary = Effect.fn("WorkSessionGuard.requireOrdinary")(function* (
  db: Pick<Db, "all" | "select">,
  sessionID: string,
) {
  const bound = yield* db
    .all<{ work_id: string }>(
      sql`
    WITH RECURSIVE lineage(id, parent_id) AS (
      SELECT ${sessionID}, parent_id FROM session WHERE id = ${sessionID}
      UNION SELECT s.id, s.parent_id FROM session s JOIN lineage p ON s.id = p.parent_id
    )
    SELECT work_id FROM work_execution WHERE session_id = ${sessionID}
      OR session_id IN (SELECT id FROM lineage) LIMIT 1
  `,
    )
    .pipe(Effect.orDie)
  if (bound.length > 0)
    return yield* new WorkAuthoritySchema.Error({
      code: "PROFILE_UNAVAILABLE",
      message: "Bound work requires its restricted execution profile; ordinary Session execution is unavailable",
    })
  const found = yield* WorkAuthority.lookupSession(db, sessionID)
  if (found.kind === "legacy_unbound")
    return yield* new WorkAuthoritySchema.Error({
      code: "WORK_AUTHORITY_MISSING",
      message: "Legacy event work has no trusted execution binding",
    })
  // A binding may have appeared after the ancestor read outside a write transaction.
  if (found.kind === "bound")
    return yield* new WorkAuthoritySchema.Error({
      code: "PROFILE_UNAVAILABLE",
      message: "Bound work requires its restricted execution profile; ordinary Session execution is unavailable",
    })
})

/** Process-local coordinator and direct runner use the same current-authority preflight. Public
 * Session mutations retain requireOrdinary: installing a profile does not make a Work writable.
 * Descendants cannot inherit the restricted lane merely by sharing a bound ancestor. */
export const requireExecution = Effect.fn("WorkSessionGuard.requireExecution")(function* (
  db: Db,
  sessionID: string,
  options?: { readonly prepareSource?: boolean },
) {
  const bound = yield* db
    .select()
    .from(WorkExecutionTable)
    .where(eq(WorkExecutionTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!bound) {
    // This also checks durable EventAdmission, IM intent and actual DAG lineage. Do not let
    // absent work_execution rows route historical work into the ordinary runner.
    yield* requireOrdinary(db, sessionID)
    return
  }
  if (bound.execution_role === "dag_controller")
    return yield* new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "Event controller trace has no agent execution authority" })
  const profile = yield* Effect.serviceOption(WorkExecutionProfile.Service)
  const evidence = yield* Effect.serviceOption(WorkRoutePolicy.Evidence)
  if (Option.isNone(profile) || Option.isNone(evidence))
    return yield* new WorkAuthoritySchema.Error({
      code: "PROFILE_UNAVAILABLE",
      message: "Trusted restricted execution and route/count evidence are not installed",
    })
  // Native/reader preparation must occur outside SQL. Event commit hooks consume the still-fresh
  // witness only; reacquiring the reader lock while holding SQL reverses its background lock order.
  if (options?.prepareSource !== false) yield* WorkExecutionProfile.prepareSource(bound)
  yield* profile.value.preflight(bound)
  const work = yield* WorkAuthority.requireContext(db, { sessionID }).pipe(
    Effect.catch((error) => (error instanceof WorkAuthoritySchema.Error ? Effect.fail(error) : Effect.die(error))),
  )
  if (!work || work.binding.location.workspaceID !== undefined)
    return yield* new WorkAuthoritySchema.Error({
      code: "PROFILE_UNAVAILABLE",
      message: "Restricted execution requires a current implicit-local Work",
    })
  yield* WorkExecutionProfile.requirePlacement(db, work).pipe(
    Effect.mapError((error) =>
      error instanceof WorkAuthoritySchema.Error
        ? error
        : new WorkAuthoritySchema.Error({
            code: "PROFILE_UNAVAILABLE",
            message: "Current Work placement authority is unavailable",
          }),
    ),
  )
  return work
})

export const requireCreation = Effect.fn("WorkSessionGuard.requireCreation")(function* (
  db: Db,
  input: {
    readonly id?: string
    readonly parentID?: string
    readonly agent?: string
    readonly model?: ModelV2.Ref
    readonly permissions?: readonly unknown[]
    readonly metadata?: unknown
    readonly location: Location.Ref
  },
) {
  if (!input.id) {
    if (input.parentID) yield* requireOrdinary(db, input.parentID)
    return
  }
  const work = yield* db
    .select()
    .from(WorkExecutionTable)
    .where(eq(WorkExecutionTable.session_id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (!work) {
    if (input.parentID) yield* requireOrdinary(db, input.parentID)
    return
  }
  const admission = yield* CurrentAdmission
  const parent = work.parent_work_id ? yield* db.transaction((tx) => Effect.gen(function* () {
    const { WorkDerivedAuthority } = yield* Effect.promise(() => import("./work-derived-authority"))
    yield* WorkDerivedAuthority.requireCurrent(tx, work)
    return yield* WorkDerivedAuthority.get(tx, work.work_id)
  }), { behavior: "immediate" }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die),
    Effect.catchTag("SqlError", Effect.die)) : undefined
  if (
    admission?.workID !== work.work_id ||
    admission.bindingHash !== work.binding_hash ||
    input.parentID !== parent?.parentSessionID ||
    input.metadata !== undefined ||
    (input.permissions?.length ?? 0) !== 0 ||
    input.location.directory !== work.binding.location.directory ||
    input.location.workspaceID !== work.binding.location.workspaceID ||
    input.agent !== work.binding.agentID ||
    input.model?.providerID !== work.binding.provider.providerID ||
    input.model?.id !== work.binding.provider.modelID ||
    input.model.variant !== undefined
  )
    return yield* new WorkAuthoritySchema.Error({
      code: "WORK_BINDING_CONFLICT",
      message: "Reserved Work Session creation requires the matching internal admission and immutable placement",
    })
})
