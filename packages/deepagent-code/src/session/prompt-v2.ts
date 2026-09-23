import path from "path"
import os from "os"
import { randomUUID } from "node:crypto"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionID, MessageID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "@deepagent-code/core/util/log"
import { Global } from "@deepagent-code/core/global"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Auth } from "@/auth"
import { configureGateway } from "@/deepagent/config"
import { type ModelMessage, streamText } from "ai"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { NamedError } from "@deepagent-code/core/util/error"
import { SessionStatus } from "./status"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { pathToFileURL } from "url"
import { Cause, Context, Effect, Layer, Option, Schema, Scope, Types } from "effect"
import * as DateTime from "effect/DateTime"
import * as EffectLogger from "@deepagent-code/core/effect/logger"
import { KeyedMutex } from "@deepagent-code/core/effect/keyed-mutex"
import { InstanceState } from "@/effect/instance-state"
import { SessionRunState } from "./run-state"
import type { SessionSteer } from "./steer"
import { SessionPromptIntent } from "./prompt-intent"
import { writeGovernanceAudit } from "./goal-governance-audit"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LegacyExecutionUnavailable, guardLegacyExecution, refuseLegacyExecution } from "./legacy-execution-zero"
import { recordTurnEvidence } from "./v2-turn-evidence"
import { EventV2Bridge } from "@/event-v2-bridge"
import { V2AgentRoster } from "@/session/v2-agent-roster"
import { Database } from "@deepagent-code/core/database/database"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { ContextFederationReadiness } from "@/context-federation/readiness"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { SessionV2 } from "@deepagent-code/core/session"
import * as mechanismBeacon from "@deepagent-code/core/deepagent/mechanism-beacon"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import {
  AgentAttachment,
  FileAttachment,
  OutputFormat,
  Prompt,
  ReferenceAttachment,
  Source,
} from "@deepagent-code/core/session/prompt"
import { Reference } from "@/reference/reference"
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { referenceTextPart } from "./prompt/reference"
import { registerInitializer } from "@/effect/instance-registry"
import { EventRouteRef, InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import type { InstanceContext } from "@/project/instance-context"
import { SessionCompaction } from "./compaction"

// v2w-l2 prompt monolith teardown: this module carries ONLY the live V2-only surfaces the httpapi
// session ingress needs — the durable V2 admission path (prompt/promptAsync/promptOrSteer), the
// loop()'s V2-owner drive, cancel's V2 interrupt bridge, and the auxiliary intelligence surfaces
// (refineIntelligenceDraft/latestSuggestion). Everything here moved verbatim from session/prompt.ts
// (the deleted V1 monolith); the deleted code was the legacy executor: runLoop, the V1
// session_intent claim/renew/complete chains, createUserMessage, the legacy steer-buffer ingress,
// the legacy provider-owner lease runtime, and the legacy crash-recovery sweeps. The V2-only
// profile is hard-wired (RuntimeFlags.coreV2Only = Config.succeed(true) — not configurable), so
// every composition of this layer runs the V2 branches; the legacy branches were unreachable when
// they were deleted and their refusal semantics are preserved below (fail-closed, never a defect).

const decodeFormatSync = Schema.decodeUnknownSync(SessionV1.Format)

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })

function taskNotification(metadata: unknown) {
  if (!isRecord(metadata)) return undefined
  if (!isRecord(metadata.deepagent)) return undefined
  if (!isRecord(metadata.deepagent.task_notification)) return undefined
  const runID = metadata.deepagent.task_notification.run_id
  const outboxID = metadata.deepagent.task_notification.outbox_id
  if (typeof runID !== "string" || typeof outboxID !== "string") return undefined
  return { runID, outboxID }
}

// RI-135: the V2 admission mirror persists message metadata (legacy createUserMessage parity) so the
// task_notification redelivery short-circuit in prompt() can reconcile outbox retries against the
// persisted user row. The prompt_pipeline mode literal is normalized at admission: the legacy "wish"
// wire value maps to "intelligence"; an unrecognized mode degrades to "direct_override" exactly like
// the legacy submission branch. A block without a mode literal (e.g. confirmed-draft submissions,
// whose evidence lives at the admission level) passes through untouched.
function mirrorAdmissionMetadata(metadata: PromptInput["metadata"]) {
  if (!isRecord(metadata)) return undefined
  const deepagent = isRecord(metadata.deepagent) ? metadata.deepagent : undefined
  const pipeline = deepagent && isRecord(deepagent.prompt_pipeline) ? deepagent.prompt_pipeline : undefined
  if (!deepagent || !pipeline || typeof pipeline.mode !== "string") return metadata
  const mode = promptPipelineRequest(metadata).mode ?? "direct_override"
  return { ...metadata, deepagent: { ...deepagent, prompt_pipeline: { ...pipeline, mode } } }
}

