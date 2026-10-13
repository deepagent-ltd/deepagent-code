import { Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import type { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { EventValidationHost } from "../../../src/deepagent/event-validation"
import { LocalAuthority } from "../../../src/installation/local-authority"
import { ServerAuth } from "../../../src/server/auth"

export function run(configuration: EventValidationSchema.Configuration, directory: string, mode = "store") {
  const database = Database.defaultLayer
  const services = Layer.mergeAll(EventValidationHost.defaultLayer, LocationIdentity.layer).pipe(
    Layer.provideMerge(database), Layer.provideMerge(ServerAuth.Config.defaultLayer), Layer.provide(FSUtil.defaultLayer))
  return Effect.gen(function*(){
    const db=(yield* Database.Service).db
    if (mode === "store-cold-read") {
      const host=yield* EventValidationHost.Service
      const before={runs:yield* db.all("SELECT * FROM event_validation_run ORDER BY run_id"),
        projects:yield* db.all("SELECT * FROM event_validation_project ORDER BY project_key")}
      yield* host.start
      // Beyond the real debounce window: a cold consumer must retain the other
      // process's original dispatching facts, even after its command has exited.
      yield* Effect.sleep(1200)
      const after={runs:yield* db.all("SELECT * FROM event_validation_run ORDER BY run_id"),
        projects:yield* db.all("SELECT * FROM event_validation_project ORDER BY project_key")}
      const runs=(yield* EventValidation.history(db,"actual-rule")).filter((run):run is EventValidationSchema.RunRecord=>run!==undefined)
      const counts=yield* db.get<{inputs:number;providers:number}>(sql`SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers`)
      return {unchanged:EventValidation.hash(before)===EventValidation.hash(after),count:runs.length,counts,
        runs:runs.map(run=>({state:run.state,observation:host.observation(run),retained:run.retainedBytes,released:run.releasedAt}))}
    }
    const session = mode === "store-capture" ? yield* Effect.gen(function* () {
      const { SessionV2 } = yield* Effect.promise(() => import("@deepagent-code/core/session"))
      return yield* Effect.gen(function* () {
        return yield* (yield* SessionV2.Service).create({ title: "Validation operator workspace", location: { directory: AbsolutePath.make(configuration.scope.canonicalRoot) } })
      }).pipe(Effect.provide(SessionV2.defaultLayer))
    }) : undefined
    const projectID=session?.projectID ?? "validation-project"
    const placement=yield* (yield* LocationIdentity.Service).resolve({boundary:{kind:"implicit_local"},
      directory:AbsolutePath.make(configuration.scope.canonicalRoot),project:{kind:"registered_root",observedProjectId:projectID}})
    const namespace=yield* db.get<{binding_hash:string}>(sql`SELECT binding_hash FROM context_security_namespace WHERE id=${placement.securityNamespaceId}`)
    if(!namespace)throw new Error("No actual namespace")
    const config=yield* ServerAuth.Config
    if(Option.isNone(config.password))throw new Error("No isolated operator configuration")
    const password=config.password.value
    yield* LocalAuthority.ensurePrivateInstallation()
    const identity=yield* LocalAuthority.configured(config)
    const provider={providerID:"unused-validation",modelID:"unused",protocol:"openai-responses",routeID:"unused",
      configurationHash:"a".repeat(64),endpoint:"https://example.invalid/v1/responses",evidenceID:"unused",evidenceHash:"b".repeat(64),
      endpointPinned:true,redirectsDenied:true,transportRetriesDenied:true,
      completion:{parameter:"max_output_tokens",hardLimit:true,includesReasoning:true,maxTokens:4096}}
    yield* LocalOperator.enroll(db,{operationID:"enroll",operatorID:"validation-operator",username:config.username,
      credentialVerifier:yield* Effect.promise(()=>Bun.password.hash(password,{algorithm:"argon2id",memoryCost:4096,timeCost:2})),
      policy:{version:2,targets:[{id:"project",locationKey:placement.locationKey,namespaceBindingHash:namespace.binding_hash,
        target:{version:2,scope:{actorID:"validation-operator",workspaceID:placement.canonicalRoot,securityNamespaceID:placement.securityNamespaceId,projectScopeKey:placement.projectScopeKey},
          location:{directory:placement.canonicalRoot},agentID:"auto",profile:{id:"project_work_v1",version:1,hash:WorkAuthorityPolicy.PROJECT_PROFILE_HASH},
          projectScope:{projectID,locationKey:placement.locationKey,namespaceBindingHash:namespace.binding_hash,
            canonicalRoot:placement.canonicalRoot,helperHash:configuration.helperHash,rootIdentity:configuration.scope.rootIdentity},
          contextPolicy:{kind:"scoped_project_history_v1",instructionsRevision:1,history:"same_work_activity",graphs:[],references:[],files:"approved_tool_results_only"},
          toolPolicy:{kind:"scoped_project_tools_v1",capabilities:[{toolID:"managed_command",definitionHash:"e".repeat(64),operations:["run"]}],
            fileScope:{read:configuration.watch.map(path=>({kind:"file",path})),write:[],deny:[],maxReadBytes:67108864,maxPageBytes:51200,maxHashBytes:16777216,maxWriteBytes:0,symlinks:"deny"},
            commandScope:[],commandRecipes:[configuration.recipe],integrations:[]},childPolicy:"deny_all",
          provider,budget:WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget,durationMs:60000}}]},
    }).pipe(Effect.provideService(LocalOperator.Runtime,identity.runtime))
    const witness=yield* LocalAuthority.authenticatePassword(db,identity.runtime,config.username,password)
    const auth={runtime:identity.runtime,witness}
    const actual={...configuration,scope:{...configuration.scope,instanceID:identity.runtime.instanceID,
      securityNamespaceID:placement.securityNamespaceId,namespaceBindingHash:namespace.binding_hash,locationKey:placement.locationKey,
      projectScopeKey:placement.projectScopeKey,projectID,canonicalRoot:placement.canonicalRoot}}
    const host=yield* EventValidationHost.Service
    if (mode === "store-prepare") {
      const { runPreparation } = yield* Effect.promise(() => import("./event-validation-preparation"))
      return yield* LocalAuthority.provide(auth,runPreparation({...actual,maxRuns:14}))
    }
    if (mode === "store-capture" && session) {
      const { runHTTP } = yield* Effect.promise(() => import("./event-validation-http"))
      return yield* runHTTP({ sessionID: session.id, configuration: actual, password })
    }
    yield* LocalAuthority.provide(auth,host.configure({ruleID:"actual-rule",requestID:"create",expectedRevision:0,configuration:actual}))
    yield* LocalAuthority.provide(auth,host.control({ruleID:"actual-rule",requestID:"enable",expectedRevision:1,action:"enable"}))
    const wait = (predicate:(rule:EventValidationSchema.RuleRecord,history:readonly EventValidationSchema.RunRecord[])=>boolean) => Effect.gen(function*(){
      const deadline=Date.now()+45000
      while(Date.now()<deadline){
        const rule=yield* EventValidation.getRule(db,"actual-rule")
        const history=(yield* EventValidation.history(db,"actual-rule")).filter((entry):entry is EventValidationSchema.RunRecord=>entry!==undefined)
        if(rule && predicate(rule,history))return {rule,history}
        yield* Effect.sleep(50)
      }
      throw new Error("Validation result did not reach its durable boundary")
    })
    if (mode === "store-cold-hold") {
      const active=yield* wait((_rule,history)=>history.some(run=>run.state==="dispatching" && run.processID!==null))
      yield* Effect.promise(()=>fs.writeFile(path.join(directory,"cold-ready.json"),JSON.stringify({runID:active.history[0]?.runID})))
      return yield* Effect.never
    }
    if (mode === "store-race") {
      const active=yield* wait((_rule,history)=>history.some(run=>run.state==="dispatching" && run.processID!==null))
      yield* Effect.promise(()=>fs.appendFile(path.join(configuration.scope.canonicalRoot,"guard.test.ts"),"\n// change while actual process is running\n"))
      const current=yield* wait((rule,history)=>history.length===2 && history.every(run=>run.releasedAt!==null) &&
        history.some(run=>run.resultCurrent && rule.currentRunID===run.runID))
      const latest=current.history.find(run=>run.resultCurrent)
      const prior=current.history.find(run=>run.runID===active.history[0]?.runID)
      yield* LocalAuthority.provide(auth,host.control({ruleID:"actual-rule",requestID:"manual-cancel",expectedRevision:2,action:"verify"}))
      yield* wait((_rule,history)=>history.some(run=>run.ruleRevision===3 && run.state==="dispatching" && run.processID!==null))
      yield* LocalAuthority.provide(auth,host.control({ruleID:"actual-rule",requestID:"cancel",expectedRevision:3,action:"cancel"}))
      const cancelled=yield* wait((_rule,history)=>history.length===3 && history.every(run=>run.releasedAt!==null))
      const stopped=cancelled.history.find(run=>run.ruleRevision===3)
      const counts=yield* db.get<{inputs:number;providers:number}>(sql`SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers`)
      return { prior:prior && {state:prior.state,current:prior.resultCurrent,content:prior.contentRevision,stop:prior.result?.stopConfirmed},
        latest:latest && {state:latest.state,current:latest.resultCurrent,content:latest.contentRevision},
        cancelled:stopped && {state:stopped.state,outcome:stopped.outcome,current:stopped.resultCurrent,stop:stopped.result?.stopConfirmed,
          stdout:stopped.result?.stdout.complete,stderr:stopped.result?.stderr.complete}, count:cancelled.history.length,counts }
    }
    const first=yield* wait((rule,history)=>history.some(run=>run.resultCurrent && run.releasedAt!==null && rule.currentRunID===run.runID))
    yield* Effect.promise(()=>fs.appendFile(path.join(configuration.scope.canonicalRoot,"binary.dat"),Buffer.from([255,0,128])))
    const changed=yield* wait((rule,history)=>rule.contentRevision>first.rule.contentRevision && history.some(run=>run.resultCurrent && run.releasedAt!==null && rule.currentRunID===run.runID))
    const manual={ruleID:"actual-rule",requestID:"manual",expectedRevision:2,action:"verify" as const}
    const requested=yield* LocalAuthority.provide(auth,host.control(manual))
    const verified=yield* wait((rule,history)=>rule.revision===3 && history.some(run=>run.ruleRevision===3 && run.resultCurrent && run.releasedAt!==null))
    const retry=yield* LocalAuthority.provide(auth,host.control(manual))
    yield* LocalAuthority.provide(auth,host.control({ruleID:"actual-rule",requestID:"pause",expectedRevision:3,action:"pause"}))
    yield* Effect.promise(()=>fs.appendFile(path.join(configuration.scope.canonicalRoot,"guard.test.ts"),"\n// paused modification\n"))
    yield* Effect.sleep(900)
    const paused=yield* host.list
    const history=yield* host.history("actual-rule")
    const counts=yield* db.get<{inputs:number;providers:number}>(sql`SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers`)
    return {first:first.history.length,changed:changed.history.length,verified:verified.history.length,final:history.length,
      outcomes:history.map(run=>run.outcome),allReleased:history.every(run=>run.releasedAt!==null),manifest:first.history[0]?.content.files,manual:requested.receipt,
      retry:retry.replayed,contentUnchangedOnManual:changed.rule.contentRevision===verified.rule.contentRevision,paused:paused[0]?.state,counts}
  }).pipe(Effect.provide(services),Effect.scoped)
}
