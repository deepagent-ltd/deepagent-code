import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { EventValidation } from "../src/deepagent/event-validation"
import { EventValidationStoreFixture } from "./fixture/event-validation-store"

test("file DB exact commands, content CAS, manual reapproval and cold unknown retain single project owner",()=>EventValidationStoreFixture.fixture(async f=>{
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function*(){
    const db=(yield* Database.Service).db
    const create={ruleID:"build-rule",requestID:"create",expectedRevision:0,configuration:f.configuration}
    const first=yield* EventValidation.configure(db,create)
    expect((yield* EventValidation.configure(db,create))).toEqual({...first,replayed:true})
    yield* EventValidation.control(db,{ruleID:"build-rule",requestID:"enable",expectedRevision:1,action:"enable"})
    const observed=yield* EventValidation.observe(db,"build-rule",true)
    const claimed=yield* EventValidation.claim(db,"build-rule",observed.observation,"owner")
    if (!claimed) throw new Error("No run")
    expect(yield* EventValidation.claim(db,"build-rule",observed.observation,"other")).toBeUndefined()
    yield* EventValidation.preparing(db,claimed.run.runID,"owner")
    const handle=yield* f.native.service.prepare(f.configuration,observed.observation,claimed.run.workspaceBasename,claimed.run.deadline)
    yield* EventValidation.prepared(db,claimed.run.runID,"owner",handle)
    yield* f.native.service.execute(handle,{beforeDispatch:EventValidation.dispatch(db,claimed.run.runID,"owner",handle).pipe(Effect.provideService(EventValidation.Native,f.native.service),Effect.asVoid),
      started:pid=>EventValidation.started(db,claimed.run.runID,"owner",pid).pipe(Effect.asVoid)})
    f.native.state.content="second"
    const newer=yield* EventValidation.observe(db,"build-rule",true)
    const late=yield* EventValidation.finish(db,claimed.run.runID,"owner",handle)
    expect(late).toMatchObject({state:"superseded",resultCurrent:false,outcome:"passed"})
    expect((yield* EventValidation.getRule(db,"build-rule"))?.currentRunID).toBeNull()
    yield* f.native.service.cleanup(handle);yield* EventValidation.released(db,late.runID,handle)
    const next=yield* EventValidation.claim(db,"build-rule",newer.observation,"owner2")
    if(!next)throw new Error("No second run")
    yield* EventValidation.preparing(db,next.run.runID,"owner2")
    const pending=yield* f.native.service.prepare(f.configuration,newer.observation,next.run.workspaceBasename,next.run.deadline)
    yield* EventValidation.prepared(db,next.run.runID,"owner2",pending)
    yield* EventValidation.dispatch(db,next.run.runID,"owner2",pending)
    yield* EventValidation.markUnknown(db,next.run.runID,"owner2")
    expect(Exit.isFailure(yield* EventValidation.released(db,next.run.runID,pending).pipe(Effect.exit))).toBe(true)
    expect((yield* EventValidation.getRun(db,next.run.runID))?.releasedAt).toBeNull()
    const verify={ruleID:"build-rule",requestID:"manual",expectedRevision:2,action:"verify" as const}
    const manual=yield* EventValidation.control(db,verify)
    expect(manual.receipt.ruleRevision).toBe(3)
    expect((yield* EventValidation.getRule(db,"build-rule"))?.contentRevision).toBe(2)
    expect((yield* EventValidation.control(db,verify)).replayed).toBe(true)
    expect(yield* EventValidation.claim(db,"build-rule",newer.observation,"cold")).toBeUndefined()
    expect(yield* db.get("SELECT count(*) count FROM session_input")).toEqual({count:0})
    expect(yield* db.get("SELECT count(*) count FROM session_v2_provider_turn_receipt")).toEqual({count:0})
  }).pipe(Effect.provideService(EventValidation.Native,f.native.service),Effect.scoped)))
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function*(){const db=(yield* Database.Service).db
    expect(yield* EventValidation.canSchedule(db,EventValidation.projectKey(f.configuration.scope))).toBe(false)
    expect((yield* EventValidation.history(db,"build-rule")).map(run=>run?.state)).toContain("unknown")
  })))
  expect(f.native.state.executed).toBe(1)
}))

