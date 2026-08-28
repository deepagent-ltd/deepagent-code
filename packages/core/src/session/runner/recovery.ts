export * as SessionProviderRecovery from "./recovery"

// C1B-01/02 — unified `SessionProviderRecovery` V2 recovery service + five-class descriptor.
//
// Design authority: docs/core-v2.0-beta/design.md §9 (provider unknown result &
// maintenance recovery: descriptor / command / evidence / safe exits; no automatic
// replay), §2.2 (durable receipt before dispatch; indeterminate is never auto-replayed),
// §2.3 (exact retry identity). Frozen contract: contract/recovery-command.ts (C0-02 —
// the discriminated union + request-hash semantics are AUTHORITATIVE and read-only).
//
// C1B-01: the single production resolve entry for a session's provider-unknown /
// indeterminate state. The legacy session_tool_request_receipt / prompt-epoch recovery
// path is reachable ONLY through the adapter, and the adapter never commits a successor
// epoch.
// C1B-02: the five-class descriptor (exact / repairable / fork / coordination / resolved)
// mapped onto the frozen contract vocabulary (resolvable_exact / repairable_exact /
// fork_only / coordination_required / resolved), each with the user exit + least-privilege
// permission requirement.
// C1B-04: `abandonExact` — abandon a classified `exact` attempt in ONE transaction with
// the command/evidence store's CAS semantics, with the network-unknown query-command-first
// refusal and same-tx-or-nothing crash behavior.
//
// Command / evidence store semantics live in ./recovery-store (C1B-03); this service owns
// the single-writer serialize + classify + authorize + command-record path.

import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { RecoveryCommandContract } from "../../contract/recovery-command"
import type {
  AbandonRecord,
  AbandonTransactionOutcome,
  AttemptIdentity,
  CommandRecord,
  CommandWriteOutcome,
  EvidenceRecord,
  RecoveryStoreState,
} from "./recovery-store"
import {
  abandonAttemptKey,
  abandonTransaction,
  commandCas,
  commandsOf,
  emptyRecoveryStoreState,
  evidenceOf,
  recoveryCommandContentAddress,
} from "./recovery-store"

// Re-export the store's value functions so consumers reach them through the service namespace.
export {
  abandonAttemptKey,
  abandonTransaction,
  commandCas,
  emptyRecoveryStoreState,
  recoveryCommandContentAddress,
} from "./recovery-store"

// ---------------------------------------------------------------------------
// Attempt identity (C2-04 protocol identity where present)
// ---------------------------------------------------------------------------

export type { AttemptIdentity }

/** The five descriptor classes, mapped onto the frozen contract vocabulary. */
export type DescriptorKind = RecoveryCommandContract.RecoveryDescriptorKind

// ---------------------------------------------------------------------------
// User exit + least-privilege permission requirement (design §9.1, §9.3)
// ---------------------------------------------------------------------------

/** The actionable exit a recovery descriptor presents to a user. */
export const DescriptorAction = {
  resolvable_exact: "abandon",
  repairable_exact: "repair",
  fork_only: "fork",
  coordination_required: "coordinate",
  resolved: "refresh",
} as const
export type DescriptorAction = (typeof DescriptorAction)[keyof typeof DescriptorAction]

/**
 * Least-privilege permission required to invoke an exit. `abandon` of a verifiable
 * attempt is user-grade; `repair` (writes a reconstructed baseline) and `coordinate`
 * (export evidence / external authority) are administrator-grade; `fork` and `refresh`
 * are user-grade (design §9.3). The typed refusal never mutates state.
 */
export const DescriptorPermission = {
  resolvable_exact: "user",
  repairable_exact: "administrator",
  fork_only: "user",
  coordination_required: "administrator",
  resolved: "user",
} as const
export type DescriptorPermission = (typeof DescriptorPermission)[keyof typeof DescriptorPermission]

/** The user exit available for a descriptor class. */
export function exitFor(kind: DescriptorKind): DescriptorAction {
  return DescriptorAction[kind]
}

