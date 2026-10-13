export * as EventDagNativeCrash from "@test/installation/fixture/event-dag-native-crash"

import fs from "node:fs/promises"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { EventWorkController } from "@deepagent-code/core/deepagent/event-work-controller"
import { EventWorkDagPolicy } from "@deepagent-code/core/deepagent/event-work-dag.policy"
import { EventWorkNodeAuthority } from "@deepagent-code/core/deepagent/event-work-node-authority"
import { EventWorkRuleSchema } from "@deepagent-code/core/deepagent/event-work-rule.schema"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppRuntime } from "@/effect/app-runtime"
import { LocalAuthority } from "@/installation/local-authority"
import { Service } from "@/installation/work-execution-profile"
import { NativeWorkKnownRecovery } from "@/installation/work-known-recovery"
import { EventWorkRuntime } from "@/session/event-work-admission"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { cmd } from "@/cli/cmd/cmd"

const descriptor = {
  originID: Schema.String,
  ruleID: Schema.String,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300_000)),
}
export const Input = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("setup-source"), directory: Schema.String }),
  Schema.Struct({ ...descriptor, mode: Schema.Literal("enable"), instruction: Schema.String }),
  Schema.Struct({ ...descriptor, mode: Schema.Literal("run"), triggerText: Schema.String,
    checkpointPath: Schema.optional(Schema.String) }),
  Schema.Struct({ mode: Schema.Literal("cold"), ruleID: Schema.String,
    expectedProviderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({ mode: Schema.Literal("recover"), request: WorkKnownRecoverySchema.Request }),
])

/** A debug entry in a signed fixture. All authority, placement and execution use the original
 * Root. The only crash seam is a post-commit event observer; it cannot grant or replay Work. */
