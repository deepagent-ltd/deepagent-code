import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("actual nested frames bind references to ancestor documents and click in the top viewport", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-frames-"))
  await fs.chmod(root, 0o700)
  await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
  await Bun.write(path.join(root, "main.ts"), `
import { app, BrowserWindow } from "electron"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import { createManagedBrowserActions } from ${JSON.stringify(path.join(import.meta.dir, "managed-browser-actions.ts"))}
app.setPath("userData", ${JSON.stringify(path.join(root, "profile"))})
app.on("window-all-closed",()=>{})
const pages={
 '/':'<button id="outside" onclick="window.wrong=(window.wrong||0)+1">Outside</button><iframe id="outer" src="/outer" style="display:block;width:700px;height:480px;margin:120px 0 0 140px;border:13px solid blue;transform:scale(.8);transform-origin:top left"></iframe>',
 '/outer':'<h1>Outer</h1><iframe id="nested" src="/nested" style="width:400px;height:280px;margin:55px 0 0 65px;border:9px solid green"></iframe>',
 '/nested':'<label>Nested entry<input id="entry"></label><button id="inside" style="display:block;margin:24px;width:160px;height:50px" onclick="window.clicked=(window.clicked||0)+1"><span>Inside</span></button>',
}
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(pages[req.url.split('?')[0]]||pages['/nested'])})
const result={dispatch:0,errors:[],frames:[],filled:'',clicked:0,wrong:0,staleDispatchZero:false,foreignDispatchZero:false}
async function main(){
 await app.whenReady()
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin='http://127.0.0.1:'+server.address().port
 const window=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 const contents=window.webContents
 try{
  await contents.loadURL(origin+'/')
  contents.debugger.attach('1.3')
  await contents.debugger.sendCommand('Page.enable')
  await contents.debugger.sendCommand('DOM.enable')
  await contents.debugger.sendCommand('Accessibility.enable')
  const helper=createManagedBrowserActions({send:(method,params)=>contents.debugger.sendCommand(method,params),current:async()=>{},generation:()=>1,origin,fail:(code)=>{throw new Error(code)},dispatched:()=>result.dispatch++})
  contents.debugger.on('message',(_event,method)=>{if(['DOM.documentUpdated','Page.frameDetached','Page.frameNavigated','Page.navigatedWithinDocument'].includes(method))helper.invalidate()})
  result.frames=await helper.frames()
  const nested=result.frames.find(frame=>frame.url===origin+'/nested')
  const mainFrame=result.frames.find(frame=>frame.parentFrameID===null)
  if(!nested||!nested.parentFrameID||!mainFrame)throw new Error('Missing actual frame tree')
  const snapshot=()=>helper.snapshot({type:'snapshot',tabID:'test',generation:1,frameID:nested.frameID})
  const target=(page,name)=>({tabID:'test',generation:1,frameID:page.frameID,observationRevision:page.observationRevision,ref:page.refs.find(ref=>ref.name===name).ref})
  const page=await snapshot()
  await helper.execute({type:'fill',...target(page,'Nested entry'),text:'中文嵌套输入'})
  result.filled=await contents.executeJavaScript('document.getElementById("outer").contentWindow.document.getElementById("nested").contentWindow.document.getElementById("entry").value')
  const clickable=await snapshot()
  await helper.execute({type:'click',...target(clickable,'Inside')})
  result.clicked=await contents.executeJavaScript('document.getElementById("outer").contentWindow.document.getElementById("nested").contentWindow.clicked||0')
  result.wrong=await contents.executeJavaScript('window.wrong||0')
  const before=result.dispatch
  try{await helper.execute({type:'click',...target(clickable,'Inside'),frameID:mainFrame.frameID})}catch(error){result.errors.push(error.message)}
  result.foreignDispatchZero=result.dispatch===before
  const stale=await snapshot()
  await contents.executeJavaScript('document.getElementById("outer").contentWindow.document.getElementById("nested").src="/nested?new-document";true')
  const until=Date.now()+3000
  while(Date.now()<until){
   const tree=await contents.debugger.sendCommand('Page.getFrameTree')
   if(tree.frameTree.childFrames?.[0]?.childFrames?.[0]?.frame.url.endsWith('?new-document'))break
   await new Promise(resolve=>setTimeout(resolve,10))
  }
  const old=result.dispatch
  try{await helper.execute({type:'click',...target(stale,'Inside')})}catch(error){result.errors.push(error.message)}
  result.staleDispatchZero=result.dispatch===old
  await helper.release()
  await writeFile(${JSON.stringify(path.join(root, "result.json"))},JSON.stringify(result))
 }finally{window.destroy();server.closeAllConnections();server.close()}
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)})
`)
  const built = await Bun.build({ entrypoints: [path.join(root, "main.ts")], outdir: root, target: "node", external: ["electron"] })
  expect(built.success).toBe(true)
  await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), built.outputs[0]!.path], {
    cwd: root, env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: root },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + stderr)
  console.log("MANAGED_BROWSER_FRAME_EVIDENCE", root)
  expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.frames).toHaveLength(3)
  expect(result.filled).toBe("中文嵌套输入")
  expect(result.clicked).toBe(1)
  expect(result.wrong).toBe(0)
  expect(result.foreignDispatchZero).toBe(true)
  expect(result.staleDispatchZero).toBe(true)
  expect(result.errors).toEqual(["BROWSER_STALE_TARGET", "BROWSER_STALE_TARGET"])
}, 30_000)
