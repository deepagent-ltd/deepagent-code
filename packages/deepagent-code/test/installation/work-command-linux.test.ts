import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { Hash } from "@deepagent-code/core/util/hash"

const image = "public.ecr.aws/x8v8d7g8/mars-base:latest"
const libraryPaths = ["/lib/aarch64-linux-gnu/libc.so.6", "/lib/aarch64-linux-gnu/libpthread.so.0",
  "/lib/aarch64-linux-gnu/libdl.so.2", "/lib/aarch64-linux-gnu/libm.so.6", "/lib/ld-linux-aarch64.so.1"]
const Census = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ state: Schema.String, kind: Schema.String, has_proof: Schema.Int })),
  commands: Schema.Array(Schema.Struct({ state: Schema.String, outcome: Schema.NullOr(Schema.String), reserved_bytes: Schema.Int,
    observed_retained_bytes: Schema.Int, released_at: Schema.NullOr(Schema.Int) })),
  commandMeter: Schema.Array(Schema.Struct({ custody_count: Schema.Int, retained_bytes: Schema.Int, audit_count: Schema.Int })),
})

test.skipIf(process.env.DAC_LINUX_COMMAND_ACTUAL !== "1")("Linux ARM64 original source/HTTP accept/canonical managed_command/known proof and cleanup", async () => {
  const reuse = process.env.DAC_LINUX_COMMAND_REUSE
  const directory = reuse ? await fs.realpath(reuse) : await fs.mkdtemp(path.join(os.homedir(), ".cache/dac-linux-command-actual-"))
  const previous = reuse ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ guest: Schema.String, cgroup: Schema.String, origin: Schema.String })))(await fs.readFile(path.join(directory, "setup.json"), "utf8")) : undefined
  await fs.chmod(directory, 0o700)
  const assets = path.join(directory, "assets")
  await fs.mkdir(assets, { recursive: true })
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: 120000 })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr.slice(-2000)}`)
    return stdout
  }
  const container = `dac-linux-command-assets-${process.pid}`
  const certificate = reuse ? { ca: await fs.readFile(path.join(directory, "ca.pem"), "utf8"), keyPath: path.join(directory, "ca-key.pem"), certificatePath: path.join(directory, "ca.pem") } : await EventInvestigationInstallation.certificate(directory)
  const ledger: { route: string; authenticated: boolean }[] = []
  const state = { generations: 0 }
  const provider = Bun.serve({ hostname: "127.0.0.1", port: previous ? Number(new URL(previous.origin).port) : 0,
    tls: { key: await fs.readFile(certificate.keyPath), cert: await fs.readFile(certificate.certificatePath) },
    async fetch(request) {
      const route = new URL(request.url).pathname
      const body: unknown = await request.json()
      if (typeof body !== "object" || body === null) return new Response("invalid", { status: 400 })
      ledger.push({ route, authenticated: request.headers.get("authorization") === "Bearer fixture-native-key" })
      if (route === "/v1/responses/input_tokens") return Response.json({ object: "response.input_tokens", input_tokens: 41 })
      if (route !== "/v1/responses") return new Response("unavailable", { status: 404 })
      state.generations++
      if (state.generations === 1) {
        const call = { type: "function_call", id: "item_command", call_id: "call_command", name: "managed_command", arguments: JSON.stringify({ commandID: "build", parameters: [] }) }
        return new Response([{ type: "response.output_item.added", item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
          { type: "response.output_item.done", item: call },
          { type: "response.completed", response: { id: "resp_command", usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      }
      return new Response('data: {"type":"response.output_text.delta","item_id":"msg_done","delta":"The approved command completed."}\n\n' +
        'data: {"type":"response.completed","response":{"id":"resp_done","usage":{"input_tokens":41,"output_tokens":12,"total_tokens":53}}}\n\n',
        { headers: { "content-type": "text/event-stream" } })
    },
  })
  const tunnel = Bun.spawn(["ssh", "-F", path.join(os.homedir(), ".colima/_lima/colima/ssh.config"), "-N", "-o", "ExitOnForwardFailure=yes",
    "-R", `127.0.0.1:${provider.port}:127.0.0.1:${provider.port}`, "lima-colima"], { stdout: "ignore", stderr: "pipe" })
  const guest = previous?.guest ?? `/var/tmp/dac-linux-command-${process.pid}`
  const unit = path.basename(guest)
  try {
    if (!reuse) {
    await run(["docker", "create", "--name", container, "--network", "none", image])
    await run(["docker", "cp", "-L", `${container}:/root/.bun/bin/bun`, path.join(assets, "bun-command-runtime")])
    for (const name of ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor"])
      await fs.copyFile(path.join(os.homedir(), ".cache/dac-linux-command-native-build/target/debug", name), path.join(assets, name))
    const runtimeClosure = []
    for (const library of libraryPaths) {
      const destination = path.join(assets, "runtime-closure", library)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await run(["docker", "cp", "-L", `${container}:${library}`, destination])
      await fs.chmod(destination, (await fs.stat(destination)).mode & 0o111 ? 0o755 : 0o644)
      runtimeClosure.push({ source: destination, mountPath: library })
    }
    await Promise.all(["bun-command-runtime", "deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor"].map((name) => fs.chmod(path.join(assets, name), 0o755)))
    const installation = await EventInvestigationInstallation.build({ directory, assets, storageCleanupAsset: path.join(assets, "deepagent-work-storage-cleanup"),
      target: "linux-arm64", supervisorAssets: { supervisor: path.join(assets, "deepagent-work-process-supervisor"), runtimeClosure },
      ca: certificate.ca, origin: provider.url.origin, debugFixturePath: path.join(import.meta.dirname, "fixture/work-command-linux.ts") })
    await run(["colima", "ssh", "--", "sudo", "-n", "mkdir", "-m", "700", guest])
    await run(["colima", "ssh", "--", "sudo", "-n", "cp", "-R", installation.install, `${guest}/install`])
    await run(["colima", "ssh", "--", "sudo", "-n", "chown", "-R", "0:0", guest])
    await run(["colima", "ssh", "--", "sudo", "-n", "systemd-run", "--unit", unit, "--property", "Delegate=yes", "--property", "DelegateSubgroup=keeper", "--property", "TasksMax=infinity", "/usr/bin/sleep", "600"])
    }
    if (reuse) await run(["colima", "ssh", "--", "sudo", "-n", "systemctl", "is-active", unit])
    const cgroup = (await run(["colima", "ssh", "--", "sudo", "-n", "systemctl", "show", unit, "--property", "ControlGroup", "--value"])).trim()
    if (previous) expect(cgroup).toBe(previous.cgroup)
    await run(["colima", "ssh", "--", "sudo", "-n", "python3", "-c", `import pathlib;p=pathlib.Path(${JSON.stringify("/sys/fs/cgroup")}+${JSON.stringify(cgroup)});(p/'cgroup.subtree_control').write_text('+cpu +memory +pids');print((p/'cgroup.subtree_control').read_text())`])
    const setup = { guest, cgroup, directory, repository: EventInvestigationInstallation.repository,
      budget: WorkAuthorityPolicy.PROJECT_PROFILE.budget, origin: provider.url.origin }
    if (!reuse) await fs.writeFile(path.join(directory, "setup.json"), JSON.stringify(setup), { mode: 0o600 })
    const script = `import json,os,pathlib,subprocess\ns=json.load(open(${JSON.stringify(path.join(directory, "setup.json"))}))\nr=pathlib.Path(s['guest']);p=r/'project'\np.mkdir(mode=0o700)\nsubprocess.run(['git','init','-q',str(p)],check=True)\n(p/'input.ts').write_text("await Bun.write('./output.js', 'export const answer = 42;\\\\n');\\n")\n(p/'approved.txt').write_text('approved input\\n')\nfor name in ['home','tmp','config','data','cache','state','managed']: (r/name).mkdir(mode=0o700)\n(p/'deepagent-code.json').write_text(json.dumps({'formatter':False,'lsp':False,'model':'openai/gpt-4.1-2025-04-14','providers':{'openai':{'env':['DAC_FIXTURE_NATIVE_KEY'],'api':{'type':'native','settings':{},'protocol':'openai.responses','url':s['origin']+'/v1'},'models':{'gpt-4.1-2025-04-14':{'api':{'id':'gpt-4.1-2025-04-14'},'capabilities':{'input':['text'],'output':['text'],'tools':True},'limit':{'context':100000,'output':4096}}}}}}))\npolicy={'version':4,'targets':[{'id':'review','directory':str(p),'agentID':'auto','providerID':'openai','modelID':'gpt-4.1-2025-04-14','budget':s['budget'],'project':{'tools':['read','managed_command'],'fileScope':{'read':[{'kind':'file','path':'input.ts'},{'kind':'file','path':'approved.txt'}],'write':[],'deny':[],'maxReadBytes':67108864,'maxPageBytes':51200,'maxHashBytes':16777216,'maxWriteBytes':0,'symlinks':'deny'},'commandRecipes':[{'schemaVersion':'work-command-recipe.v2','logicalID':'build','revision':1,'executable':'installed-bun-v2','target':'linux-arm64','argv':[{'kind':'literal','value':'run'},{'kind':'literal','value':'input.ts'}],'parameters':[],'cwd':None,'inputs':['input.ts'],'outputs':['output.js'],'environment':[{'name':'CI','value':'1'}],'workspace':'private_explicit_files.v1','sandbox':{'id':'linux-cgroup2-single-payload-v1','revision':1,'network':'deny','filesystem':'explicit_snapshot_closure','payloadProcesses':1,'payloadThreadsMax':64,'supervisorProcessesMax':2,'openFiles':64,'stopProof':'root_exit_stream_eof_tree_empty','cpu':{'quotaMicros':100000,'periodMicros':100000,'totalWatchdogMicros':10000000,'pollMs':10},'memory':{'maxBytes':536870912,'swapMaxBytes':0},'tasksMax':66,'threadsEnforcement':'cgroup_pids'},'timeoutMs':30000,'stdoutBytes':1048576,'stderrBytes':1048576}]}}]}\n(r/'policy.json').write_text(json.dumps(policy));os.chmod(r/'policy.json',0o600)\ne={'PATH':'/usr/bin:/bin','HOME':str(r/'home'),'TMPDIR':str(r/'tmp'),'XDG_CONFIG_HOME':str(r/'config'),'XDG_DATA_HOME':str(r/'data'),'XDG_CACHE_HOME':str(r/'cache'),'XDG_STATE_HOME':str(r/'state'),'DEEPAGENT_CODE_TEST_HOME':str(r/'home'),'DEEPAGENT_CODE_HOME':str(r/'data'),'DEEPAGENT_CODE_DB':str(r/'database.sqlite'),'DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR':str(r/'managed'),'DEEPAGENT_CODE_DISABLE_MODELS_FETCH':'1','DEEPAGENT_CODE_MODELS_PATH':s['repository']+'/packages/deepagent-code/test/tool/fixtures/models-api.json','DEEPAGENT_CODE_V2_OWNER_DEV_MINT':'1','DEEPAGENT_CODE_SERVER_USERNAME':'fixture-operator','DEEPAGENT_CODE_SERVER_PASSWORD':'fixture-operator-password','DEEPAGENT_IM_AGENT_RESPONDER':'off','DAC_FIXTURE_NATIVE_KEY':'fixture-native-key','DAC_WORK_PROJECT':'1','DAC_WORK_COMMAND_CASE':'1','DAC_WORK_PRODUCTION_RESULT':str(r/'run.json'),'DEEPAGENT_CODE_WORK_CGROUP':'/sys/fs/cgroup'+s['cgroup'],'NO_COLOR':'1'}\n(r/'private-env.json').write_text(json.dumps(e));os.chmod(r/'private-env.json',0o600)\nprint('prepared')\n`
    if (!reuse) {
      await fs.writeFile(path.join(directory, "setup.py"), script, { mode: 0o600 })
      await run(["colima", "ssh", "--", "sudo", "-n", "python3", path.join(directory, "setup.py")])
    }
    const invoke = async (name: string, args: string[], caseGuest = guest, extraEnv: Record<string, string> = {}) => {
      const command = `import json,pathlib,subprocess,os\nr=pathlib.Path(${JSON.stringify(caseGuest)});e=json.load(open(r/'private-env.json'));e.update(${JSON.stringify(extraEnv)});p=subprocess.Popen([${JSON.stringify(guest + "/install/deepagent-code")},${args.map((arg) => JSON.stringify(arg)).join(",")}],cwd=r/'project',env=e,stdout=subprocess.PIPE,stderr=subprocess.PIPE);(r/${JSON.stringify(name + ".pid")}).write_text(str(p.pid));o,er=p.communicate(timeout=900);(r/${JSON.stringify(name + ".log")}).write_text(json.dumps({'code':p.returncode,'stdout':o.decode(errors='replace'),'stderr':er.decode(errors='replace')}));print(p.returncode)\n`
      await fs.writeFile(path.join(directory, `${name}.py`), command, { mode: 0o600 })
      return Number((await run(["colima", "ssh", "--", "sudo", "-n", "python3", path.join(directory, `${name}.py`)])).trim())
    }
    if (!reuse) expect(await invoke("enroll", ["operator", "enroll", "--request-id", "linux-enroll", "--policy", `${guest}/policy.json`])).toBe(0)
    expect(await invoke("approve", ["operator", "approve-route", "--target", "review", "--snapshot", "gpt-4.1-2025-04-14", "--request-id", "linux-route", "--expected-revision", "1", "--expected-route-revision", "0", "--expires-at", String(Date.now() + 300000)])).toBe(0)
    expect(await invoke("run", ["debug", "im-task"])).toBe(0)
    const raw = await run(["colima", "ssh", "--", "sudo", "-n", "cat", `${guest}/run.json`])
    await fs.writeFile(path.join(directory, "actual.json"), raw, { mode: 0o600 })
    const result = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
      authority: Schema.Struct({ result: Schema.String }), after: Census, afterRetry: Census,
    })))(raw)
    expect(result.authority.result).toBe("succeeded")
    expect(result.after.tools).toEqual([{ state: "settled", kind: "mutating", has_proof: 1 }])
    expect(result.after.commands).toEqual([expect.objectContaining({ state: "settled", outcome: "exited", reserved_bytes: 0, observed_retained_bytes: 0 })])
    expect(result.after.commandMeter).toEqual([{ custody_count: 0, retained_bytes: 0, audit_count: 1 }])
    expect(result.afterRetry).toEqual(result.after)
    expect(ledger.map((entry) => entry.route)).toEqual(["/v1/responses/input_tokens", "/v1/responses", "/v1/responses/input_tokens", "/v1/responses"])
    expect(ledger.every((entry) => entry.authenticated)).toBe(true)
    const readCommands = async (caseGuest: string) => {
      const raw = await run(["colima", "ssh", "--", "sudo", "-n", "python3", "-c", `import sqlite3,json;d=sqlite3.connect(${JSON.stringify("file:" + caseGuest + "/database.sqlite?mode=ro")},uri=True);print(json.dumps([json.loads(x[0]) for x in d.execute('SELECT record FROM work_command_intent')]))`])
      return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(WorkCommandSchema.Record)))(raw)
    }
    const [normal] = await readCommands(guest)
    expect(normal?.exitCode).toBe(0)
    expect(normal?.stopConfirmed).toBe(true)
    expect(normal?.releasedAt).not.toBeNull()
    expect(normal?.outputs).toEqual([expect.objectContaining({ relative: "output.js", bytes: 26,
      sha256: Hash.sha256(Buffer.from("export const answer = 42;\n")) })])
    const cases: { kind: string; guest: string; ledger: typeof ledger; commands: readonly WorkCommandSchema.Record[]; cancel?: unknown }[] = []
    const setupCase = async (kind: string, inputSource?: string) => {
      const caseGuest = `${guest}/${kind}`
      await run(["colima", "ssh", "--", "sudo", "-n", "mkdir", "-m", "700", caseGuest])
      const file = path.join(directory, `setup-${kind}.json`)
      await fs.writeFile(file, JSON.stringify({ ...setup, guest: caseGuest }), { mode: 0o600 })
      await fs.writeFile(path.join(directory, `setup-${kind}.py`), script.replace(JSON.stringify(path.join(directory, "setup.json")), JSON.stringify(file)), { mode: 0o600 })
      await run(["colima", "ssh", "--", "sudo", "-n", "python3", path.join(directory, `setup-${kind}.py`)])
      if (inputSource) await run(["colima", "ssh", "--", "sudo", "-n", "python3", "-c", `import pathlib;(pathlib.Path(${JSON.stringify(caseGuest)})/'project/input.ts').write_text(${JSON.stringify(inputSource)})`])
      expect(await invoke(`${kind}-enroll`, ["operator", "enroll", "--request-id", `${kind}-enroll`, "--policy", `${caseGuest}/policy.json`], caseGuest)).toBe(0)
      expect(await invoke(`${kind}-approve`, ["operator", "approve-route", "--target", "review", "--snapshot", "gpt-4.1-2025-04-14", "--request-id", `${kind}-route`, "--expected-revision", "1", "--expected-route-revision", "0", "--expires-at", String(Date.now() + 300000)], caseGuest)).toBe(0)
      return caseGuest
    }
    if (!reuse) {
      const cancelGuest = await setupCase("cancel", "await Bun.write('./output.js', 'payload-started\\n'); await Bun.sleep(600000);\n")
      const start = ledger.length
      state.generations = 0
      const cancellation = `import json,pathlib,sqlite3,time,urllib.request,base64,os\nr=pathlib.Path(${JSON.stringify(cancelGuest)});deadline=time.monotonic()+45\nwhile True:\n try:\n  d=sqlite3.connect('file:'+str(r/'database.sqlite')+'?mode=ro',uri=True);row=d.execute('SELECT record FROM work_command_intent').fetchone();d.close();c=json.loads(row[0]) if row else None\n  if c and c['state']=='dispatching' and (r/'data/work-command-stage'/c['workspaceBasename']/'output.js').read_text()=='payload-started\\n':break\n except (sqlite3.Error,FileNotFoundError):pass\n if time.monotonic()>deadline:raise RuntimeError('actual payload did not reach original marker')\n time.sleep(.02)\npid=int((r/'cancel-run.pid').read_text());sockets={os.readlink(p) for p in pathlib.Path('/proc/'+str(pid)+'/fd').iterdir() if p.is_symlink() and os.readlink(p).startswith('socket:')}\nports=[int(x.split()[1].split(':')[1],16) for x in pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:] if x.split()[3]=='0A' and x.split()[1].split(':')[0]=='0100007F' and 'socket:['+x.split()[9]+']' in sockets]\nassert len(ports)==1,ports\nidentity=json.load(open(r/'project/work-identity.json'));base='http://127.0.0.1:'+str(ports[0]);headers={'authorization':'Basic '+base64.b64encode(b'fixture-operator:fixture-operator-password').decode(),'content-type':'application/json','x-deepagent-code-directory':str(r/'project')}\ndef req(route,body=None):\n q=urllib.request.Request(base+route,data=None if body is None else json.dumps(body).encode(),headers=headers,method='GET' if body is None else 'POST');return json.load(urllib.request.urlopen(q,timeout=15))\ns=req('/api/v1/im/tasks/requests/'+identity['requestID']+'/state');cmd={'operationID':'linux-cancel','expectedGrantRevision':s['grant']['revision'],'expectedControlRevision':s['work']['controlRevision']};receipt=req('/api/v1/im/tasks/requests/'+identity['requestID']+'/cancel',cmd);again=req('/api/v1/im/tasks/requests/'+identity['requestID']+'/cancel',cmd);assert receipt['receipt']==again['receipt'];(r/'cancel-result.json').write_text(json.dumps({'before':s,'receipt':receipt,'exact':again}));print('actual-cancelled')\n`
      await fs.writeFile(path.join(directory, "cancel.py"), cancellation, { mode: 0o600 })
      const running = invoke("cancel-run", ["debug", "im-task"], cancelGuest)
      await run(["colima", "ssh", "--", "sudo", "-n", "python3", path.join(directory, "cancel.py")])
      expect(await running).toBe(0)
      const cancelled = await readCommands(cancelGuest)
      expect(cancelled).toHaveLength(1)
      expect(cancelled[0]?.state).toBe("settled")
      expect(cancelled[0]?.outcome).toBe("cancelled")
      expect(cancelled[0]?.stopConfirmed).toBe(true)
      expect(cancelled[0]?.releasedAt).toBeNull()
      expect(ledger.slice(start).map((entry) => entry.route)).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
      cases.push({ kind: "physical-command-cancel", guest: cancelGuest, ledger: ledger.slice(start), commands: cancelled,
        cancel: Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(await run(["colima", "ssh", "--", "sudo", "-n", "cat", `${cancelGuest}/cancel-result.json`])) })
      const unavailableGuest = await setupCase("no-delegation")
      const unavailableStart = ledger.length
      state.generations = 0
      // Withdrawal after route approval is a leaf refusal. The preceding real
      // provider turn remains charged; no command may reserve or execute.
      expect(await invoke("no-delegation-run", ["debug", "im-task"], unavailableGuest, { DEEPAGENT_CODE_WORK_CGROUP: "" })).toBe(0)
      expect(await readCommands(unavailableGuest)).toHaveLength(0)
      expect(ledger.slice(unavailableStart).map((entry) => entry.route)).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
      cases.push({ kind: "missing-delegation", guest: unavailableGuest, ledger: ledger.slice(unavailableStart), commands: [] })
    }
    await fs.writeFile(path.join(directory, "safe-result.json"), JSON.stringify({ directory, guest, rootQA: true, generations: ledger.filter((entry) => entry.route === "/v1/responses").length, ledger,
      result: result.authority.result, commands: result.after.commands, meter: result.after.commandMeter, cases, cohort: path.join(directory, "source-cohort.json") }), { mode: 0o600 })
  } finally {
    tunnel.kill()
    await tunnel.exited
    await provider.stop(true)
    await run(["docker", "rm", "-f", container]).catch(() => undefined)
    await run(["colima", "ssh", "--", "sudo", "-n", "systemctl", "stop", unit]).catch(() => undefined)
    // Retain the private case and failure logs; they are never copied into evidence.
  }
}, 240000)