export const execute = Effect.fn("EventDagNativeCrash.execute")(function* (input: typeof Input.Type) {
  const database = yield* Database.Service
  const sessions = yield* SessionV2.Service
  if (input.mode === "setup-source") {
    const source = yield* sessions.create({ title: "Native DAG fault ordinary source",
      agent: AgentV2.ID.make("auto"),
      model: { providerID: ProviderV2.ID.make("deepseek"), id: ModelV2.ID.make("deepseek-flash") },
      location: { directory: AbsolutePath.make(input.directory) },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    })
    return { mode: input.mode, sourceSessionID: source.id, projectID: source.projectID }
  }
  if (input.mode === "recover") {
    const config = yield* ServerAuth.Config
    const configured = yield* LocalAuthority.configured(config)
    const identity = yield* LocalAuthority.authenticatePassword(database.db, configured.runtime,
      config.username, configured.password)
    const outcome = yield* LocalAuthority.provide({ runtime: configured.runtime, witness: identity },
      NativeWorkKnownRecovery.recover(input.request)).pipe(Effect.exit)
    if (Exit.isSuccess(outcome)) return { mode: input.mode, accepted: true, receipt: outcome.value }
    const error = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.optional(Schema.String),
      _tag: Schema.optional(Schema.String) }), { onExcessProperty: "ignore" })(Cause.squash(outcome.cause))
    return { mode: input.mode, accepted: false,
      failure: Option.isSome(error) ? error.value : { _tag: "UNCLASSIFIED" } }
  }
  if (input.mode === "cold") {
    const rule = yield* database.db.get<{ directory: string; sourceSessionID: string }>(sql`SELECT
      json_extract(record,'$.target.location.directory') directory,
      json_extract(record,'$.origin.sourceSessionID') sourceSessionID FROM event_work_rule WHERE rule_id=${input.ruleID}`)
    if (!rule) throw new Error("Cold fixture has no original rule")
    yield* instance(rule.directory, rule.sourceSessionID)
    const before = yield* census(input.ruleID)
    if (before.providers !== input.expectedProviderCount) throw new Error("Cold startup replayed an original provider")
    // Let the actual startup/cadence run. No manual resume, recovery grant or SQL mutation.
    yield* Effect.sleep(750)
    const after = yield* census(input.ruleID)
    if (after.providers !== before.providers || after.effects !== before.effects)
      throw new Error("Cold cadence replayed an original provider or tool")
    return { mode: input.mode, before, after, providerIncrement: 0, effectIncrement: 0 }
  }
  const installed = yield* Service
  const runtime = yield* installed.eventWorkAuthority
  const actor = yield* database.db.transaction((tx) => LocalOperator.requireCurrent(tx))
    .pipe(Effect.provideService(LocalOperator.Runtime, runtime))
  if (actor.policy.version !== 4 || !installed.eventPlacement) throw new Error("Original DAG factory is unavailable")
  const origin = actor.policy.eventOrigins.find((value) => value.id === input.originID)
  const target = actor.policy.targets.find((value) => value.id === origin?.targetID)?.target
  if (!origin || !Schema.is(EventWorkRuleSchema.DagOrigin)(origin) || !target || !("version" in target) ||
    target.profile.id !== "event_deepseek_dag_v1" || target.provider.providerID !== "deepseek" ||
    target.provider.modelID !== "deepseek-flash" || origin.execution.plan.nodes.length !== 1)
    throw new Error("Fault fixture requires the original single-node DeepSeek DAG policy")
  const source = yield* sessions.get(SessionSchema.ID.make(origin.sourceSessionID))
  if (source.parentID || source.location.directory !== target.location.directory ||
    source.location.workspaceID !== undefined || source.projectID !== target.projectScope.projectID)
    throw new Error("Original ordinary source placement differs from the approved target")
  if (input.mode === "enable") {
    if (!(yield* installed.eventPlacement.available(target, origin.execution.plan)) ||
      !installed.eventPlacement.availableCurrent(target, origin.execution.plan))
      throw new Error("Original Native DAG product readiness refused; no availability override")
    const publicInstance = yield* instance(target.location.directory, source.id)
    if (!Array.isArray(publicInstance.candidates) || !publicInstance.candidates.some((value) => value.originID === origin.id && value.available))
      throw new Error("Original public candidate gate refused the approved DAG")
    yield* publicInstance.request("/api/v1/event-work/rules/control", { sourceSessionID: source.id, ruleID: input.ruleID,
      requestID: `${input.ruleID}:create`, action: "create", expectedRevision: 0,
      originID: origin.id, instruction: input.instruction, expiresAt: Date.now() + input.timeoutMs })
    yield* publicInstance.request("/api/v1/event-work/rules/control", { sourceSessionID: source.id, ruleID: input.ruleID,
      requestID: `${input.ruleID}:enable`, action: "enable", expectedRevision: 1 })
    return { mode: input.mode, publicCandidateAccepted: true, publicControlAccepted: true,
      originalProductReadiness: true, availabilityOverride: false, sourceSessionID: source.id,
      after: yield* census(input.ruleID) }
  }
  if (input.checkpointPath) {
    const checkpointPath = input.checkpointPath
    yield* (yield* EventV2Bridge.Service).listen((event) => Effect.gen(function* () {
      if (!Schema.is(SessionEvent.Tool.Success)(event)) return
      const effect = yield* database.db.get<{ workID: string; sessionID: string; controlRevision: number;
        claim: number; tool: string; state: string; error: string | null; proof: string | null }>(sql`SELECT
        w.work_id workID,w.session_id sessionID,w.control_revision controlRevision,s.execution_claim_token claim,
        e.tool_name tool,e.state state,e.error_code error,coalesce(e.known_write_proof,e.known_command_proof) proof
        FROM session_v2_tool_effect e JOIN work_execution w ON w.session_id=e.session_id
        JOIN session s ON s.id=w.session_id JOIN event_work_node_authority n ON n.work_id=w.work_id
        JOIN event_work_receipt r ON r.receipt_id=n.receipt_id
        WHERE r.rule_id=${input.ruleID} AND e.session_id=${event.data.sessionID} AND e.tool_call_id=${event.data.callID}`)
      if (!effect) return
      if (effect.state !== "settled" || effect.error !== null || !effect.proof || !effect.claim)
        throw new Error("Tool.Success observer did not follow the original committed Native effect")
      const observed = yield* census(input.ruleID)
      yield* Effect.promise(async () => {
        await fs.writeFile(`${checkpointPath}.pending`, JSON.stringify({ ...effect, proof: undefined,
          stage: "original-native-effect-committed", census: observed }), { mode: 0o600 })
        await fs.rename(`${checkpointPath}.pending`, checkpointPath)
      })
      // The independent parent kills this owned process. Provider/Native execution is unchanged.
      yield* Effect.never
    }).pipe(Effect.provideService(Database.Service, database), Effect.orDie))
  }
  yield* sessions.prompt({ sessionID: source.id, prompt: Prompt.fromUserMessage({ text: input.triggerText }),
    delivery: "queue", resume: false })
  yield* sessions.resume(source.id)
  // Start the original HTTP graph after the real source settles, so its initial pass
  // captures this occurrence. Starting it earlier would require its full 60s cadence.
  // No fixture invokes reconcile, dispatch, or a private replacement scheduler.
  yield* instance(target.location.directory, source.id)
  const deadline = Date.now() + input.timeoutMs
  const diagnosed = new Set<string>()
  while (Date.now() < deadline) {
    const row = yield* database.db.get<{ eventID: string; state: string }>(sql`SELECT r.event_id eventID,c.state state
      FROM event_work_controller c JOIN event_work_receipt r ON r.receipt_id=c.receipt_id WHERE r.rule_id=${input.ruleID}`)
    if (!row) {
      const observed = yield* database.db.get<{ eventID: string }>(sql`SELECT event_id eventID
        FROM event_work_receipt WHERE rule_id=${input.ruleID} AND phase='observed'`)
      if (observed && !diagnosed.has(observed.eventID)) {
        diagnosed.add(observed.eventID)
        const current = yield* EventWorkRuntime.make
        const source = yield* current.lookup(observed.eventID).pipe(Effect.exit)
        if (Exit.isFailure(source)) throw new Error(`Original pending DAG source lookup refused: ${Cause.pretty(source.cause)}`)
        const pending = yield* current.pendingDags
        console.info(JSON.stringify({ diagnostic: "original_pending_dag_source", eventID: observed.eventID,
          sourceLookupAccepted: true, pendingEvents: pending.map((value) => value.id) }))
      }
    }
    if (row?.state === "succeeded") {
      const controller = yield* EventWorkController.read(database.db, { eventID: row.eventID })
      if (!controller) throw new Error("Completed DAG has no original controller")
      const node = yield* EventWorkNodeAuthority.get(database.db,
        EventWorkDagPolicy.identities(controller.receipt.receiptID, origin.execution.plan.nodes[0].id).workID!)
      if (!node?.terminal || node.terminal.outcome !== "succeeded") throw new Error("Completed DAG has no original known terminal")
      // Read the producer's hash-validated durable terminal. Its successful run has
      // already released the temporary leaf witness; a second readKnown would retry it.
      return { mode: input.mode, eventID: row.eventID, rootWorkID: controller.controller.rootWorkID,
        terminal: node.terminal, after: yield* census(input.ruleID) }
    }
    if (row?.state === "failed" || row?.state === "unknown") throw new Error(`Original DAG ended ${row.state}; no retry`)
    yield* Effect.sleep(100)
  }
  throw new Error("Original DAG cadence did not finish within the fixed fault-fixture deadline")
})

