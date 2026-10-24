import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  managedBrowserInputFixtureEnvironment,
  managedBrowserInputFixtureExecutable,
} from "./fixture/managed-browser-input-runtime"

test("actual Chromium references reject stale nodes and focus theft without exposing passwords", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-inputs-")))
  await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
  await Bun.write(
    path.join(root, "main.ts"),
    `
import { app, BrowserWindow } from "electron"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import { createManagedBrowserActions } from ${JSON.stringify(path.join(import.meta.dir, "managed-browser-actions.ts"))}
app.setPath("userData", ${JSON.stringify(path.join(root, "profile"))})
app.on("window-all-closed",()=>{})
const server=createServer((_req,res)=>res.end('<html><body><label>Entry<input id="entry" value="before"></label><label>Other<input id="other"></label><label>Secret<input type="password" value="NEVER_REVEAL_PASSWORD"></label><select id="pick"><option value="a">A</option><option value="b">B</option></select><button>Go</button></body></html>'))
const result={dispatch:0,errors:[],passwordVisible:false,filled:'',focusOther:'',selected:''}
async function main(){
 await app.whenReady()
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 const contents=window.webContents
 try {
  await contents.loadURL('http://127.0.0.1:'+server.address().port)
  contents.debugger.attach('1.3')
  await contents.debugger.sendCommand('Page.enable')
  await contents.debugger.sendCommand('Accessibility.enable')
  const helper=createManagedBrowserActions({send:(method,params)=>contents.debugger.sendCommand(method,params),current:async()=>{},generation:()=>1,fail:(code)=>{throw new Error(code)},dispatched:()=>{result.dispatch++}})
  const snapshot=()=>helper.snapshot({type:'snapshot',tabID:'test',generation:1})
  const target=(page,name)=>({tabID:'test',generation:1,frameID:page.frameID,observationRevision:page.observationRevision,ref:page.refs.find(ref=>ref.name===name).ref})
  const page=await snapshot()
  result.passwordVisible=JSON.stringify(page).includes('NEVER_REVEAL_PASSWORD')
  await helper.execute({type:'fill',...target(page,'Entry'),text:'中文一次'})
  result.filled=await contents.executeJavaScript('document.getElementById("entry").value')
  const fresh=await snapshot()
  try{await helper.execute({type:'fill',...target(page,'Entry'),text:'stale'})}catch(e){result.errors.push(e.message)}
  await contents.executeJavaScript('document.getElementById("entry").setAttribute("type","password")')
  const before=result.dispatch
  try{await helper.execute({type:'fill',...target(fresh,'Entry'),text:'wrong'})}catch(e){result.errors.push(e.message)}
  result.staleInputZero=result.dispatch===before
  await contents.executeJavaScript('document.getElementById("entry").setAttribute("type","text");document.getElementById("other").focus();document.getElementById("entry").addEventListener("focus",()=>document.getElementById("other").focus())')
  const stolen=await snapshot()
  try{await helper.execute({type:'fill',...target(stolen,'Entry'),text:'DO_NOT_INSERT'})}catch(e){result.errors.push(e.message)}
  result.focusOther=await contents.executeJavaScript('document.getElementById("other").value')
  const selected=await snapshot()
  await helper.execute({type:'select',tabID:'test',generation:1,frameID:selected.frameID,observationRevision:selected.observationRevision,ref:selected.refs.find(ref=>ref.role==='combobox').ref,values:['b']})
  result.selected=await contents.executeJavaScript('document.getElementById("pick").value')
  await contents.executeJavaScript('document.querySelector("button").addEventListener("mouseenter",()=>{const shield=document.createElement("button");shield.textContent="Other action";Object.assign(shield.style,{position:"fixed",inset:"0",zIndex:"999999"});shield.addEventListener("mousedown",()=>window.wrongInput=true);document.body.append(shield)},{once:true})')
  const hovered=await snapshot()
  try{await helper.execute({type:'click',...target(hovered,'Go')})}catch(e){result.errors.push(e.message)}
  result.hoverOther=await contents.executeJavaScript('Boolean(window.wrongInput)')
  await helper.release()
  await writeFile(${JSON.stringify(path.join(root, "result.json"))},JSON.stringify(result))
 }finally{window.destroy();server.closeAllConnections();server.close()}
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)})
`,
  )
  const build = await Bun.build({
    entrypoints: [path.join(root, "main.ts")],
    outdir: root,
    target: "node",
    external: ["electron"],
  })
  expect(build.success).toBe(true)
  await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, build.outputs[0]!.path], {
    cwd: root,
    env: {
      ...managedBrowserInputFixtureEnvironment,
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + stderr)
  console.log("MANAGED_BROWSER_INPUT_EVIDENCE", root)
  expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.passwordVisible).toBe(false)
  expect(result.filled).toBe("中文一次")
  expect(result.staleInputZero).toBe(true)
  expect(result.focusOther).toBe("")
  expect(result.selected).toBe("b")
  expect(result.hoverOther).toBe(false)
  expect(result.errors).toEqual([
    "BROWSER_STALE_TARGET",
    "BROWSER_STALE_TARGET",
    "BROWSER_STALE_TARGET",
    "BROWSER_STALE_TARGET",
  ])
}, 30_000)