test("file DB pause and revoked namespace prevent dispatch and cannot synthesize terminal process evidence",()=>EventValidationStoreFixture.fixture(async f=>{
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function*(){
    const db=(yield* Database.Service).db
    yield* EventValidation.configure(db,{ruleID:"rule",requestID:"create",expectedRevision:0,configuration:f.configuration})
    yield* EventValidation.control(db,{ruleID:"rule",requestID:"enable",expectedRevision:1,action:"enable"})
    const observed=yield* EventValidation.observe(db,"rule",true)
    const claimed=yield* EventValidation.claim(db,"rule",observed.observation,"owner")
    if(!claimed)throw new Error("No claim")
    yield* EventValidation.preparing(db,claimed.run.runID,"owner")
    const handle=yield* f.native.service.prepare(f.configuration,observed.observation,claimed.run.workspaceBasename,claimed.run.deadline)
    yield* EventValidation.control(db,{ruleID:"rule",requestID:"pause",expectedRevision:2,action:"pause"})
    expect(Exit.isFailure(yield* EventValidation.dispatch(db,claimed.run.runID,"owner",handle).pipe(Effect.exit))).toBe(true)
    const refused=yield* EventValidation.finishBeforeDispatch(db,claimed.run.runID,"owner")
    expect(refused).toMatchObject({state:"cancelled",outcome:"cancelled",result:null,processID:null,releasedAt:null})
    expect(yield* EventValidation.canSchedule(db,claimed.run.projectKey)).toBe(true)
    yield* db.run(sql`UPDATE context_security_namespace SET retired_at=${Date.now()}`)
    expect(Exit.isFailure(yield* EventValidation.control(db,{ruleID:"rule",requestID:"enable-new",expectedRevision:3,action:"enable"}).pipe(Effect.exit))).toBe(true)
    expect((yield* EventValidation.getRule(db,"rule"))?.state).toBe("paused")
  }).pipe(Effect.provideService(EventValidation.Native,f.native.service),Effect.scoped)))
  expect(f.native.state.executed).toBe(0)
}))

test("captured command retries survive lost preview while policy and failure feedback remain current",()=>EventValidationStoreFixture.fixture(async f=>{
  const command={captureID:"ephemeral-preview",ruleID:"rule",requestID:"configure-captured",expectedRevision:0}
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function*(){
    const db=(yield* Database.Service).db
    const bad={...f.configuration,recipe:{...f.configuration.recipe,logicalID:"not-approved"}}
    expect(Exit.isFailure(yield* EventValidation.configure(db,{ruleID:"denied",requestID:"denied",expectedRevision:0,configuration:bad}).pipe(Effect.exit))).toBe(true)
    expect(yield* EventValidation.getRule(db,"denied")).toBeUndefined()
    yield* EventValidation.configureCaptured(db,command,f.configuration)
    yield* EventValidation.control(db,{ruleID:"rule",requestID:"enable",expectedRevision:1,action:"enable"})
    const before=yield* EventValidation.observe(db,"rule",true)
    yield* EventValidation.observationUnavailable(db,before.rule,"VALIDATION_CAPACITY")
    expect(yield* EventValidation.getRule(db,"rule")).toMatchObject({lastReason:"budget_exhausted",dueAt:before.rule.dueAt,contentHash:before.rule.contentHash})
    yield* EventValidation.control(db,{ruleID:"rule",requestID:"manual",expectedRevision:2,action:"verify"})
    const newer=yield* EventValidation.getRule(db,"rule")
    yield* EventValidation.observationUnavailable(db,before.rule)
    expect(yield* EventValidation.getRule(db,"rule")).toEqual(newer)
    yield* EventValidation.control(db,{ruleID:"rule",requestID:"pause",expectedRevision:3,action:"pause"})
  }).pipe(Effect.provideService(EventValidation.Native,f.native.service))))
  // A separate file-backed connection has no Native service or preview Map.
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function*(){
    const db=(yield* Database.Service).db
    expect(yield* EventValidation.replayCaptured(db,command)).toMatchObject({replayed:true,receipt:{ruleID:"rule",ruleRevision:1}})
    expect(Exit.isFailure(yield* EventValidation.replayCaptured(db,{...command,captureID:"different"}).pipe(Effect.exit))).toBe(true)
    expect((yield* EventValidation.history(db,"rule")).length).toBe(0)
    expect((yield* EventValidation.getRule(db,"rule"))?.state).toBe("paused")
  })))
}))
