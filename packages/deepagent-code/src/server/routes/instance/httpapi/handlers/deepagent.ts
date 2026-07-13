import path from "node:path"
import * as nodeFs from "node:fs"
import * as Log from "@deepagent-code/core/util/log"
import { Config } from "@/config/config"
import { configureGateway, reviewRunsDir } from "@/deepagent/config"
import { buildProfile } from "@/deepagent/profile-detector"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Effect } from "effect"
import { buildRunReview, listRunIds } from "@/deepagent/run-review"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { InstanceHttpApi } from "../api"
import { DeepAgentPromotionError } from "../groups/deepagent"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SettingsStore } from "@/settings/store"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { GoalManager } from "@/session/goal-manager"
import { SessionID } from "@/session/schema"
import { consultPanel } from "@/panel/consult"
import { makeTaskSubagentRunner } from "@/session/goal-loop-wiring"
import { openWikiGraph, openWikiService, openWikiSearchIndex, buildWikiEditGate } from "@/wiki/session-archive"
import { WIKI_EDITABLE_TYPES, type WikiPage } from "@/wiki/wiki-service"
import type { PanelTurnRunner } from "@/panel/panelist-runner"
import type { PanelVerdict } from "@/agent/schema/panel"
import type { CompletionCriterion } from "@deepagent-code/core/deepagent/goal-loop"
import type { PlanInput } from "@deepagent-code/core/deepagent/plan-controller"

const dbgLog = Log.create({ service: "deepagent.packs.debug" })

