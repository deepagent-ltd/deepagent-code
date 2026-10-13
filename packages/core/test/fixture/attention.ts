import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, LayerMap } from "effect"
import { Database } from "../../src/database/database"
import { Attention } from "../../src/attention"
import { AttentionSchema } from "../../src/attention/schema"
import { SessionRestart } from "../../src/session/execution/restart"
import { SessionRunner } from "../../src/session/runner"
import { SessionStore } from "../../src/session/store"
import { SessionSchema } from "../../src/session/schema"
import { SessionMessage } from "../../src/session/message"
import { SessionInputTable, SessionTable, TaskRunTable } from "../../src/session/sql"
import { Prompt } from "../../src/session/prompt"
import { SessionActivityTable } from "../../src/context-federation/session-sql"
import { SessionProviderOwner } from "../../src/context-federation/provider-owner"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "../../src/session/runner/v2-tool-effect.sql"
import { V2ProviderTurnReceiptTable } from "../../src/session/runner/v2-provider-turn.sql"
import { EventV2 } from "../../src/event"
import { LocationServiceMap } from "../../src/location-layer"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { Delegation } from "../../src/tool/delegation"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { MessageID } from "../../src/v1/session"
import { WorkspaceV2 } from "../../src/workspace"

export const capability = Attention.localCapability({ profile: "implicit-local", gateway: false })

export const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp("/tmp/deepagent-attention-")),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

export function services(
  filename: string,
  run: SessionRunner.Interface["run"] = () => Effect.die("Unexpected attention wake"),
  access: AttentionSchema.Capability = capability,
  providedDatabase?: Layer.Layer<Database.Service>,
) {
  const database = providedDatabase ?? Database.layerFromPath(filename)
  const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const events = EventV2.layer.pipe(Layer.provide(database))
  const locations = Layer.effect(
    LocationServiceMap,
    LayerMap.make(() => Layer.succeed(SessionRunner.Service, { run })).pipe(
      // Only the provider boundary is controlled. Execution, events, claims and recovery use real services.
      Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
    ),
  )
  const execution = SessionExecutionLocal.layer.pipe(
    Layer.provide(Layer.mergeAll(store, events, locations, Delegation.delegationSlotLayer)),
  )
  const restart = SessionRestart.layer.pipe(Layer.provide(Layer.mergeAll(database, store, execution)))
  return Attention.layer().pipe(
    Layer.provideMerge(Layer.mergeAll(database, store, execution, events, restart, owners)),
    Layer.provide(Layer.succeed(Attention.Access, access)),
  )
}