// §S1.2 — a goal in one of these phases is no longer ticking, so a "goal_steer" would never be drained.
// promptOrSteer routes to the plain "steer" channel (or a fresh turn) instead. Mirrors goal-manager's
// isTerminalGoalPhase (kept as a local const to avoid a circular import: goal-manager imports the prompt surface).
const TERMINAL_GOAL_PHASES: ReadonlySet<string> = new Set(["done", "needs_human", "rolled_back", "stopped"])

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void, LegacyExecutionUnavailable>
  readonly prompt: (
    input: PromptInput,
  ) => Effect.Effect<SessionV1.WithParts, SessionPromptIntent.Error | Session.BusyError | LegacyExecutionUnavailable>
  readonly promptAsync: (
    input: PromptInput,
  ) => Effect.Effect<PromptAdmissionReceipt, SessionPromptIntent.Error | Session.BusyError | LegacyExecutionUnavailable>
  // LEGACY-EXECUTION-ZERO: the legacy steer-buffer admission is closed under the V2-only profile —
  // this surface is the typed firewall refusal. Goal steers admit on the V2 goal channel inside
  // promptOrSteer (delivery "goal_steer"); chat coalescing is the V2 admission contract itself.
  readonly steer: (input: {
    sessionID: SessionID
    prompt: Prompt
    delivery?: SessionSteer.Delivery
    messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionSteer.Admitted, LegacyExecutionUnavailable>
  // V4.1 §S1.2: the busy-session ingress decision. Under the V2-only profile (the only reachable
  // profile) a NON-terminal active goal routes to the V2 goal channel; everything else is a V2
  // chat admission (busy/steer coalescing is the V2 admission contract).
  readonly promptOrSteer: (
    input: PromptInput,
  ) => Effect.Effect<PromptOrSteerResult, SessionPromptIntent.Error | Session.BusyError | LegacyExecutionUnavailable>
  readonly loop: (
    input: LoopInput,
    onRunning?: Effect.Effect<void>,
  ) => Effect.Effect<SessionV1.WithParts, LegacyExecutionUnavailable | SessionPromptIntent.Conflict>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  // Admission-support model resolution shared with the command surface (session-command-v2):
  // currentModel resolves the session's effective model (session row → last user message → provider
  // default), the same resolution the command template/shell mirror paths consume.
  readonly currentModel: (
    sessionID: SessionID,
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string }, never, never>
  // The lane-interrupt assistant the shell lane and the loop's shell-busy queue resolve (RI-128):
  // the latest non-user message, or the newest message when only user rows exist.
  readonly lastAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
  readonly refineIntelligenceDraft: (input: {
    sessionID: SessionID
    rawInput: string
    outputLanguage?: AgentGateway.DeepAgentPromptPipeline.IntelligenceRefinementOutputLanguage
    onProgress?: (preview: string) => void
  }) => Effect.Effect<
    {
      prompt_draft_id: string
      context_plan_id: string
      state: string
      mode: "intelligence"
      route: "code" | "general"
      goal: string
      preview: string
    },
    AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError | LegacyExecutionUnavailable
  >
  // A3 macro-round: read the latest persisted next-round suggestion ({status, body}) so the UI can
  // surface it for human approval (high/max). Returns null when no suggestion has been produced.
  readonly latestSuggestion: (input: { sessionID: SessionID }) => Effect.Effect<{ status: string; body: string } | null>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionPromptV2") {}

export type PromptAdmissionReceipt = {
  readonly messageID: MessageID
  readonly delivery: SessionPromptIntent.Delivery
}

type PromptLifecycle = {
  readonly intent?: SessionPromptIntent.Receipt & {
    readonly state: "admitting"
    readonly ownerToken: string
    readonly messageID: MessageID
  }
  readonly ready: (input: PromptAdmissionReceipt) => Effect.Effect<void>
}

type ExecutePrompt = (
  input: PromptInput,
  lifecycle?: PromptLifecycle,
) => Effect.Effect<SessionV1.WithParts, SessionPromptIntent.Error | Session.BusyError | LegacyExecutionUnavailable>

type ExecutePromptOrSteer = (
  input: PromptInput,
  lifecycle?: PromptLifecycle,
) => Effect.Effect<PromptOrSteerResult, SessionPromptIntent.Error | Session.BusyError | LegacyExecutionUnavailable>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const compaction = yield* SessionCompaction.Service
    const config = yield* Config.Service
    const instances = yield* InstanceStore.Service
    const fsys = yield* FSUtil.Service
    const references = yield* Reference.Service
    const state = yield* SessionRunState.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const coreV2Session = yield* SessionV2.Service
    const federationReadiness = Option.getOrUndefined(yield* Effect.serviceOption(ContextFederationReadiness.Service))
    const parityCampaign = yield* V2ProviderTurn.CurrentCampaign
    const ownerCampaign = yield* V2ProviderTurn.CurrentOwnerCampaign
    const database = yield* Database.Service
    const coreV2OwnerQualified = yield* V2ProviderTurn.ownerQualified(database.db, ownerCampaign)
    const federationRollout = ContextFederationRollout.resolve(
      {
        contextFederationShadow: flags.contextFederationShadow,
        locationIndexesV2Shadow: flags.locationIndexesV2Shadow,
        contextProjectionV2: flags.contextProjectionV2,
        contextQueryToolsV2: flags.contextQueryToolsV2,
        coreV2ExecutionOwner: flags.coreV2ExecutionOwner,
      },
      { coreV2ParityVerified: coreV2OwnerQualified },
    )
    const { db } = database
    const scope = yield* Scope.Scope

    const rootSession = Effect.fn("SessionPrompt.rootSession")(function* (input: Session.Info) {
      const seen = new Set<SessionID>()
      let current = input
      while (current.parentID) {
        if (seen.has(current.id)) return yield* Effect.die(new Error(`Session parent cycle at ${current.id}`))
        seen.add(current.id)
        current = yield* sessions.get(current.parentID).pipe(Effect.orDie)
      }
      return current
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      // LEGACY-EXECUTION-ZERO: under the V2-only profile abort targets the V2 execution owner
      // (process-local interrupt, idle = no-op) instead of the legacy run-state cancel.
      yield* coreV2Session.interrupt(sessionID).pipe(
        Effect.catchTag("Session.LegacySessionRequiresAdoption", () =>
          refuseLegacyExecution({
            sessionID,
            reason: "legacy_session_requires_adoption",
            detail: "Historical V1-only session requires an explicit audited adoption before writing",
          }),
        ),
        Effect.catch((error) => (error instanceof LegacyExecutionUnavailable ? Effect.fail(error) : Effect.die(error))),
      )
      // RI-128: the `!` shell lane lives on the run-state Runner, decoupled from the V2 drain —
      // bridge cancel to it so a running shell aborts (and a loop queued behind it is released).
      yield* state.cancelShell(sessionID)
    })

    const resolveReferenceParts = Effect.fnUntraced(function* (template: string) {
      const parts: Types.DeepMutable<PromptInput["parts"]> = []
      const seen = new Set<string>()
      yield* Effect.forEach(
        ConfigMarkdown.files(template),
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          const alias = name.split("/")[0]
          if (!alias || seen.has(alias)) return
          const reference = yield* references.get(alias)
          if (!reference) return
          seen.add(alias)

          const start = match.index ?? 0
          const source = { value: match[0], start, end: start + match[0].length }
          if (reference.kind === "invalid") {
            parts.push(referenceTextPart({ reference, source }))
            return
          }

          yield* references.ensure(reference.path)
          parts.push({
            type: "file",
            url: pathToFileURL(reference.path).href,
            filename: alias,
            mime: "application/x-directory",
            source: { type: "file", text: source, path: alias },
          })
        }),
        { concurrency: 1, discard: true },
      )
      return parts
    })

    // LEGACY-EXECUTION-ZERO classification: write-free history helper — pure text/reference/file
    // resolution (filesystem reads only), no durable rows, no provider call. Exempt reader.
    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [
        { type: "text", text: template },
        ...(yield* resolveReferenceParts(template)),
      ]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const slash = name.indexOf("/")
          const alias = slash === -1 ? name : name.slice(0, slash)
          if (yield* references.get(alias)) return

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: 16, discard: true },
      )
      return parts
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const intelligenceRefinementModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const opts = (yield* config.get()).provider?.deepagent?.options
      // Legacy-compat: `wishModel` is the pre-rename option key. Prefer the new `intelligenceModel`
      // key but still read `wishModel` so an existing user's configured model keeps resolving.
      // Do NOT drop the `wishModel` read.
      const value = opts?.intelligenceModel ?? opts?.wishModel
      if (typeof value === "string") {
        const separator = value.indexOf("/")
        if (separator > 0 && separator < value.length - 1) {
          const candidate = {
            providerID: ProviderV2.ID.make(value.slice(0, separator)),
            modelID: ModelV2.ID.make(value.slice(separator + 1)),
          }
          // Graceful fallback: a syntactically valid but non-existent intelligenceModel (unknown provider
          // or model) must fall back to the session model rather than fail the intelligence refinement.
          // Probe getModel; only use the configured model if it actually resolves.
          const resolved = yield* provider.getModel(candidate.providerID, candidate.modelID).pipe(Effect.option)
          if (Option.isSome(resolved)) return candidate
        }
      }
      return yield* currentModel(sessionID)
    })

    const deepagentModelAuthProviderID = (model: Provider.Model) => {
      if (model.providerID !== "deepagent") return
      const value = model.options?.authProviderID
      return typeof value === "string" && value.length > 0 ? value : undefined
    }

    // Intelligence refinement asks the model for a JSON object describing the refined prompt, but we do
    // NOT force a structured/tool-call output: LLMs are non-deterministic, and a hard schema gate
    // makes weaker models (e.g. small/flash variants) fail the whole turn instead of producing a
    // usable result. We generate plain text and extract the JSON leniently — the goal is a clear,
    // readable refinement, not strict format compliance. If parsing fails, the caller fails soft.
    const extractIntelligenceJson = (text: string): unknown => {
      const trimmed = text.trim()
      // Prefer a fenced ```json block when present, else the first balanced-looking {...} span.
      const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
      const candidates: string[] = []
      if (fence?.[1]) candidates.push(fence[1].trim())
      const first = trimmed.indexOf("{")
      const last = trimmed.lastIndexOf("}")
      if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))
      candidates.push(trimmed)
      for (const c of candidates) {
        try {
          return JSON.parse(c)
        } catch {
          /* try next candidate */
        }
      }
      return undefined
    }

    const partialIntelligencePrompt = (text: string) => {
      const match = /"refined_prompt"\s*:\s*"/.exec(text)
      if (!match) return
      const escapes: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      }
      let preview = ""
      for (let index = match.index + match[0].length; index < text.length; index++) {
        const character = text[index]!
        if (character === '"') return preview
        if (character !== "\\") {
          preview += character
          continue
        }
        const escaped = text[index + 1]
        if (!escaped) return preview
        if (escaped !== "u") {
          preview += escapes[escaped] ?? escaped
          index++
          continue
        }
        const code = text.slice(index + 2, index + 6)
        if (!/^[0-9a-f]{4}$/i.test(code)) return preview
        preview += String.fromCharCode(Number.parseInt(code, 16))
        index += 5
      }
      return preview
    }

    const generateIntelligenceRefinement = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      rawInput: string
      outputLanguage?: AgentGateway.DeepAgentPromptPipeline.IntelligenceRefinementOutputLanguage
      onProgress?: (preview: string) => void
    }) {
      const cfg = yield* config.get()
      const model = yield* intelligenceRefinementModel(input.sessionID)
      const resolved = yield* provider.getModel(model.providerID, model.modelID)
      const language = yield* provider.getLanguage(resolved)
      const modelAuthID = deepagentModelAuthProviderID(resolved)
      const providerAuth = yield* auth.get(model.providerID).pipe(Effect.orDie)
      const modelAuth = modelAuthID ? yield* auth.get(modelAuthID).pipe(Effect.orDie) : undefined
      const authInfo = model.providerID === "deepagent" ? (modelAuth ?? providerAuth) : providerAuth
      const isOpenaiOauth = (model.providerID === "openai" || modelAuthID === "openai") && authInfo?.type === "oauth"
      const system = AgentGateway.DeepAgentPromptPipeline.intelligenceRefinementSystemPrompt(
        input.outputLanguage ?? "english",
      )

      // Feed the refiner the recent conversation so it reuses already-stated facts (target
      // directory, paths, prior decisions) instead of guessing them and emitting misleading
      // assumptions. Best-effort: history failures must not block refinement (first turn => none).
      const recent = yield* sessions
        .messages({ sessionID: input.sessionID, limit: 8 })
        .pipe(Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))
      const turns: AgentGateway.DeepAgentPromptPipeline.IntelligenceContextTurn[] = recent
        .filter((m) => m.info.role === "user" || m.info.role === "assistant")
        .map((m) => ({
          role: m.info.role as "user" | "assistant",
          text: m.parts
            .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text" && !p.synthetic && !p.ignored)
            .map((p) => p.text)
            .join("\n")
            .trim(),
        }))
        .filter((t) => t.text.length > 0)
      const briefing = AgentGateway.DeepAgentPromptPipeline.buildIntelligenceContextBriefing(turns)
      const contextMessages: ModelMessage[] = briefing
        ? [{ role: "user", content: AgentGateway.DeepAgentPromptPipeline.intelligenceContextMessage(briefing) }]
        : []

      const params = {
        temperature: 0.2,
        messages: [
          ...(isOpenaiOauth ? [] : ([{ role: "system", content: system }] satisfies ModelMessage[])),
          ...contextMessages,
          { role: "user", content: input.rawInput },
        ],
        model: language,
      } satisfies Parameters<typeof streamText>[0]
      const run = {
        callKind: "auxiliary_ai_call" as const,
        feature: "intelligence_prompt_prepare",
        providerID: model.providerID,
        modelID: model.modelID,
        sessionID: input.sessionID,
        auxiliaryCallID: `intelligence_${randomUUID()}`,
        agent: "intelligence.prepare",
        origin: {
          file: "packages/deepagent-code/src/session/prompt-v2.ts",
          function: "SessionPrompt.refineIntelligenceDraft",
        },
      }

      if (!isOpenaiOauth) configureGateway(cfg)
      return yield* AgentGateway.runAuxiliary(
        run,
        Effect.tryPromise(async (signal) => {
          const result = streamText({
            ...params,
            ...(isOpenaiOauth
              ? {
                  providerOptions: ProviderTransform.providerOptions(resolved, { instructions: system, store: false }),
                  onError: () => {},
                }
              : {}),
            abortSignal: signal,
          })
          let text = ""
          let preview = ""
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
            if (part.type !== "text-delta") continue
            text += part.text
            const next = partialIntelligencePrompt(text)
            if (!next || next === preview) continue
            preview = next
            input.onProgress?.(preview)
          }
          return extractIntelligenceJson(text)
        }),
      )
    })

    // A2: model-driven intelligence first-turn refinement. Calls the user-specified model to turn a raw
    // request into a complete, directly-executable prompt with explicit assumptions, persists a
    // draft, and returns its id/preview. The draft is NOT submitted here — the client shows the
    // preview in the input box for review and only later confirms via confirmedDraftID. General
    // chat can bypass DeepAgent when refinement is unavailable; code tasks fail closed instead of
    // pretending intelligence produced a useful prompt.
    const refineIntelligenceDraft = Effect.fn("SessionPrompt.refineIntelligenceDraft")(function* (input: {
      sessionID: SessionID
      rawInput: string
      outputLanguage?: AgentGateway.DeepAgentPromptPipeline.IntelligenceRefinementOutputLanguage
      onProgress?: (preview: string) => void
    }) {
      // W0-3b — refinement is an AUXILIARY-AI surface, not legacy execution: it runs one
      // AgentGateway.runAuxiliary model call (streaming SDK, no V1 durable rows) and persists the
      // draft as PromptDraftStore FILES (draftsDir JSON/MD, not database tables). The V1 intent
      // admission the old guard protected lives in the HTTP prepare handler, which skips it under
      // the profile; V2 prompt idempotency is carried by the SessionV2 messageID instead. The
      // LEGACY-EXECUTION-ZERO firewall does not apply (D2 classification: auxiliary_ai_call).
      const ctx = yield* InstanceState.context
      const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome(Global.Path.agent.data)
      const sessionPath = home.ensureSession(projectIDForDirectory(ctx.directory), input.sessionID)
      const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(sessionPath)
      const fallbackRoute = AgentGateway.DeepAgentPromptPipeline.classifyIntelligenceRoute(input.rawInput)

      const built = yield* Effect.gen(function* () {
        const output = AgentGateway.DeepAgentPromptPipeline.normalizeIntelligenceRefinementOutput(
          yield* generateIntelligenceRefinement(input),
          input.rawInput,
        )
        if (!output) {
          return yield* Effect.fail(
            new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError("invalid intelligence refinement output"),
          )
        }
        if (fallbackRoute === "code" && output.route === "general") {
          return yield* Effect.fail(
            new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError(
              "code intelligence refinement was routed as general",
            ),
          )
        }
        if (output.route === "general") {
          return {
            route: "general" as const,
            prompt_draft_id: "",
            context_plan_id: "",
            state: "general_ready",
            mode: "intelligence" as const,
            goal: output.goal.trim() || input.rawInput,
            preview: input.rawInput,
          }
        }
        if (!AgentGateway.DeepAgentPromptPipeline.isUsefulIntelligenceRefinement(input.rawInput, output)) {
          return yield* Effect.fail(
            new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError(
              "intelligence refinement did not improve the prompt",
            ),
          )
        }
        return {
          route: "code" as const,
          ...AgentGateway.DeepAgentPromptPipeline.draftFromIntelligenceRefinement(store, input.rawInput, output),
        }
      }).pipe(
        // Fail-soft only for obvious general chat. Code tasks need a real, useful refinement.
        Effect.catch(() =>
          fallbackRoute === "general"
            ? Effect.succeed({
                route: "general" as const,
                prompt_draft_id: "",
                context_plan_id: "",
                state: "general_ready",
                mode: "intelligence" as const,
                goal: input.rawInput,
                preview: input.rawInput,
              })
            : Effect.fail(
                new AgentGateway.DeepAgentPromptPipeline.PromptRefinerModelError(
                  "intelligence refinement failed for code task",
                ),
              ),
        ),
      )

      if (built.route === "general") return built
      return {
        prompt_draft_id: built.draft.id,
        context_plan_id: built.draft.context_plan_id,
        state: built.draft.state,
        mode: "intelligence" as const,
        route: "code" as const,
        goal: built.draft.goal,
        preview: AgentGateway.DeepAgentPromptPipeline.renderDraftMarkdown(built.draft),
      }
    })

    // LEGACY-EXECUTION-ZERO classification: read-only draft preview (disk read), no durable rows.
    // Exempt reader.
    const latestSuggestion = Effect.fn("SessionPrompt.latestSuggestion")(function* (input: { sessionID: SessionID }) {
      const ctx = yield* InstanceState.context
      return yield* Effect.sync(() => {
        const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome(Global.Path.agent.data)
        const sessionPath = home.ensureSession(projectIDForDirectory(ctx.directory), input.sessionID)
        const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(sessionPath)
        return store.loadLatestSuggestion()
      })
    })

    const buildPromptPipelineSubmission = Effect.fn("SessionPrompt.buildPromptPipelineSubmission")(function* (
      input: PromptInput,
    ) {
      const ctx = yield* InstanceState.context
      return yield* Effect.sync(() => {
        const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome(Global.Path.agent.data)
        const session = home.ensureSession(projectIDForDirectory(ctx.directory), input.sessionID)
        const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(session)
        const request = promptPipelineRequest(input.metadata)
        const mode = request.mode
        const rawInput = rawInputFromPromptParts(input.parts)

        if (request.confirmedDraftID) {
          store.confirm(request.confirmedDraftID, request.editedGoal)
          const submitted = store.submitConfirmed(request.confirmedDraftID)
          return {
            action: "submit" as const,
            parts: replacePromptText(input.parts, submitted.task_prompt),
            metadata: { mode: mode ?? "confirmed", confirmed: true, ...submitted },
          }
        }

        // Draft creation + review live in the real production entrypoint
        // (POST /session/{sessionID}/prompt_prepare). The client prepares a draft there, shows it
        // for review, and resubmits with confirmedDraftID (handled above). There is no
        // server-side requires_confirmation round-trip on the prompt submission path.
        const submitted = store.directOverride(rawInput)
        return {
          action: "submit" as const,
          parts: input.parts,
          metadata: {
            mode: mode ?? "direct_override",
            explicit: request.mode === "direct_override",
            ...submitted,
          },
        }
      })
    })

    // 1.4.8.r0 — V2 interactive execution: under the V2-only profile the legacy instance prompt
    // surface executes on the V2 owner. Admission is a SessionV2.prompt (resume:false, admission-
    // before-wake); the drain+projection rides loop()'s V2 branch; the V2→V1 mirror keeps the limited
    // history reader (App/TUI V1 projection) current. The typed refusal now fires ONLY before any
    // admission when the owner authorization (protected build identity campaign) is not verified —
    // no partial V2 state on refuse. Unmapped part kinds degrade to text (log-free best effort:
    // file/agent attachments are mapped, everything else keeps its text form).
    const interactiveV2Prompt = (input: PromptInput): Prompt => {
      const text = input.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter((value) => value.length > 0)
        .join("\n")
      const files = input.parts.flatMap((part) =>
        part.type === "file"
          ? [
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                ...(part.filename ? { name: part.filename } : {}),
                ...(part.source
                  ? {
                      source: new Source({
                        start: part.source.text.start,
                        end: part.source.text.end,
                        text: part.source.text.value,
                      }),
                    }
                  : {}),
              }),
            ]
          : [],
      )
      // INVARIANT (P2-2): subtask parts are deliberately NOT mapped here — a subtask command under
      // the profile must fail typed (requireV2PromptText empty-text refusal) instead of silently
      // becoming a plain V2 turn. Do not add subtask mapping before its V2 drive is wired.
      const agents = input.parts.flatMap((part) =>
        part.type === "agent" ? [new AgentAttachment({ name: part.name })] : [],
      )
      // RI-126: a json_schema format request rides the V2 admission (core runner consumes it
      // from the projected user message); text format is the default and needs no marker.
      const requestedFormat = input.format === undefined ? undefined : decodeFormatSync(input.format)
      const format =
        requestedFormat?.type === "json_schema"
          ? new OutputFormat({
              type: "json_schema",
              schema: requestedFormat.schema,
              retryCount: requestedFormat.retryCount,
            })
          : undefined
      return new Prompt({
        text,
        ...(files.length > 0 ? { files } : {}),
        ...(agents.length > 0 ? { agents } : {}),
        ...(format === undefined ? {} : { format }),
      })
    }

    // P2-7: a prompt with nothing mappable for V2 (all parts dropped) must fail typed instead of
    // admitting an empty prompt that the runner cannot execute meaningfully.
    const requireV2PromptText = (
      sessionID: SessionID,
      message: Prompt,
      input?: PromptInput,
    ): Effect.Effect<Prompt, LegacyExecutionUnavailable, never> =>
      message.text.trim().length > 0 || (message.files?.length ?? 0) > 0 || (message.agents?.length ?? 0) > 0
        ? Effect.succeed(message)
        : refuseLegacyExecution({
            sessionID,
            reason: "v2_owner_unavailable",
            detail: input?.parts.some((part) => part.type === "subtask")
              ? "subtask commands are not supported under the V2-only profile yet (the subagent drive is not wired); use the task tool inside a normal turn instead"
              : "V2 prompt admission has no mappable content (text/file/agent parts)",
          })

    // P2-10 (rN): lifecycle is accepted for call-site compatibility but not wired to V2 admission
    // (no lifecycle.ready under the profile); no production caller passes one under the profile today.
    // V1 and V2 share a projection row. Only the durable V2 authority marker grants write access;
    // ordinary prompt requests never create or repair an historical Session.
    const ensureV2Session = Effect.fn("SessionPrompt.ensureV2Session")(function* (sessionID: SessionID) {
      yield* coreV2Session.requireWritable(SessionV2.ID.make(sessionID)).pipe(
        Effect.catchTags({
          "Session.LegacySessionRequiresAdoption": () =>
            refuseLegacyExecution({
              sessionID,
              reason: "legacy_session_requires_adoption",
              detail: "Historical V1-only session requires an explicit audited adoption before writing",
            }),
          "Session.NotFoundError": () =>
            refuseLegacyExecution({
              sessionID,
              reason: "v2_stack_unavailable",
              detail: "Session has no V2 projection",
            }),
        }),
      )
    })

    const promptV2 = Effect.fn("SessionPrompt.promptV2")(function* (input: PromptInput, lifecycle?: PromptLifecycle) {
      // Call-time qualification: the campaign is minted by the r0 flow (possibly after server start),
      // so the layer-build snapshot is NOT the authority — read both the campaign tag and the
      // authorization at call time (mirrors the loop's V2-branch re-check).
      const ownerCampaignNow = yield* V2ProviderTurn.CurrentOwnerCampaign
      if (!(yield* V2ProviderTurn.ownerQualified(database.db, ownerCampaignNow)))
        return yield* refuseLegacyExecution({
          sessionID: input.sessionID,
          reason: "v2_owner_unavailable",
          detail: "V2 owner qualification is not verified for the V2-only profile",
        })
      yield* ensureV2Session(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const agentName = input.agent ?? session.agent ?? "build"
      // RI-136 + RI-26 read-model convergence: the EXECUTION authority decides. The V1 registry can
      // know names the Location roster cannot run, and a mirror validated against the wrong roster
      // displays a mode the provider turn never used (the pre-convergence loop/design seam).
      // Subagent-mode agents stay admissible here — the task/goal subagent drives prompt their child
      // sessions through this same path; the interactive selectable rule lives at create/switchAgent
      // (RI-04). A composition without a LocationServiceMap (bare legacy test graphs) has no V2
      // execution placement either and keeps the V1 read model.
      const v2SessionID = SessionV2.ID.make(input.sessionID)
      const roster = yield* V2AgentRoster.agentsFor({
        directory: AbsolutePath.make(session.directory),
        ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
      })
      const resolvedV2 = roster ? V2AgentRoster.resolveIn(roster, agentName) : undefined
      const resolvedV1 = roster ? undefined : Option.getOrUndefined(yield* agents.get(agentName).pipe(Effect.option))
      if (!resolvedV2 && !resolvedV1) {
        const available = roster
          ? V2AgentRoster.selectableNames(roster)
          : (yield* agents.list()).filter((item) => !item.hidden).map((item) => item.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        throw new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      }
      const agentMode = resolvedV2?.mode ?? resolvedV1?.mode ?? agentName
      // Propagate the selection into the V2 session so the runner resolves what the caller chose.
      // AgentSwitched owns the transition; only selectable primaries/all switch — subagent drives
      // run on child sessions whose agent was fixed at creation, and switchAgent would refuse them.
      if (resolvedV2) {
        const v2Current = yield* coreV2Session.get(v2SessionID).pipe(Effect.option)
        if (
          Option.isSome(v2Current) &&
          String(v2Current.value.agent ?? "") !== String(resolvedV2.id) &&
          resolvedV2.mode !== "subagent" &&
          !resolvedV2.hidden
        )
          yield* coreV2Session.switchAgent({ sessionID: v2SessionID, agent: String(resolvedV2.id) }).pipe(Effect.orDie)
      }
      // P2-6 (rN): this model identity is used ONLY for the V1 mirror row (display fidelity); the
      // drain's model resolution happens in the core runner from the V2 session store. The final
      // "test/test" fallback is a last-resort mirror label, never an execution input.
      const resolvedModel = resolvedV2?.model
        ? { providerID: resolvedV2.model.providerID, modelID: resolvedV2.model.id }
        : (resolvedV1?.model ?? undefined)
      const resolvedVariant = resolvedV2?.model?.variant ?? resolvedV1?.variant ?? undefined
      const model = input.model ??
        (session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined) ??
        resolvedModel ??
        Option.getOrUndefined(yield* provider.defaultModel().pipe(Effect.option)) ?? {
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("test"),
        }
      // RI-134: variant resolution mirrors the legacy createUserMessage contract — an explicit
      // input.variant always wins; the agent's configured variant applies only when the resolved
      // model is the agent's own model and that model declares the variant.
      const sameAgentModel =
        resolvedModel !== undefined &&
        model.providerID === resolvedModel.providerID &&
        model.modelID === resolvedModel.modelID
      const fullModel =
        input.variant === undefined && resolvedVariant !== undefined && sameAgentModel
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant =
        input.variant ??
        (resolvedVariant !== undefined && fullModel?.variants?.[resolvedVariant] !== undefined
          ? resolvedVariant
          : undefined)
      // The requested prompt model is a V2 execution input, not a mirror label: persist it onto
      // the V2 session BEFORE admission so the drain's catalog resolution sees the caller's choice.
      // An unknown model must keep failing (regression #27371) instead of silently falling back to
      // the catalog default — the refusal surfaces from the drain's catalog lookup.
      if (input.model)
        yield* coreV2Session
          .switchModel({
            sessionID: v2SessionID,
            model: {
              id: ModelV2.ID.make(input.model.modelID),
              providerID: ProviderV2.ID.make(input.model.providerID),
              ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
            },
          })
          .pipe(Effect.orDie)
      // P1-1: resume:false is the admission-before-wake contract — the interactive path drains
      // explicitly via loop(); a wake would race the drain into a second provider dispatch.
      const admittedInput = yield* coreV2Session
        .prompt({
          sessionID: v2SessionID,
          ...(input.messageID ? { id: SessionMessage.ID.make(input.messageID) } : {}),
          prompt: yield* requireV2PromptText(input.sessionID, interactiveV2Prompt(input), input),
          resume: false,
        })
        .pipe(
          // P2-8 (rN): V2 admission contract errors (including a legacy session without a V2
          // projection row) map into the legacy instance service union so the HTTP surface stays
          // typed (409 Conflict with a reason). A dedicated 404 mapping is an rN refinement.
          Effect.catch((error) =>
            Effect.fail(
              new SessionPromptIntent.Conflict({
                intentID: String(input.sessionID),
                reason: String((error as { message?: unknown }).message ?? (error as { _tag?: unknown })._tag ?? error),
              }),
            ),
          ),
        )
      // P2-10: wire lifecycle.ready to the V2 admission receipt when a caller supplied one — the
      // legacy intent-complete signal is a no-op for the V2 path but callers that wait on it must not
      // hang.
      if (lifecycle) yield* lifecycle.ready({ messageID: MessageID.make(admittedInput.id), delivery: "steer" })
      // V2→V1 mirror: same evidence contract as the subagent drive (all outcomes, best-effort).
      const evidence = recordTurnEvidence({
        sessions,
        session: coreV2Session,
        sessionID: input.sessionID,
        parentSessionID: input.sessionID,
        agentName,
        agentMode,
        model: { providerID: model.providerID, modelID: model.modelID },
      }).pipe(Effect.ignoreCause({ log: "Warn", message: "v2 interactive turn evidence unavailable" }))
      // Mirror BEFORE the drain: the loop V2 branch projects the assistant against the last V1 user
      // row, which only exists once the V2 user message has been mirrored.
      yield* evidence
      if (input.noReply === true) {
        // RI-124 adjudication (mirror-after-admission): admission is admit-only (P1-1 resume:false),
        // so the visible V2 user message is promoted only by the NEXT drain — neither the mirror
        // above nor the core journal→V1-wire egress can see it yet. Mirror the user row straight
        // from the admission receipt in the deterministic shape the core egress derives at
        // promotion (core projector legacyUserRow), plus the admission-side extras the egress never
        // authors: the resolved model variant (RI-134) and the normalized message metadata
        // (RI-135). The egress only CREATES user rows it cannot see, so the later promotion publish
        // is a no-op and the two writers never disagree. This replaces the legacy findMessage
        // fallback, which 503'd fresh sessions post-admission and returned a STALE earlier user
        // message on sessions with history.
        const created = DateTime.toEpochMillis(admittedInput.timeCreated)
        const messageID = SessionV1.MessageID.ascending(admittedInput.id)
        const metadata = mirrorAdmissionMetadata(input.metadata)
        const info: SessionV1.Info = {
          id: messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created },
          agent: agentName,
          model: {
            providerID: ProviderV2.ID.make(model.providerID),
            modelID: ModelV2.ID.make(model.modelID),
            ...(variant === undefined ? {} : { variant }),
          },
          ...(metadata === undefined ? {} : { metadata }),
        }
        const parts: SessionV1.Part[] = []
        if (admittedInput.prompt.text) {
          parts.push({
            id: SessionV1.PartID.ascending(`prt_${admittedInput.id.slice("msg_".length)}_0`),
            sessionID: input.sessionID,
            messageID,
            type: "text",
            text: admittedInput.prompt.text,
            time: { start: created, end: created },
          })
        }
        for (const [index, file] of (admittedInput.prompt.files ?? []).entries()) {
          parts.push({
            id: SessionV1.PartID.ascending(`prt_${admittedInput.id.slice("msg_".length)}_f${index}`),
            sessionID: input.sessionID,
            messageID,
            type: "file",
            url: file.uri,
            mime: file.mime,
            ...(file.name === undefined ? {} : { filename: file.name }),
            time: { start: created, end: created },
          } as SessionV1.Part)
        }
        yield* sessions.updateMessage(info)
        yield* Effect.forEach(parts, (part) => sessions.updatePart(part))
        return { info, parts }
      }
      return yield* loop({ sessionID: input.sessionID, drainFirst: true }).pipe(Effect.ensuring(evidence))
    })

    // W16 (O-W0-4): the V2-goal admission under the V2-only profile. Shares promptV2's pre-admission
    // guards (owner qualification + get-or-create adoption) but admits with delivery="goal_steer"
    // (SessionInput.Delivery literal, the W1.1 goal channel) and the DEFAULT resume (wake), so the
    // runner's drain-only turn delivers the guidance to the active goal's durable runtime state
    // WITHOUT a provider dispatch (the goal's own tick drives the model). This deliberately differs
    // from promptV2's chat-admission contract (resume:false + explicit loop): a goal steer is NOT a
    // chat activity — no transcript promotion, no V1 mirror, no loop. The wake also cannot race a
    // second provider dispatch here because the goal channel opens a drain-ONLY turn (llm.ts W1.1).
    // Under the profile NO legacy SessionSteer row is written — the W1 channel takes over admission;
    // the legacy buffer remains for the non-profile ingress and the goal-manager cold-path relay
    // (dual-channel convergence: both channels settle in the goal runtime state's pendingSteers).
    const promptV2GoalSteer = Effect.fn("SessionPrompt.promptV2GoalSteer")(function* (
      input: PromptInput,
      lifecycle?: PromptLifecycle,
    ) {
      const ownerCampaignNow = yield* V2ProviderTurn.CurrentOwnerCampaign
      if (!(yield* V2ProviderTurn.ownerQualified(database.db, ownerCampaignNow)))
        return yield* refuseLegacyExecution({
          sessionID: input.sessionID,
          reason: "v2_owner_unavailable",
          detail: "V2 owner qualification is not verified for the V2-only profile",
        })
      yield* ensureV2Session(input.sessionID)
      const admitted = yield* coreV2Session
        .prompt({
          sessionID: SessionV2.ID.make(input.sessionID),
          ...(input.messageID ? { id: SessionMessage.ID.make(input.messageID) } : {}),
          prompt: yield* requireV2PromptText(input.sessionID, interactiveV2Prompt(input), input),
          delivery: "goal_steer",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.fail(
              new SessionPromptIntent.Conflict({
                intentID: String(input.sessionID),
                reason: String((error as { message?: unknown }).message ?? (error as { _tag?: unknown })._tag ?? error),
              }),
            ),
          ),
        )
      // P2-10: same lifecycle contract as promptV2 — signal the V2 admission receipt with the goal
      // channel's delivery so lifecycle callers never hang.
      if (lifecycle) yield* lifecycle.ready({ messageID: MessageID.make(admitted.id), delivery: "goal_steer" })
      return admitted
    })

    const prompt: ExecutePrompt = Effect.fn("SessionPrompt.prompt")(function* (
      input: PromptInput,
      lifecycle?: PromptLifecycle,
    ) {
      yield* sessions.recoverForks()
      yield* sessions.assertRunnable(input.sessionID).pipe(Effect.orDie)
      const notification = taskNotification(input.metadata)
      if (notification && input.messageID) {
        const existing = yield* MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (existing) {
          const persisted = existing.info.role === "user" ? taskNotification(existing.info.metadata) : undefined
          if (
            existing.info.role !== "user" ||
            persisted?.runID !== notification.runID ||
            persisted.outboxID !== notification.outboxID
          )
            return yield* Effect.die(
              new Error(`Task notification message ID ${input.messageID} conflicts with persisted content`),
            )
          if (lifecycle) yield* lifecycle.ready({ messageID: existing.info.id, delivery: "turn" })
          return existing
        }
      }
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const current = yield* InstanceState.context
      const route = yield* EventRouteRef
      const root = yield* rootSession(session)
      if (
        !route ||
        FSUtil.resolve(route.directory) !== FSUtil.resolve(root.directory) ||
        route.workspaceID !== root.workspaceID
      ) {
        const rootContext =
          FSUtil.resolve(current.directory) === FSUtil.resolve(root.directory)
            ? current
            : yield* instances.load({ directory: root.directory })
        return yield* prompt(input, lifecycle).pipe(
          Effect.provideService(EventRouteRef, {
            ...rootContext,
            ...(root.workspaceID ? { workspaceID: root.workspaceID } : {}),
          }),
        )
      }
      if (FSUtil.resolve(session.directory) !== FSUtil.resolve(current.directory)) {
        return yield* instances.provide({ directory: session.directory }, prompt(input, lifecycle))
      }
      // 1.4.8.r0 + v2w-l2: under the V2-only profile the interactive prompt executes on the V2 owner.
      // The profile is hard-wired (RuntimeFlags.coreV2Only = Config.succeed(true)); the legacy
      // session_intent claim/execute chain that previously followed this point lived behind
      // `!flags.coreV2Only` — unreachable in every composition — and was deleted with the V1
      // monolith. A non-profile composition fails closed here instead of reaching legacy execution.
      if (!flags.coreV2Only)
        return yield* refuseLegacyExecution({
          sessionID: input.sessionID,
          reason: "v2_only_profile",
          detail: "V2-only profile: legacy execution is closed until the V2 execution owner is wired",
        })
      return yield* promptV2(input, lifecycle)
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    // LEGACY-EXECUTION-ZERO: the legacy steer-buffer admission is closed under the V2-only profile.
    // The refusal is the typed firewall contract (guardLegacyExecution); the unreachable V1 buffer
    // body was deleted with the monolith — goal steers admit on the V2 goal channel (promptOrSteer),
    // chat coalescing is the V2 admission contract. The guard always fails while this service
    // exists (the profile is hard-wired), so the success branch is unreachable and the cast only
    // satisfies the historical Admitted-typed signature callers still see.
    const steer = (input: {
      sessionID: SessionID
      prompt: Prompt
      delivery?: SessionSteer.Delivery
      messageID?: SessionMessage.ID
    }): Effect.Effect<SessionSteer.Admitted, LegacyExecutionUnavailable> =>
      guardLegacyExecution(flags, { sessionID: input.sessionID }) as Effect.Effect<
        SessionSteer.Admitted,
        LegacyExecutionUnavailable
      >

    // V4.1 §S1.2 — the ingress decision. Both the HTTP prompt route and the IM agent executor call THIS
    // instead of prompt() directly, so the steer-vs-turn choice lives in exactly one place.
    // v2w-l2: the V2-only profile is the only reachable profile — the legacy ingress branches
    // (steer-buffer admission + the drainPendingSteers race guard) lived behind !coreV2Only and were
    // deleted with the V1 monolith.
    const promptOrSteer: ExecutePromptOrSteer = Effect.fn("SessionPrompt.promptOrSteer")(function* (
      input: PromptInput,
      lifecycle?: PromptLifecycle,
    ) {
      // 1.4.8.r0: under the V2-only profile the ingress routes to the V2 owner (busy/steer
      // coalescing is the V2 admission contract).
      if (!flags.coreV2Only)
        return yield* refuseLegacyExecution({
          sessionID: input.sessionID,
          reason: "v2_only_profile",
          detail: "V2-only profile: legacy execution is closed until the V2 execution owner is wired",
        })
      // W16 (O-W0-4): the goalActive predicate moves BEFORE the promptV2 short-circuit. A running
      // goal's steer must land on the V2 goal channel (SessionInput delivery "goal_steer"), not as
      // the default "steer" chat input that the parent runner promotes into the transcript — under
      // the profile the goal would never receive it. The predicate is the SAME sync session-state
      // pointer read as the legacy branch (getActiveGoal + TERMINAL_GOAL_PHASES exclusion).
      const goal = AgentGateway.DeepAgentSessionState.getActiveGoal(input.sessionID)
      if (goal != null && !TERMINAL_GOAL_PHASES.has(goal.phase)) {
        const admitted = yield* promptV2GoalSteer(input, lifecycle)
        // V4.1 governance audit, aligned with the legacy goal-steer branch below: length-only
        // detail (bounded + PII-light), best-effort, after admission + lifecycle receipt. The
        // text comes from the same interactiveV2Prompt mapping the admission just made — the
        // admitted record is the V2 owner's return value and is not a reliable text source.
        writeGovernanceAudit(input.sessionID, goal.goalId, "steer", {
          textChars: interactiveV2Prompt(input).text.trim().length,
        })
        return { kind: "steer_v2" as const, delivery: "goal_steer" as const, admitted }
      }
      const message = yield* promptV2(input, lifecycle)
      return { kind: "turn" as const, message }
    })

    const promptAsync: (
      input: PromptInput,
    ) => Effect.Effect<
      PromptAdmissionReceipt,
      SessionPromptIntent.Error | Session.BusyError | LegacyExecutionUnavailable
    > = Effect.fn("SessionPrompt.promptAsync")(function* (input: PromptInput) {
      // 1.4.8.r0 + v2w-l2: under the V2-only profile prompt-async is a pure durable V2 admission.
      // The legacy claim/renew/Deferred chain lived behind !coreV2Only — unreachable — and was
      // deleted with the V1 monolith.
      if (!flags.coreV2Only)
        return yield* refuseLegacyExecution({
          sessionID: input.sessionID,
          reason: "v2_only_profile",
          detail: "V2-only profile: legacy execution is closed until the V2 execution owner is wired",
        })
      const ownerCampaignNow = yield* V2ProviderTurn.CurrentOwnerCampaign
      if (!(yield* V2ProviderTurn.ownerQualified(database.db, ownerCampaignNow)))
        return yield* refuseLegacyExecution({
          sessionID: input.sessionID,
          reason: "v2_owner_unavailable",
          detail: "V2 owner qualification is not verified for the V2-only profile",
        })
      yield* ensureV2Session(input.sessionID)
      // W0-3b — consume the confirmed intelligence draft before V2 admission. The submission
      // builder is the same pure path the V1 loop used (fs draft store: confirm + read the
      // task_prompt); under the profile it writes no legacy rows, so the refined text replaces
      // the first user text part exactly as the legacy createUserMessage would.
      const pipelineV2 = yield* buildPromptPipelineSubmission(input)
      const admitted = yield* coreV2Session
        .prompt({
          sessionID: SessionV2.ID.make(input.sessionID),
          ...(input.messageID ? { id: SessionMessage.ID.make(input.messageID) } : {}),
          prompt: yield* requireV2PromptText(
            input.sessionID,
            interactiveV2Prompt({ ...input, parts: pipelineV2.parts }),
            input,
          ),
          // P1-1: admission-before-wake — prompt-async is admit-only until its own resume/wake path.
          resume: false,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.fail(
              new SessionPromptIntent.Conflict({
                intentID: String(input.sessionID),
                reason: String((error as { message?: unknown }).message ?? (error as { _tag?: unknown })._tag ?? error),
              }),
            ),
          ),
        )
      // 1.4.8.rN: admission-before-execution — the interactive UI's promptAsync is admit-only
      // under the profile (resume:false) and nothing else drains it, so mirror the V2->V1 user
      // evidence FIRST (the loop V2 branch projects the assistant against the last V1 user row)
      // and then drive the drain explicitly, forked in the service scope like the legacy branch.
      // The run coordinator coalesces same-Session drains; a later wake joins this drain.
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const agentName = input.agent ?? session.agent ?? "build"
      const agentMode = Option.getOrUndefined(yield* agents.get(agentName).pipe(Effect.option))?.mode ?? agentName
      const model = input.model ??
        (session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined) ??
        Option.getOrUndefined(yield* provider.defaultModel().pipe(Effect.option)) ?? {
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("test"),
        }
      const evidence = recordTurnEvidence({
        sessions,
        session: coreV2Session,
        sessionID: input.sessionID,
        parentSessionID: input.sessionID,
        agentName,
        agentMode,
        model: { providerID: model.providerID, modelID: model.modelID },
      }).pipe(Effect.ignoreCause({ log: "Warn", message: "v2 interactive turn evidence unavailable" }))
      yield* evidence
      yield* loop({ sessionID: input.sessionID, drainFirst: true }).pipe(
        Effect.ensuring(evidence),
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.error("v2 interactive drain failed", { sessionID: input.sessionID, cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return { messageID: MessageID.make(admitted.id), delivery: admitted.delivery }
    })

    const loop: (
      input: LoopInput,
      onRunning?: Effect.Effect<void>,
    ) => Effect.Effect<SessionV1.WithParts, LegacyExecutionUnavailable | SessionPromptIntent.Conflict> = Effect.fn(
      "SessionPrompt.loop",
    )(function* (input: LoopInput, onRunning?: Effect.Effect<void>) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const current = yield* InstanceState.context
      const route = yield* EventRouteRef
      const root = yield* rootSession(session)
      if (
        !route ||
        FSUtil.resolve(route.directory) !== FSUtil.resolve(root.directory) ||
        route.workspaceID !== root.workspaceID
      ) {
        const rootContext =
          FSUtil.resolve(current.directory) === FSUtil.resolve(root.directory)
            ? current
            : yield* instances.load({ directory: root.directory })
        return yield* loop(input, onRunning).pipe(
          Effect.provideService(EventRouteRef, {
            ...rootContext,
            ...(root.workspaceID ? { workspaceID: root.workspaceID } : {}),
          }),
        )
      }
      if (FSUtil.resolve(session.directory) !== FSUtil.resolve(current.directory)) {
        return yield* instances.provide({ directory: session.directory }, loop(input, onRunning))
      }
      // FEAT-010: V2/legacy fork observability. Pure observation — the fork logic itself is
      // untouched (no tightening, no loosening). Every loop() execution records ONE info-level
      // structured slog with the owner selection plus the decision-factor snapshot, so production
      // audits can answer "was the V2 owner branch selected, and why (not)" at any time.
      // 1.4.8.r0: under the V2-only profile the V2 branch selection ignores the rollout gate and
      // keys on the durable owner qualification itself (call-time re-check: the campaign can be minted
      // after server start). Unqualified => typed refusal below.
      // P2-4: under the profile the campaign is call-time (minted after start); outside the profile
      // the layer-build value is authoritative — byte-identical to the pre-r0 behavior.
      const ownerCampaignNow = flags.coreV2Only ? yield* V2ProviderTurn.CurrentOwnerCampaign : ownerCampaign
      const v2OwnerSelected = flags.coreV2Only
        ? yield* V2ProviderTurn.ownerQualified(database.db, ownerCampaignNow)
        : federationRollout.enabled.coreV2ExecutionOwner
      mechanismBeacon.recordEngagement("v2_execution_owner", `owner=${v2OwnerSelected ? "v2" : "blocked"}`)
      yield* elog.info("v2 owner fork", {
        sessionID: input.sessionID,
        owner: v2OwnerSelected ? "v2" : flags.coreV2Only ? "blocked_v2_only" : "legacy",
        // P2-3: the decision is call-time under the profile — log the same values the branch used.
        ownerQualified: v2OwnerSelected,
        coreV2ExecutionOwnerFlag: flags.coreV2ExecutionOwner,
        coreV2ExecutionOwnerEnabled: v2OwnerSelected,
        parityCampaign: parityCampaign ? `${parityCampaign.id}:${parityCampaign.case}` : "none",
        ownerCampaign: ownerCampaignNow ?? "none",
        blockedReasons: federationRollout.blocked.coreV2ExecutionOwner ?? [],
      })
      if (v2OwnerSelected) {
        if (parityCampaign)
          return yield* Effect.die(new Error("V2 owner and parity recorder cannot run in the same process"))
        if (!(yield* V2ProviderTurn.ownerQualified(database.db, ownerCampaignNow)))
          return yield* flags.coreV2Only
            ? refuseLegacyExecution({
                sessionID: input.sessionID,
                reason: "v2_owner_unavailable",
                detail: "V2 owner qualification is not verified: " + (ownerCampaignNow ?? "none"),
              })
            : Effect.die(new Error("V2 owner qualification is not verified: " + (ownerCampaignNow ?? "none")))
        // R6 — the guard's purpose is preventing a CONCURRENT legacy dispatch while V2 owns the
        // session. Non-terminal legacy receipts whose owner lease is dead are harmless residue of
        // a crashed legacy run (V1-mode crash before flipping to the V2-only profile); refusing on
        // them forever bricks the session because the profile never runs the legacy sweep. Refuse
        // only while a live legacy owner lease backs a non-terminal receipt.
        const liveLegacyOwner = yield* database.db
          .select({ state: SessionToolRequestReceiptTable.provider_state })
          .from(SessionToolRequestReceiptTable)
          .innerJoin(
            SessionProviderOwnerLeaseTable,
            eq(SessionToolRequestReceiptTable.owner_token, SessionProviderOwnerLeaseTable.owner_token),
          )
          .where(
            and(
              eq(SessionToolRequestReceiptTable.session_id, input.sessionID),
              inArray(SessionToolRequestReceiptTable.provider_state, [
                "preparing",
                "prepared",
                "dispatching",
                "streaming",
              ]),
              isNull(SessionProviderOwnerLeaseTable.released_at),
              gt(
                SessionProviderOwnerLeaseTable.lease_expires_at,
                sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
              ),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (liveLegacyOwner)
          return yield* flags.coreV2Only
            ? refuseLegacyExecution({
                sessionID: input.sessionID,
                reason: "v2_owner_unavailable",
                detail: `Legacy provider owner is still active: ${input.sessionID}`,
              })
            : Effect.die(new Error(`Legacy provider owner is still active: ${input.sessionID}`))
        const v2Drain = Effect.gen(function* () {
          yield* elog.info("v2 owner branch selected", {
            sessionID: input.sessionID,
            owner: "v2",
            reason: "rollout_gate_open",
            ownerQualified: coreV2OwnerQualified,
            ownerCampaign: ownerCampaign ?? "none",
          })
          yield* status.set(input.sessionID, { type: "busy" })
          if (onRunning) yield* onRunning
          const readiness = yield* federationReadiness?.snapshot() ??
            Effect.succeed(ContextFederationReadiness.unavailableSnapshot())
          const ownerDecision = ContextFederationRollout.activate(
            ContextFederationRollout.resolveProject(federationRollout, session.projectID, {
              stage: flags.contextFederationRolloutStage,
              percentage: flags.contextFederationRolloutPercent,
              internalProjectScopeKeys: flags.contextFederationInternalProjects,
              killSwitch: flags.contextFederationKillSwitch,
            }),
            readiness,
          )
          // 1.4.8.r0: under the V2-only profile the rollout readiness gate does not apply — owner
          // qualification (checked above at call time) is the authority.
          if (!flags.coreV2Only && !ownerDecision.enabled.coreV2ExecutionOwner)
            return yield* flags.coreV2Only
              ? refuseLegacyExecution({
                  sessionID: input.sessionID,
                  reason: "v2_owner_unavailable",
                  detail: "V2 owner readiness gate is closed for the V2-only profile",
                })
              : Effect.die(new Error(`V2 owner readiness gate is closed: ${input.sessionID}`))
          // W4-6/6b-2: the F-17 in-process mirror is RETIRED. The journal→V1-wire egress in the
          // core projector (post-commit listener + durable fingerprint cursor) now derives the
          // wire rows for this drain as session.next.* events commit — crash-safe and
          // replay-convergent, unlike the drain-local mirrorPublished map this replaces. The
          // SSE surface (message.updated / message.part.updated) keeps the same shape, so the
          // run CLI and both clients are unaffected.
          yield* coreV2Session
            .resume(SessionV2.ID.make(input.sessionID))
            .pipe(Effect.provideService(V2ProviderTurn.CurrentOwnerCampaign, ownerCampaignNow))
            .pipe(
              // F-18 follow-up: a typed admission refusal (live in-flight attempt, expired
              // selection, unsafe retry) is a user-actionable "cannot run now", not a defect.
              // Surface the reason (already carried in the error message) on the session error
              // channel for the streaming surfaces, then fail with the typed Conflict the HTTP
              // layer maps to 409 + reason — instead of orDie-ing into a generic 500.
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (
                    !(
                      error instanceof SessionRunnerCanonical.AdmissionError ||
                      error instanceof V2ProviderTurn.UnsafeRetryError ||
                      error instanceof V2ProviderTurn.ConflictError
                    )
                  )
                    return yield* Effect.orDie(Effect.fail(error))
                  yield* events
                    .publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({ message: error.message }).toObject(),
                    })
                    .pipe(Effect.ignore)
                  return yield* Effect.fail(
                    new SessionPromptIntent.Conflict({ intentID: input.sessionID, reason: error.message }),
                  )
                }),
              ),
            )
          // FEAT-010: durable evidence correlation. The receipt row itself is written by the core
          // runner (V2ProviderTurn.admit inside SessionRunner.runTurn during resume); read back the
          // latest owner=v2 receipt so the slog trail ties this selection to its durable row.
          // Best-effort: never fails the turn.
          yield* database.db
            .select({
              receiptID: V2ProviderTurnReceiptTable.receipt_id,
              state: V2ProviderTurnReceiptTable.state,
            })
            .from(V2ProviderTurnReceiptTable)
            .where(
              and(
                eq(V2ProviderTurnReceiptTable.session_id, input.sessionID),
                eq(V2ProviderTurnReceiptTable.owner_mode, "v2"),
              ),
            )
            .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal))
            .get()
            .pipe(
              Effect.orDie,
              Effect.flatMap((receipt) =>
                elog.info("v2 owner turn receipt", {
                  sessionID: input.sessionID,
                  owner: "v2",
                  receiptID: receipt?.receiptID ?? "missing",
                  receiptState: receipt?.state ?? "missing",
                }),
              ),
            )
            .pipe(
              Effect.catchCause((cause) =>
                elog.warn("v2 owner turn receipt lookup failed", {
                  sessionID: input.sessionID,
                  owner: "v2",
                  error: Cause.pretty(cause),
                }),
              ),
            )
          const assistant = (yield* coreV2Session
            .context(SessionV2.ID.make(input.sessionID))
            .pipe(Effect.orDie)).findLast(
            (message): message is SessionMessage.Assistant => message.type === "assistant",
          )
          if (!assistant)
            return yield* flags.coreV2Only
              ? refuseLegacyExecution({
                  sessionID: input.sessionID,
                  reason: "v2_owner_unavailable",
                  detail: `V2 owner produced no assistant message: ${input.sessionID}`,
                })
              : Effect.die(new Error(`V2 owner produced no assistant message: ${input.sessionID}`))
          // 6b-2: the settle-time return derives from the folded V2 state through the same
          // canonical converter the egress uses (legacyAssistant). No wire-table write happens
          // here — the egress owns the wire rows now; this is only the loop's return value.
          const mirrorParent = yield* sessions
            .findMessage(input.sessionID, (message) => message.info.role === "user")
            .pipe(Effect.orDie)
          return SessionV2.legacyAssistant({
            sessionID: SessionV2.ID.make(input.sessionID),
            parentMessageID: Option.isSome(mirrorParent)
              ? Option.getOrThrow(mirrorParent).info.id
              : MessageID.make(assistant.id),
            directory: session.directory,
            root: current.worktree,
            message: assistant,
          })
        }).pipe(Effect.ensuring(status.set(input.sessionID, { type: "idle" })))
        // RI-128: a shell holds the session lane exclusively (V1 parity). While one runs, the loop
        // queues behind it on the run-state Runner instead of draining concurrently; cancel then
        // releases the queued loop with the interrupted-turn assistant via the lane's onInterrupt.
        if (yield* state.shellBusy(input.sessionID))
          return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), v2Drain)
        return yield* v2Drain
      }
      // v2w-l2: the legacy executor tail (V1 runLoop drive through state.ensureRunning) lived here
      // behind `!flags.coreV2Only` — unreachable in every composition (the profile is hard-wired)
      // — and was deleted with the V1 monolith. The refusal below is the fail-closed contract the
      // monolith produced under the profile: typed LegacyExecutionUnavailable, never a defect.
      return yield* refuseLegacyExecution({
        sessionID: input.sessionID,
        reason: "v2_owner_unavailable",
        detail: `V2 owner qualification is not verified for Session: ${input.sessionID}`,
      })
    })

    // Recovery attempts for one session serialize through this mutex: recursive instance loads
    // (loop() redirects into instances.load when the EventRoute differs, which re-runs this
    // initializer) can fork duplicate recovery loops before the fail-closed transition lands.
    const recoveryMutex = KeyedMutex.makeUnsafe<string>()

    const wakeCommittedContinuations = (ctx: InstanceContext) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const pending = yield* compaction.recoverableContinuations(ctx.project.id)
          yield* Effect.forEach(
            pending,
            (item) =>
              recoveryMutex
                .withLock(item.sessionID)(
                  Effect.gen(function* () {
                    // Re-check under the lock: a concurrent wake may already have failed the run
                    // closed while this fork was waiting.
                    const recoverable = yield* compaction.recoverableContinuations(ctx.project.id)
                    if (!recoverable.some((row) => row.runID === item.runID)) return
                    yield* loop({ sessionID: item.sessionID }).pipe(
                      Effect.catchCause((cause) =>
                        // provider recovery §10.1: continuation recovery is a Maintenance deliverable,
                        // so a failed attempt is the expected fail-closed outcome — warn (not
                        // error) and stop advertising the run as recoverable.
                        Effect.logWarning("compaction continuation recovery unavailable; failing closed").pipe(
                          Effect.annotateLogs({
                            runID: item.runID,
                            sessionID: item.sessionID,
                            messageID: item.messageID,
                            causeDetail: Cause.pretty(cause),
                          }),
                          Effect.andThen(
                            compaction
                              .failContinuationClosed({
                                runID: item.runID,
                                // Persist a stable, redacted authority reason. The full Cause is
                                // log-only and must never become part of replay/resolution state.
                                reason: "continuation_recovery_not_supported",
                              })
                              .pipe(Effect.provideService(Database.Service, database)),
                          ),
                        ),
                      ),
                    )
                  }),
                )
                .pipe(Effect.forkIn(scope)),
            { discard: true },
          )
        }).pipe(Effect.provideService(InstanceRef, ctx)),
      )
    const unregisterCompactionRecovery = yield* registerInitializer(wakeCommittedContinuations)
    const currentInstance = yield* InstanceRef
    if (currentInstance) {
      yield* Effect.promise(() => wakeCommittedContinuations(currentInstance)).pipe(Effect.forkIn(scope))
    }

    // Durable task execution is owned by the Core V2 TaskRunDispatcher + TaskOutbox runtime,
    // mounted process-globally next to this layer (app-runtime / httpapi server compose
    // TaskRunDispatcher.runtimeLayer). This layer no longer forks per-directory notification,
    // dispatch, or delivery daemons — there is exactly ONE background drain owner per process.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        unregisterCompactionRecovery()
      }),
    )

    const service = Service.of({
      cancel,
      prompt,
      promptAsync,
      steer,
      promptOrSteer,
      loop,
      resolvePromptParts,
      currentModel,
      lastAssistant,
      refineIntelligenceDraft,
      latestSuggestion,
    })
    return service
  }),
)

