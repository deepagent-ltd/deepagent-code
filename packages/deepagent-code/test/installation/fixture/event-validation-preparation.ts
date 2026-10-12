import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { watch } from "node:fs"
import path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationConsumer } from "@deepagent-code/core/deepagent/event-validation-consumer"
import type { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"

export const runPreparation = Effect.fn(function* (configuration: EventValidationSchema.Configuration) {
  const db=(yield* Database.Service).db
  const native=yield* EventValidation.Native
  const global=yield* Global.Service
  yield* EventValidation.configure(db,{ruleID:"preparation",requestID:"create",expectedRevision:0,configuration})
  yield* EventValidation.control(db,{ruleID:"preparation",requestID:"enable",expectedRevision:1,action:"enable"})
  const results:string[]=[]
  const runtime=path.join(path.dirname(process.execPath),"bun-command-runtime")
  const original=yield* Effect.promise(()=>fs.readFile(path.join(configuration.scope.canonicalRoot,"binary.dat")))
  const released: { run: EventValidationSchema.RunRecord; preparation: EventValidation.Preparation }[]=[]
  for(let index=0;index<11;index++) {
    if(index) yield* EventValidation.control(db,{ruleID:"preparation",requestID:`verify-${index}`,expectedRevision:index+1,action:"verify"})
    const observation=yield* EventValidation.observe(db,"preparation",true)
    const claimed=yield* EventValidation.claim(db,"preparation",observation.observation,"actual-preparation-owner")
    if(!claimed)throw new Error("No preparation reservation")
    const run=claimed.run
    const previous=released.at(-1)
    if(previous) {
      const before={run:yield* EventValidation.getRun(db,run.runID),projects:yield* db.all("SELECT * FROM event_validation_project")}
      assert.equal(Exit.isFailure(yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,previous.preparation).pipe(Effect.exit)),true)
      assert.deepEqual(yield* EventValidation.releasedPreparation(db,previous.run.runID,previous.run.ownerToken,previous.preparation),previous.run)
      assert.deepEqual({run:yield* EventValidation.getRun(db,run.runID),projects:yield* db.all("SELECT * FROM event_validation_project")},before)
    }
    yield* EventValidation.preparing(db,run.runID,run.ownerToken)
    assert.equal(Exit.isFailure(yield* EventValidation.startPreparation(db,{...run},observation.observation).pipe(Effect.exit)),true)
    assert.equal(Exit.isFailure(yield* EventValidation.startPreparation(db,(yield* EventValidation.getRun(db,run.runID))!,observation.observation).pipe(Effect.exit)),true)
    const preparation=yield* EventValidation.startPreparation(db,run,observation.observation)
    assert.equal(Exit.isFailure(yield* EventValidation.startPreparation(db,run,observation.observation).pipe(Effect.exit)),true)
    yield* Effect.scoped(Effect.gen(function*(){
      // Eight real pre-mkdir failures must not permanently consume all eight slots.
      if(index<8) yield* Effect.promise(()=>fs.chmod(runtime,0o600))
      if(index===8 || index===9) yield* Effect.promise(()=>fs.appendFile(path.join(configuration.scope.canonicalRoot,"binary.dat"),Buffer.from([255])))
      const prepare=native.prepare(configuration,observation.observation,run.workspaceBasename,run.deadline,preparation)
      const failed=index===10 ? yield* Effect.gen(function*(){
        const signal: { resolve?:()=>void }={}
        const created=new Promise<void>(resolve=>{signal.resolve=resolve})
        const watcher=watch(path.join(global.data,"work-command-stage"),(_event,name)=>{if(name?.toString()===run.workspaceBasename)signal.resolve?.()})
        const fiber=yield* prepare.pipe(Effect.forkChild)
        yield* Effect.promise(()=>created).pipe(Effect.timeout("5 seconds"),Effect.ensuring(Effect.sync(()=>watcher.close())))
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }) : yield* prepare.pipe(Effect.exit,
        Effect.ensuring(Effect.promise(()=>index<8 ? fs.chmod(runtime,0o755) : fs.writeFile(path.join(configuration.scope.canonicalRoot,"binary.dat"),original))))
      assert.equal(Exit.isFailure(failed),true)
      assert.equal(native.disposition({...preparation}),undefined)
      assert.equal(Exit.isFailure(yield* native.cleanupPreparation({...preparation}).pipe(Effect.exit)),true)
      assert.equal(Exit.isFailure(yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,{...preparation}).pipe(Effect.exit)),true)
      const workspace=path.join(global.data,"work-command-stage",run.workspaceBasename)
      if(index>=8)assert.equal(workspaceOpen(workspace),true)
      if(index===9) {
        yield* Effect.promise(()=>fs.writeFile(path.join(workspace,"foreign.txt"),"not part of the owned snapshot",{mode:0o600}))
        assert.equal(Exit.isFailure(yield* native.cleanupPreparation(preparation).pipe(Effect.exit)),true)
        assert.equal(native.disposition(preparation),undefined)
        assert.equal(Exit.isFailure(yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,preparation).pipe(Effect.exit)),true)
        assert.equal((yield* EventValidation.getRun(db,run.runID))?.retainedBytes,102825984)
        // The fixture removes only its injected foreign file; production never does.
        yield* Effect.promise(()=>fs.unlink(path.join(workspace,"foreign.txt")))
      }
      yield* native.cleanupPreparation(preparation)
      const disposition=native.disposition(preparation)
      assert.equal(disposition?.kind,index<8 ? "no_workspace_created" : "partial_workspace_cleaned")
      assert.equal(Exit.isFailure(yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,disposition as unknown as EventValidation.Preparation).pipe(Effect.exit)),true)
      assert.equal(yield* Effect.promise(()=>awaitExists(workspace)),false)
      const terminal=yield* EventValidation.finishBeforeDispatch(db,run.runID,run.ownerToken)
      assert.equal(terminal.result,null)
      const receipt=yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,preparation)
      assert.equal(receipt.retainedBytes,0)
      assert.deepEqual(yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,preparation),receipt)
      released.push({run:receipt,preparation})
      results.push(disposition!.kind)
    }))
    assert.equal(workspaceOpen(path.join(global.data,"work-command-stage",run.workspaceBasename)),false)
    const children=Bun.spawnSync(["/bin/ps","-ax","-o","ppid=,comm="],{stdout:"pipe",stderr:"pipe"})
    assert.equal(children.exitCode,0)
    assert.equal(children.stdout.toString().split("\n").some(line=>line.trim().startsWith(`${process.pid} `) &&
      /(?:deepagent-work-file-helper|sandbox-exec)/.test(line)),false)
  }
  const counts=yield* db.get<{inputs:number;providers:number;runs:number;retained:number}>("SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers,count(*) runs,sum(retained_bytes) retained FROM event_validation_run")
  assert.deepEqual(counts,{inputs:0,providers:0,runs:11,retained:0})
  const consumer=yield* Effect.scoped(Effect.gen(function*(){
    const consumer=yield* EventValidationConsumer.make(db,configuration.scope.instanceID)
    yield* EventValidation.control(db,{ruleID:"preparation",requestID:"verify-consumer",expectedRevision:12,action:"verify"})
    const signal: { resolve?:(name:string)=>void }={}
    const created=new Promise<string>(resolve=>{signal.resolve=resolve})
    const watcher=watch(path.join(global.data,"work-command-stage"),(_event,name)=>{
      if(name?.toString().startsWith("cmd_"))signal.resolve?.(name.toString())
    })
    yield* consumer.hint("preparation",true)
    const name=yield* Effect.promise(()=>created).pipe(Effect.timeout("5 seconds"),Effect.ensuring(Effect.sync(()=>watcher.close())))
    yield* consumer.cancel("preparation")
    const run=(yield* EventValidation.history(db,"preparation")).find(run=>run?.workspaceBasename===name)
    assert.equal(run?.retainedBytes,0)
    assert.equal(run?.result,null)
    assert.equal(run?.processID,null)
    assert.equal(run?.preparationRelease?.kind,"partial_workspace_cleaned")
    assert.equal(yield* Effect.promise(()=>awaitExists(path.join(global.data,"work-command-stage",name))),false)
    assert.deepEqual(consumer.live(),{timers:0,running:0})
    return {state:run?.state,kind:run?.preparationRelease?.kind,retained:run?.retainedBytes}
  }))
  const finalCounts=yield* db.get<{inputs:number;providers:number;runs:number;retained:number}>("SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers,count(*) runs,sum(retained_bytes) retained FROM event_validation_run")
  assert.deepEqual(finalCounts,{inputs:0,providers:0,runs:12,retained:0})
  const barrier=yield* Effect.scoped(Effect.gen(function*(){
    yield* EventValidation.control(db,{ruleID:"preparation",requestID:"verify-barrier",expectedRevision:13,action:"verify"})
    const observation=yield* EventValidation.observe(db,"preparation",true)
    const claimed=yield* EventValidation.claim(db,"preparation",observation.observation,"actual-barrier-owner")
    if(!claimed)throw new Error("No barrier reservation")
    const run=claimed.run
    const preparation=yield* EventValidation.startPreparation(db,run,observation.observation)
    yield* EventValidation.preparing(db,run.runID,run.ownerToken)
    const handle=yield* native.prepare(configuration,observation.observation,run.workspaceBasename,run.deadline,preparation)
    yield* EventValidation.prepared(db,run.runID,run.ownerToken,handle)
    yield* native.execute(handle,{beforeDispatch:EventValidation.dispatch(db,run.runID,run.ownerToken,handle).pipe(Effect.provideService(EventValidation.Native,native),Effect.asVoid),
      started:pid=>EventValidation.started(db,run.runID,run.ownerToken,pid).pipe(Effect.asVoid)})
    assert.equal(native.result(handle)?.stopConfirmed,true)
    assert.equal(Exit.isFailure(yield* native.cleanupPreparation(preparation).pipe(Effect.exit)),true)
    assert.equal(native.disposition(preparation),undefined)
    assert.equal(Exit.isFailure(yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,preparation).pipe(Effect.exit)),true)
    yield* EventValidation.markUnknown(db,run.runID,run.ownerToken)
    yield* native.cleanup(handle)
    assert.equal(Exit.isFailure(yield* EventValidation.releasedPreparation(db,run.runID,run.ownerToken,preparation).pipe(Effect.exit)),true)
    assert.equal(Exit.isFailure(yield* EventValidation.released(db,run.runID,handle).pipe(Effect.exit)),true)
    const retained=yield* EventValidation.getRun(db,run.runID)
    assert.equal(retained?.state,"unknown")
    assert.equal(retained?.retainedBytes,102825984)
    assert.equal(retained?.releasedAt,null)
    return {state:retained?.state,retained:retained?.retainedBytes,stopConfirmed:native.result(handle)?.stopConfirmed}
  }))
  const barrierCounts=yield* db.get<{inputs:number;providers:number;runs:number;retained:number}>("SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers,count(*) runs,sum(retained_bytes) retained FROM event_validation_run")
  assert.deepEqual(barrierCounts,{inputs:0,providers:0,runs:13,retained:102825984})
  return {results,counts,consumer,finalCounts,barrier,barrierCounts,descriptorsClosed:11,helpersStopped:11}
})
function workspaceOpen(filename:string){
  const descriptors=Bun.spawnSync(["/usr/sbin/lsof","-a","-p",String(process.pid),"-Fn"],{stdout:"pipe",stderr:"pipe"})
  assert.equal(descriptors.exitCode,0)
  return descriptors.stdout.toString().split("\n").some(line=>line.startsWith("n") && line.includes(filename))
}
function awaitExists(filename:string){return fs.lstat(filename).then(()=>true,(error:unknown)=>{
  if(typeof error==="object" && error!==null && "code" in error && error.code==="ENOENT")return false
  throw error
})}