export function seedSession(
  database: Database.Interface,
  name: string,
  options: { project?: string; workspace?: string; claim?: number; native?: boolean } = {},
) {
  return Effect.gen(function* () {
    const project = options.project ?? "project-a"
    const id = SessionSchema.ID.make(`ses_attention_${name}`)
    yield* database.db
      .insert(ProjectTable)
      .values({
        id: Project.ID.make(project),
        worktree: AbsolutePath.make(path.join("/tmp", project)),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.make(project),
        directory: path.join("/tmp", project),
        slug: name,
        title: name,
        version: "test",
        v2_authority: options.native ?? true,
        execution_claim_token: options.claim,
        workspace_id: options.workspace ? WorkspaceV2.ID.make(options.workspace) : undefined,
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })
}

export function seedActivity(
  database: Database.Interface,
  sessionID: SessionSchema.ID,
  name: string,
  state: typeof SessionActivityTable.$inferInsert.state = "failed",
  time = 100,
) {
  return Effect.gen(function* () {
    const input = SessionMessage.ID.make(`msg_attention_${name}`)
    yield* database.db
      .insert(SessionInputTable)
      .values({
        id: input,
        session_id: sessionID,
        prompt: new Prompt({ text: "attention fixture" }),
        delivery: "steer",
        admitted_seq: time,
        promoted_seq: time,
        time_created: time,
      })
      .run()
      .pipe(Effect.orDie)
    // fixture-exempt: persisted terminal/crash history is the authority under test.
    yield* database.db
      .insert(SessionActivityTable)
      .values({
        activity_id: `activity_${name}`,
        session_id: sessionID,
        ordinal: time,
        trigger_input_id: input,
        delivery: "steer",
        state,
        created_at: time,
        settled_at: state === "active" ? null : time + 1,
      })
      .run()
      .pipe(Effect.orDie)
    return `activity_${name}`
  })
}

export function seedRecovery(
  database: Database.Interface,
  name: string,
  disposition: SessionRestart.PendingRecovery["disposition"],
  options: { project?: string; workspace?: string; claim?: number } = {},
) {
  return Effect.gen(function* () {
    const id = yield* seedSession(database, name, { ...options, claim: options.claim ?? 12345 })
    if (disposition === "claim_only") return id
    if (
      disposition === "safe_before_dispatch" ||
      disposition === "recovery_required" ||
      disposition === "owned_elsewhere"
    ) {
      // fixture-exempt: a legacy task crash row tests the production read-only classifier.
      yield* database.db
        .insert(TaskRunTable)
        .values({
          run_id: `task_${name}`,
          request_hash: "a".repeat(64),
          parent_session_id: id,
          parent_message_id: MessageID.make(`msg_${name}`),
          tool_call_id: `call_${name}`,
          child_session_id: SessionSchema.ID.make(`ses_child_${name}`),
          generation: 1,
          delivery_mode: "background",
          phase: "research",
          time_created: 1,
          time_updated: 1,
          state: disposition === "safe_before_dispatch" ? "queued" : "running",
          execution_owner: disposition === "owned_elsewhere" ? `owner_${name}` : null,
          lease_expires_at: disposition === "owned_elsewhere" ? Date.now() + 3_600_000 : null,
        } satisfies typeof TaskRunTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      return id
    }
    if (disposition === "terminal_consistent") {
      const common = {
        session_id: id,
        provider_attempt_id: `attempt_${name}`,
        receipt_id: `receipt_${name}`,
        tool_call_id: `call_${name}`,
        tool_name: "read",
        effect_kind: "read_only" as const,
        owner_token: `owner_${name}`,
        time_created: 1,
      }
      // fixture-exempt: an immutable terminal effect and admission model a settled crash watermark.
      yield* database.db
        .insert(V2ToolEffectAdmissionTable)
        .values({ ...common, admission_id: `admission_${name}` })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(V2ToolEffectTable)
        .values({
          ...common,
          effect_id: `effect_${name}`,
          state: "settled",
          outcome_hash: "a".repeat(64),
          grant_receipt_id: `grant_${name}`,
          grant_owner_id: `grant_owner_${name}`,
          grant_state: "settled",
          grant_version: 1,
        })
        .run()
        .pipe(Effect.orDie)
      return id
    }
    const owners = yield* SessionProviderOwner.Service
    const owner = yield* owners.register({ ownerToken: `owner_${name}`, leaseMs: 60000 })
    // fixture-exempt: an admitted receipt with no attempt binding is an authority conflict.
    yield* database.db
      .insert(V2ProviderTurnReceiptTable)
      .values({
        receipt_id: `receipt_${name}`,
        session_id: id,
        request_ordinal: 1,
        activity_id: `activity_${name}`,
        provider_turn_seq: 1,
        user_message_id: `msg_${name}`,
        history_prompt_epoch: 1,
        request_input_hash: "a".repeat(64),
        provider_id: "fixture",
        model_id: "fixture",
        protocol: "responses",
        owner_mode: "v2",
        owner_token: `owner_${name}`,
        state: "preparing",
        created_at: owner.registeredAt,
      })
      .run()
      .pipe(Effect.orDie)
    yield* owners.release({ ownerToken: owner.ownerToken })
    return id
  })
}
