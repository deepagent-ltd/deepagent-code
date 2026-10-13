import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import type { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"

const actual = process.platform === "darwin" && process.arch === "arm64" && process.env.DAC_WORK_TASK_KNOWN_ACTUAL === "1" ? test : test.skip
const assets = "/var/folders/cs/___vcxjx2cq69pr_mqhzl_fm0000gn/T/dac-event-validation-ui-e5_dupyf/live/install"
const marker = "NATIVE_TASK_COLD_ORIGINAL_MARKER"
actual("original shared NativeTask survives a real parent crash without reviving or repeating its expired child", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-work-task-known-recovery-production-"))
  await fs.writeFile("/tmp/dac-work-task-known-recovery-production-current",root,{mode:0o600})
  const certificate = await EventInvestigationInstallation.certificate(root)
  const requests: {path:string; authenticated:boolean; body:unknown}[] = []
  const generations = {value:0}
  const child: {value?:ReturnType<EventInvestigationInstallation.NativeCase["spawn"]>} = {}
  const provider = Bun.serve({hostname:"127.0.0.1",port:0,tls:{key:Bun.file(certificate.keyPath),cert:Bun.file(certificate.certificatePath)},
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const body:unknown = await request.json()
      requests.push({path:pathname,body,authenticated:request.headers.get("authorization")==="Bearer fixture-native-key"})
      if (pathname==="/v1/responses/input_tokens") return Response.json({object:"response.input_tokens",input_tokens:41})
      if (pathname!=="/v1/responses") return new Response("unavailable",{status:404})
      generations.value++
      if (generations.value===1 || generations.value===2) {
        const task = generations.value===1
        const call = {type:"function_call",id:task?"item_cold_task":"item_cold_read",call_id:task?"call_cold_task":"call_cold_read",
          name:task?"task":"read",arguments:JSON.stringify(task?{description:"Read original approved marker",
            prompt:"Read only guard.test.ts and report its original marker.",subagent_type:"explore"}:{path:"guard.test.ts",byteOffset:0,pageBytes:51200})}
        return new Response([{type:"response.output_item.added",item:{...call,arguments:""}},
          {type:"response.function_call_arguments.delta",item_id:call.id,delta:call.arguments},
          {type:"response.output_item.done",item:call},{type:"response.completed",response:{id:`response_cold_${generations.value}`,
            usage:{input_tokens:41,output_tokens:12,total_tokens:53}}}].map((event)=>`data: ${JSON.stringify(event)}\n\n`).join(""),
          {headers:{"content-type":"text/event-stream"}})
      }
      assert.ok(generations.value===3 || generations.value===4,"Original child/provider was replayed")
      const input = JSON.stringify(body)
      assert.ok(input.includes(generations.value===3?"call_cold_read":"call_cold_task"),"Original real tool result was not consumed")
      assert.ok(input.includes(marker),"Original marker/result was lost")
      assert.ok(!input.includes("known_read_proof") && !input.includes("work_task_known_proof"),"Private proof leaked to provider")
      return new Response(`data: ${JSON.stringify({type:"response.output_text.delta",item_id:`msg_cold_${generations.value}`,delta:marker})}\n\n`+
        `data: ${JSON.stringify({type:"response.completed",response:{id:`response_cold_${generations.value}`,
          usage:{input_tokens:41,output_tokens:12,total_tokens:53}}})}\n\n`,{headers:{"content-type":"text/event-stream"}})
    }})
  try {
    const installation = await EventInvestigationInstallation.build({directory:root,assets,ca:certificate.ca,
      origin:provider.url.origin,debugFixturePath:path.join(import.meta.dir,"fixture/work-child-known-cli.ts")})
    const candidate = await EventInvestigationInstallation.caseFor({installation,directory:path.join(root,"case"),sourceText:`export const marker = '${marker}';\n`})
    await fs.writeFile(candidate.policy,JSON.stringify({version:6,targets:[{id:"review",directory:candidate.project,agentID:"auto",
      providerID:"openai",modelID:"gpt-4.1-2025-04-14",profile:"project_shared_root_v1",
      budget:{...WorkAuthorityPolicy.SHARED_ROOT_PROFILE.budget,maxTotalTokens:20000,maxCompletionTokens:4096,
        maxChildren:2,maxDurationMs:180000,maxProviderDispatches:4,maxToolCalls:2},
      children:{kind:"shared_root_v1",maxConcurrent:2,agents:["explore"],toolIDs:["read"],
        budget:{...WorkAuthorityPolicy.PROJECT_PROFILE.budget,maxTotalTokens:10000,maxCompletionTokens:4096,maxChildren:0,
          maxDurationMs:10000,maxProviderDispatches:2,maxToolCalls:1}},project:{tools:["read","task"],
        fileScope:{read:[{kind:"file",path:"guard.test.ts"}],write:[],deny:[],maxReadBytes:65536,maxPageBytes:51200,
          maxHashBytes:16777216,maxWriteBytes:0,symlinks:"deny"}}}]}),{mode:0o600})
    const run = async (name:string,args:string[]) => {
      const result = await candidate.run(name,args,{DAC_WORK_PROJECT:"1",DAC_WORK_PRODUCTION_RESULT:path.join(candidate.directory,`${name}.json`)})
      assert.equal(result.code,0,`${name}: ${result.stderr.slice(-3500)} ${result.stdout.slice(-1500)}`)
      return result
    }
    await run("enroll",["operator","enroll","--request-id","task-cold-enroll","--policy",candidate.policy])
    await run("approve",["operator","approve-route","--request-id","task-cold-route","--target","review","--snapshot",
      "gpt-4.1-2025-04-14","--expected-revision","1","--expected-route-revision","0","--expires-at",String(Date.now()+3600000)])
    const start = requests.length
    child.value = candidate.spawn(["debug","project-cold-known"],{DAC_WORK_PROJECT:"1",DAC_WORK_PRODUCTION_RESULT:path.join(candidate.directory,"original.json")})
    const stdout = new Response(child.value.stdout).text()
    const stderr = new Response(child.value.stderr).text()
    const checkpoint = path.join(candidate.project,"known-read-committed")
    const deadline = Date.now()+25000
    while (!(await Bun.file(checkpoint).exists()) && child.value.exitCode===null && Date.now()<deadline) await Bun.sleep(20)
    const committed = await Bun.file(checkpoint).exists()
    child.value.kill("SIGKILL")
    const killed = await child.value.exited
    await fs.writeFile(path.join(candidate.directory,"original.log"),(await stdout)+(await stderr),{mode:0o600})
    expect({committed,killed}).toEqual({committed:true,killed:137})
    const before = snapshot(candidate.dbPath)
    await fs.writeFile(path.join(root,"before.json"),JSON.stringify(before),{mode:0o600})
    expect(before.work.map((row)=>row.outcome)).toEqual(["pending","succeeded"])
    expect(before.taskRun).toMatchObject({state:"completed",phase:"settled",execution_owner:null,control_state:"closed"})
    expect(before.taskReceipt.state).toBe("completed")
    expect(before.taskProof).toMatchObject({state:"sealed",version:2})
    expect(before.tools.map((row)=>row.tool_name).sort()).toEqual(["read","task"])
    expect(before.providers.every((row)=>row.state==="settled")).toBe(true)
    expect(before.providers).toHaveLength(3)
    expect(before.counts).toHaveLength(3)
    expect(before.reservations.reduce((sum,row)=>sum+row.charged_tokens,0)).toBe(159)
    expect(generations.value).toBe(3)
    expect(before.claim).toBeGreaterThan(0)
    await run("ordinary-cold",["debug","cold"])
    expect(snapshot(candidate.dbPath)).toEqual(before)
    expect(requests.length).toBe(start+6)
    // Advance the actual old lease and actual child deadline; never rewrite claim or time rows.
    while (Date.now()<=Math.max(before.leaseExpiry,before.childExpiry)) await Bun.sleep(Math.min(500,Math.max(before.leaseExpiry,before.childExpiry)-Date.now()+1))
    expect(Date.now()).toBeGreaterThan(before.childExpiry)
    await run("proof-oracle",["debug","proof-oracle"])
    expect((await Bun.file(path.join(candidate.directory,"proof-oracle.json")).json()).proof).toEqual({
      originalAuthenticated:true,clonedCode:"TASK_PROOF_UNKNOWN",wrongCode:"TASK_PROOF_INVALID",copiedCode:"RECOVERY_UNAVAILABLE"})
    expect(snapshot(candidate.dbPath)).toEqual(before)
    expect(requests.length).toBe(start+6)
    const recoverArgs = ["im","work","recover-known",before.workID,"--session-id",before.sessionID,"--request-id","task-cold-recover",
      "--expected-claim-token",String(before.claim),"--expected-control-revision","1"]
    const recovered = JSON.parse((await run("recover-only",recoverArgs)).stdout.trim()) as {receipt:WorkKnownRecoverySchema.Receipt;execution:string}
    expect(recovered.execution).toBe("not_started")
    expect(recovered.receipt.recoveryID.startsWith("wrecover2_")).toBe(true)
    expect(recovered.receipt.replayed).toBe(false)
    const recovery = snapshot(candidate.dbPath)
    expect(recovery).toEqual({...before,claim:null,recoveries:1})
    const retry = JSON.parse((await run("recover-exact",recoverArgs)).stdout.trim()) as {receipt:WorkKnownRecoverySchema.Receipt;execution:string}
    expect(retry.receipt.replayed).toBe(true)
    expect(retry.execution).toBe("not_started")
    expect(snapshot(candidate.dbPath)).toEqual(recovery)
    await run("released-cold",["debug","cold"])
    expect(snapshot(candidate.dbPath)).toEqual(recovery)
    expect(requests.length).toBe(start+6)
    const resumeArgs = ["im","work","resume-recovered",recovered.receipt.recoveryID,"--request-id","task-cold-resume","--expected-control-revision","1"]
    const resumed = JSON.parse((await run("explicit-resume",resumeArgs)).stdout.trim()) as {receipt:WorkKnownRecoverySchema.ResumeReceipt;execution:string}
    expect(resumed.execution).toBe("drained")
    expect(resumed.receipt.replayed).toBe(false)
    const final = snapshot(candidate.dbPath)
    expect(final.work.every((row)=>row.outcome==="succeeded")).toBe(true)
    expect(final.tools).toEqual(before.tools)
    expect(final.taskRun).toEqual(before.taskRun)
    expect(final.taskReceipt).toEqual(before.taskReceipt)
    expect(final.taskProof).toEqual(before.taskProof)
    expect(final.inputs).toEqual(before.inputs)
    expect(final.providers).toHaveLength(4)
    expect(final.providers.filter((row)=>row.session_id===before.childSessionID)).toEqual(before.providers.filter((row)=>row.session_id===before.childSessionID))
    expect(final.counts).toHaveLength(4)
    expect(final.reservations.reduce((sum,row)=>sum+row.charged_tokens,0)).toBe(212)
    expect(final.resumes).toBe(1)
    expect(final.claim).toBeNull()
    const repeated = JSON.parse((await run("resume-exact",resumeArgs)).stdout.trim()) as {receipt:WorkKnownRecoverySchema.ResumeReceipt;execution:string}
    expect(repeated.receipt.replayed).toBe(true)
    expect(repeated.execution).toBe("not_started")
    expect(snapshot(candidate.dbPath)).toEqual(final)
    expect(generations.value).toBe(4)
    expect(requests.filter((row)=>row.path==="/v1/responses/input_tokens")).toHaveLength(4)
    expect(requests.filter((row)=>row.path==="/v1/responses")).toHaveLength(4)
    expect(requests.every((row)=>row.authenticated)).toBe(true)
    await fs.writeFile(path.join(root,"result.json"),JSON.stringify({before,recovery,final,generations,
      paths:requests.map((row)=>row.path),sourceCohort:path.join(root,"source-cohort.json")}),{mode:0o600})
  } finally { if (child.value && child.value.exitCode===null && !child.value.signalCode) {child.value.kill("SIGKILL");await child.value.exited} provider.stop(true) }
},180000)

