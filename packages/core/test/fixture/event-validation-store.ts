export * as EventValidationStoreFixture from "./event-validation-store"

import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { LocalOperator } from "../../src/im/local-operator"
import { EventValidation } from "../../src/deepagent/event-validation"
import { EventValidationSchema } from "../../src/deepagent/event-validation.schema"
import { WorkAuthorityFixture } from "./work-authority"
import { WorkRouteApprovalFixture } from "./work-route-approval"
import { IMTaskAuthorityFixture } from "./im-task-authority"
import { WorkAuthorityPolicy } from "../../src/session/work-authority-policy"

// Controlled native provenance, real formal-migration file DB and LocalOperator guards.
// The signed host oracle separately exercises actual sandboxed processes and filesystem.
export function native() {
  const state = { content: "first", executed: 0, outcome: "passed" as "passed" | "failed", refuseCleanup: false }
  const approvals = new WeakSet<object>()
  const observations = new WeakMap<object, EventValidationSchema.Content>()
  const handles = new WeakMap<object, { snapshot: NonNullable<ReturnType<EventValidation.Native["Service"]["snapshot"]>>; result?: EventValidationSchema.Result; cleaned: boolean }>()
  const service = EventValidation.Native.of({
    approve: () => Effect.sync(() => { const value = Object.freeze({}) as EventValidation.Approval; approvals.add(value); return value }),
    approved: (value) => approvals.has(value),
    observe: () => Effect.sync(() => {
      const value = Object.freeze({}) as EventValidation.Observation
      const digest = EventValidation.hash(state.content)
      observations.set(value, { files: [{ relative: "input.ts", identity: { kind: "posix", device: "1", inode: "2" },
        sha256: digest, bytes: Buffer.byteLength(state.content), missing: false }], contentHash: digest, observedAt: Date.now() })
      return value
    }),
    content: (value) => observations.get(value),
    preparation: () => Effect.fail(new EventValidationSchema.Error({ code:"VALIDATION_UNAVAILABLE",message:"Controlled producer has no preparation failure proof" })),
    cleanupPreparation: () => Effect.fail(new EventValidationSchema.Error({ code:"VALIDATION_UNAVAILABLE",message:"Controlled producer has no preparation failure proof" })),
    disposition: () => undefined,
    prepare: (configuration, observation, basename) => Effect.sync(() => {
      const content = observations.get(observation)
      if (!content) throw new Error("No owned observation")
      const value = Object.freeze({}) as EventValidation.Handle
      handles.set(value, { snapshot: { snapshotHash: EventValidation.hash(content), incarnation: basename,
        configHash: EventValidation.hash(configuration), contentHash: content.contentHash, workspaceBasename: basename,
        workspaceIdentity: { kind: "posix", device: "1", inode: "3" } }, cleaned:false })
      return value
    }),
    snapshot: (value) => handles.get(value)?.snapshot,
    execute: (value, hooks) => Effect.gen(function* () {
      const entry = handles.get(value)
      if (!entry) throw new Error("No owned handle")
      yield* hooks.beforeDispatch; yield* hooks.started(1234); state.executed++
      const stream = { sha256:EventValidation.hash(""),bytes:0,capturedBytes:0,truncated:false,complete:true,excerptTruncated:false,excerpt:"" }
      entry.result = { outcome:state.outcome,exitCode:state.outcome === "passed" ? 0 : 1,signal:null,stdout:stream,stderr:stream,stopConfirmed:true,endedAt:Date.now() }
    }),
    result: (value) => handles.get(value)?.result,
    cleanup: (value) => Effect.sync(() => { const entry=handles.get(value); if (!entry?.result || state.refuseCleanup) throw new Error("No cleanup proof"); entry.cleaned=true }),
    cleaned: (value) => handles.get(value)?.cleaned === true,
  })
  return { state, service }
}
export function configuration() {
  const value = { profile:"project_validation_v1",kind:"build",
    scope:{instanceID:WorkRouteApprovalFixture.runtime.instanceID,workspaceID:null,
      securityNamespaceID:IMTaskAuthorityFixture.proof.securityNamespaceID, namespaceBindingHash:IMTaskAuthorityFixture.proof.namespaceBindingHash,
      locationKey:IMTaskAuthorityFixture.target.location.directory,projectScopeKey:IMTaskAuthorityFixture.target.scope.projectScopeKey,
      projectID:"project-validation",canonicalRoot:IMTaskAuthorityFixture.target.location.directory,rootIdentity:{kind:"posix",device:"1",inode:"1"}},
    recipe:{schemaVersion:"work-command-recipe.v1",logicalID:"build",revision:1,
      executable:{assetPath:"packages/work-file-helper/bin/darwin-arm64/bun-command-runtime",sha256:"c".repeat(64),bytes:10,
        platform:"darwin-arm64",identity:{kind:"posix",device:"1",inode:"4"}},argv:[{kind:"literal",value:"build"}],
      parameters:[],cwd:null,inputs:["input.ts"],outputs:["output.js"],environment:[],workspace:"private_explicit_files.v1",
      sandbox:{id:"darwin-single-process-workspace-v1",revision:1,network:"deny",processes:1,openFiles:64,maxInputFiles:256,
        maxInputFileBytes:16777216,maxInputBytes:67108864,maxDepth:16,maxOutputFiles:32,maxOutputFileBytes:1048576,maxOutputBytes:33554432},
      timeoutMs:60000,stdoutBytes:1048576,stderrBytes:1048576},helperHash:"d".repeat(64),parameters:[],watch:["input.ts"],recipient:"local_status",
    maxRuns:20,expiresAt:Date.now()+300000,investigation:"disabled",autoFix:false } satisfies EventValidationSchema.Configuration
  const decoded = Schema.decodeUnknownSync(EventValidationSchema.Configuration)(value)
  return { ...decoded, recipe: Schema.decodeUnknownSync(EventValidationSchema.MacRecipe)(decoded.recipe) }
}
export async function fixture(body: (input: { run:<A,E>(effect:Effect.Effect<A,E,Database.Service>)=>Promise<A>; native:ReturnType<typeof native>; configuration:EventValidationSchema.Configuration })=>Promise<void>) {
  const root=await fs.mkdtemp("/tmp/dac-ev-store-")
  const producer=native()
  const configured=configuration()
  const layer=WorkAuthorityFixture.database(path.join(root,"file.sqlite"))
  const run=<A,E>(effect:Effect.Effect<A,E,Database.Service>)=>Effect.runPromise(Effect.gen(function*(){
    yield* (yield* Database.Service).db.run("PRAGMA foreign_keys=ON")
    return yield* effect
  }).pipe(Effect.provide(layer),Effect.scoped))
  try {
    await run(Effect.gen(function*(){
      yield* WorkRouteApprovalFixture.initialize
      const db=(yield* Database.Service).db
      yield* db.run("UPDATE context_project_scope_identity SET observed_project_id='project-validation'")
      yield* db.run("UPDATE context_location_identity SET observed_project_id='project-validation'")
      yield* authorized(db.transaction((tx) => Effect.gen(function* () {
        const actor=yield* LocalOperator.requireCurrent(tx)
        yield* LocalOperator.updatePolicyInTransaction(tx,{expectedRevision:actor.revision,now:Date.now(),policy:{version:2,
          targets:WorkRouteApprovalFixture.policy.targets.map(entry=>({...entry,target:{...entry.target,version:2,
            profile:{id:"project_work_v1",version:1,hash:WorkAuthorityPolicy.PROJECT_PROFILE_HASH},
            projectScope:{projectID:configured.scope.projectID,locationKey:configured.scope.locationKey,
              namespaceBindingHash:configured.scope.namespaceBindingHash,canonicalRoot:configured.scope.canonicalRoot,
              rootIdentity:configured.scope.rootIdentity,helperHash:configured.helperHash},
            contextPolicy:{kind:"scoped_project_history_v1",instructionsRevision:1,history:"same_work_activity",graphs:[],references:[],files:"approved_tool_results_only"},
            toolPolicy:{kind:"scoped_project_tools_v1",capabilities:[{toolID:"managed_command",definitionHash:"e".repeat(64),operations:["run"]}],
              fileScope:{read:configured.watch.map(path=>({kind:"file",path})),write:[],deny:[],maxReadBytes:67108864,maxPageBytes:51200,maxHashBytes:16777216,maxWriteBytes:0,symlinks:"deny"},
              commandScope:[],integrations:[],commandRecipes:[configured.recipe]},childPolicy:"deny_all"}}))}})
      })))
    }).pipe(Effect.provideService(LocalOperator.Runtime,WorkRouteApprovalFixture.runtime)))
    await body({run,native:producer,configuration:configured})
  } finally { await fs.rm(root,{recursive:true,force:true}) }
}
export function authorized<A,E,R>(effect:Effect.Effect<A,E,R>) {
  return Effect.gen(function*(){ const db=(yield* Database.Service).db
    const actor=yield* db.transaction((tx)=>LocalOperator.requireCurrent(tx))
    return yield* effect.pipe(Effect.provideService(LocalOperator.Mutation,LocalOperator.mutationWitness(actor)))
  }).pipe(Effect.provideService(LocalOperator.Runtime,WorkRouteApprovalFixture.runtime))
}

