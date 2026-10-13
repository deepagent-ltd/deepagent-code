export * as EventInvestigationHost from "./event-investigation"

import { Context, Effect, Layer, Option } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { EventInvestigation } from "@deepagent-code/core/deepagent/event-investigation"
import { EventInvestigationPolicy } from "@deepagent-code/core/deepagent/event-investigation-policy"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventInvestigationEvidence } from "@/installation/event-investigation-evidence"
import { ProductionWorkExecution } from "@/installation/work-execution-profile"
import { NativeRuntime } from "@/installation/native-runtime"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { WorkAdmission } from "@deepagent-code/core/session/work-admission"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { EventV2Bridge } from "@/event-v2-bridge"

const unavailable = () =>
  new EventInvestigationSchema.Error({
    code: "INVESTIGATION_UNAVAILABLE",
    message: "Current same-root investigation evidence or native authority is unavailable",
  })

/** Private construction from the existing Root services. This layer has no model resolver,
 * provider client, runner, database fallback or process owner of its own. */
export const make = Effect.gen(function* () {
  const work = yield* Effect.serviceOption(ProductionWorkExecution.Service)
  const native = yield* Effect.serviceOption(EventValidation.Native)
  const database = yield* Effect.serviceOption(Database.Service)
  const sessions = yield* Effect.serviceOption(SessionV2.Service)
  const execution = yield* Effect.serviceOption(SessionExecution.Service)
  const events = yield* Effect.serviceOption(EventV2Bridge.Service)
  const owner = { active: true }
  const grants = new WeakMap<
    EventInvestigation.GrantCapture,
    {
      readiness: NativeRuntime.PurposeReadiness
      inputHash: string
      expiresAt: number
    }
  >()
  const failures = new WeakMap<
    EventInvestigation.FailureCapture,
    {
      readiness: NativeRuntime.PurposeReadiness
      evidence: EventInvestigation.FailureEvidence
      expiresAt: number
    }
  >()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      owner.active = false
    }),
  )
  const required = Effect.gen(function* () {
    if (!owner.active || Option.isNone(work) || Option.isNone(native)) return yield* unavailable()
    return { work: work.value, native: native.value }
  })
  const current = (readiness: NativeRuntime.PurposeReadiness, expiresAt: number) =>
    owner.active && expiresAt > Date.now() && Option.isSome(work) && work.value.investigationTargetCurrent(readiness)
  const investigationNative = EventInvestigation.Native.of({
    approveGrant: Effect.fn("EventInvestigationHost.approveGrant")(function* (input) {
      const services = yield* required
      const readiness = yield* services.work.approveInvestigationTarget(input)
      if (!owner.active) return yield* unavailable()
      const capture = Object.freeze(Object.create(null)) as EventInvestigation.GrantCapture
      grants.set(capture, {
        readiness,
        inputHash: EventValidation.hash(input),
        expiresAt: Math.min(Date.now() + 60_000, input.expiresAt),
      })
      return capture
    }),
    approvedGrant: (capture, input) => {
      const grant = typeof capture === "object" && capture !== null ? grants.get(capture) : undefined
      return !!grant && current(grant.readiness, grant.expiresAt) && grant.inputHash === EventValidation.hash(input)
    },
    observeFailure: Effect.fn("EventInvestigationHost.observeFailure")(function* (input) {
      const services = yield* required
      const readiness = yield* services.work.approveInvestigationTarget({
        rule: input.rule,
        targetID: input.grant.targetID,
        target: input.grant.target,
        principal: input.grant.principal,
        expiresAt: input.grant.expiresAt,
      })
      const observation = yield* services.native.observe(input.rule.configuration).pipe(Effect.mapError(unavailable))
      const content = services.native.content(observation, input.rule.configuration)
      if (
        !content ||
        content.contentHash !== input.run.contentHash ||
        EventValidation.hash(content.files) !== EventValidation.hash(input.run.content.files) ||
        !current(readiness, input.grant.expiresAt)
      )
        return yield* unavailable()
      const evidence = yield* Effect.try({
        try: () =>
          EventInvestigationEvidence.build(
            input.rule,
            input.run,
            input.grant.target.toolPolicy.fileScope.read.map((rule) => rule.path),
          ),
        catch: unavailable,
      })
      const capture = Object.freeze(Object.create(null)) as EventInvestigation.FailureCapture
      failures.set(capture, { readiness, evidence, expiresAt: Math.min(Date.now() + 10_000, input.grant.expiresAt) })
      return capture
    }),
    failure: (capture) => {
      const failure = typeof capture === "object" && capture !== null ? failures.get(capture) : undefined
      return failure && current(failure.readiness, failure.expiresAt) ? structuredClone(failure.evidence) : undefined
    },
  })
  const admission = Effect.gen(function* () {
    const services = yield* required
    if (Option.isNone(database) || Option.isNone(sessions) || Option.isNone(execution) || Option.isNone(events))
      return yield* unavailable()
    const operator = yield* services.work.investigationAuthority
    return {
      ...services,
      operator,
      database: database.value,
      sessions: sessions.value,
      execution: execution.value,
      events: events.value,
    }
  })
  const controlled = Effect.gen(function* () {
    if (!owner.active || Option.isNone(database) || Option.isNone(execution)) return yield* unavailable()
    return { database: database.value, execution: execution.value }
  })
  const admit = Effect.fn("EventInvestigationHost.admit")(function* (
    reserved: Effect.Success<ReturnType<typeof EventInvestigation.acceptFailureAndReserve>>,
    services: Effect.Success<typeof admission>,
  ) {
    if (reserved.work.admission_state === "ready") return { ...reserved, becameReady: false }
    const admitted = yield* WorkAdmission.admitWithState({
      binding: reserved.binding,
      auditedText: reserved.receipt.auditedText,
    }).pipe(
      Effect.provideService(Database.Service, services.database),
      Effect.provideService(SessionV2.Service, services.sessions),
      Effect.provideService(EventV2.Service, services.events),
      Effect.provideService(WorkAuthority.Verifier, services.work.verifier),
    )
    if (admitted.becameReady) yield* services.execution.wake(SessionSchema.ID.make(reserved.receipt.sessionID))
    return { ...reserved, becameReady: admitted.becameReady }
  })
  const accept = Effect.fn("EventInvestigationHost.accept")(function* (input: { ruleID: string; runID: string }) {
    const services = yield* admission
    const reserved = yield* EventInvestigation.acceptFailureAndReserve(services.database.db, input).pipe(
      Effect.provideService(EventInvestigation.Native, investigationNative),
      Effect.provideService(LocalOperator.Runtime, services.operator),
      Effect.provideService(WorkAuthority.Verifier, services.work.verifier),
    )
    return yield* admit(reserved, services)
  })
  return {
    native: investigationNative,
    accept,
    onKnownFailure: (run: EventValidationSchema.RunRecord) =>
      accept({ ruleID: run.ruleID, runID: run.runID }).pipe(Effect.asVoid),
    capture: (input: Parameters<typeof EventInvestigation.captureGrant>[1]) =>
      Effect.gen(function* () {
        const services = yield* controlled
        return yield* EventInvestigation.captureGrant(services.database.db, input).pipe(
          Effect.provideService(EventInvestigation.Native, investigationNative),
        )
      }),
    control: (
      input: Parameters<typeof EventInvestigation.enableAuthority>[1],
      capture?: EventInvestigation.GrantCapture,
    ) =>
      Effect.gen(function* () {
        const services = yield* controlled
        const result = yield* EventInvestigation.enableAuthority(services.database.db, input, capture).pipe(
          Effect.provideService(EventInvestigation.Native, investigationNative),
        )
        yield* Effect.forEach(
          result.interruptedSessionIDs,
          (sessionID) => services.execution.interrupt(SessionSchema.ID.make(sessionID)),
          { discard: true },
        )
        return result
      }),
    postRuleControl: (ruleID: string) =>
      Effect.gen(function* () {
        const services = yield* controlled
        let afterReceiptID: string | undefined
        while (owner.active) {
          const page = yield* EventInvestigation.readRevokedSessionPage(services.database.db, {
            ruleID,
            afterReceiptID,
          })
          yield* Effect.forEach(
            page.sessionIDs,
            (sessionID) => services.execution.interrupt(SessionSchema.ID.make(sessionID)),
            { discard: true },
          )
          if (page.nextReceiptID === null) return
          if (afterReceiptID !== undefined && page.nextReceiptID <= afterReceiptID) return yield* unavailable()
          afterReceiptID = page.nextReceiptID
        }
      }),
    reconcile: Effect.gen(function* () {
      const services = yield* admission
      const candidates = yield* EventInvestigation.readReconcileCandidates(services.database.db).pipe(
        Effect.provideService(LocalOperator.Runtime, services.operator),
      )
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            if (candidate.kind === "failure") {
              yield* accept({ ruleID: candidate.ruleID, runID: candidate.runID })
              return
            }
            const receipt = candidate.receipt
            const ready = yield* services.database.db
              .transaction((tx) => EventInvestigation.requireColdWake(tx, EventInvestigationPolicy.bindingFor(receipt)))
              .pipe(
                Effect.provideService(LocalOperator.Runtime, services.operator),
                Effect.provideService(WorkAuthority.Verifier, services.work.verifier),
              )
            if (ready.work.admission_state === "reserved") {
              yield* admit({ ...ready, replayed: true }, services)
              return
            }
            yield* services.work.profile.preflight(ready.work)
            yield* services.execution.wake(SessionSchema.ID.make(receipt.sessionID))
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Investigation Work remains unstarted", {
                code: error instanceof EventInvestigationSchema.Error ? error.code : "INVESTIGATION_UNAVAILABLE",
              }),
            ),
          ),
        { discard: true },
      )
    }),
  }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()(
  "@deepagent-code/EventInvestigationHost",
) {}
export const layer = Layer.effect(Service, make)
