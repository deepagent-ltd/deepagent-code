import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("actual native wheel and pointer drag target only current observed references", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-pointer-"))
  await fs.chmod(root, 0o700)
  await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
  await Bun.write(path.join(root, "main.ts"), `
import { app, BrowserWindow } from "electron"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import { createManagedBrowserActions } from ${JSON.stringify(path.join(import.meta.dir, "managed-browser-actions.ts"))}
app.setPath("userData", ${JSON.stringify(path.join(root, "profile"))})
app.on("window-all-closed",()=>{})
const page='<html><body><button aria-label="Drag source" id="source" style="margin:40px;width:140px;height:60px">Drag source</button><button aria-label="Drop target" id="destination" style="margin:40px;width:140px;height:60px">Drop target</button><div id="scroll" role="region" aria-label="Scroll area" style="height:220px;width:400px;overflow:auto"><button>Wheel anchor</button><div style="height:2000px">Scrollable content</div></div><script>source.onpointerdown=(e)=>{source.setPointerCapture(e.pointerId);window.down={x:e.clientX,y:e.clientY};};source.onpointerup=(e)=>{window.up={x:e.clientX,y:e.clientY};window.ups=(window.ups||0)+1;};document.getElementById("scroll").onwheel=()=>{window.wheels=(window.wheels||0)+1;};</script></body></html>'
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(page)})
const result={dispatch:0,drag:null,wheel:null}
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
  const snapshot=()=>helper.snapshot({type:'snapshot',tabID:'test',generation:1})
  const target=(page,name)=>({tabID:'test',generation:1,frameID:page.frameID,observationRevision:page.observationRevision,ref:page.refs.find(ref=>ref.name===name).ref})
  const drag=await snapshot()
  await helper.execute({type:'drag',...target(drag,'Drag source'),targetRef:target(drag,'Drop target').ref,steps:8})
  result.drag=await contents.executeJavaScript('({down:window.down,up:window.up,ups:window.ups})')
  const wheel=await snapshot()
  await helper.execute({type:'scroll',...target(wheel,'Wheel anchor'),deltaX:0,deltaY:360})
  const until=Date.now()+2000
  do{
   result.wheel=await contents.executeJavaScript('({count:window.wheels||0,top:document.getElementById("scroll").scrollTop})')
   if(result.wheel.count&&result.wheel.top>0)break
   await new Promise(resolve=>setTimeout(resolve,10))
  }while(Date.now()<until)
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
  console.log("MANAGED_BROWSER_POINTER_EVIDENCE", root)
  expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.drag.ups).toBe(1)
  expect(result.drag.up.x - result.drag.down.x).toBeGreaterThan(150)
  expect(result.wheel.count).toBe(1)
  expect(result.wheel.top).toBeGreaterThan(0)
}, 30_000)
