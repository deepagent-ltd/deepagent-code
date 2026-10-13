export * as GoalPlanRebaseHost from "./goal-plan-rebase"

import { Effect, Option } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { AgentV2 } from "@deepagent-code/core/agent"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { GoalPlanRebase } from "@deepagent-code/core/deepagent/goal-plan-rebase"
import { GoalPlanRebaseSchema } from "@deepagent-code/core/deepagent/goal-plan-rebase.schema"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { GoalPlanRebaseAccess } from "./goal-plan-rebase-access"
import { GoalTickExecution } from "./goal-tick-execution"
import { goalStoreRoot } from "./goal-manager"

const failure = (message: string) => new GoalPlanRebaseSchema.Error({ code: "AUTH_CHANGED", message })
const mapped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) => {
      if (error instanceof GoalPlanRebaseSchema.Error) return error
      const permission = PermissionV2.permissionFailureCode(error)
      if (permission)
        return new GoalPlanRebaseSchema.Error({
          code: permission === "permission_denied_rule" ? "PERMISSION_DENIED" : "APPROVAL_REJECTED",
          message:
            permission === "permission_denied_rule"
              ? "Current parent permission denies this plan edit"
              : "Plan edit approval was declined or corrected",
        })
      if (error instanceof GoalControlSchema.Error)
        return new GoalPlanRebaseSchema.Error({
          code:
            error.code === "not_found"
              ? "NOT_FOUND"
              : error.code === "revision_conflict"
                ? "REVISION_CONFLICT"
                : error.code === "request_conflict"
                  ? "REQUEST_CONFLICT"
                  : error.code === "recovery_required"
                    ? "RECOVERY_REQUIRED"
                    : "TARGET_CONFLICT",
          message: error.message,
        })
      return new GoalPlanRebaseSchema.Error({
        code: "UNAVAILABLE",
        message: "Plan edit authority or durable storage is unavailable",
      })
    }),
  )

const authority = (access: GoalPlanRebaseAccess.Access, sessionID: string, goalID: string) =>
  Effect.gen(function* () {
    yield* GoalPlanRebaseAccess.current(access)
    const db = (yield* Database.Service).db
    const parent = yield* GoalControl.session(db, sessionID)
    yield* GoalPlanRebaseAccess.current(access, { sessionID, goalID, directory: parent.directory,
      ...(parent.workspace_id ? { workspaceID: parent.workspace_id } : {}) })
    yield* GoalControl.requireTarget(db, goalID, sessionID)
    const locations = yield* Effect.serviceOption(LocationServiceMap)
    if (Option.isNone(locations)) return yield* failure("Actual Location services are unavailable")
    const location = locations.value.get({
      directory: AbsolutePath.make(parent.directory),
      ...(parent.workspace_id ? { workspaceID: WorkspaceV2.ID.make(parent.workspace_id) } : {}),
    })
    const captured = yield* Effect.gen(function* () {
      yield* (yield* PluginBoot.Service).wait()
      const agents = yield* AgentV2.Service
      if (!agents.snapshot) return yield* failure("Native Agent roster is unavailable")
      const snapshot = yield* agents.snapshot(parent.agent ?? undefined)
      const permissions = yield* PermissionV2.Service
      return { snapshot, permissions }
    }).pipe(Effect.provide(location))
    const authorize: GoalPlanRebase.Authority = (reader, currentSession, currentGoal) =>
      mapped(
        Effect.gen(function* () {
          yield* GoalPlanRebaseAccess.current(access)
          if (currentSession !== sessionID || currentGoal !== goalID || !AgentV2.snapshotView(captured.snapshot))
            return yield* failure("Plan edit scope or actual Agent roster changed")
          yield* GoalControl.requireTarget(reader, goalID, sessionID)
          const currentParent = yield* GoalControl.session(reader, sessionID)
          yield* GoalPlanRebaseAccess.current(access, { sessionID, goalID, directory: currentParent.directory,
            ...(currentParent.workspace_id ? { workspaceID: currentParent.workspace_id } : {}) })
        }),
      )
    return { db, authorize, location, permissions: captured.permissions, parent }
  })

