export * as GoalOwnedLoop from "./goal-owned-loop"

import { Effect, Schema } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { GoalChildPolicy } from "@deepagent-code/core/deepagent/goal-child-policy"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { GoalTickState } from "@deepagent-code/core/deepagent/goal-tick-state"
import { GoalPlanRebase } from "@deepagent-code/core/deepagent/goal-plan-rebase"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { DeepAgentPlanStore } from "@deepagent-code/core/deepagent/plan-store"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { InstanceStore } from "../project/instance-store"
import { InstanceRef } from "../effect/instance-ref"
import { LSP } from "../lsp/lsp"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { ReviewResult, ReviewFinding } from "../agent/schema/orchestration"
import { PanelLens, PanelOpinion, DEFAULT_QUORUM_POLICY } from "../agent/schema/panel"
import { GoalTickExecution } from "./goal-tick-execution"
import { GoalOwnedTurn } from "./goal-owned-turn"
import { GoalTickProjection } from "./goal-tick-projection"
import { evaluateForController } from "@deepagent-code/core/deepagent/goal-loop"
import { renderPanelistPrompt, opinionFromReview } from "../panel/panelist-runner"
import { arbitrate } from "../panel/arbiter"

export const Review = Schema.Struct({
  ...ReviewResult.fields,
  findings: Schema.Array(
    Schema.Struct({
      ...ReviewFinding.fields,
      file: Schema.String.check(Schema.isMaxLength(512)),
      summary: Schema.String.check(Schema.isMaxLength(1024)),
      failureScenario: Schema.String.check(Schema.isMaxLength(2048)),
      suggestion: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
      confidence: Schema.Number.check(
        Schema.isFinite(),
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(1),
      ),
    }),
  ).check(Schema.isMaxLength(32)),
})
const workerRecipe =
  "owned-goal-worker-v2. Work only the frozen parent plan. Your plan tool writes your own scratch proposal. Keep every step_id and acceptance unchanged. Parent completion is decided by the controller using independent evidence."
const failure = (message: string) => new GoalControlSchema.Error({ code: "recovery_required", message })

/** Prepare immutable source/roster/program bytes before any role or local effect. The actual SQL
 * begin operation reserves every encoded slot and freezes the steering cutoff afterwards. */