export const productionLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(Database.defaultLayer),
  ),
)

/** Standalone default. Production roots must provide one shared SessionV2 runtime to productionLayer. */
export const defaultLayer = productionLayer.pipe(Layer.provide(SessionV2.liveLayer))
const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  intentID: Schema.optional(Schema.String),
  intentSource: Schema.optional(Schema.Literals(["composer", "intelligence", "followup", "rewrite"])),
  intentVariant: Schema.optional(Schema.Literals(["original", "rewritten"])),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

// V4.1 §S1.1: the shape a mid-turn steer is admitted with. Deliberately the reduced Prompt payload (a
// steer is a plain user turn) — file/agent/reference attachments carry through so a steered @mention or
// attachment is preserved. `messageID` is optional so an at-least-once ingress (S1.2) can supply a
// stable idempotency id; when omitted, admit generates one.
export const SteerInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(SessionMessage.ID),
  text: Schema.String,
  files: Schema.optional(Schema.Array(FileAttachment)),
  agents: Schema.optional(Schema.Array(AgentAttachment)),
  references: Schema.optional(Schema.Array(ReferenceAttachment)),
  // §S1.3 delivery channel: "steer" (default, drained by the session runLoop) or "goal_steer" (drained
  // by the goal driver between ticks). Omitted ⇒ "steer".
  delivery: Schema.optional(Schema.Literals(["steer", "goal_steer"])),
})
export type SteerInput = Schema.Schema.Type<typeof SteerInput>