export const begin = (input: GoalPlanRebaseSchema.Begin, access: GoalPlanRebaseAccess.Access) =>
  mapped(
    Effect.gen(function* () {
      const scoped = yield* authority(access, input.sessionID, input.goalID)
      return yield* GoalPlanRebase.begin(scoped.db, input, scoped.authorize)
    }),
  )

export const get = (
  input: { sessionID: string; goalID: string; editID: string; requestID: string },
  access: GoalPlanRebaseAccess.Access,
) =>
  mapped(
    Effect.gen(function* () {
      const scoped = yield* authority(access, input.sessionID, input.goalID)
      const row = yield* GoalPlanRebase.read(scoped.db, input.editID)
      if (!row || row.goal_id !== input.goalID || row.session_id !== input.sessionID)
        return yield* new GoalPlanRebaseSchema.Error({
          code: "NOT_FOUND",
          message: "Plan edit does not belong to this Goal",
        })
      const response = yield* GoalPlanRebase.response(scoped.db, row, input.requestID, true, scoped.authorize)
      if (!response.current.safeToResume) return response
      const goal = yield* GoalControl.requireTarget(scoped.db, input.goalID, input.sessionID)
      const source = yield* GoalPlanRebase.baseline(scoped.db, goal)
      const unchanged = yield* Effect.try({
        try: () => {
          const store = DocumentStore.openExact(
            goalStoreRoot(input.sessionID),
            source.documents.map((item) => item.id),
          )
          return source.documents.every((item) => store.get(item.id)?.hash === `sha256:${GoalTickProgram.hash(item)}`)
        },
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false))
      return { ...response, current: { ...response.current, safeToResume: unchanged } }
    }),
  )

export const apply = (input: GoalPlanRebaseSchema.Apply, access: GoalPlanRebaseAccess.Access) =>
  mapped(
    Effect.gen(function* () {
      const scoped = yield* authority(access, input.sessionID, input.goalID)
      const row = yield* GoalPlanRebase.read(scoped.db, input.editID)
      if (!row || row.session_id !== input.sessionID || row.goal_id !== input.goalID)
        return yield* new GoalPlanRebaseSchema.Error({ code: "NOT_FOUND", message: "Plan edit target is unavailable" })
      // Historical identity is checked before an approval can be displayed. prepare also checks it in SQL.
      const prior = yield* GoalControl.command(scoped.db, input.sessionID, input.requestID)
      if (prior) {
        const existing = yield* GoalPlanRebase.prepare(
          scoped.db,
          input,
          goalStoreRoot(input.sessionID),
          scoped.authorize,
        )
        return yield* GoalPlanRebase.response(scoped.db, existing.row, input.requestID, true, scoped.authorize)
      }
      const control = yield* GoalPlanRebase.requireCurrent(scoped.db, row, scoped.authorize)
      yield* Effect.try({
        try: () => GoalPlanRebase.requireDocuments(row, goalStoreRoot(input.sessionID), false),
        catch: () =>
          new GoalPlanRebaseSchema.Error({ code: "PLAN_CONFLICT", message: "Goal document changed before approval" }),
      })
      if (!scoped.permissions.authorizeAction || !scoped.permissions.checkAction)
        return yield* failure("Current multi-step permission authority is unavailable")
      const action = {
        sessionID: SessionSchema.ID.make(input.sessionID),
        agent: scoped.parent.agent ? AgentV2.ID.make(scoped.parent.agent) : undefined,
        action: "plan",
        resources: [row.journal.source!.planDocID],
        save: [row.journal.source!.planDocID],
      }
      const permit = yield* scoped.permissions.authorizeAction(action).pipe(Effect.provide(scoped.location))
      const checked: GoalPlanRebase.Authority = (reader, sessionID, goalID) =>
        mapped(
          scoped.authorize(reader, sessionID, goalID).pipe(
            Effect.andThen(() => GoalControl.requireTarget(reader, goalID, sessionID)),
            Effect.flatMap((goal) =>
              goal.revision === control.revision ? Effect.void : failure("Goal control changed after plan approval"),
            ),
            Effect.andThen(() => scoped.permissions.checkAction!(permit, action).pipe(Effect.provide(scoped.location))),
          ),
        )
      yield* GoalPlanRebase.requireCurrent(scoped.db, row, scoped.authorize)
      const prepared = yield* GoalPlanRebase.prepare(scoped.db, input, goalStoreRoot(input.sessionID), checked)
      for (const document of prepared.row.journal.documents)
        yield* GoalPlanRebase.project(
          scoped.db,
          input.editID,
          document.documentID,
          goalStoreRoot(input.sessionID),
          checked,
        )
      const committed = yield* GoalPlanRebase.settle(scoped.db, input.editID, goalStoreRoot(input.sessionID), checked)
      return yield* GoalPlanRebase.response(scoped.db, committed, input.requestID, prepared.replayed, scoped.authorize)
    }).pipe(Effect.scoped),
  )