export const prepare = (input: { permitID: string; directory: string }) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const source = yield* GoalTickCheckpoint.currentPermit(db, input.permitID)
    const initialization = source.goal.initialization
    if (initialization.executionContract !== "owned-goal-v2" || !initialization.ownedPreparation)
      return yield* failure("Owned Goal has no versioned initial document source")
    const preparation = initialization.ownedPreparation
    const parent = yield* GoalControl.session(db, source.goal.session_id)
    const docs = yield* Effect.try({
      try: () => {
        const store = DocumentStore.openExact(
          input.directory,
          preparation.documents.map((item) => item.documentID),
        )
        return preparation.documents.map((item) => {
          const doc = store.get(item.documentID)
          if (!doc || doc.scope !== `run:${parent.id}`) throw failure("Goal document source changed scope")
          return Schema.decodeUnknownSync(GoalTickProgram.DocumentPayload)(
            Object.fromEntries(Object.entries(doc).filter(([key]) => key !== "hash")),
          )
        })
      },
      catch: () => failure("Goal exact document source is unavailable"),
    })
    const baseline = yield* GoalPlanRebase.baseline(db, source.goal)
    if (baseline.documents.length !== docs.length || docs.some((doc) =>
      !baseline.documents.some((item) => item.id === doc.id && GoalTickProgram.canonical(item) === GoalTickProgram.canonical(doc))))
      return yield* failure("Prior verified Goal projection changed; source differs from its committed structural lineage")
    const planDoc = docs.find((doc) => doc.id === source.goal.plan_doc_id)
    const plan = planDoc ? DeepAgentPlanStore.decodePlanDoc(planDoc.body) : null
    const stateDoc = docs.find((doc) => doc.id === `doc:run_context:${source.goal.goal_id}`)
    if (!planDoc || !plan || plan.session_id !== parent.id || !stateDoc)
      return yield* failure("Goal plan or runtime identity is unavailable")
    const state = yield* Effect.try({
      try: () =>
        GoalTickState.requireState(
          Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(stateDoc.body),
        ),
      catch: () => failure("Goal complete state is malformed"),
    })
    if (
      state.goalId !== source.goal.goal_id ||
      state.sessionId !== parent.id ||
      state.ledger.ticks !== source.permit.tick_seq ||
      planDoc.version !== source.permit.plan_version ||
      GoalControl.fingerprint(state.spec) !== GoalControl.fingerprint(initialization.spec)
    )
      return yield* failure("Goal state does not match its admitted tick frontier")
    const lenses = yield* Effect.try({
      try: () => preparation.panel.lenses.map((lens) => Schema.decodeUnknownSync(PanelLens)(lens)),
      catch: () => failure("Goal panel lens is unsupported"),
    })
    const rounds = preparation.panel.maxRounds ?? 3
    const definitions: Array<Pick<GoalTickProgram.Role, "kind" | "criterion" | "round" | "lens">> = [
      { kind: "worker", criterion: null, round: null, lens: null },
      ...initialization.spec.criteria.flatMap((criterion, index) =>
        criterion.kind === "reviewer_clean"
          ? [{ kind: "reviewer" as const, criterion: index, round: null, lens: null }]
          : [],
      ),
      ...initialization.spec.criteria.flatMap((criterion, index) =>
        criterion.kind === "panel_approves"
          ? Array.from({ length: rounds }, (_, round) =>
              lenses.map((_, lens) => ({ kind: "panel" as const, criterion: index, round, lens })),
            ).flat()
          : [],
      ),
    ]
    const locations = yield* LocationServiceMap
    const roles = yield* Effect.gen(function* () {
      yield* (yield* PluginBoot.Service).wait()
      const agents = yield* AgentV2.Service
      if (!agents.snapshot) return yield* failure("Actual native Agent roster is unavailable")
      const parentAgent = yield* agents.snapshot(parent.agent ?? undefined)
      return yield* Effect.forEach(definitions, (definition, index) =>
        Effect.gen(function* () {
          const agent =
            definition.kind === "worker" ? "goal-worker" : definition.kind === "reviewer" ? "reviewer" : "researcher"
          const child = yield* agents.snapshot!(agent)
          const view = AgentV2.snapshotView(child)
          const policyHash = GoalChildPolicy.roleHash(parentAgent, child)
          if (!policyHash || view?.role?.kind !== definition.kind || view.role.version !== "owned-goal-v2")
            return yield* failure("Role has no trusted native roster registration")
          const key = `${definition.kind}.${index}`
          const unitHash = GoalControl.fingerprint([source.permit.permit_id, key])
          const childID = `ses_goalchild_${unitHash.slice(0, 40)}`
          const scratch =
            definition.kind !== "worker"
              ? undefined
              : GoalTickProgram.canonical({
                  ...planDoc,
                  id: `doc:plan:plan-${childID}`,
                  scope: `run:${childID}`,
                  version: 1,
                  superseded_by: null,
                  description: DeepAgentPlanStore.planDescription(childID),
                  provenance: { source: "runner", run_ref: `run:${childID}` },
                  links: [],
                  body: JSON.stringify({ ...plan, session_id: childID, plan_id: `plan_${unitHash}` }),
                })
          const role: GoalTickProgram.Role = {
            ...definition,
            key,
            agent: view.info.id,
            ordinal: index,
            mode: definition.kind === "worker" ? "plain" : "structured",
            policyHash,
            recipe: {
              id:
                definition.kind === "worker"
                  ? "goal-worker-v2"
                  : definition.kind === "reviewer"
                    ? "goal-reviewer-v2"
                    : "goal-panel-v2",
              hash: GoalTickProgram.hash({
                version: 2,
                workerRecipe,
                initializationHash: source.goal.initialization_hash,
                stateHash: GoalTickProgram.hash(state),
                planHash: GoalTickProgram.hash(planDoc),
                panel: preparation.panel,
                definition,
              }),
              schemaHash: GoalControl.fingerprint(
                definition.kind === "worker" ? { type: "string" } : Schema.toJsonSchemaDocument(Review),
              ),
              dependencies: Array.from({ length: index }, (_, prior) => prior),
            },
            ...(scratch === undefined
              ? {}
              : {
                  scratch: {
                    documentID: `doc:plan:plan-${childID}`,
                    payload: scratch,
                    payloadHash: GoalTickProgram.hash(scratch),
                    parentDocumentID: planDoc.id,
                    parentVersion: planDoc.version,
                    parentHash: GoalTickProgram.hash(planDoc),
                    criteriaHash: GoalControl.fingerprint(initialization.spec.criteria),
                  },
                }),
          }
          return role
        }),
      )
    }).pipe(
      Effect.provide(
        locations.get({
          directory: AbsolutePath.make(parent.directory),
          ...(parent.workspace_id ? { workspaceID: WorkspaceV2.ID.make(parent.workspace_id) } : {}),
        }),
      ),
    )
    const program: GoalTickProgram.Program = {
      version: 3,
      planLineage: { version: 1, planRevision: source.goal.plan_revision, rebaseID: source.goal.plan_rebase_id,
        sourceReceiptHash: baseline.receiptHash, planDocID: planDoc.id, planDocVersion: planDoc.version,
        planDocHash: GoalTickProgram.hash(planDoc), baselineDocsHash: GoalTickProgram.hash(baseline.documents) },
      contract: "owned-goal-v2",
      roles,
      documents: docs.map((doc) =>
        GoalTickProgram.documentBudget(
          doc,
          doc.id === source.goal.plan_doc_id
            ? "plan"
            : doc.type === "run_context"
              ? "state"
              : doc.type === "decision"
                ? "completion"
                : doc.type === "diagnosis"
                  ? "diagnosis"
                  : "worklog",
          doc.type === "run_context" ? 131072 : 65536,
        ),
      ),
      localEffectSlots: initialization.spec.criteria.reduce(
        (count, item) => count + (item.kind === "tests_pass" ? item.commands.length : 0),
        0,
      ),
      nextStateBytes: 131072,
    }
    yield* Effect.try({
      try: () =>
        requireProjectionCapacity({
          program,
          plan,
          state,
          permitID: source.permit.permit_id,
          diagnosticFiles: preparation.panel.codeRefs.length,
        }),
      catch: () =>
        failure(
          "Goal projection cannot reserve its complete bounded result; shorten the plan, commands, or criteria before execution",
        ),
    })
    const checkpoint = yield* GoalTickCheckpointV2.begin(db, {
      permitID: source.permit.permit_id,
      permitToken: source.permit.token,
      program,
    })
    return { source, checkpoint, docs, plan, state, lenses, workerRecipe }
  })