// §S1.2 the discriminated ack returned by promptOrSteer: either a completed turn (the session was idle)
// or an accepted steer (the session was mid-turn; the running/next turn absorbs it). The `delivery` tells
// the caller which channel absorbed it ("steer" = this session's turn, "goal_steer" = the active goal).
// `steer_v2` is the goal_steer ack under the V2-only profile: the steer was admitted on the V2 goal
// channel (SessionInput delivery "goal_steer") and NO legacy SessionSteer row exists — hence the
// distinct kind (wire consumers read only `admitted.id`, which both admitted shapes carry).
export type PromptOrSteerResult =
  | { readonly kind: "turn"; readonly message: SessionV1.WithParts }
  | { readonly kind: "steer"; readonly delivery: "steer" | "goal_steer"; readonly admitted: SessionSteer.Admitted }
  | { readonly kind: "steer_v2"; readonly delivery: "goal_steer"; readonly admitted: SessionInput.Admitted }

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
  // §S1.2: start a pure-drain turn that absorbs a pending steer on step 0 (no initiating message). Only
  // set by promptOrSteer's race guard; a normal loop() leaves it unset (false).
  drainFirst: Schema.optional(Schema.Boolean),
}) {}

const rawInputFromPromptParts = (parts: readonly PromptInput["parts"][number][]): string => {
  const text = parts
    .filter(
      (part): part is Extract<PromptInput["parts"][number], { type: "text" }> =>
        part.type === "text" && !part.synthetic,
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text || `[non-text prompt parts: ${parts.length}]`
}

const promptPipelineRequest = (
  metadata: unknown,
): {
  mode?: "intelligence" | "direct_override"
  confirmedDraftID?: string
  editedGoal?: string
} => {
  const deepagent = isRecord(metadata) && isRecord(metadata.deepagent) ? metadata.deepagent : {}
  const raw = isRecord(deepagent.prompt_pipeline) ? deepagent.prompt_pipeline : deepagent
  // Legacy-compat: "wish" is the pre-rename wire/metadata literal for "intelligence". Normalize it
  // so an older client (or a session persisted before the rename) whose mode is "wish" still
  // resolves to the intelligence pipeline.
  const rawMode = raw.mode === "wish" ? "intelligence" : raw.mode
  const mode = rawMode === "intelligence" || rawMode === "direct_override" ? rawMode : undefined
  return {
    mode,
    confirmedDraftID:
      typeof raw.confirmedDraftID === "string"
        ? raw.confirmedDraftID
        : typeof raw.confirmed_draft_id === "string"
          ? raw.confirmed_draft_id
          : undefined,
    editedGoal:
      typeof raw.editedGoal === "string"
        ? raw.editedGoal
        : typeof raw.edited_goal === "string"
          ? raw.edited_goal
          : undefined,
  }
}

const replacePromptText = (parts: readonly PromptInput["parts"][number][], text: string): PromptInput["parts"] => {
  let replaced = false
  const next = parts.map((part) => {
    if (part.type !== "text" || part.synthetic || replaced) return part
    replaced = true
    return { ...part, text }
  })
  return (replaced ? next : [{ type: "text" as const, text }, ...next]) as PromptInput["parts"]
}

// docs/34 §8: single canonical workspace-id derivation (shared with the gateway/retriever write+read
// sides). Delegates to the durable-knowledge-store helper so a project's durable knowledge tags and
// its retrieval filter agree on the same id.
const projectIDForDirectory = (directory: string): string =>
  AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(directory)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export * as SessionPromptV2 from "./prompt-v2"
