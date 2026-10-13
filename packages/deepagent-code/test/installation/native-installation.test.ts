import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"

const fixture = path.join(import.meta.dir, "fixture/native-installation-process.ts")
const repository = path.resolve(import.meta.dir, "../../../..")
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-installation-"))
const executable = path.join(directory, process.platform === "win32" ? "native-fixture.exe" : "native-fixture")
const pair = generateKeyPairSync("ed25519")
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const privateSentinel = "private-native-manifest-content-must-not-escape"
const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")
const inventory = [
  "packages/deepagent-code/src/installation/native-installation.schema.ts",
  "packages/deepagent-code/src/installation/native-installation.ts",
  "packages/deepagent-code/test/installation/fixture/native-installation-process.ts",
  "packages/llm/src/route/executor.ts",
].toSorted()
const components = new NativeInstallationSchema.Components({
  schemaVersion: "dac.native-components.v1",
  target: `${process.platform}-${process.arch}`,
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  components: await Promise.all(
    inventory.map(async (entry) => {
      const bytes = await Bun.file(path.join(repository, entry)).bytes()
      return new NativeInstallationSchema.Component({ path: entry, bytes: bytes.byteLength, sha256: hash(bytes) })
    }),
  ),
})
const componentsText = CanonicalJson.stringify(components)
const state: { payload?: NativeInstallationSchema.Payload } = {}

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [fixture],
    target: "bun",
    compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
    define: {
      DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(publicKey),
      DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(componentsText),
    },
  })
  expect(result.success).toBe(true)
  const bytes = await Bun.file(executable).bytes()
  state.payload = new NativeInstallationSchema.Payload({
    domain: NativeInstallationSchema.DOMAIN,
    releaseID: "isolated-compiled-fixture",
    target: `${process.platform}-${process.arch}`,
    sourceCommit: components.sourceCommit,
    sourceTree: components.sourceTree,
    componentsHash: hash(componentsText),
    executable: new NativeInstallationSchema.Executable({ bytes: bytes.byteLength, sha256: hash(bytes) }),
  })
  // Only public evidence is eligible for retention. The private KeyObject stays in this parent process.
  await Bun.write(path.join(directory, "public-key.pem"), publicKey)
  await Bun.write(path.join(directory, "components.json"), componentsText)
  await writeManifest(executable, state.payload)
  if (process.env.DAC_NATIVE_INSTALLATION_EVIDENCE)
    await Bun.write(
      path.join(process.env.DAC_NATIVE_INSTALLATION_EVIDENCE, "compiled-artifact.json"),
      CanonicalJson.stringify({ directory, executable: state.payload.executable, publicKey, components }),
    )
}, 60_000)

afterAll(async () => {
  if (!process.env.DAC_NATIVE_INSTALLATION_EVIDENCE) await fs.rm(directory, { recursive: true, force: true })
})

async function writeManifest(binary: string, payload: NativeInstallationSchema.Payload, signature?: string) {
  const manifest = new NativeInstallationSchema.Manifest({
    payload,
    signature: signature ?? sign(null, Buffer.from(CanonicalJson.stringify(payload)), pair.privateKey).toString("hex"),
  })
  await fs.writeFile(`${binary}${NativeInstallationSchema.SIDECAR_SUFFIX}`, CanonicalJson.stringify(manifest), {
    mode: 0o644,
  })
}

async function isolated(name: string) {
  const root = path.join(directory, name)
  await fs.mkdir(root, { mode: 0o700 })
  const binary = path.join(root, path.basename(executable))
  await fs.copyFile(executable, binary)
  await fs.chmod(binary, 0o755)
  await writeManifest(binary, state.payload!)
  return { root, binary }
}

function spawn(binary: string, mode = "inspect", source = false) {
  return Bun.spawn(source ? [process.execPath, fixture, mode] : [binary, mode], {
    cwd: directory,
    env: {
      HOME: directory,
      TMPDIR: directory,
      XDG_DATA_HOME: directory,
      XDG_CONFIG_HOME: directory,
      XDG_CACHE_HOME: directory,
      XDG_STATE_HOME: directory,
      // Environment names must never become the compiled issuance pin or component manifest.
      DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: publicKey,
      DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: componentsText,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  })
}

async function output(child: ReturnType<typeof spawn>) {
  child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stdout + stderr).not.toContain(privateSentinel)
  expect(stdout + stderr).not.toContain(directory)
  expect(stdout + stderr).not.toContain("PRIVATE KEY")
  return { stdout, stderr, code }
}