/** Reserve the controller's generated bodies, including previous evidence and both state copies.
 * These are conservative encoded upper bounds, not fabricated execution or diagnostic receipts. */
function requireProjectionCapacity(input: {
  program: GoalTickProgram.Program
  plan: NonNullable<ReturnType<typeof DeepAgentPlanStore.decodePlanDoc>>
  state: GoalTickState.Runtime
  permitID: string
  diagnosticFiles: number
}) {
  const size = (value: unknown) => GoalTickProgram.bytes(GoalTickProgram.canonical(value))
  const gaps = [
    "x".repeat(512),
    ...input.state.spec.criteria.map((criterion) =>
      "\\".repeat(
        criterion.kind === "plan_complete"
          ? size(input.plan.steps) + 256
          : criterion.kind === "tests_pass"
            ? size(criterion.commands) + 128
            : 512,
      ),
    ),
  ].slice(0, 64)
  if (gaps.some((gap) => gap.length > 4096)) throw failure("A possible Goal gap exceeds its bounded schema")
  const plan = {
    ...input.plan,
    steps: input.plan.steps.map((step) =>
      step.step_id !== input.plan.active_step_id
        ? step
        : {
            ...step,
            status: "cancelled",
            evidence: [
              ...(step.evidence ?? []),
              ...Array.from({ length: input.program.localEffectSlots + input.program.roles.length + 2 }, () =>
                "x".repeat(600),
              ),
            ],
          },
    ),
  }
  const count = Number.MAX_SAFE_INTEGER
  const state = {
    ...input.state,
    phase: "needs_human",
    lastOutcome: "needs_human",
    gaps,
    ledger: { ...input.state.ledger, ticks: count, tokens: count, wallclockMs: count, costComplete: false },
    stallCount: count,
    lastDoneCount: count,
    lastEvidenceCount: count,
    lastMetCount: count,
    lastProcessedVersion: count,
    lastFingerprint: "x".repeat(64),
    lastTransitionHash: "x".repeat(64),
    lastDeliveredFeedback: input.state.gaps,
    haltReason: "cost_exceeded",
  }
  const decision = {
    result: { met: false, gaps },
    escalate: true,
    escalateReason: gaps.reduce((longest, gap) => (gap.length > longest.length ? gap : longest), ""),
  }
  const bodies = {
    plan,
    state,
    worklog: {
      tick: count,
      outcome: "needs_human",
      decision,
      diagnostics: {
        state: "not_applicable",
        scope: "explicit_code_refs",
        sources: Array.from({ length: input.diagnosticFiles * 2 }, () => "x".repeat(2048)),
      },
      results: { count: 192, hash: "x".repeat(64) },
      localEffects: Array.from({ length: input.program.localEffectSlots }, () => ({
        id: "x".repeat(512),
        outcome: "cancelled",
      })),
    },
    diagnosis: { gaps, haltReason: "cost_exceeded" },
    completion: { phase: "needs_human", decision, checkpoint: input.permitID },
  }
  if (
    size(state) > input.program.nextStateBytes ||
    input.program.documents.some(
      (slot) => slot.kind !== "link" && size(GoalTickProgram.canonical(bodies[slot.kind])) > slot.bodyBytes,
    )
  )
    throw failure("Complete controller projection cannot fit its pre-execution slots")
}