test("actual Chromium shared file submit keeps clear ACK and cleanup failures distinct", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-file-ack-")))
  await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
  await Bun.write(
    path.join(root, "main.ts"),
    `
import { app, BrowserWindow } from "electron"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import { createManagedBrowserActions } from ${JSON.stringify(path.join(import.meta.dir, "managed-browser-actions.ts"))}
app.setPath("userData", ${JSON.stringify(path.join(root, "profile"))})
app.on("window-all-closed",()=>{})
const rows=[]
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<label>Upload file<input type="file" name="asset" form="upload"></label><form id="upload" method="post" enctype="multipart/form-data" action="/upload"></form>')})
async function main(){
 await app.whenReady()
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin='http://127.0.0.1:'+server.address().port
 for(const fault of ['false','exception','permission','cleanup']) {
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
  const contents=window.webContents
  const facts={fault,ack:0,submitCalls:0,releaseFailures:0,permissionDenied:false,error:''}
  try {
   await contents.loadURL(origin)
   contents.debugger.attach('1.3')
   for(const name of ['Page.enable','Accessibility.enable','Runtime.enable']) await contents.debugger.sendCommand(name)
   const helper=createManagedBrowserActions({
    sharedDocument:true,approvedOrigins:[origin],generation:()=>1,
    current:async()=>{if(facts.permissionDenied)throw new Error('CONTROLLED_PERMISSION_DENIED')},
    dispatched:()=>{},fail:code=>{throw new Error(code)},
    send:async(method,params)=>{
     if(method==='Runtime.releaseObject'&&fault==='cleanup'&&facts.ack){facts.releaseFailures++;throw new Error('CONTROLLED_RELEASE_FAILURE')}
     if(method==='Runtime.callFunctionOn'&&String(params?.functionDeclaration).startsWith('function(path,href)')){
      facts.submitCalls++
      if(fault==='exception')return contents.debugger.sendCommand(method,{...params,functionDeclaration:'function(){throw new Error("controlled submit exception")}'})
     }
     return contents.debugger.sendCommand(method,params)
    },
   })
   const page=await helper.snapshot({type:'snapshot',tabID:'test',generation:1})
   const ref=page.refs.find(value=>value.name==='Upload file')
   if(!ref)throw new Error('Missing actual Chromium file input')
   if(fault==='false')await contents.executeJavaScript('document.querySelector("form").method="get"')
   if(fault==='permission')facts.permissionDenied=true
   try { await helper.submitFiles({type:'file.upload',tabID:'test',generation:1,frameID:ref.frameID,observationRevision:page.observationRevision,ref:ref.ref,grantIDs:['controlled-leaf-only']},'/upload',origin+'/upload',()=>{facts.ack++}) }
   catch(error){facts.error=error.message}
   rows.push(facts)
  }finally{window.destroy()}
 }
 await writeFile(${JSON.stringify(path.join(root, "result.json"))},JSON.stringify({rows,controlledFaults:true,modelRequests:0,automaticRetries:0}))
 server.closeAllConnections();server.close()
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)})
`,
  )
  const build = await Bun.build({
    entrypoints: [path.join(root, "main.ts")],
    outdir: root,
    target: "node",
    external: ["electron"],
  })
  expect(build.success).toBe(true)
  await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, build.outputs[0]!.path], {
    cwd: root,
    env: {
      ...managedBrowserInputFixtureEnvironment,
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: root,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await Bun.write(path.join(root, "process.log"), stdout + stderr)
  console.log("SHARED_FILE_ACK_FAULT_EVIDENCE", root)
  expect(code, stderr).toBe(0)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.rows.map((row: { ack: number }) => row.ack)).toEqual([0, 0, 0, 1])
  expect(result.rows.map((row: { error: string }) => row.error)).toEqual([
    "BROWSER_UNKNOWN",
    "BROWSER_STALE_TARGET",
    "CONTROLLED_PERMISSION_DENIED",
    "BROWSER_UNKNOWN",
  ])
  expect(result.rows.map((row: { submitCalls: number }) => row.submitCalls)).toEqual([1, 1, 0, 1])
  expect(result.rows[3].releaseFailures).toBe(1)
  expect(result.automaticRetries).toBe(0)
  expect(result.modelRequests).toBe(0)
}, 30_000)