/** The permission required to invoke the exit for a descriptor class. */
export function requiredPermissionFor(kind: DescriptorKind): DescriptorPermission {
  return DescriptorPermission[kind]
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionProviderRecovery.NotFoundError", {}) {}
export class MismatchError extends Schema.TaggedErrorClass<MismatchError>()("SessionProviderRecovery.MismatchError", {
  reason: Schema.String,
}) {}
export class CasLostError extends Schema.TaggedErrorClass<CasLostError>()("SessionProviderRecovery.CasLostError", {
  reason: Schema.String,
}) {}
export class PermissionDeniedError extends Schema.TaggedErrorClass<PermissionDeniedError>()(
  "SessionProviderRecovery.PermissionDeniedError",
  { required: Schema.String, granted: Schema.String },
) {}
export class AdapterOutOfAuthorityError extends Schema.TaggedErrorClass<AdapterOutOfAuthorityError>()(
  // The typed result for invoking the legacy adapter: the adapter is a read-only
  // historical reader with no execution authority (design §2.1) and therefore can never
  // commit a successor epoch. Reaching this beyond read-only classification is a caller
  // defect, not a path.
  "SessionProviderRecovery.AdapterOutOfAuthorityError",
  { reason: Schema.String },
) {}
export class RecoveryDecodeError extends Schema.TaggedErrorClass<RecoveryDecodeError>()(
  "SessionProviderRecovery.RecoveryDecodeError",
  { message: Schema.String },
) {}
/**
 * Typed refusal for the network-unknown abandon path: a settled/terminal
 * provider evidence already exists for the request, so the attempt may have
 * dispatched and produced a result — the user is NOT offered abandon and is
 * pointed to confirm-settled instead (design §9.1 / §11.3 query-command-first).
 */
export class RefuseAbandonWithTerminalEvidenceError extends Schema.TaggedErrorClass<RefuseAbandonWithTerminalEvidenceError>()(
  "SessionProviderRecovery.RefuseAbandonWithTerminalEvidenceError",
  { evidenceRef: Schema.String, requestHash: Schema.String },
) {}
/** Typed refusal for a transaction that was torn by a crash/simulated fault: no state was committed. */
export class RecoveryTransactionAbortedError extends Schema.TaggedErrorClass<RecoveryTransactionAbortedError>()(
  "SessionProviderRecovery.RecoveryTransactionAbortedError",
  { operation: Schema.String },
) {}

export type Error =
  | NotFoundError
  | MismatchError
  | CasLostError
  | PermissionDeniedError
  | AdapterOutOfAuthorityError
  | RecoveryDecodeError
  | RefuseAbandonWithTerminalEvidenceError
  | RecoveryTransactionAbortedError

export type {
  AbandonRecord,
  AbandonTransactionOutcome,
  CommandRecord,
  CommandWriteOutcome,
  EvidenceRecord,
  RecoveryStoreState,
}

// ---------------------------------------------------------------------------
// Evidence store statuses — typed (pending / external / settled)
// ---------------------------------------------------------------------------

import type { EvidenceStatus } from "./recovery-store"
export type { EvidenceStatus }

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Everything the classifier needs to produce the frozen descriptor. Missing
 * verification is never fabricated: if a baseline hash / history hash is absent the
 * descriptor falls to `coordination_required` (or `fork_only` when a proven safe
 * boundary exists) rather than inventing a committed baseline (design §9.1).
 */
export type ClassifyInput = {
  readonly attempt: AttemptIdentity
  readonly attemptState: string
  readonly expectedAttemptState: string
  readonly ownerToken: string
  readonly expectedVersion: number
  readonly baseline?: {
    readonly baselineHash?: string
    readonly sourceSnapshotRef?: string
    readonly state?: "present" | "corrupt" | "missing"
    readonly verified: boolean
  }
  readonly safeBoundary?: {
    readonly safeBoundaryRef?: string
    readonly safeBoundaryHash?: string
  }
  readonly historyVerified: boolean
  readonly providerLookupComplete: boolean
  readonly placementUnresolved: boolean
  readonly permissionIncomplete: boolean
  readonly workspaceConflict: boolean
  readonly resolution?: {
    readonly resolutionRef: string
    readonly bridgeRef: string
    readonly terminal: RecoveryCommandContract.RecoveryTerminal
  }
}

function casTokens(input: ClassifyInput): RecoveryCommandContract.RecoveryCasTokens {
  return {
    expectedState: input.expectedAttemptState,
    expectedVersion: input.expectedVersion,
    ownerToken: input.ownerToken,
  }
}

function provenanceOf(input: ClassifyInput): RecoveryCommandContract.RecoveryProvenance {
  const sourceRefs: string[] = [input.attempt.attemptId]
  if (input.attempt.protocol) sourceRefs.push(`protocol:${input.attempt.protocol}`)
  return { origin: "recorded", sourceRefs }
}

function baselineOf(input: ClassifyInput): RecoveryCommandContract.RecoveryBaselineRef {
  return {
    ...(input.baseline?.baselineHash ? { baselineHash: input.baseline.baselineHash } : {}),
    ...(input.baseline?.sourceSnapshotRef ? { sourceSnapshotRef: input.baseline.sourceSnapshotRef } : {}),
    verified: input.baseline?.verified ?? false,
  }
}

function bridgeOf(input: ClassifyInput): RecoveryCommandContract.RecoveryTerminalBridge {
  if (!input.resolution) return { bridgeId: "none", bridgeType: "none" }
  return {
    bridgeId: input.resolution.bridgeRef,
    bridgeType: "terminal_bridge",
    terminalRef: input.resolution.terminal,
  }
}

/**
 * Synthesize a `RecoveryDescriptor` for an attempt. Pure and deterministic; the same
 * snapshot always yields the same descriptor. The five classes map exactly onto the
 * frozen contract vocabulary.
 *
 * Mapping (design §9.1 → contract vocabulary):
 *   exact        → `resolvable_exact`
 *   repairable   → `repairable_exact`
 *   fork         → `fork_only`
 *   coordination → `coordination_required`
 *   resolved     → `resolved`
 */
export function classify(input: ClassifyInput): RecoveryCommandContract.RecoveryDescriptor {
  if (input.resolution) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "resolved",
      resolved: {
        resolutionRef: input.resolution.resolutionRef,
        bridgeRef: input.resolution.bridgeRef,
        terminal: input.resolution.terminal,
      },
    }
  }

  const baselineState = input.baseline?.state ?? "present"
  const verifiable =
    input.baseline?.verified === true &&
    Boolean(input.baseline.baselineHash) &&
    input.historyVerified &&
    input.providerLookupComplete &&
    !input.placementUnresolved &&
    !input.permissionIncomplete &&
    !input.workspaceConflict

  if (baselineState === "present" && verifiable) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "resolvable_exact",
      exact: {
        attemptHash: input.attempt.projectionHash,
        selectionHash: input.attempt.selectionId,
        historyHash: input.baseline?.baselineHash ?? input.attempt.requestHash,
        baselineHash: input.baseline?.baselineHash ?? input.attempt.requestHash,
        allVerified: true,
      },
    }
  }

  if ((baselineState === "missing" || baselineState === "corrupt") && input.baseline?.sourceSnapshotRef) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "repairable_exact",
      repairable: {
        baselineState,
        sourceSnapshotRef: input.baseline.sourceSnapshotRef,
        canReconstruct: true,
      },
    }
  }

  if (input.safeBoundary?.safeBoundaryRef) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "fork_only",
      fork: {
        safeBoundaryRef: input.safeBoundary.safeBoundaryRef,
        safeBoundaryHash: input.safeBoundary.safeBoundaryHash ?? "",
        reasonCode: "safe_boundary_none",
        originalSessionReadOnly: true,
      },
    }
  }

  return {
    schemaVersion: "recovery-descriptor.v1",
    requestHash: input.attempt.requestHash,
    provenance: provenanceOf(input),
    baseline: baselineOf(input),
    terminalBridge: bridgeOf(input),
    casTokens: casTokens(input),
    descriptorKind: "coordination_required",
    coordination: {
      reason: coordinateReason(input),
      requiredActor: "admin",
      ...(input.baseline?.sourceSnapshotRef ? { evidenceExportRef: input.baseline.sourceSnapshotRef } : {}),
    },
  }
}

