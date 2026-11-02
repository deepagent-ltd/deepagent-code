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
  const diagnosticAB =
    process.env.DAC_BROWSER_INPUT_FIXTURE_AB_DIAGNOSTIC === "1" ||
    (process.platform === "linux" &&
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      process.env.DAC_TEST_FILE === "src/main/managed-browser-actions.test.ts" &&
      process.env.DAC_TEST_NAME ===
        "actual Chromium references reject stale nodes and focus theft without exposing passwords")
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
const originalSequence=[]
const inputState=(contents,id)=>contents.executeJavaScript('(()=>{const entry=document.getElementById('+JSON.stringify(id)+');return entry?{active:document.activeElement===entry,start:entry.selectionStart,end:entry.selectionEnd,length:entry.value.length,isBefore:entry.value==="before",empty:entry.value==="",matchesFill:entry.value==="中文一次",visible:document.visibilityState==="visible",focused:document.hasFocus()}:null})()')
const inputTrace=async(contents,id,scope,stage,params={})=>console.log('LINUX_BROWSER_INPUT_TRACE',JSON.stringify({scope,stage,type:params.type,key:params.key,code:params.code,modifiers:params.modifiers,commands:params.commands,windowVisible:BrowserWindow.fromWebContents(contents)?.isVisible(),windowFocused:BrowserWindow.fromWebContents(contents)?.isFocused(),contentsFocused:contents.isFocused(),state:await inputState(contents,id)}))
async function main(){
 await app.whenReady()
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 const contents=window.webContents
 try {
  await contents.loadURL('http://127.0.0.1:'+server.address().port)
  // Match the production dynamic-action visibility/focus precondition on Xvfb.
  if(process.platform==='linux'){
   const nativeFocus=(stage)=>console.log('LINUX_BROWSER_INPUT_TRACE',JSON.stringify({scope:'original-native-focus',stage,windowVisible:window.isVisible(),windowFocused:window.isFocused(),contentsFocused:contents.isFocused()}))
   nativeFocus('before')
   // DOM document.hasFocus() alone does not establish the OS top-level input focus.
   await new Promise((resolve,reject)=>{
    const dispose=()=>{clearTimeout(timer);window.removeListener('focus',ready);contents.removeListener('focus',ready)}
    const ready=()=>{if(!window.isFocused()||!contents.isFocused())return;dispose();resolve(undefined)}
    const timer=setTimeout(()=>{dispose();nativeFocus('timeout');reject(new Error('MANAGED_BROWSER_INPUT_FIXTURE_NATIVE_FOCUS_TIMEOUT'))},1000)
    window.on('focus',ready)
    contents.on('focus',ready)
    window.show()
    window.focus()
    contents.focus()
    ready()
   })
   const documentFocus=await contents.executeJavaScript('({visible:document.visibilityState==="visible",focused:document.hasFocus()})')
   console.log('LINUX_BROWSER_INPUT_TRACE',JSON.stringify({scope:'original-native-focus',stage:'ready',windowVisible:window.isVisible(),windowFocused:window.isFocused(),contentsFocused:contents.isFocused(),documentFocus}))
   if(!window.isFocused()||!contents.isFocused()||!documentFocus.visible||!documentFocus.focused)throw new Error('MANAGED_BROWSER_INPUT_FIXTURE_NOT_READY')
  }
  contents.debugger.attach('1.3')
  await contents.debugger.sendCommand('Page.enable')
  await contents.debugger.sendCommand('Accessibility.enable')
  const helper=createManagedBrowserActions({send:async(method,params)=>{
   if(!result.filled)originalSequence.push(method)
   const response=await contents.debugger.sendCommand(method,params)
   if(process.platform==='linux'&&['Input.dispatchKeyEvent','Input.insertText'].includes(method))await inputTrace(contents,'entry','original',method,params)
   return response
  },current:async()=>{},generation:()=>1,fail:(code)=>{throw new Error(code)},dispatched:()=>{result.dispatch++}})
  const snapshot=()=>helper.snapshot({type:'snapshot',tabID:'test',generation:1})
  const target=(page,name)=>({tabID:'test',generation:1,frameID:page.frameID,observationRevision:page.observationRevision,ref:page.refs.find(ref=>ref.name===name).ref})
  const page=await snapshot()
  result.passwordVisible=JSON.stringify(page).includes('NEVER_REVEAL_PASSWORD')
  if(process.platform==='linux')await inputTrace(contents,'entry','original','fill-before')
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
  if(${diagnosticAB}){
   // Original results stay fixed. Cold windows and reloads use the identical HTTP page.
   // Navigations reset values; diagnostics never assign values or script selections.
   console.log('LINUX_BROWSER_INPUT_TRACE',JSON.stringify({scope:'original',stage:'method-sequence',methods:originalSequence}))
   for(const variant of [
    {name:'http-cold-helper',cold:true,frontend:false,focus:'backend',guard:true,world:true,helper:true},
    {name:'http-cold-direct',cold:true,frontend:false,focus:'backend',guard:false,world:false,helper:false},
    {name:'http-helper-backend',cold:false,frontend:false,focus:'backend',guard:true,world:true,helper:true},
    {name:'http-direct-backend',cold:false,frontend:false,focus:'backend',guard:false,world:false,helper:false},
    {name:'http-direct-ax',cold:false,frontend:false,focus:'backend',guard:true,world:false,helper:false},
    {name:'http-direct-world',cold:false,frontend:false,focus:'backend',guard:true,world:true,helper:false},
    {name:'http-helper-frontend',cold:false,frontend:true,focus:'backend',guard:true,world:true,helper:true},
    {name:'http-helper-node',cold:false,frontend:true,focus:'node',guard:true,world:true,helper:true},
   ]){
    const owner=variant.cold?new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}):window
    const probe=owner.webContents
    const phase={stage:'http-page-load'}
    const identity={node:0,backend:0,frame:''}
    const methods=[]
    const send=async(method,params)=>{
     phase.stage=method
     if(variant.helper&&variant.focus==='node'&&method==='DOM.focus'){
      if(params?.backendNodeId!==identity.backend)throw new Error('DIAGNOSTIC_TARGET_IDENTITY_MISMATCH')
      params={nodeId:identity.node}
     }
     methods.push(method)
     const response=await probe.debugger.sendCommand(method,params)
     if(method==='Accessibility.getFullAXTree')identity.backend=response.nodes?.find(node=>node.role?.value==='textbox'&&node.name?.value==='Entry')?.backendDOMNodeId??0
     if(['Input.dispatchKeyEvent','Input.insertText'].includes(method))await inputTrace(probe,'entry',variant.name,method,params)
     return response
    }
    const diagnostic=createManagedBrowserActions({send,current:async()=>{},generation:()=>1,fail:code=>{throw new Error(code)},dispatched:()=>{}})
    try{
     if(probe.debugger.isAttached())probe.debugger.detach()
     await probe.loadURL('http://127.0.0.1:'+server.address().port)
     if(process.platform==='linux'){owner.show();owner.focus();probe.focus()}
     phase.stage='debugger-attach'
     probe.debugger.attach('1.3')
     await send('Page.enable')
     await send('Accessibility.enable')
     phase.stage='helper-snapshot'
     const page=await diagnostic.snapshot({type:'snapshot',tabID:'diagnostic',generation:1})
     const entry=page.refs.find(ref=>ref.name==='Entry')
     if(!entry)throw new Error('DIAGNOSTIC_ENTRY_MISSING')
     identity.frame=page.frameID
     if(!identity.backend)throw new Error('DIAGNOSTIC_TARGET_IDENTITY_MISSING')
     if(variant.frontend){
      const document=await send('DOM.getDocument')
      const node=await send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'#entry'})
      const description=await send('DOM.describeNode',{nodeId:node.nodeId,depth:0})
      identity.node=node.nodeId
      if(!identity.node||description.node.backendNodeId!==identity.backend)throw new Error('DIAGNOSTIC_FRONTEND_TARGET_CHANGED')
     }
     await inputTrace(probe,'entry',variant.name,'ready')
     if(variant.helper){
      await diagnostic.execute({type:'fill',tabID:'diagnostic',generation:1,frameID:page.frameID,observationRevision:page.observationRevision,ref:entry.ref,text:'中文一次'})
     }else{
      const guard=async()=>{
       if(!variant.guard)return
       const frame=await send('Page.getFrameTree')
       if(frame.frameTree.frame.id!==identity.frame)throw new Error('DIAGNOSTIC_FRAME_CHANGED')
       const ax=await send('Accessibility.getPartialAXTree',{backendNodeId:identity.backend,fetchRelatives:false})
       if(!ax.nodes.some(node=>node.backendDOMNodeId===identity.backend))throw new Error('DIAGNOSTIC_AX_TARGET_MISSING')
       const node=await send('DOM.describeNode',{backendNodeId:identity.backend,depth:0})
       if(node.node.backendNodeId!==identity.backend)throw new Error('DIAGNOSTIC_BACKEND_CHANGED')
      }
      const inspect=async()=>{
       await guard()
       if(!variant.world)return
       const world=await send('Page.createIsolatedWorld',{frameId:identity.frame,worldName:'dac-managed-input-v1',grantUniveralAccess:false})
       const resolved=await send('DOM.resolveNode',{backendNodeId:identity.backend,executionContextId:world.executionContextId})
       if(!resolved.object?.objectId)throw new Error('DIAGNOSTIC_RESOLUTION_FAILED')
       try{
        await guard()
        const active=await send('Runtime.callFunctionOn',{objectId:resolved.object.objectId,functionDeclaration:'function() { return this.isConnected && document.activeElement === this && !(this instanceof HTMLInputElement && ["password","file"].includes(this.type)); }',arguments:[],returnByValue:true,awaitPromise:false,userGesture:false})
        if(active.exceptionDetails||active.result?.value!==true)throw new Error('DIAGNOSTIC_ACTIVE_TARGET_FAILED')
       }finally{await send('Runtime.releaseObject',{objectId:resolved.object.objectId})}
      }
      await send('DOM.focus',variant.focus==='node'?{nodeId:identity.node}:{backendNodeId:identity.backend})
      const key=async(name,code,modifiers,commands)=>{
       await inspect()
       await guard()
       const params={key:name,windowsVirtualKeyCode:code,modifiers}
       await send('Input.dispatchKeyEvent',{type:'keyDown',...params,...(commands?{commands}:{})})
       await send('Input.dispatchKeyEvent',{type:'keyUp',...params})
      }
      await key('a',65,process.platform==='darwin'?4:2,['selectAll'])
      await key('Backspace',8,0)
      await inspect()
      await guard()
      await send('Input.insertText',{text:'中文一次'})
     }
     await inputTrace(probe,'entry',variant.name,'terminal')
    }catch(error){
     // Diagnostics never change the original result or its business assertions.
     console.log('LINUX_BROWSER_INPUT_TRACE',JSON.stringify({scope:variant.name,stage:'diagnostic-error',during:phase.stage,name:error?.name,message:String(error?.message??error).slice(0,240)}))
    }finally{
     await diagnostic.release()
     console.log('LINUX_BROWSER_INPUT_TRACE',JSON.stringify({scope:variant.name,stage:'method-sequence',methods}))
     if(variant.cold)owner.destroy()
    }
   }
  }
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
  if (process.platform === "linux" || diagnosticAB)
    stdout.split("\n").filter((line) => line.startsWith("LINUX_BROWSER_INPUT_TRACE ")).forEach((line) => console.log(line))
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
