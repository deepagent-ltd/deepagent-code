import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"

const helper = process.env.DAC_EV_HELPER
const runtime = process.env.DAC_EV_BUN
const actual = process.platform === "darwin" && process.arch === "arm64" && helper && runtime ? test : test.skip
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
actual(process.env.DAC_EV_STORE ? "signed EV rule observes actual file changes, executes and persists results without a model" : "signed native EV leaf observes content and runs actual isolated bun test with zero network", async () => {
  const repository = path.resolve(import.meta.dir, "../../../..")
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/dac-ev-native-"))
  const installation = path.join(directory, "install")
  await fs.mkdir(installation, { mode: 0o700 }); await fs.mkdir(path.join(directory, "project"), { mode: 0o700 })
  const entrypoint = path.join(import.meta.dir, "fixture/event-validation-native.ts")
  const reads = new Map<string, { path: string; bytes: number; sha256: string }>()
  const pair = generateKeyPairSync("ed25519")
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const options = { entrypoints: [entrypoint], target: "bun" as const, minify: false,
    define: { DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(publicKey), DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: '""' } }
  const discovered = await Bun.build({ ...options, plugins: [{ name: "actual-inputs", setup(build) {
    build.onLoad({ filter: /\.(?:ts|tsx|js|json)$/ }, async (args) => {
      const relative = path.relative(repository, args.path)
      if (!relative.startsWith("../") && !relative.startsWith("node_modules/")) {
        const bytes = await fs.readFile(args.path)
        reads.set(relative, { path: relative, bytes: bytes.length, sha256: hash(bytes) })
      }
      return undefined
    })
  } }] })
  expect(discovered.success, discovered.logs.join("\n")).toBe(true)
  for (const [source, name] of [[helper!, "deepagent-work-file-helper"], [runtime!, "bun-command-runtime"]]) {
    const canonical = await fs.realpath(source!)
    const stat = await fs.lstat(canonical)
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || !(stat.mode & 0o111)) throw new Error("Unsafe fixture asset")
    const bytes = await fs.readFile(canonical)
    await fs.writeFile(path.join(installation, name!), bytes, { mode: 0o755 })
    const relative = `packages/work-file-helper/bin/darwin-arm64/${name}`
    reads.set(relative, { path: relative, bytes: bytes.length, sha256: hash(bytes) })
  }
  const components = CanonicalJson.stringify(new NativeInstallationSchema.Components({ schemaVersion: "dac.native-components.v1",
    target: "darwin-arm64", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), components: [...reads.values()].sort((a,b) => a.path.localeCompare(b.path, "en")) }))
  // Use the same lexical ordering the installation verifier requires.
  const sorted = JSON.parse(components)
  sorted.components.sort((a: {path:string}, b: {path:string}) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const componentText = CanonicalJson.stringify(sorted)
  const binary = path.join(installation, "ev-fixture")
  const compiled = await Bun.build({ ...options, compile: { outfile: binary, autoloadDotenv: false, autoloadBunfig: false },
    define: { ...options.define, DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(componentText) } })
  expect(compiled.success, compiled.logs.join("\n")).toBe(true)
  for (const item of reads.values()) {
    if (item.path.startsWith("packages/work-file-helper/bin/")) continue
    expect(hash(await fs.readFile(path.join(repository, item.path)))).toBe(item.sha256)
  }
  const bytes = await fs.readFile(binary)
  const payload = new NativeInstallationSchema.Payload({ domain: NativeInstallationSchema.DOMAIN, releaseID: "ev-native-primitive",
    target: "darwin-arm64", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), componentsHash: hash(componentText),
    executable: { bytes: bytes.length, sha256: hash(bytes) } })
  await fs.writeFile(binary + NativeInstallationSchema.SIDECAR_SUFFIX, CanonicalJson.stringify({ payload,
    signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), pair.privateKey).toString("hex") }), { mode: 0o600 })
  const sink = { connections: 0 }
  const listener = net.createServer((socket) => { sink.connections++; socket.destroy() })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  try {
    const address = listener.address()
    if (!address || typeof address === "string") throw new Error("No owned listener")
    const source = `import {test,expect} from "bun:test"; import {readFileSync,writeFileSync} from "node:fs"; import {spawnSync} from "node:child_process";
test("contained test",async()=>{ ${["store-race","store-cold"].includes(process.env.DAC_EV_STORE || "") ? "await Bun.sleep(1500);" : ""} expect(()=>readFileSync(${JSON.stringify(path.join(directory, "project/guard.test.ts"))})).toThrow();
expect(()=>readFileSync(${JSON.stringify(path.join(directory, "outside-secret"))})).toThrow();
expect(()=>writeFileSync(${JSON.stringify(path.join(directory, "outside-write"))},"bad")).toThrow();
expect(process.env.SYNTHETIC_API_KEY).toBeUndefined(); expect(spawnSync(process.execPath,["--version"]).error).toBeDefined();
await expect(fetch("http://127.0.0.1:${address.port}",{signal:AbortSignal.timeout(500)})).rejects.toBeDefined();writeFileSync("result.txt","checked"); });`
    await fs.writeFile(path.join(directory, "outside-secret"), "private fixture data")
    await fs.writeFile(path.join(directory, "project/guard.test.ts"), source)
    await fs.writeFile(path.join(directory, "project/binary.dat"), Buffer.from([255,0,128,254]))
    await fs.writeFile(path.join(directory, "project/empty.dat"), Buffer.alloc(0))
    const env = { HOME: directory, DEEPAGENT_CODE_TEST_HOME: path.join(directory,"data"), XDG_CONFIG_HOME: path.join(directory,"config"),
        XDG_DATA_HOME: path.join(directory,"data"), XDG_CACHE_HOME: path.join(directory,"cache"), TMPDIR: directory,
        DEEPAGENT_CODE_DB: "validation.sqlite", SYNTHETIC_API_KEY: "must-not-inherit", DEEPAGENT_CODE_SERVER_PASSWORD: "isolated-ev-fixture-password", DEEPAGENT_CODE_SERVER_USERNAME: "ev-operator" }
    if (process.env.DAC_EV_STORE === "store-cold") {
      const owner=Bun.spawn([binary,directory,String(address.port),"store-cold-hold"],{cwd:directory,env,stdout:"pipe",stderr:"pipe",timeout:60000})
      const stdout=new Response(owner.stdout).text()
      const stderr=new Response(owner.stderr).text()
      try {
        const deadline=Date.now()+45000
        while(Date.now()<deadline && !(await fs.stat(path.join(directory,"cold-ready.json")).then(()=>true,()=>false))) await Bun.sleep(25)
        expect(await fs.stat(path.join(directory,"cold-ready.json")).then(()=>true,()=>false)).toBe(true)
      } finally { owner.kill("SIGKILL"); await owner.exited; await stdout; await stderr }
    }
    const child = Bun.spawn([binary, directory, String(address.port), process.env.DAC_EV_STORE === "store-cold" ? "store-cold-read" : process.env.DAC_EV_STORE || "native"],
      { cwd: directory, env, stdout: "pipe", stderr: "pipe", timeout: process.env.DAC_EV_STORE === "store-prepare" ? 180000 : 90000 })
    const output = await new Response(child.stdout).text()
    const diagnostic = await new Response(child.stderr).text()
    expect(await child.exited, output + diagnostic).toBe(0)
    const result = JSON.parse(output)
    expect(result.ok).toBe(true)
    if (process.env.DAC_EV_STORE === "store-prepare") {
      expect(result.value.counts).toEqual({inputs:0,providers:0,runs:11,retained:0})
      expect(result.value.results).toEqual([...Array(8).fill("no_workspace_created"),...Array(3).fill("partial_workspace_cleaned")])
      expect(result.value.consumer).toMatchObject({kind:"partial_workspace_cleaned",retained:0})
      expect(result.value.finalCounts).toEqual({inputs:0,providers:0,runs:12,retained:0})
      expect(result.value.barrier).toEqual({state:"unknown",retained:102825984,stopConfirmed:true})
      expect(result.value.barrierCounts).toEqual({inputs:0,providers:0,runs:13,retained:102825984})
      expect(result.value).toMatchObject({descriptorsClosed:11,helpersStopped:11})
    } else if (process.env.DAC_EV_STORE === "store-cold") {
      expect(result.value).toMatchObject({unchanged:true,count:1,counts:{inputs:0,providers:0},
        runs:[{state:"dispatching",observation:"recovery_required",retained:102825984,released:null}]})
    } else if (process.env.DAC_EV_STORE === "store-capture") {
      expect(result.value).toMatchObject({denied:401,candidates:200,capture:200,configure:200,exact:200,conflict:409,expired:409,exhausted:429,
        counts:{inputs:0,providers:0},runs:{count:1,released:1}})
    } else if (process.env.DAC_EV_STORE === "store-race") {
      expect(result.value).toMatchObject({count:3,counts:{inputs:0,providers:0},
        prior:{state:"superseded",current:false,content:1,stop:true},latest:{state:"settled",current:true,content:2},
        cancelled:{state:"superseded",outcome:"cancelled",current:false,stop:true,stdout:true,stderr:true}})
    } else if (process.env.DAC_EV_STORE) {
      expect(result.value).toMatchObject({ first:1,changed:2,verified:3,final:3,allReleased:true,retry:true,
        contentUnchangedOnManual:true,paused:"paused",counts:{inputs:0,providers:0} })
      expect(result.value.outcomes).toEqual(["passed","passed","passed"])
      expect(result.value.manifest.find((file: {relative:string}) => file.relative === "binary.dat")).toMatchObject({bytes:4,missing:false,sha256:hash(Buffer.from([255,0,128,254]))})
      expect(result.value.manifest.find((file: {relative:string}) => file.relative === "empty.dat")).toMatchObject({bytes:0,missing:false,sha256:hash(Buffer.alloc(0))})
      expect(result.value.manifest.find((file: {relative:string}) => file.relative === "missing.dat")).toMatchObject({bytes:0,missing:true,sha256:null,identity:null})
    } else {
      expect(result.value).toMatchObject({ started: 1, cleaned: true, changed: true,
        result: { outcome: "passed", exitCode: 0, stopConfirmed: true, stdout: {complete:true}, stderr:{complete:true} } })
      expect(result.value.result.stderr.excerpt).toContain("1 pass")
      expect(result.value.sourceBytes).toBe(source + "\n// content revision two\n")
    }
    expect(sink.connections).toBe(0)
    expect(await fs.stat(path.join(directory, "outside-write")).then(() => true, () => false)).toBe(false)
    if (process.env.DAC_EV_EVIDENCE) await fs.writeFile(path.join(process.env.DAC_EV_EVIDENCE, process.env.DAC_EV_STORE ? `${process.env.DAC_EV_STORE}-result.json` : "native-result.json"), JSON.stringify({ result:process.env.DAC_EV_STORE ? result.value : result.value.result,
      started:result.value.started,cleaned:result.value.cleaned,changed:result.value.changed,sink:sink.connections,components:[...reads.values()], binaryHash:hash(bytes) }))
  } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); await fs.rm(directory, { recursive:true,force:true }) }
}, process.env.DAC_EV_STORE === "store-prepare" ? 240000 : 120000)