export const deepagentHandlers = HttpApiBuilder.group(InstanceHttpApi, "deepagent", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    // V3.9 §C/§D services — provided by the app runtime the server executes in.
    const flags = yield* RuntimeFlags.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const goals = yield* GoalManager.Service

    // Build a reviewer-subagent turn runner scoped to a session — the panelist seam consultPanel needs.
    // Reuses makeTaskSubagentRunner (the same child-session + permission-derivation path the goal loop
    // and the task tool use) and adapts its SubagentTurnResult to the PanelTurnRunner shape.
    const panelTurnRunnerFor = (sessionID: string): Effect.Effect<PanelTurnRunner> =>
      Effect.gen(function* () {
        const model = yield* provider.defaultModel().pipe(Effect.orDie)
        const runTurn = makeTaskSubagentRunner({
          sessions,
          agents,
          sessionPrompt,
          parentSessionID: SessionID.make(sessionID),
          model: { providerID: model.providerID, modelID: model.modelID },
        })
        return (turnInput) =>
          runTurn({ agentType: turnInput.agentType, prompt: turnInput.prompt, outputSchema: turnInput.outputSchema }).pipe(
            Effect.map((r) => ({ structured: r.structured })),
          )
      })

    const resolveReviewRunsDir = Effect.fn("DeepAgentHttpApi.resolveReviewRunsDir")(function* () {
      const route = yield* WorkspaceRouteContext
      void route.directory
      const cfg = yield* config.get()
      return reviewRunsDir(cfg)
    })

    const reviews = Effect.fn("DeepAgentHttpApi.reviews")(function* () {
      const runsDir = yield* resolveReviewRunsDir()
      const ids = (yield* Effect.promise(() => listRunIds(runsDir))).slice(0, 50)
      const list = yield* Effect.promise(() => Promise.all(ids.map((id) => buildRunReview(path.join(runsDir, id)))))
      return { reviews: list }
    })

    // The active workspace directory — durable knowledge stores root under the gateway baseDir, keyed
    // by this path (docs/34 §8). configureGateway points the knowledge-source at baseDir first.
    const workspaceDir = Effect.fn("DeepAgentHttpApi.workspaceDir")(function* () {
      const route = yield* WorkspaceRouteContext
      const cfg = yield* config.get()
      configureGateway(cfg)
      return route.directory
    })

    // The durable memory dir for the active workspace (RejectedBuffer fingerprint cache lives here).
    const workspaceMemoryDir = Effect.fn("DeepAgentHttpApi.workspaceMemoryDir")(function* () {
      const route = yield* WorkspaceRouteContext
      void route.directory
      const cfg = yield* config.get()
      configureGateway(cfg)
      return path.join(path.dirname(reviewRunsDir(cfg)), "memory")
    })

    const promote = Effect.fn("DeepAgentHttpApi.promote")(function* (ctx) {
      // P1-2: bind to the active workspace store before any read/write.
      const memoryDir = yield* workspaceMemoryDir()
      yield* workspaceDir()
      const now = new Date().toISOString()
      const promoted = yield* Effect.try({
        try: () => {
          // P1-A: the promotion gate is enforced SERVER-SIDE. The client-supplied `verdict` is NOT
          // trusted for the pass decision (a caller could otherwise POST verdict:{pass:true} and
          // bypass replay/regression entirely). Instead we run promotion.validate(), which dedupes
          // against the RejectedBuffer (contract R3) AND runs the replay/regression gate, and we
          // pass the SERVER-COMPUTED verdict into promote().
          const buffer = new AgentGateway.DeepAgentPromotion.RejectedBuffer(memoryDir)
          // Server-owned replay runner. There is no live replay sandbox in the route yet, so the
          // runner enforces the objective, server-checkable invariant: a promotable candidate must
          // carry real evidence (non-empty evidence_refs) and must not regress (metricDelta 0). This
          // is the single seam to wire a real eval-replay harness into later — the contract
          // (validate() owns the verdict) does not change when that lands.
          const replay: AgentGateway.DeepAgentPromotion.ReplayRunner = (candidate) => ({
            pass: candidate.evidence_refs.length > 0,
            metricDelta: 0,
            evidenceRef: candidate.evidence_refs[0],
          })
          const verdict = AgentGateway.DeepAgentPromotion.validate(ctx.payload.candidate, buffer, replay)
          if (!verdict.pass) {
            throw new Error(
              `promotion validation gate failed: ${verdict.reason ?? "candidate did not pass server-side validation"}`,
            )
          }
          const record = AgentGateway.DeepAgentPromotion.promote(
            ctx.payload.candidate,
            ctx.payload.origin,
            verdict,
            ctx.payload.approval,
            now,
          )
          AgentGateway.DeepAgentPromotion.persistPromoted(
            record,
            AgentGateway.DeepAgentKnowledgeSource.userGlobalStoreFor(),
          )
          AgentGateway.DeepAgentKnowledgeRetriever.invalidateCache()
          return record
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
      return { promoted }
    })

    const reject = Effect.fn("DeepAgentHttpApi.reject")(function* (ctx) {
      const memoryDir = yield* workspaceMemoryDir()
      const dir = yield* workspaceDir()
      const rejected = yield* Effect.try({
        try: () => {
          // P2-6: reject writes BOTH truth sources — the durable doc status (authoritative,
          // reversible, what the UI/retriever read) AND the RejectedBuffer fingerprint (relearn-dedup
          // index that promote checks).
          const buffer = new AgentGateway.DeepAgentPromotion.RejectedBuffer(memoryDir)
          const fingerprint = AgentGateway.DeepAgentPromotion.fingerprint(ctx.payload.candidate)
          AgentGateway.DeepAgentPromotion.reject(ctx.payload.candidate, buffer, ctx.payload.reason)
          AgentGateway.DeepAgentKnowledgeSource.setApprovalForWorkspace(
            dir,
            ctx.payload.candidate.candidate_id,
            "rejected",
          )
          AgentGateway.DeepAgentKnowledgeRetriever.invalidateCache()
          return { candidateId: ctx.payload.candidate.candidate_id, fingerprint, reason: ctx.payload.reason }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
      return { rejected }
    })

    const knowledgePending = Effect.fn("DeepAgentHttpApi.knowledgePending")(function* () {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          // P0-1b: return ALL three states so the Review UI can also revoke an already-approved
          // entry. Sorted by id for a stable list (the UI filters/groups by approval_status).
          const REVIEW_TYPES = ["knowledge", "strategy", "methodology", "memory", "skill", "failure_dossier"] as const
          type ReviewType = (typeof REVIEW_TYPES)[number]
          const asReviewType = (t: string): ReviewType =>
            REVIEW_TYPES.includes(t as ReviewType) ? (t as ReviewType) : "knowledge"
          const items = [...AgentGateway.DeepAgentKnowledgeSource.listAllForWorkspace(dir)]
            // Skills are agent-executable procedures, not human-readable facts — the governance UI
            // only surfaces learned facts (knowledge/memory/strategy/methodology/failure_dossier).
            // (Domain-pack seed docs are already excluded upstream by knowledge-source.)
            .filter((e) => e.type !== "skill")
            .map((e) => ({
              id: e.id,
              type: asReviewType(e.type),
              summary: e.summary,
              evidence_strength: e.evidence_strength,
              evidence_refs: e.evidence_refs,
              approval_status: e.approval_status,
              scope: e.scope,
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
          return { items }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const knowledgeApprove = Effect.fn("DeepAgentHttpApi.knowledgeApprove")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          for (const id of ctx.payload.ids)
            AgentGateway.DeepAgentKnowledgeSource.setApprovalForWorkspace(dir, id, "approved")
          AgentGateway.DeepAgentKnowledgeRetriever.invalidateCache()
          return { updated: ctx.payload.ids }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const knowledgeRejectIds = Effect.fn("DeepAgentHttpApi.knowledgeRejectIds")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          for (const id of ctx.payload.ids)
            AgentGateway.DeepAgentKnowledgeSource.setApprovalForWorkspace(dir, id, "rejected")
          AgentGateway.DeepAgentKnowledgeRetriever.invalidateCache()
          return { updated: ctx.payload.ids }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    // V3.2 ablation ship gate (docs/30 §7): the live enforcement seam for "knowledge must not drag
    // down the model". CI/eval posts the REAL measured metric matrix (per group×task) plus the
    // candidate refs under test. We feed those measurements into the existing evaluateSnapshot
    // regression rule; on FAIL the candidate refs are DEMOTED (approval_status=rejected) so they
    // are immediately unretrievable — ablation now has teeth via the same flag mechanism as review.
    const knowledgeShipGate = Effect.fn("DeepAgentHttpApi.knowledgeShipGate")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          const { tasks, metrics, candidateRefs, tolerance, repeats } = ctx.payload
          // Build a deterministic runner from the posted measurements (default 0 for missing cells
          // so an absent MAX measurement reads as a regression rather than a silent pass).
          const byKey = new Map<string, number>()
          for (const m of metrics) byKey.set(`${m.group}:${m.task}`, m.metric)
          const runner = (group: "general" | "high" | "max", task: string) => byKey.get(`${group}:${task}`) ?? 0
          const decision = AgentGateway.DeepAgentKnowledgeGate.evaluateSnapshot(
            `ship_gate:${new Date().toISOString()}`,
            tasks,
            runner,
            { ...(tolerance !== undefined ? { tolerance } : {}), ...(repeats !== undefined ? { repeats } : {}) },
          )
          const demoted: string[] = []
          const notInStore: string[] = []
          if (!decision.ship) {
            // FAIL → demote every candidate ref under test (the suspect delta) so it cannot ship.
            // P1-2: setApprovalForWorkspace only affects durable docs. In-code / domain-pack refs
            // (e.g. "strategy:first-fast-design", "strategy:gpu:...") have no doc, so demoting them
            // is a no-op — report them separately instead of claiming a false demotion.
            for (const ref of candidateRefs) {
              if (AgentGateway.DeepAgentKnowledgeSource.setApprovalForWorkspace(dir, ref, "rejected")) demoted.push(ref)
              else notInStore.push(ref)
            }
            AgentGateway.DeepAgentKnowledgeRetriever.invalidateCache()
          }
          return {
            ship: decision.ship,
            reason: decision.reason,
            offenders: decision.offenders,
            demoted,
            not_in_store: notInStore,
            per_group: decision.perGroup,
          }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    // docs/34 §9 S10: pinned packs persist per-workspace as a small JSON file under the memory dir.
    const pinnedPacksFile = (memoryDir: string) => path.join(memoryDir, "pinned-packs.json")
    const readPinned = (memoryDir: string): string[] => {
      try {
        const raw = nodeFs.readFileSync(pinnedPacksFile(memoryDir), "utf8")
        const arr = JSON.parse(raw)
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []
      } catch {
        return []
      }
    }
    const writePinned = (memoryDir: string, ids: readonly string[]): void => {
      nodeFs.mkdirSync(memoryDir, { recursive: true })
      nodeFs.writeFileSync(pinnedPacksFile(memoryDir), JSON.stringify([...new Set(ids)].sort(), null, 2), "utf8")
    }

    const packsActive = Effect.fn("DeepAgentHttpApi.packsActive")(function* () {
      const dir = yield* workspaceDir()
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          const pinned = new Set(readPinned(memoryDir))
          const manifests = AgentGateway.DeepAgentDomainPackRegistry.discover()
          // Build a profile from the workspace so detection reflects reality; user overrides = pinned.
          const profile = buildProfile({
            cwd: dir,
            agentMode: "max",
            scenarioMode: "intelligence",
            userRequest: "",
            userOverrides: [...pinned],
          })
          const { snapshot, resolution } = AgentGateway.DeepAgentDomainPackRegistry.activateForProfile(
            profile,
            0.5,
            manifests,
          )
          const byId = new Map(manifests.map((m) => [m.id, m]))
          const packs = resolution.activePackIds.flatMap((id) => {
            const m = byId.get(id)
            if (!m) return []
            return [
              {
                id: m.id,
                name: m.name,
                version: m.version,
                risk: m.risk,
                domains: m.domains,
                pinned: pinned.has(m.id),
              },
            ]
          })
          return { packs, snapshotId: snapshot.id }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const packsAll = Effect.fn("DeepAgentHttpApi.packsAll")(function* () {
      dbgLog.info("packsAll: handler entered")
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          const pinned = new Set(readPinned(memoryDir))
          const manifests = AgentGateway.DeepAgentDomainPackRegistry.discover()
          const scanDbg = AgentGateway.DeepAgentDomainPackRegistry.dirsToScanDebug()
          dbgLog.info("packsAll: discover", {
            count: manifests.length,
            dirs: scanDbg.dirs.join(" | "),
            builtin: String(scanDbg.builtin),
            metaUrl: scanDbg.metaUrl,
            sample: manifests
              .slice(0, 2)
              .map((m) => m.id)
              .join(","),
          })
          const packs = manifests
            .map((m) => ({
              id: m.id,
              name: m.name,
              ...(m.description ? { description: m.description } : {}),
              version: m.version,
              risk: m.risk,
              domains: m.domains,
              builtin: m.scope === "system",
              pinned: pinned.has(m.id),
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
          dbgLog.info("packsAll: returning", { packs: packs.length })
          return { packs }
        },
        catch: (error) => {
          dbgLog.error("packsAll: failed", { error: error instanceof Error ? error.message : String(error) })
          return new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) })
        },
      })
    })

    const packsPin = Effect.fn("DeepAgentHttpApi.packsPin")(function* (ctx) {
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          writePinned(memoryDir, [...readPinned(memoryDir), ctx.payload.packId])
          return { ok: true, packId: ctx.payload.packId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const packsUnpin = Effect.fn("DeepAgentHttpApi.packsUnpin")(function* (ctx) {
      const memoryDir = yield* workspaceMemoryDir()
      return yield* Effect.try({
        try: () => {
          writePinned(
            memoryDir,
            readPinned(memoryDir).filter((id) => id !== ctx.payload.packId),
          )
          return { ok: true, packId: ctx.payload.packId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    // V3.8.1 §G environment-fact use-gate handlers. The adoption service roots at the same gateway
    // baseDir the retriever reads (workspaceDir() calls configureGateway first), keyed by the active
    // workspace path — so a project's adopt/reject decisions are isolated per project (§G.8).
    const now = () => new Date().toISOString()

    const envFacts = Effect.fn("DeepAgentHttpApi.envFacts")(function* () {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => AgentGateway.DeepAgentKnowledgeSource.environmentFactAdoptionFor(dir).resolve(),
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const envFactsDecide = Effect.fn("DeepAgentHttpApi.envFactsDecide")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          const adoption = AgentGateway.DeepAgentKnowledgeSource.environmentFactAdoptionFor(dir)
          if (ctx.payload.decision === "adopt") adoption.adopt(ctx.payload.factId, now())
          else adoption.reject(ctx.payload.factId, now())
          AgentGateway.DeepAgentKnowledgeRetriever.invalidateCache()
          return { ok: true, factId: ctx.payload.factId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const envFactsModify = Effect.fn("DeepAgentHttpApi.envFactsModify")(function* (ctx) {
      const dir = yield* workspaceDir()
      return yield* Effect.try({
        try: () => {
          const adoption = AgentGateway.DeepAgentKnowledgeSource.environmentFactAdoptionFor(dir)
          const { updatedId } = adoption.modify({
            factId: ctx.payload.factId,
            description: ctx.payload.description,
            body: ctx.payload.body,
            ...(ctx.payload.domain !== undefined ? { domain: ctx.payload.domain } : {}),
            mode: ctx.payload.mode,
            now: now(),
          })
          AgentGateway.DeepAgentKnowledgeRetriever.invalidateCache()
          return { ok: true, factId: updatedId }
        },
        catch: (error) =>
          new DeepAgentPromotionError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    // ── V3.9 §C Expert Panel ────────────────────────────────────────────────
    const toVerdictResult = (v: PanelVerdict) => ({
      decision: v.decision,
      confidence: v.confidence,
      rounds: v.rounds,
      evidence: [...v.evidence],
      dissent: v.dissent.map((d) => ({
        lens: d.lens,
        verdict: d.verdict,
        confidence: d.confidence,
        findings: d.findings.map((f) => ({
          severity: f.severity,
          category: f.category,
          file: f.file ?? null,
          line: f.line ?? null,
          summary: f.summary,
          failureScenario: f.failureScenario,
          confidence: f.confidence,
        })),
      })),
    })

    const panelConsult = Effect.fn("DeepAgentHttpApi.panelConsult")(function* (ctx) {
      // §C: the panel is independently gated. Flag off ⇒ 400 (never silently run a disabled capability).
      if (!flags.experimentalExpertPanel)
        return yield* Effect.fail(new DeepAgentPromotionError({ message: "expert panel is disabled" }))
      const { sessionID } = ctx.payload
      const runTurn = yield* panelTurnRunnerFor(sessionID)
      const verdict = yield* consultPanel(
        {
          question:
            ctx.payload.question ?? "Review the current changes in this conversation for correctness, security, and design.",
          codeRefs: ctx.payload.codeRefs ? [...ctx.payload.codeRefs] : [],
          parentSessionID: sessionID,
          ...(ctx.payload.lenses ? { lenses: [...ctx.payload.lenses] } : {}),
          ...(ctx.payload.maxRounds != null ? { maxRounds: ctx.payload.maxRounds } : {}),
          ...(ctx.payload.policy ? { policy: ctx.payload.policy } : {}),
        },
        { runTurn },
      )
      return toVerdictResult(verdict)
    })

    // The global Expert Panel default (§C): the effective armed state falls back to this when a session
    // has never explicitly toggled. Read from the first-party SettingsStore (expertPanelDefault).
    const expertPanelDefault = () =>
      Effect.promise(() => SettingsStore.read()).pipe(
        Effect.map((s) => s.deepagent?.expertPanelDefault ?? false),
      )

    const panelArm = Effect.fn("DeepAgentHttpApi.panelArm")(function* (ctx) {
      const { sessionID, armed } = ctx.payload
      AgentGateway.DeepAgentSessionState.setPanelArmed(sessionID, armed)
      const globalDefault = yield* expertPanelDefault()
      return { sessionID, armed: AgentGateway.DeepAgentSessionState.resolvePanelArmed(sessionID, globalDefault) }
    })

    const panelStatus = Effect.fn("DeepAgentHttpApi.panelStatus")(function* (ctx) {
      const sessionID = ctx.query.sessionID
      const globalDefault = yield* expertPanelDefault()
      const choice = AgentGateway.DeepAgentSessionState.panelArmedChoice(sessionID)
      return {
        sessionID,
        armed: choice ?? globalDefault,
        explicit: choice != null,
      }
    })

    // ── V3.9 §D Goal Loop lifecycle ─────────────────────────────────────────
    const goalStart = Effect.fn("DeepAgentHttpApi.goalStart")(function* (ctx) {
      if (!flags.experimentalGoalLoop)
        return yield* Effect.fail(new DeepAgentPromotionError({ message: "goal loop is disabled" }))
      type CriterionPayload = {
        kind: CompletionCriterion["kind"]
        commands?: readonly string[]
        maxSeverity?: string
        severityAtMost?: string
      }
      const criteria = ctx.payload.criteria?.map(
        (c: CriterionPayload) =>
          ({
            kind: c.kind,
            ...(c.commands ? { commands: [...c.commands] } : {}),
            ...(c.maxSeverity != null ? { maxSeverity: c.maxSeverity } : {}),
            ...(c.severityAtMost != null ? { severityAtMost: c.severityAtMost } : {}),
          }) as CompletionCriterion,
      )
      const snapshot = yield* goals
        .start({
          sessionID: ctx.payload.sessionID,
          ...(ctx.payload.objective != null ? { objective: ctx.payload.objective } : {}),
          ...(criteria ? { criteria } : {}),
          ...(ctx.payload.limits ? { limits: ctx.payload.limits } : {}),
          ...(ctx.payload.stallThreshold != null ? { stallThreshold: ctx.payload.stallThreshold } : {}),
        })
        .pipe(Effect.mapError((e) => new DeepAgentPromotionError({ message: e.reason })))
      return snapshot
    })

    const goalPause = Effect.fn("DeepAgentHttpApi.goalPause")(function* (ctx) {
      return { ok: yield* goals.pause(ctx.payload.sessionID) }
    })
    const goalResume = Effect.fn("DeepAgentHttpApi.goalResume")(function* (ctx) {
      return { ok: yield* goals.resume(ctx.payload.sessionID) }
    })
    const goalStop = Effect.fn("DeepAgentHttpApi.goalStop")(function* (ctx) {
      return { ok: yield* goals.stop(ctx.payload.sessionID) }
    })
    // V4.1 §S2 — hot-edit the plan of a running/paused goal. Normalize the wire payload (readonly step
    // structs → the loose PlanInput the backend reconciles via buildPlanFromInput, preserving ids +
    // runtime-owned evidence). GoalManager.editPlan enqueues it on the control channel (ok:false when no
    // goal is running or the goal is terminal); the driver applies it between ticks.
    const goalEditPlan = Effect.fn("DeepAgentHttpApi.goalEditPlan")(function* (ctx) {
      const p = ctx.payload.plan
      const plan: PlanInput = {
        goal: p.goal,
        steps: p.steps.map((s: (typeof p.steps)[number]) => ({
          ...(s.step_id != null ? { step_id: s.step_id } : {}),
          title: s.title,
          ...(s.status != null ? { status: s.status } : {}),
          ...(s.acceptance !== undefined ? { acceptance: s.acceptance } : {}),
          ...(s.assigned_agent !== undefined ? { assigned_agent: s.assigned_agent } : {}),
          ...(s.note !== undefined ? { note: s.note } : {}),
        })),
        ...(p.assumptions ? { assumptions: [...p.assumptions] } : {}),
        ...(p.active_step_id !== undefined ? { active_step_id: p.active_step_id } : {}),
      }
      return { ok: yield* goals.editPlan({ sessionID: ctx.payload.sessionID, plan }) }
    })
    const goalStatus = Effect.fn("DeepAgentHttpApi.goalStatus")(function* (ctx) {
      return { goal: yield* goals.status(ctx.query.sessionID) }
    })
    const goalStartable = Effect.fn("DeepAgentHttpApi.goalStartable")(function* (ctx) {
      return yield* goals.startable(ctx.query.sessionID)
    })

    // ── V3.9 §B Repo & Wiki ─────────────────────────────────────────────────
    // Read-only projection + governed knowledge edit + full-text search. All fail-closed on the wiki
    // flag. The graph union / search index / edit gate are all built from the active workspace dir.
    const requireWiki = Effect.fn("DeepAgentHttpApi.requireWiki")(function* () {
      if (!flags.experimentalWiki)
        return yield* Effect.fail(new DeepAgentPromotionError({ message: "wiki is disabled" }))
    })

    // Flatten a rendered WikiPage into the wire shape (crossLinks lists → plain arrays).
    const toWikiPageResult = (page: WikiPage) => ({
      docId: page.docId,
      type: page.type,
      title: page.title,
      markdown: page.markdown,
      editable: page.editable,
      version: page.version,
      crossLinks: {
        toCode: page.crossLinks.toCode.map((r) => ({
          docId: r.docId,
          rel: r.rel,
          path: r.path,
          line: r.line,
          symbolPath: r.symbolPath,
          stale: r.stale,
        })),
        toDocs: page.crossLinks.toDocs.map((r) => ({
          docId: r.docId,
          rel: r.rel,
          type: r.type,
          title: r.title,
          stale: r.stale,
        })),
      },
    })

    const wikiPages = Effect.fn("DeepAgentHttpApi.wikiPages")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const typeFilter = ctx.query.type
      const graph = openWikiGraph({ workspacePath })
      const pages = graph
        .allDocs()
        .filter((doc) => (typeFilter ? doc.type === typeFilter : true))
        .map((doc) => ({
          docId: doc.id,
          type: doc.type,
          title: doc.description,
          scope: doc.scope,
          editable: WIKI_EDITABLE_TYPES.has(doc.type),
          version: doc.version,
        }))
      return { pages }
    })

    const wikiPage = Effect.fn("DeepAgentHttpApi.wikiPage")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const service = openWikiService({ workspacePath })
      const page = yield* service
        .renderPage({ docId: ctx.query.docId, scope: ctx.query.scope })
        .pipe(Effect.mapError((e) => new DeepAgentPromotionError({ message: e.reason ?? "page not found" })))
      return toWikiPageResult(page)
    })

    const wikiSearch = Effect.fn("DeepAgentHttpApi.wikiSearch")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const index = openWikiSearchIndex({ workspacePath })
      // The index is a rebuildable projection with no auto-refresh — rebuild from the graph before the
      // query, then close the sqlite handle. Both are default-safe (never fail).
      yield* index.rebuild()
      const hits = yield* index.search({
        text: ctx.query.text,
        ...(ctx.query.type ? { type: ctx.query.type as WikiPage["type"] } : {}),
        ...(ctx.query.scope ? { scope: ctx.query.scope } : {}),
      })
      index.close()
      return { hits: hits.map((h) => ({ docId: h.docId, type: h.type, scope: h.scope, title: h.title, score: h.score })) }
    })

    const wikiEdit = Effect.fn("DeepAgentHttpApi.wikiEdit")(function* (ctx) {
      yield* requireWiki()
      const workspacePath = yield* workspaceDir()
      const memoryDir = yield* workspaceMemoryDir()
      // Inject the REAL evidence-gate (same validate() promotion uses) — not the trivial default.
      const service = openWikiService({ workspacePath, gate: buildWikiEditGate(memoryDir) })
      const page = yield* service
        .editKnowledge({
          docId: ctx.payload.docId,
          body: ctx.payload.body,
          editor: { id: ctx.payload.editor.id, ...(ctx.payload.editor.name ? { name: ctx.payload.editor.name } : {}) },
        })
        .pipe(Effect.mapError((e) => new DeepAgentPromotionError({ message: e.message })))
      return toWikiPageResult(page)
    })

    return handlers
      .handle("reviews", reviews)
      .handle("promote", promote)
      .handle("reject", reject)
      .handle("knowledgePending", knowledgePending)
      .handle("knowledgeApprove", knowledgeApprove)
      .handle("knowledgeRejectIds", knowledgeRejectIds)
      .handle("knowledgeShipGate", knowledgeShipGate)
      .handle("packsActive", packsActive)
      .handle("packsAll", packsAll)
      .handle("packsPin", packsPin)
      .handle("packsUnpin", packsUnpin)
      .handle("envFacts", envFacts)
      .handle("envFactsDecide", envFactsDecide)
      .handle("envFactsModify", envFactsModify)
      .handle("panelConsult", panelConsult)
      .handle("panelArm", panelArm)
      .handle("panelStatus", panelStatus)
      .handle("goalStart", goalStart)
      .handle("goalPause", goalPause)
      .handle("goalResume", goalResume)
      .handle("goalStop", goalStop)
      .handle("goalEditPlan", goalEditPlan)
      .handle("goalStatus", goalStatus)
      .handle("goalStartable", goalStartable)
      .handle("wikiPages", wikiPages)
      .handle("wikiPage", wikiPage)
      .handle("wikiSearch", wikiSearch)
      .handle("wikiEdit", wikiEdit)
  }),
)