export const cancel = (input: GoalPlanRebaseSchema.Target, access: GoalPlanRebaseAccess.Access) =>
  mapped(
    Effect.gen(function* () {
      const scoped = yield* authority(access, input.sessionID, input.goalID)
      const response = yield* GoalPlanRebase.cancel(scoped.db, input, scoped.authorize)
      const frames = yield* Effect.serviceOption(GoalTickExecution.Service)
      if (Option.isSome(frames)) yield* frames.value.control(input.goalID, response.current.controlRevision)
      return response
    }),
  )

export const reconcile = (input: GoalPlanRebaseSchema.Target, access: GoalPlanRebaseAccess.Access) =>
  mapped(
    Effect.gen(function* () {
      const scoped = yield* authority(access, input.sessionID, input.goalID)
      const prior = yield* GoalPlanRebase.historical(scoped.db, { action: "reconcile", request: input })
      const row = prior ?? (yield* GoalPlanRebase.read(scoped.db, input.editID))
      if (!row || row.goal_id !== input.goalID || row.session_id !== input.sessionID)
        return yield* new GoalPlanRebaseSchema.Error({ code: "NOT_FOUND", message: "Plan edit target is unavailable" })
      if (row.state === "committed")
        return yield* GoalPlanRebase.response(scoped.db, row, input.requestID, true, scoped.authorize)
      const control = yield* GoalPlanRebase.requireCurrent(scoped.db, row, scoped.authorize)
      if (!scoped.permissions.authorizeAction || !scoped.permissions.checkAction)
        return yield* failure("Current multi-step permission authority is unavailable")
      const action = {
        sessionID: SessionSchema.ID.make(input.sessionID),
        agent: scoped.parent.agent ? AgentV2.ID.make(scoped.parent.agent) : undefined,
        action: "plan",
        resources: [row.journal.source!.planDocID],
        save: [row.journal.source!.planDocID],
      }
      const permit = yield* scoped.permissions.authorizeAction(action).pipe(Effect.provide(scoped.location))
      const checked: GoalPlanRebase.Authority = (reader, sessionID, goalID) =>
        mapped(
          scoped.authorize(reader, sessionID, goalID).pipe(
            Effect.andThen(() => GoalControl.requireTarget(reader, goalID, sessionID)),
            Effect.flatMap((goal) =>
              goal.revision === control.revision
                ? Effect.void
                : failure("Goal control changed after reconciliation approval"),
            ),
            Effect.andThen(() => scoped.permissions.checkAction!(permit, action).pipe(Effect.provide(scoped.location))),
          ),
        )
      const prepared = yield* GoalPlanRebase.reconcile(scoped.db, input, checked)
      for (const document of prepared.row.journal.documents)
        yield* GoalPlanRebase.project(
          scoped.db,
          input.editID,
          document.documentID,
          goalStoreRoot(input.sessionID),
          checked,
        )
      const committed = yield* GoalPlanRebase.settle(scoped.db, input.editID, goalStoreRoot(input.sessionID), checked)
      return yield* GoalPlanRebase.response(scoped.db, committed, input.requestID, prepared.replayed, scoped.authorize)
    }).pipe(Effect.scoped),
  )