async function rejected(binary: string, code: string, source = false) {
  const result = await output(spawn(binary, "inspect", source))
  expect(result.code).toBe(2)
  expect(result.stdout).toContain(code)
  expect(JSON.parse(result.stdout).ok).toBe(false)
}

test("compiled process verifies its own signed executable and immutable local handle", async () => {
  const result = await output(spawn(executable))
  expect(result.code).toBe(0)
  const parsed = JSON.parse(result.stdout)
  expect(parsed.ok).toBe(true)
  expect(parsed.result.description.executableHash).toBe(state.payload!.executable.sha256)
  expect(parsed.result.description.executableBytes).toBe(state.payload!.executable.bytes)
  expect(parsed.result.description.componentsHash).toBe(hash(componentsText))
  expect(parsed.result.description).toEqual(parsed.result.rechecked)
  expect(parsed.result.description).not.toHaveProperty("generation")
  expect(parsed.result.description).not.toHaveProperty("approved")
})

test("copied, JSON, structural and null handles have no identity", async () => {
  const result = await output(spawn(executable, "handles"))
  expect(result.code).toBe(0)
  const parsed = JSON.parse(result.stdout)
  expect(parsed.result.frozen).toBe(true)
  expect(parsed.result.mutable).toBe(false)
  expect(parsed.result.serialized).toBe("{}")
  expect(parsed.result.rejected).toBe(true)
  expect(parsed.result.errors).toHaveLength(10)
  expect(parsed.result.errors.every((value: string) => value.includes("NATIVE_HANDLE_INVALID"))).toBe(true)
})

test("source Bun cannot treat its interpreter or environment defines as installed proof", async () => {
  await rejected(executable, "NATIVE_INSTALLATION_UNAVAILABLE", true)
})

test("a different valid Ed25519 issuer cannot replace the compiled pin", async () => {
  const item = await isolated("wrong-issuer")
  const wrong = generateKeyPairSync("ed25519")
  await writeManifest(
    item.binary,
    state.payload!,
    sign(null, Buffer.from(CanonicalJson.stringify(state.payload!)), wrong.privateKey).toString("hex"),
  )
  await rejected(item.binary, "NATIVE_SIGNATURE_INVALID")
})

test.each(["hardlink", "writable"])("rejects unsafe executable identity: %s", async (kind) => {
  const item = await isolated(`binary-${kind}`)
  if (kind === "hardlink") await fs.link(item.binary, `${item.binary}.link`)
  if (kind === "writable") await fs.chmod(item.binary, 0o777)
  await rejected(item.binary, "NATIVE_INSTALLATION_UNAVAILABLE")
})

test.each([
  ["signature", "NATIVE_SIGNATURE_INVALID"],
  ["components", "NATIVE_COMPONENTS_MISMATCH"],
  ["commit", "NATIVE_COMPONENTS_MISMATCH"],
  ["target", "NATIVE_TARGET_MISMATCH"],
  ["binary", "NATIVE_BYTES_MISMATCH"],
  ["size", "NATIVE_BYTES_MISMATCH"],
] as const)("rejects signed artifact mismatch: %s", async (kind, error) => {
  const item = await isolated(kind)
  const payload = new NativeInstallationSchema.Payload({
    ...state.payload!,
    ...(kind === "components" ? { componentsHash: "c".repeat(64) } : {}),
    ...(kind === "commit" ? { sourceCommit: "c".repeat(40) } : {}),
    ...(kind === "target" ? { target: process.platform === "linux" ? "darwin-arm64" : "linux-x64" } : {}),
    ...(kind === "binary"
      ? {
          executable: new NativeInstallationSchema.Executable({ ...state.payload!.executable, sha256: "d".repeat(64) }),
        }
      : {}),
    ...(kind === "size"
      ? { executable: new NativeInstallationSchema.Executable({ ...state.payload!.executable, bytes: 1 }) }
      : {}),
  })
  await writeManifest(item.binary, payload, kind === "signature" ? "0".repeat(128) : undefined)
  await rejected(item.binary, error)
})

