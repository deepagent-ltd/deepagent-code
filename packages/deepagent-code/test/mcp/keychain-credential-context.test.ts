import { expect, test } from "bun:test"
import path from "node:path"

test("Keychain credential context only scopes the original child process environment", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      String.raw`
import assert from "node:assert/strict"
import { mock } from "bun:test"
import { Writable } from "node:stream"
import { Process } from "./src/util/process.ts"

const parentHome = process.env.HOME
const parentPath = process.env.PATH
const credentialHome = process.cwd()
const inherited = await Process.run([process.execPath, "-e", "console.log(JSON.stringify({home:process.env.HOME,path:process.env.PATH}))"], {env:{HOME:credentialHome}})
assert.deepEqual(JSON.parse(inherited.stdout.toString()), {home:credentialHome,path:parentPath})
assert.equal(process.env.HOME,parentHome)

const calls = []
const input = []
const replies = []
mock.module("./src/util/process.ts", () => ({Process:{
  run: async (argv,opts) => {
    calls.push({kind:"run",argv,opts})
    return replies.shift() ?? {code:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}
  },
  spawn: (argv,opts) => {
    calls.push({kind:"spawn",argv,opts})
    return {stdin:new Writable({write(chunk,encoding,done){input.push(chunk.toString());done()}}),exited:Promise.resolve(0)}
  },
}}))
const { SecretStore } = await import("./src/mcp/secret-store.ts")
const service = "dac-unit-credential-context"
const account = "installation-p256-v1"
const dummy = "unit-only-not-a-real-key"
const envelope = "dac-im-secret-v1:"+Buffer.from(dummy).toString("base64")
const defaults = SecretStore.macOsKeychainBackend(service,true)
replies.push({code:0,stdout:Buffer.from(envelope+"\n"),stderr:Buffer.alloc(0)})
assert.equal(await defaults.get(account),dummy)
assert.deepEqual(calls.at(-1).argv,["security","find-generic-password","-a",account,"-s",service,"-w"])
assert.deepEqual(Object.keys(calls.at(-1).opts).sort(),["abort","nothrow"])
assert.equal(calls.at(-1).opts.abort instanceof AbortSignal,true)

const context = {home:credentialHome}
const backend = SecretStore.macOsKeychainBackend(service,true,context)
context.home = "/changed-after-construction"
const start = calls.length
assert.equal(await backend.available(),process.platform === "darwin")
if(process.platform === "darwin") assert.deepEqual(calls.at(-1).argv,["/usr/bin/security","list-keychains"])
replies.push({code:0,stdout:Buffer.from(envelope+"\n"),stderr:Buffer.alloc(0)})
assert.equal(await backend.get(account),dummy)
replies.push({code:44,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)})
assert.equal(await backend.get(account),undefined)
replies.push({code:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)})
await assert.rejects(backend.get(account),/Keychain protected read failed/)
replies.push({code:0,stdout:Buffer.from("not-a-protected-envelope"),stderr:Buffer.alloc(0)})
await assert.rejects(backend.get(account),/Protected secret envelope is invalid/)
await backend.put(account,dummy)
replies.push({code:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)})
await backend.remove(account)
for(const call of calls.slice(start)){
  assert.equal(call.argv[0],"/usr/bin/security")
  assert.deepEqual(call.opts.env,{HOME:credentialHome})
  assert.equal(call.opts.abort instanceof AbortSignal,true)
}
assert.deepEqual(calls.find(x=>x.kind === "spawn").argv,["/usr/bin/security","-i","-q"])
assert.equal(input.length,1)
assert.equal(input[0].includes(dummy),false)
assert.equal(input[0].startsWith("add-generic-password "),true)
assert.equal(process.env.HOME,parentHome)
assert.equal(process.env.PATH,parentPath)
assert.equal(replies.length,0)
console.log("KEYCHAIN_CONTEXT_UNIT_PASS_NO_SECURITY_EXECUTED")
`,
    ],
    { cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(child.stdout.toString()).toContain("KEYCHAIN_CONTEXT_UNIT_PASS_NO_SECURITY_EXECUTED")
})