function snapshot(filename:string) {
  const db = new Database(filename,{readonly:true})
  try {
    const work = db.query<{work_id:string;session_id:string;parent_work_id:string|null;outcome:string},[]>(
      "SELECT work_id,session_id,parent_work_id,outcome FROM work_execution ORDER BY parent_work_id IS NOT NULL,work_id").all()
    const parent = work.find((row)=>row.parent_work_id===null)!
    const child = work.find((row)=>row.parent_work_id!==null)!
    return {workID:parent.work_id,sessionID:parent.session_id,childSessionID:child.session_id,work,
      claim:db.query<{token:number|null},[string]>("SELECT execution_claim_token token FROM session WHERE id=?").get(parent.session_id)!.token,
      childExpiry:db.query<{expiry:number},[]>("SELECT expires_at expiry FROM work_child_authority").get()!.expiry,
      leaseExpiry:db.query<{expiry:number},[]>("SELECT coalesce(max(lease_expires_at),0) expiry FROM session_provider_owner_lease WHERE released_at IS NULL").get()!.expiry,
      taskRun:db.query<{state:string;phase:string;execution_owner:string|null;control_state:string},[]>("SELECT run_id,state,phase,execution_owner,control_state,generation,raw_result_message_id,time_settled,output,error FROM task_run").get()!,
      taskReceipt:db.query<{state:string},[]>("SELECT * FROM session_v2_task_run_receipt").get()!,
      taskProof:db.query<{state:string;version:number},[]>("SELECT * FROM work_task_known_proof").get()!,
      tools:db.query<{tool_name:string;state:string},[]>("SELECT * FROM session_v2_tool_effect ORDER BY effect_id").all(),
      providers:db.query<{receipt_id:string;session_id:string;state:string},[]>("SELECT receipt_id,session_id,state,outcome_hash,wire_request_hash FROM session_v2_provider_turn_receipt ORDER BY created_at,receipt_id").all(),
      counts:db.query<{acquisition_id:string},[]>("SELECT acquisition_id,work_id,state,record FROM work_count_acquisition ORDER BY created_at,acquisition_id").all(),
      reservations:db.query<{charged_tokens:number},[]>("SELECT reservation_id,work_id,state,charged_tokens FROM work_dispatch_reservation ORDER BY created_at,reservation_id").all(),
      inputs:db.query<{id:string},[]>("SELECT id,session_id,promoted_seq FROM session_input ORDER BY admitted_seq,id").all(),
      recoveries:db.query<{n:number},[]>("SELECT count(*) n FROM work_known_recovery_v2").get()!.n,
      resumes:db.query<{n:number},[]>("SELECT count(*) n FROM work_known_recovery_resume_v2").get()!.n}
  } finally {db.close()}
}