/** Pick the most specific frozen reason code for a coordination descriptor. */
function coordinateReason(input: ClassifyInput): RecoveryCommandContract.RecoveryReasonCode {
  if (input.baseline === undefined || input.baseline.state === "missing")
    return "baseline_missing" as RecoveryCommandContract.RecoveryReasonCode
  if (input.baseline.state === "corrupt") return "baseline_corrupt" as RecoveryCommandContract.RecoveryReasonCode
  if (!input.baseline.verified) return "history_unverified" as RecoveryCommandContract.RecoveryReasonCode
  if (!input.providerLookupComplete) return "provider_lookup_incomplete" as RecoveryCommandContract.RecoveryReasonCode
  if (input.placementUnresolved) return "placement_unresolved" as RecoveryCommandContract.RecoveryReasonCode
  if (input.permissionIncomplete) return "permission_incomplete" as RecoveryCommandContract.RecoveryReasonCode
  if (input.workspaceConflict) return "workspace_conflict" as RecoveryCommandContract.RecoveryReasonCode
  if (!input.safeBoundary) return "safe_boundary_none" as RecoveryCommandContract.RecoveryReasonCode
  return "unsupported_state" as RecoveryCommandContract.RecoveryReasonCode
}

// ---------------------------------------------------------------------------
// Permission guard
// ---------------------------------------------------------------------------