const decisions = new WeakMap<
  object,
  {
    permitID: string
    journalHash: string
    roles: readonly number[]
    rule: "cheap-gate-v2" | "panel-converged-v2" | "terminal-decision-v2"
    policy: GoalChildPolicy.Frame
  }
>()
const skipRoles = GoalTickCheckpointV2.controllerAuthority((witness: object) => {
  const value = decisions.get(witness)
  return value && GoalChildPolicy.frameCurrent(value.policy, value.permitID) ? value : undefined
})

/** Cold completion only projects the already accepted bytes. It never constructs an execution frame. */
export const project = (input: { permitID: string; directory: string }) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const row = yield* GoalTickCheckpointV2.read(db, input.permitID)
    if (!row || !["mirror_pending", "committed"].includes(row.state))
      return yield* failure("Only a complete prepared projection can be recovered without execution")
    if (row.state === "committed") return row
    for (const document of row.journal.documents)
      yield* GoalTickCheckpointV2.projectDocument(db, { ...input, documentID: document.documentID })
    return yield* GoalTickCheckpointV2.settle(db, {
      permitID: input.permitID,
      revision: (yield* GoalTickCheckpointV2.read(db, input.permitID))!.revision,
    })
  })

/** The controller owns parent documents. Role prose is never a completion receipt. */
export const run = (input: { permitID: string; directory: string }) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const existing = yield* GoalTickCheckpointV2.read(db, input.permitID)
    if (existing && ["mirror_pending", "committed"].includes(existing.state)) return yield* project(input)
    if (existing?.journal.activations.length || existing?.journal.localEffects.length)
      return yield* failure("A previously issued tick requires recovery; it cannot restart its roles")
    const prepared = yield* prepare(input)
    const frames = yield* GoalTickExecution.Service
    const remaining = prepared.state.spec.limits.maxWallclockMs - (Date.now() - prepared.state.ledger.startedAtMs)
    if (remaining <= 0 || !GoalTickState.remainingBudget(prepared.state))
      return yield* failure("Goal has reached an original execution budget limit")
    return yield* frames.withFrame(prepared.source.permit, (frame) =>
      Effect.gen(function* () {
        const steers = yield* GoalTickCheckpointV2.steering(db, prepared.checkpoint)
        const worker = yield* GoalOwnedTurn.run({
          ...input,
          frame,
          role: 0,
          text: `${prepared.workerRecipe}\nFrozen plan:\n${JSON.stringify(prepared.plan)}\nPrevious verified gaps:\n${JSON.stringify(prepared.state.gaps)}\nFrozen operator steering:\n${JSON.stringify(steers)}`,
        })
        const criteria = prepared.state.spec.criteria
        const validations: Array<Effect.Success<ReturnType<typeof GoalOwnedTurn.validate>>> = []
        for (let ordinal = 0; ordinal < prepared.checkpoint.journal.program.localEffectSlots; ordinal++) {
          yield* frames.current(frame)
          validations.push(
            yield* GoalOwnedTurn.validate({
              ...input,
              frame,
              ordinal,
              timeoutMs: Math.max(
                1,
                Math.min(
                  120000,
                  prepared.state.spec.limits.maxWallclockMs - (Date.now() - prepared.state.ledger.startedAtMs),
                ),
              ),
            }),
          )
        }
        // The controller can advance the active step only from independently observed validations.
        // A scratch status or plain assistant claim alone never marks the parent step complete.
        const validationPassed = validations.length > 0 && validations.every((item) => item.pass)
        const diagnosticRequested = criteria.some((item) => item.kind === "no_diagnostics")
        const reviewRequested = criteria.some(
          (item) => item.kind === "reviewer_clean" || item.kind === "panel_approves",
        )
        const active = prepared.plan.steps.find(
          (step) => step.step_id === prepared.plan.active_step_id && step.status === "active",
        )
        const nextPending = prepared.plan.steps.find((step) => step.status === "pending")
        if (
          worker.proposal &&
          prepared.plan.steps.some((step) => {
            const candidate = worker.proposal!.plan.steps.find((item) => item.step_id === step.step_id)!
            return (
              step.step_id !== active?.step_id &&
              candidate.status !== step.status &&
              !(step.step_id === nextPending?.step_id && candidate.status === "active")
            )
          })
        )
          return yield* failure("Plan proposal changes a step outside this tick's frozen active step")
        const stepProposed = Boolean(
          active &&
            (validationPassed ||
              (worker.proposal &&
                worker.proposal.plan.steps.find((step) => step.step_id === active.step_id)?.status === "done")),
        )
        const proposed = !stepProposed
          ? prepared.plan
          : {
              ...prepared.plan,
              steps: prepared.plan.steps.map((step) =>
                step.step_id === active!.step_id
                  ? { ...step, status: "done" as const }
                  : step.step_id === nextPending?.step_id
                    ? { ...step, status: "active" as const }
                    : step,
              ),
              active_step_id: nextPending?.step_id ?? null,
            }
        const parent = yield* GoalControl.session(db, prepared.source.goal.session_id)
        const parentLocation = (yield* LocationServiceMap).get({
          directory: AbsolutePath.make(parent.directory),
          ...(parent.workspace_id ? { workspaceID: WorkspaceV2.ID.make(parent.workspace_id) } : {}),
        })
        const diagnosticInput: LSP.CheckedInput = {
          files: prepared.source.goal.initialization.ownedPreparation!.panel.codeRefs,
          authorize: (action, file) =>
            Effect.gen(function* () {
              yield* frames.current(frame)
              yield* GoalTickCheckpointV2.requireParent(db, (yield* GoalTickCheckpointV2.read(db, input.permitID))!)
              yield* (yield* PermissionV2.Service).assert({
                sessionID: SessionSchema.ID.make(parent.id),
                agent: parent.agent ? AgentV2.ID.make(parent.agent) : undefined,
                action,
                resources: [file],
                save: [file],
              })
              yield* frames.current(frame)
              yield* GoalTickCheckpointV2.requireParent(db, (yield* GoalTickCheckpointV2.read(db, input.permitID))!)
            }).pipe(Effect.provide(parentLocation), Effect.orDie),
        }
        const lsp = yield* LSP.Service
        const context = diagnosticRequested
          ? yield* (yield* InstanceStore.Service).load({ directory: parent.directory })
          : undefined
        const observed =
          diagnosticRequested && context && lsp.observeChecked
            ? yield* lsp.observeChecked(diagnosticInput).pipe(Effect.provideService(InstanceRef, context))
            : { state: "not_applicable" as const, receipts: [] }
        const diagnosticViews =
          context && observed.state === "checked" && lsp.recheck
            ? yield* lsp
                .recheck({ ...diagnosticInput, receipts: observed.receipts })
                .pipe(Effect.provideService(InstanceRef, context))
            : undefined
        const worst = diagnosticViews?.reduce<number | null>(
          (value, item) =>
            item.maxSeverity === null ? value : value === null ? item.maxSeverity : Math.min(value, item.maxSeverity),
          null,
        )
        const diagnostics = {
          checked: Boolean(diagnosticViews?.length),
          maxSeverity:
            worst === null || worst === undefined ? null : ["error", "warning", "information", "hint"][worst - 1],
        }
        const verificationGap =
          criteria.some((item) => item.kind === "no_diagnostics") && !diagnostics.checked
            ? `no_diagnostics: ${observed.state}; no checked content revision for the explicit codeRefs file set; choose exact code references with an authorized diagnostic provider or explicit tests/review`
            : criteria.some((item) => item.kind === "plan_complete") &&
                !validationPassed &&
                !(worker.proposal && (reviewRequested || diagnostics.checked))
              ? "plan_complete: no independently verifiable proposal; choose explicit validation commands or an owned Plan proposal with review"
              : null
        const reviewResults: Array<{ criterion: number; review: typeof Review.Type }> = []
        const panelResults: Array<{ criterion: number; decision: string }> = []
        const testPorts = {
          runTests: (commands: readonly string[]) =>
            Effect.sync(() => {
              const declared = criteria.flatMap((criterion) =>
                criterion.kind === "tests_pass" ? criterion.commands : [],
              )
              const matches = criteria.filter((criterion) => criterion.kind === "tests_pass")
              const criterion = matches.find(
                (item) => GoalControl.fingerprint(item.commands) === GoalControl.fingerprint(commands),
              )
              if (!criterion) throw failure("Grader requested validation outside its frozen specification")
              return {
                pass:
                  commands.length > 0 &&
                  commands.every((command) =>
                    declared.every((item, index) => item !== command || validations[index]?.pass),
                  ),
              }
            }),
          diagnostics: () => Effect.succeed(diagnostics),
          reviewerClean: () => Effect.die("Expensive reviewer was requested before its owned stage"),
          panelApproves: () => Effect.die("Panel was requested before its owned stage"),
        }
        const cheap = yield* evaluateForController(
          criteria.filter(
            (item) =>
              item.kind !== "reviewer_clean" &&
              item.kind !== "panel_approves" &&
              !(item.kind === "plan_complete" && stepProposed),
          ),
          testPorts,
          proposed,
        )
        const skip = (
          roles: readonly number[],
          rule: "cheap-gate-v2" | "panel-converged-v2" | "terminal-decision-v2",
        ) =>
          Effect.gen(function* () {
            if (!roles.length) return
            yield* frames.current(frame)
            const row = (yield* GoalTickCheckpointV2.read(db, input.permitID))!
            const witness = Object.freeze({})
            decisions.set(witness, {
              permitID: input.permitID,
              journalHash: row.journal_hash,
              roles,
              rule,
              policy: frames.policy(frame)!,
            })
            yield* skipRoles(db, witness).pipe(Effect.ensuring(Effect.sync(() => decisions.delete(witness))))
          })
        if (verificationGap || !cheap.result.met) {
          yield* skip(
            prepared.checkpoint.journal.program.roles.slice(1).map((role) => role.ordinal),
            "cheap-gate-v2",
          )
        } else {
          const roles = prepared.checkpoint.journal.program.roles
          for (const role of roles.filter((role) => role.kind === "reviewer")) {
            const result = yield* GoalOwnedTurn.run({
              ...input,
              frame,
              role: role.ordinal,
              resultSchema: Review,
              text: `Review the actual workspace for frozen criterion ${JSON.stringify(criteria[role.criterion!])}. Investigate with permitted tools and return grounded findings.\nFrozen active step and acceptance: ${JSON.stringify(active)}\nFrozen plan: ${JSON.stringify(prepared.plan)}\nProposed controller plan: ${JSON.stringify(proposed)}\nNative proposal receipt: ${JSON.stringify(worker.proposal?.receipt ?? null)}\nVerified worker activity: ${worker.result.activityID}`,
            })
            reviewResults.push({ criterion: role.criterion!, review: Schema.decodeUnknownSync(Review)(result.value) })
          }
          const reviewFailed = reviewResults.some((item) => {
            const criterion = criteria[item.criterion]
            if (criterion.kind !== "reviewer_clean") return true
            const ranks = { low: 1, medium: 2, high: 3, critical: 4 }
            return (
              item.review.verdict !== "approve" ||
              item.review.findings.some(
                (finding) => ranks[finding.severity] > (Reflect.get(ranks, criterion.maxSeverity) ?? -1),
              )
            )
          })
          if (reviewFailed)
            yield* skip(
              roles.filter((role) => role.kind === "panel").map((role) => role.ordinal),
              "terminal-decision-v2",
            )
          for (const [criterion, item] of criteria.entries()) {
            if (reviewFailed || item.kind !== "panel_approves") continue
            const seats = roles.filter((role) => role.kind === "panel" && role.criterion === criterion)
            const prior: Array<typeof PanelOpinion.Type> = []
            for (
              let round = 0;
              round < (prepared.source.goal.initialization.ownedPreparation!.panel.maxRounds ?? 3);
              round++
            ) {
              const opinions: Array<typeof PanelOpinion.Type> = []
              for (const role of seats.filter((role) => role.round === round)) {
                const lens = prepared.lenses[role.lens!]
                const question = {
                  ...prepared.source.goal.initialization.ownedPreparation!.panel,
                  lenses: prepared.lenses,
                  maxRounds: prepared.source.goal.initialization.ownedPreparation!.panel.maxRounds ?? 3,
                  policy: DEFAULT_QUORUM_POLICY,
                }
                const result = yield* GoalOwnedTurn.run({
                  ...input,
                  frame,
                  role: role.ordinal,
                  resultSchema: Review,
                  text: renderPanelistPrompt({
                    spec: { lens, id: role.key },
                    question,
                    round: round + 1,
                    peers: prior.map((opinion) => ({
                      verdict: opinion.verdict,
                      confidence: opinion.confidence,
                      findings: opinion.findings,
                    })),
                  }),
                })
                opinions.push(opinionFromReview(lens, Schema.decodeUnknownSync(Review)(result.value))!)
              }
              const verdict = arbitrate(opinions, DEFAULT_QUORUM_POLICY, round + 1)
              const future = seats.filter((role) => role.round! > round)
              if (verdict.decision !== "revise" || !future.length) {
                panelResults.push({ criterion, decision: verdict.decision })
                yield* skip(
                  future.map((role) => role.ordinal),
                  "panel-converged-v2",
                )
                break
              }
              prior.splice(0, prior.length, ...opinions)
            }
          }
        }
        const ranks = { low: 1, medium: 2, high: 3, critical: 4 }
        const independentlyApproved =
          stepProposed &&
          !verificationGap &&
          cheap.result.met &&
          (validationPassed || Boolean(worker.proposal && (reviewRequested || diagnostics.checked))) &&
          (!criteria.some((item) => item.kind === "reviewer_clean") ||
            (reviewResults.length > 0 &&
              reviewResults.every(
                (item) =>
                  item.review.verdict === "approve" &&
                  item.review.findings.every((finding) => {
                    const criterion = criteria[item.criterion]
                    return (
                      criterion.kind === "reviewer_clean" &&
                      ranks[finding.severity] <= (Reflect.get(ranks, criterion.maxSeverity) ?? -1)
                    )
                  }),
              ))) &&
          (!criteria.some((item) => item.kind === "panel_approves") ||
            (panelResults.length > 0 && panelResults.every((item) => item.decision === "approve")))
        const verifiedPlan = !independentlyApproved
          ? prepared.plan
          : {
              ...proposed,
              steps: proposed.steps.map((step) =>
                step.step_id !== active?.step_id
                  ? step
                  : {
                      ...step,
                      evidence: [
                        ...(step.evidence ?? []),
                        ...validations
                          .filter((item) => item.pass)
                          .map((item) => `owned_validation:${item.receipt.snapshot.handleID}`),
                        ...(worker.proposal ? [`owned_plan:${worker.proposal.receipt.documentHash}`] : []),
                        ...reviewResults.map((item) => `owned_review:${input.permitID}:${item.criterion}`),
                        ...panelResults.map((item) => `owned_panel:${input.permitID}:${item.criterion}`),
                        ...(diagnosticViews ? [`owned_diagnostics:${GoalTickProgram.hash(diagnosticViews)}`] : []),
                      ],
                    },
              ),
            }
        const gradedChecks = yield* evaluateForController(
          criteria.filter((item) => item.kind !== "plan_complete"),
          {
            ...testPorts,
            reviewerClean: (severity: string) =>
              Effect.succeed({
                pass:
                  reviewResults.length > 0 &&
                  reviewResults
                    .filter((item) => {
                      const criterion = criteria[item.criterion]
                      return criterion.kind === "reviewer_clean" && criterion.maxSeverity === severity
                    })
                    .every(
                      (item) =>
                        item.review.verdict === "approve" &&
                        item.review.findings.every(
                          (finding) => ranks[finding.severity] <= (Reflect.get(ranks, severity) ?? -1),
                        ),
                    ),
              }),
            panelApproves: () =>
              Effect.succeed({
                decision:
                  panelResults.every((item) => item.decision === "approve") && panelResults.length
                    ? "approve"
                    : (panelResults.find((item) => item.decision !== "approve")?.decision ?? "needs_human"),
              }),
          },
          verifiedPlan,
        )
        const gradedPlan = yield* evaluateForController(
          criteria.filter((item) => item.kind === "plan_complete"),
          testPorts,
          verifiedPlan,
        )
        const graded = {
          result: {
            met: gradedChecks.result.met && gradedPlan.result.met,
            gaps: [...gradedPlan.result.gaps, ...gradedChecks.result.gaps],
          },
          escalate: gradedChecks.escalate || gradedPlan.escalate,
          escalateReason: gradedPlan.escalateReason ?? gradedChecks.escalateReason,
        }
        const decision = verificationGap
          ? {
              result: { met: false, gaps: [verificationGap, ...graded.result.gaps].slice(0, 64) },
              escalate: true,
              escalateReason: verificationGap,
            }
          : graded
        yield* frames.current(frame)
        const row = (yield* GoalTickCheckpointV2.read(db, input.permitID))!
        const plan = verifiedPlan
        const doneCount = plan.steps.filter((step) => step.status === "done").length
        const evidenceCount = plan.steps.reduce((sum, step) => sum + (step.evidence?.length ?? 0), 0)
        const metCount = Math.max(0, criteria.length - decision.result.gaps.length)
        const progressed =
          doneCount > prepared.state.lastDoneCount ||
          evidenceCount > prepared.state.lastEvidenceCount ||
          metCount > prepared.state.lastMetCount
        const halt =
          decision.escalate ||
          (!progressed && prepared.state.stallCount + 1 >= prepared.state.spec.stallThreshold) ||
          prepared.state.ledger.ticks + 1 >= prepared.state.spec.limits.maxTicks
        const outcome = decision.result.met
          ? ("done" as const)
          : halt
            ? ("needs_human" as const)
            : ("continue" as const)
        const transition: GoalTickState.Transition = {
          priorStateHash: GoalTickProgram.hash(prepared.state),
          tickSeq: prepared.source.permit.tick_seq,
          planVersion: prepared.source.permit.plan_version + 1,
          finishedAt: Date.now(),
          phase: outcome === "continue" ? "running" : outcome,
          outcome,
          fingerprint: GoalTickProgram.hash(plan),
          doneCount,
          evidenceCount,
          metCount,
          gaps: decision.result.gaps,
          deliveredFeedback: prepared.state.gaps,
          consumedSteers: steers.map((item) => item.id),
          usage: row.journal.results.map((result) => ({
            inputID: result.inputID,
            input: result.usage.input,
            output: result.usage.output,
            cacheRead: result.usage.cacheRead,
            cacheWrite: result.usage.cacheWrite,
            cost: null,
          })),
        }
        const next = GoalTickState.reduce(prepared.state, transition, steers)
        const ids = GoalTickProjection.documentIDs(row.goal_id, prepared.source.goal.plan_doc_id)
        const bodies = new Map([
          [ids.plan, JSON.stringify(plan)],
          [ids.state, GoalTickProgram.canonical(next)],
          [
            ids.worklog,
            GoalTickProgram.canonical({
              tick: row.tick_seq,
              outcome: next.lastOutcome,
              decision,
              diagnostics: { state: observed.state, scope: "explicit_code_refs", sources: diagnosticViews ?? [] },
              // Full per-stage references remain in the SQL journal; the projection has a
              // fixed-size complete digest rather than another unbounded copy of that ledger.
              results: { count: row.journal.results.length, hash: GoalTickProgram.hash(row.journal.results) },
              localEffects: row.journal.localEffects.map((item) => ({ id: item.id, outcome: item.outcome })),
            }),
          ],
          [ids.diagnosis, GoalTickProgram.canonical({ gaps: next.gaps, haltReason: next.haltReason })],
          [ids.completion, GoalTickProgram.canonical({ phase: next.phase, decision, checkpoint: row.permit_id })],
        ])
        const documents = prepared.docs.map((doc) =>
          GoalTickProjection.fullDocument(
            { ...doc, version: doc.version + 1, body: bodies.get(doc.id)! },
            { version: doc.version, hash: `sha256:${GoalTickProgram.hash(doc)}` },
          ),
        )
        if (diagnosticViews && context) {
          yield* frames.current(frame)
          const current = yield* lsp.recheck!({ ...diagnosticInput, receipts: observed.receipts }).pipe(
            Effect.provideService(InstanceRef, context),
          )
          if (!current || GoalTickProgram.hash(current) !== GoalTickProgram.hash(diagnosticViews))
            return yield* failure("Checked diagnostic content changed before result acceptance")
        }
        yield* GoalTickCheckpointV2.prepareProjection(db, { ...input, revision: row.revision, transition, documents })
        return yield* project(input)
      }).pipe(Effect.timeoutOrElse({ duration: remaining, orElse: () => failure("Goal wallclock deadline elapsed") })),
    )
  })