test.each(["excess", "duplicate", "domain", "oversize", "utf8", "bom", "missing", "symlink", "writable", "hardlink"])(
  "rejects malformed or unsafe sidecar without leaking content: %s",
  async (kind) => {
    const item = await isolated(kind)
    const sidecar = `${item.binary}${NativeInstallationSchema.SIDECAR_SUFFIX}`
    const original = await Bun.file(sidecar).text()
    if (kind === "excess") await fs.writeFile(sidecar, original.replace(/}$/, `,"extra":"${privateSentinel}"}`))
    if (kind === "duplicate")
      await fs.writeFile(sidecar, original.replace("{", '{"signature":"' + "0".repeat(128) + '",'))
    if (kind === "domain")
      await fs.writeFile(sidecar, original.replace(NativeInstallationSchema.DOMAIN, privateSentinel))
    if (kind === "oversize") await fs.writeFile(sidecar, privateSentinel.repeat(1000))
    if (kind === "utf8") await fs.writeFile(sidecar, Buffer.from([0xff, 0xfe, 0xfd]))
    if (kind === "bom") await fs.writeFile(sidecar, `\ufeff${original}`)
    if (kind === "missing") await fs.unlink(sidecar)
    if (kind === "symlink") {
      await fs.rename(sidecar, `${sidecar}.target`)
      await fs.symlink(`${sidecar}.target`, sidecar)
    }
    if (kind === "writable") await fs.chmod(sidecar, 0o666)
    if (kind === "hardlink") await fs.link(sidecar, `${sidecar}.linked`)
    await rejected(
      item.binary,
      ["excess", "duplicate", "domain", "bom"].includes(kind)
        ? "NATIVE_MANIFEST_INVALID"
        : kind === "symlink"
          ? "NATIVE_IDENTITY_CHANGED"
          : "NATIVE_INSTALLATION_UNAVAILABLE",
    )
  },
)

test.each(["sidecar", "executable", "changed-bytes"])("requireCurrent refuses post-capture %s drift", async (kind) => {
  const item = await isolated(`drift-${kind}`)
  const child = spawn(item.binary, "hold")
  const reader = child.stdout.getReader()
  const initial = await reader.read()
  expect(initial.done).toBe(false)
  const ready = new TextDecoder().decode(initial.value)
  expect(JSON.parse(ready).ready).toBe(true)
  const filename = kind === "sidecar" ? `${item.binary}${NativeInstallationSchema.SIDECAR_SUFFIX}` : item.binary
  await fs.copyFile(filename, `${filename}.replacement`)
  if (kind === "changed-bytes") await fs.appendFile(`${filename}.replacement`, "fixture changed binary bytes")
  await fs.rename(`${filename}.replacement`, filename)
  child.stdin.write("continue\n")
  child.stdin.end()
  const rest: string[] = []
  while (true) {
    const value = await reader.read()
    if (value.done) break
    rest.push(new TextDecoder().decode(value.value))
  }
  expect(await child.exited).toBe(2)
  const stderr = await new Response(child.stderr).text()
  expect(rest.join("") + stderr).toContain(
    kind === "changed-bytes" ? "NATIVE_BYTES_MISMATCH" : "NATIVE_IDENTITY_CHANGED",
  )
  expect(rest.join("")).toContain('"invalidated":true')
  expect(rest.join("") + stderr).not.toContain(directory)
  expect(rest.join("") + stderr).not.toContain(privateSentinel)
})

test("actual executable bytes differ after harmless trailing mutation", async () => {
  const item = await isolated("actual-bytes")
  await fs.appendFile(item.binary, "fixture changed binary bytes")
  const result = await output(spawn(item.binary))
  // Bun may reject its executable trailer before loading JS; either path must reject, never verify.
  expect(result.code).not.toBe(0)
  expect(result.stdout).not.toContain('"ok":true')
})