/** Typed permission refusal: the actor lacks the permission for the exit; no mutation. */
export function assertPermission(
  actor: { readonly type: "user" | "administrator" | "system" },
  required: DescriptorPermission,
): Effect.Effect<void, PermissionDeniedError> {
  const granted = actor.type === "administrator" ? "administrator" : actor.type === "user" ? "user" : "system"
  if (actor.type === "system") return Effect.fail(new PermissionDeniedError({ required, granted }))
  if (required === "administrator" && actor.type !== "administrator")
    return Effect.fail(new PermissionDeniedError({ required, granted }))
  return Effect.void
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ResolveInput = {
  readonly sessionId: string
  readonly attemptId: string
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly expectedAttemptState: string
  readonly ownerToken: string
  readonly expectedVersion: number
  readonly baseline?: ClassifyInput["baseline"]
  readonly safeBoundary?: ClassifyInput["safeBoundary"]
  readonly historyVerified?: boolean
  readonly providerLookupComplete?: boolean
  readonly placementUnresolved?: boolean
  readonly permissionIncomplete?: boolean
  readonly workspaceConflict?: boolean
}

export type ResolveOutcome = {
  readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
  readonly commandId: string
  readonly author: { readonly actorType: "user" | "administrator" | "system"; readonly actorId: string }
}

/** C1B-04 input: abandon a classified `exact` attempt. */
export type AbandonExactInput = {
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly reasonCode: RecoveryCommandContract.RecoveryReasonCode
  /** Test seam: inject a crash at a commit boundary to prove same-tx or nothing. */
  readonly fault?: { readonly at: "after_command_stage" }
}

export interface Interface {
  /** Classify a single attempt into the five-class frozen descriptor (pure). */
  readonly classify: (input: ClassifyInput) => RecoveryCommandContract.RecoveryDescriptor
  /**
   * Single production resolve entry. Serialized per (session, attempt) so two concurrent
   * resolves return the SAME typed result with one classify and one command write. Never
   * replays a provider request (design §2.2).
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<ResolveOutcome, Error>
  /** Record a recovery command; concurrent same-attempt writes serialize & CAS. */
  readonly recordCommand: (input: {
    readonly requestHash: string
    readonly attemptIdentity: AttemptIdentity
  }) => Effect.Effect<CommandWriteOutcome, Error>
  /** Read a command record by content address. */
  readonly getCommand: (commandId: string) => Effect.Effect<CommandRecord | undefined>
  /**
   * Query a prior command / evidence by exact request hash + attempt identity
   * WITHOUT creating a new command (design §9.2 query_command). The network
   * unknown flow's FIRST step: if a settled/terminal evidence exists for the
   * request, abandon is refused (see `abandonExact`).
   */
  readonly queryCommand: (input: {
    readonly requestHash: string
    readonly attemptIdentity: AttemptIdentity
  }) => Effect.Effect<{ readonly command?: CommandRecord; readonly evidence: readonly EvidenceRecord[] }>
  /** Read the abandon record for an attempt (typed absent/undefined if never abandoned). */
  readonly queryAbandon: (attemptIdentity: AttemptIdentity) => Effect.Effect<AbandonRecord | undefined>
  /**
   * C1B-04: abandon a classified `exact` attempt, recording the abandon decision,
   * the terminal receipt and the command — ALL in one transaction with the
   * store's CAS semantics (one command wins; CAS-lost -> typed existing/conflict).
   * Same-transaction or nothing: a crash mid-abandon commits no half-state. An
   * already-abandoned attempt with the same request hash -> typed `existing`
   * (exact retry never duplicates / no double effect). The network-unknown path
   * is refused when a settled/terminal evidence already exists.
   */
  readonly abandonExact: (input: AbandonExactInput) => Effect.Effect<AbandonTransactionOutcome, Error>
  /** Evidence store: typed statuses (pending / external / settled); body is C1B-08. */
  readonly evidence: {
    readonly recordStatus: (input: {
      readonly evidenceRef: string
      readonly status: EvidenceStatus
      readonly providerId?: string
      readonly requestHash?: string
      readonly payloadHash?: string
    }) => Effect.Effect<void, Error>
    readonly getStatus: (evidenceRef: string) => Effect.Effect<EvidenceRecord | undefined>
  }
  /** Legacy adapter: read-only historical reader, never a successor-epoch writer. */
  readonly adapter: {
    readonly classifyLegacy: (input: { readonly receiptId: string }) => {
      readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
      readonly outOfAuthority: true
    }
  }
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionProviderRecovery") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Single-writer CAS authority over the composite recovery store. One permit
    // serializes every command write, resolve and recovery transaction (design §2.1 —
    // no distributed owner before clustering). All domains a transaction mutates
    // (commands, evidence, abandons) live in one state so a crash commits all-or-nothing.
    const store = yield* Ref.make(emptyRecoveryStoreState())
    const lock = yield* Semaphore.make(1)
    const resolveCache = yield* Ref.make(new Map<string, ResolveOutcome>())

    const resolve = Effect.fn("SessionProviderRecovery.resolve")(function* (input: ResolveInput) {
      const key = `${input.sessionId}:${input.attemptId}`
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          const cached = yield* Ref.get(resolveCache)
          if (cached.has(key)) return cached.get(key)!
          const outcome = yield* resolveOnce(input)
          yield* Ref.update(resolveCache, (map) => new Map(map).set(key, outcome))
          return outcome
        }),
      )
    })

    // Immutable-command write helper. All mutation of the composite store is
    // serialized by `lock`, and a transaction commits by swapping a fully-built
    // next state (see abandonExact) so a crash can never leave a torn half-application.
    const setCommand = (state: RecoveryStoreState, commandId: string, record: CommandRecord): Effect.Effect<void> =>
      Ref.set(store, { ...state, commands: new Map(state.commands).set(commandId, record) })

    const resolveOnce = (input: ResolveInput): Effect.Effect<ResolveOutcome, Error> =>
      Effect.gen(function* () {
        const descriptor = classify({
          attempt: input.attemptIdentity,
          attemptState: "indeterminate_after_crash",
          expectedAttemptState: input.expectedAttemptState,
          ownerToken: input.ownerToken,
          expectedVersion: input.expectedVersion,
          ...(input.baseline ? { baseline: input.baseline } : {}),
          ...(input.safeBoundary ? { safeBoundary: input.safeBoundary } : {}),
          historyVerified: input.historyVerified ?? true,
          providerLookupComplete: input.providerLookupComplete ?? true,
          placementUnresolved: input.placementUnresolved ?? false,
          permissionIncomplete: input.permissionIncomplete ?? false,
          workspaceConflict: input.workspaceConflict ?? false,
        })
        const state = yield* Ref.get(store)
        const write = commandCas(commandsOf(state), {
          requestHash: input.requestHash,
          attemptIdentity: input.attemptIdentity,
        })
        if (write.status === "recorded") yield* setCommand(state, write.commandId, write.record)
        return {
          descriptor,
          commandId: write.commandId,
          author: { actorType: input.actor.type, actorId: input.actor.id },
        }
      })

    const recordCommand = Effect.fn("SessionProviderRecovery.recordCommand")(function* (input: {
      readonly requestHash: string
      readonly attemptIdentity: AttemptIdentity
    }) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(store)
          const write = commandCas(commandsOf(state), input)
          if (write.status === "recorded") yield* setCommand(state, write.commandId, write.record)
          return write
        }),
      )
    })

    const getCommand = Effect.fn("SessionProviderRecovery.getCommand")(function* (commandId: string) {
      const state = yield* Ref.get(store)
      return commandsOf(state).get(commandId)
    })

    const evidence = {
      recordStatus: Effect.fn("SessionProviderRecovery.evidence.recordStatus")(function* (input: {
        readonly evidenceRef: string
        readonly status: EvidenceStatus
        readonly providerId?: string
        readonly requestHash?: string
        readonly payloadHash?: string
      }) {
        const record: EvidenceRecord = {
          evidenceRef: input.evidenceRef,
          status: input.status,
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.requestHash ? { requestHash: input.requestHash } : {}),
          ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
          recordedAt: Date.now(),
        }
        const state = yield* Ref.get(store)
        yield* Ref.set(store, { ...state, evidence: new Map(state.evidence).set(input.evidenceRef, record) })
      }),
      getStatus: (evidenceRef: string) => Effect.map(Ref.get(store), (state) => evidenceOf(state).get(evidenceRef)),
    }

    const adapter: { readonly classifyLegacy: (input: { readonly receiptId: string }) => {
      readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
      readonly outOfAuthority: true
    } } = {
      classifyLegacy: (input: { readonly receiptId: string }) => {
        // Legacy receipts are read-only historical evidence. The adapter is out of
        // authority: it only classifies (always to `coordination` — legacy provenance can
        // never be proven locally) and never writes a successor epoch.
        return {
          descriptor: classify({
            attempt: {
              sessionId: "",
              attemptId: input.receiptId,
              activityId: "",
              providerTurnSeq: 0,
              selectionId: "",
              projectionHash: "",
              requestHash: "",
              providerId: "",
            },
            attemptState: "indeterminate_after_crash",
            expectedAttemptState: "indeterminate_after_crash",
            ownerToken: "",
            expectedVersion: 0,
            historyVerified: false,
            providerLookupComplete: false,
            placementUnresolved: false,
            permissionIncomplete: false,
            workspaceConflict: false,
          }),
          outOfAuthority: true,
        }
      },
    }

    const queryCommand = Effect.fn("SessionProviderRecovery.queryCommand")(function* (input: {
      readonly requestHash: string
      readonly attemptIdentity: AttemptIdentity
    }) {
      const state = yield* Ref.get(store)
      const address = recoveryCommandContentAddress({
        requestHash: input.requestHash,
        attemptIdentity: input.attemptIdentity,
      })
      return {
        command: commandsOf(state).get(address),
        // Evidence is matched by exact request hash (query-by-hash). A settled/terminal
        // evidence is the "may have dispatched" signal that blocks abandon (design §9.1).
        evidence: [...evidenceOf(state).values()].filter((e) => e.requestHash === input.requestHash),
      }
    })

    const queryAbandon = Effect.fn("SessionProviderRecovery.queryAbandon")(function* (attemptIdentity: AttemptIdentity) {
      const state = yield* Ref.get(store)
      return state.abandons.get(abandonAttemptKey(attemptIdentity))
    })

    const abandonExact = Effect.fn("SessionProviderRecovery.abandonExact")(function* (input: AbandonExactInput) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          // Least-privilege exit: abandon of a verifiable attempt is user-grade.
          yield* assertPermission(input.actor, requiredPermissionFor("resolvable_exact"))
          const state = yield* Ref.get(store)
          // Network-unknown-after-dispatch: the FIRST step is query-command. If a
          // settled/terminal provider evidence exists the attempt may have dispatched and
          // produced a result, so the user is NOT offered abandon (design §11.3 / §9.2).
          const terminal = [...evidenceOf(state).values()].find(
            (e) => e.requestHash === input.requestHash && e.status === "settled",
          )
          if (terminal) {
            return yield* Effect.fail(
              new RefuseAbandonWithTerminalEvidenceError({
                evidenceRef: terminal.evidenceRef,
                requestHash: input.requestHash,
              }),
            )
          }
          const tx = abandonTransaction(
            state,
            {
              requestHash: input.requestHash,
              attemptIdentity: input.attemptIdentity,
              actorType: input.actor.type,
              actorId: input.actor.id,
              reasonCode: input.reasonCode,
            },
            input.fault,
          )
          if (tx.status === "aborted") {
            return yield* Effect.fail(new RecoveryTransactionAbortedError({ operation: "abandon_exact" }))
          }
          // Same-transaction or nothing: only a committed transaction swaps the store.
          yield* Ref.set(store, tx.state)
          return tx.outcome
        }),
      )
    })

    return Service.of({
      classify,
      resolve,
      recordCommand,
      getCommand,
      queryCommand,
      queryAbandon,
      abandonExact,
      evidence,
      adapter,
    })
  }),
)