function instance(directory: string, sourceSessionID: string) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const config = yield* ServerAuth.Config
    const configured = yield* LocalAuthority.configured(config)
    yield* LocalAuthority.authenticatePassword(database.db, configured.runtime, config.username, configured.password)
    const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
      (listener) => Effect.promise(() => listener.stop(true)))
    const request = (pathname: string, body: unknown) => Effect.tryPromise({ try: async () => {
      const url = new URL(pathname, listener.url)
      url.searchParams.set("directory", directory)
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${config.username}:${configured.password}`).toString("base64")}` }, body: JSON.stringify(body) })
      const result: unknown = await response.json()
      if (response.status !== 200) throw new Error(`Original public DAG control refused ${response.status}: ${JSON.stringify(result)}`)
      return result
    }, catch: (error) => error instanceof Error ? error : new Error("Original public DAG control failed") })
    const candidates = yield* request("/api/v1/event-work/candidates", { sourceSessionID })
    return { request, candidates }
  })
}

function census(ruleID: string) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db.get<{ providers: number; effects: number; nodes: number; receipts: number }>(sql`SELECT
      (SELECT count(*) FROM session_v2_provider_turn_receipt) providers,
      (SELECT count(*) FROM session_v2_tool_effect) effects,
      (SELECT count(*) FROM event_work_node_authority n JOIN event_work_receipt r ON r.receipt_id=n.receipt_id WHERE r.rule_id=${ruleID}) nodes,
      (SELECT count(*) FROM event_work_receipt WHERE rule_id=${ruleID}) receipts`)
  }).pipe(Effect.map((value) => { if (!value) throw new Error("Original fixture census is unavailable"); return value }))
}

export async function run() {
  const descriptorPath = process.env.DAC_EVENT_DAG_FAULT_INPUT
  const output = process.env.DAC_EVENT_DAG_FAULT_RESULT
  if (!descriptorPath || !output) throw new Error("Private DAG input and result paths are required")
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input), { onExcessProperty: "error" })(await fs.readFile(descriptorPath, "utf8"))
  const result = await AppRuntime.runPromise(execute(input).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit))
  await AppRuntime.dispose()
  await fs.writeFile(output, JSON.stringify(Exit.isSuccess(result) ? result.value : { error: Cause.pretty(result.cause) }), { mode: 0o600 })
  if (Exit.isFailure(result)) process.exitCode = 1
}

export const DebugCommand = cmd({ command: "debug", handler: run })
