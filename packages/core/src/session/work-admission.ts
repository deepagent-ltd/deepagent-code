export * as WorkAdmission from "./work-admission"

import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import { WorkspaceV2 } from "../workspace"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { WorkAuthority } from "./work-authority"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkSessionGuard } from "./work-session-guard"

/** Trusted internal admission only. This service never wakes a Session; the restricted
 * executor and production source/route authorities must be completed before it can run. */
export const admitWithState = Effect.fn("WorkAdmission.admitWithState")(function* (input: {
  readonly binding: unknown
  readonly auditedText: string
  readonly allowLoopbackHTTP?: boolean
}) {
  const db = (yield* Database.Service).db
  const validation = WorkAuthorityPolicy.validateBinding(input.binding, input)
  if (!validation.ok) return yield* validation.error
  const text = WorkAuthorityPolicy.checkAuditedText(validation.value, input.auditedText)
  if (!text.ok) return yield* text.error
  const reserved = yield* WorkAuthority.reserve(db, input)
  return yield* materializeReserved({ workID: reserved.work_id, expectedRevision: reserved.control_revision, auditedText: input.auditedText })
})

/** Reuses a reservation made by an original trusted source; parent placement comes only from
 * its durable derived authority. It cannot adopt an unrestricted Session or wake a runner. */
export const materializeReserved = Effect.fn("WorkAdmission.materializeReserved")(function* (input: {
  readonly workID: string; readonly expectedRevision: number; readonly auditedText: string
}) {
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const sessions = yield* SessionV2.Service
  const work = yield* WorkAuthority.requireAdmission(db, {
    workID: input.workID,
    expectedRevision: input.expectedRevision,
  })
  const text = WorkAuthorityPolicy.checkAuditedText(work.binding, input.auditedText)
  if (!text.ok) return yield* text.error
  const parent = work.parent_work_id ? yield* db.transaction((tx) => Effect.gen(function* () {
    const { WorkDerivedAuthority } = yield* Effect.promise(() => import("./work-derived-authority"))
    yield* WorkDerivedAuthority.requireCurrent(tx, work)
    const authority = yield* WorkDerivedAuthority.get(tx, work.work_id)
    if (!authority) return yield* new WorkAuthoritySchema.Error({ code: "WORK_AUTHORITY_MISSING", message: "Original node authority is absent" })
    return authority.parentSessionID
  }), { behavior: "immediate" }) : undefined
  yield* sessions
    .create({
      id: SessionSchema.ID.make(work.session_id),
      ...(parent ? { parentID: SessionSchema.ID.make(parent) } : {}),
      title: "Restricted work",
      agent: AgentV2.ID.make(work.binding.agentID),
      model: ModelV2.Ref.make({
        id: ModelV2.ID.make(work.binding.provider.modelID),
        providerID: ProviderV2.ID.make(work.binding.provider.providerID),
      }),
      permissions: [],
      location: {
        directory: AbsolutePath.make(work.binding.location.directory),
        // An omitted workspace remains implicit-local; it is never invented from the scope ID.
        ...(work.binding.location.workspaceID === undefined
          ? {}
          : { workspaceID: WorkspaceV2.ID.make(work.binding.location.workspaceID) }),
      },
    })
    .pipe(
      Effect.provideService(WorkSessionGuard.CurrentAdmission, {
        workID: work.work_id,
        bindingHash: work.binding_hash,
      }),
    )
  const expected = {
    id: SessionMessage.ID.make(work.input_id),
    sessionID: SessionSchema.ID.make(work.session_id),
    prompt: new Prompt({ text: input.auditedText }),
    delivery: "queue" as const,
  }
  const state = { becameReady: false }
  const bind = (seq: number) =>
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const previous = yield* WorkAuthority.get(db, work.work_id)
          yield* WorkAuthority.bindInputInTransaction(tx, {
            workID: work.work_id,
            sessionID: work.session_id,
            inputID: work.input_id,
            promptHash: work.binding.auditedText.hash,
            admittedSeq: seq,
            expectedRevision: work.control_revision,
          })
          if (work.parent_work_id && work.binding.profile.id === WorkAuthorityPolicy.EVENT_DAG_PROFILE.id) {
            const { EventWorkNodeAuthority } = yield* Effect.promise(() => import("../deepagent/event-work-node-authority"))
            yield* EventWorkNodeAuthority.bindReadyInTransaction(tx, work).pipe(Effect.mapError(() =>
              new WorkAuthoritySchema.Error({ code: "WORK_REVOKED", message: "Original event node changed before input commit" })))
          }
          if (!work.parent_work_id && work.source_kind === "server_rule" && work.authority_id.startsWith("evwork_")) {
            const { EventWorkAdmission } = yield* Effect.promise(() => import("../deepagent/event-work-admission"))
            yield* EventWorkAdmission.bindReadyInTransaction(tx, work).pipe(Effect.mapError(() =>
              new WorkAuthoritySchema.Error({ code: "WORK_REVOKED", message: "Original event Work source changed before input commit" })))
          }
          if (previous?.admission_state === "reserved") state.becameReady = true
        }),
      { behavior: "immediate" },
    )
  const admitted = yield* SessionInput.admit(db, events, { ...expected, commit: bind }).pipe(
    Effect.catchDefect((defect) => {
      if (defect instanceof WorkAuthoritySchema.Error) return Effect.fail(defect)
      if (defect instanceof EventV2.CommitHookError && defect.cause instanceof WorkAuthoritySchema.Error)
        return Effect.fail(defect.cause)
      return Effect.die(defect)
    }),
  )
  if (!SessionInput.equivalent(admitted, expected))
    return yield* new WorkAuthoritySchema.Error({
      code: "WORK_BINDING_CONFLICT",
      message: "The durable Work input differs from its audited request",
    })
  // Existing-input reconciliation does not invoke the commit hook. Revalidate it explicitly,
  // including live authority and control revision; a failed hook cannot become a blind retry.
  yield* bind(admitted.admittedSeq)
  return { input: admitted, becameReady: state.becameReady }
})

export const admitOnly = (input: Parameters<typeof admitWithState>[0]) =>
  admitWithState(input).pipe(Effect.map((result) => result.input))
