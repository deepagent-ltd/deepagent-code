import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { WindowsNativeCliCohort } from "../fixture/windows-native-cli-cohort"
import { windowsNativePublisherTools } from "../../../desktop/scripts/test-native-publisher"

const fixture = path.join(import.meta.dir, "fixture/native-installation-process.ts")
const repository = path.resolve(import.meta.dir, "../../../..")
const temporary = process.platform === "win32" ? path.join(repository, ".artifacts/unit") : os.tmpdir()
if (process.platform === "win32") await fs.mkdir(temporary, { recursive: true })
const directory = await fs.mkdtemp(path.join(temporary, "dac-native-installation-"))
const executable = path.join(directory, process.platform === "win32" ? "deepagent-code.exe" : "native-fixture")
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
const state: { payload?: NativeInstallationSchema.Payload; windows?: {
  cohort: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>>
  publicKey: string
  componentsText: string
} } = {}

beforeAll(async () => {
  if (process.platform === "win32") {
    const cohort = await WindowsNativeCliCohort.build({ directory: await fs.realpath(directory), businessEntry: fixture,
      extraSources: [fileURLToPath(import.meta.url)],
      manifestVariants: (payload) => Object.fromEntries(["components", "commit", "target", "binary", "size"].map((kind) => [kind,
        new NativeInstallationSchema.Payload({ ...payload,
          ...(kind === "components" ? { componentsHash: "c".repeat(64) } : {}),
          ...(kind === "commit" ? { sourceCommit: "c".repeat(40) } : {}),
          ...(kind === "target" ? { target: "linux-x64" } : {}),
          ...(kind === "binary" ? { executable: new NativeInstallationSchema.Executable({ ...payload.executable, sha256: "d".repeat(64) }) } : {}),
          ...(kind === "size" ? { executable: new NativeInstallationSchema.Executable({ ...payload.executable, bytes: 1 }) } : {}),
        }),
      ])),
    })
    state.payload = cohort.payload
    state.windows = { cohort, publicKey: await fs.readFile(path.join(cohort.root, "publisher-public.pem"), "utf8"),
      componentsText: CanonicalJson.stringify(cohort.components) }
    for (const text of Object.values(cohort.manifests)) {
      const manifest = JSON.parse(text) as NativeInstallationSchema.Manifest
      expect(verify(null, Buffer.from(CanonicalJson.stringify(manifest.payload)), state.windows.publicKey,
        Buffer.from(manifest.signature, "hex"))).toBe(true)
    }
    return
  }
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
}, process.platform === "win32" ? 240_000 : 60_000)

afterAll(async () => {
  if (state.windows) {
    await state.windows.cohort.dispose()
    return
  }
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
  if (state.windows) {
    const root = path.join(state.windows.cohort.root, name)
    await fs.mkdir(root, { mode: 0o700 })
    const prefix = `packages/work-file-helper/bin/win32-${process.arch}/`
    const assets = state.windows.cohort.components.components.filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => entry.path.slice(prefix.length))
    expect(assets.every((name) => name && !name.includes("/") && !name.includes("\\"))).toBe(true)
    const names = [...new Set(["deepagent-code.exe", "deepagent-code.exe.native-components.json",
      "deepagent-code.exe.native-installation.json", "native-preloader.installation.json", ...assets])]
    for (const file of names)
      await fs.copyFile(path.join(state.windows.cohort.root, file), path.join(root, file), fs.constants.COPYFILE_EXCL)
    for (const name of ["profile", "profile/appdata", "profile/localappdata", "tmp", "data", "config", "cache", "state"])
      await fs.mkdir(path.join(root, name), { recursive: true, mode: 0o700 })
    const binary = path.join(root, "deepagent-code.exe")
    await windowsAccepted(binary)
    return { root, binary }
  }
  const root = path.join(directory, name)
  await fs.mkdir(root, { mode: 0o700 })
  const binary = path.join(root, path.basename(executable))
  await fs.copyFile(executable, binary)
  await fs.chmod(binary, 0o755)
  await writeManifest(binary, state.payload!)
  return { root, binary }
}

function spawn(binary: string, mode = "inspect", source = false) {
  const actual = state.windows && binary === executable ? state.windows.cohort.executable : binary
  const root = path.dirname(actual)
  return Bun.spawn(source ? [process.execPath, fixture, mode] : [actual, mode], {
    cwd: directory,
    env: {
      ...(state.windows ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot, USERPROFILE: path.join(root, "profile"),
        APPDATA: path.join(root, "profile/appdata"), LOCALAPPDATA: path.join(root, "profile/localappdata"),
        TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
        DEEPAGENT_CODE_TEST_HOME: root, DEEPAGENT_CODE_HOME: path.join(root, "data"),
      } : {}),
      HOME: state.windows ? path.join(root, "profile") : directory,
      TMPDIR: state.windows ? path.join(root, "tmp") : directory,
      XDG_DATA_HOME: state.windows ? path.join(root, "data") : directory,
      XDG_CONFIG_HOME: state.windows ? path.join(root, "config") : directory,
      XDG_CACHE_HOME: state.windows ? path.join(root, "cache") : directory,
      XDG_STATE_HOME: state.windows ? path.join(root, "state") : directory,
      // Environment names must never become the compiled issuance pin or component manifest.
      DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: state.windows?.publicKey ?? publicKey,
      DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: state.windows?.componentsText ?? componentsText,
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

async function windowsAccepted(binary: string) {
  const result = await output(spawn(binary))
  expect(result.code).toBe(0)
  const parsed = JSON.parse(result.stdout) as { ok: boolean; result: { description: unknown; rechecked: unknown } }
  expect(parsed.ok).toBe(true)
  expect(parsed.result.description).toMatchObject({ target: `win32-${process.arch}`,
    executableHash: state.payload!.executable.sha256, executableBytes: state.payload!.executable.bytes,
    componentsHash: hash(state.windows!.componentsText),
    signerHash: hash(createPublicKey(state.windows!.publicKey).export({ type: "spki", format: "der" })) })
  expect(parsed.result.description).toEqual(parsed.result.rechecked)
  expect(parsed.result.description).not.toHaveProperty("generation")
  expect(parsed.result.description).not.toHaveProperty("approved")
}

function windowsEntryDenied(result: Awaited<ReturnType<typeof output>>, marker?: string) {
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('"stage":"windows-cli-entry"')
  expect(result.stderr).toContain('"code":"WINDOWS_FIRST_LOADER_UNAVAILABLE"')
  expect(result.stderr).toContain("WINDOWS_CLI_NATIVE_BOOTSTRAP_UNAVAILABLE")
  if (marker) expect(result.stderr).toContain(marker)
  expect(result.stdout).not.toContain('"ok":true')
  expect(result.stdout).not.toContain('"ready":true')
}

async function windowsRejected(binary: string, code: string, allowPreloader = false, marker?: string) {
  const result = await output(spawn(binary))
  if (allowPreloader && result.code !== 2) {
    windowsEntryDenied(result)
    return
  }
  expect(result.code).toBe(2)
  const parsed = JSON.parse(result.stdout) as { ok: boolean; structured: { code: string } }
  expect(parsed.ok).toBe(false)
  expect(parsed.structured.code).toBe(code)
  if (marker) expect(result.stderr).toContain(marker)
}

async function untrustedWriter(filename: string) {
  const result = Bun.spawnSync([windowsNativePublisherTools().acl, filename, "/grant:r", "*S-1-1-0:(W)"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
  })
  expect(result.exitCode).toBe(0)
}

async function windowsHeld(binary: string, kind: string) {
  const filename = kind === "sidecar" ? `${binary}${NativeInstallationSchema.SIDECAR_SUFFIX}` : binary
  const replacement = `${filename}.replacement`
  if (kind !== "changed-bytes") await fs.copyFile(filename, replacement, fs.constants.COPYFILE_EXCL)
  const child = spawn(binary, "hold")
  const reader = child.stdout.getReader()
  const errors = new Response(child.stderr).text()
  const identity = async () => {
    const stat = await fs.stat(filename, { bigint: true })
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(":")
  }
  try {
    const ready = { text: "" }
    while (!ready.text.includes("\n")) {
      const value = await reader.read()
      expect(value.done).toBe(false)
      ready.text += new TextDecoder().decode(value.value)
    }
    const boundary = ready.text.indexOf("\n")
    const captured = JSON.parse(ready.text.slice(0, boundary)) as { ready: boolean; description: unknown }
    expect(captured.ready).toBe(true)
    const before = { identity: await identity(), hash: hash(await fs.readFile(filename)) }
    if (kind === "changed-bytes")
      await expect(fs.appendFile(filename, "fixture changed binary bytes")).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:EACCES|EPERM|EBUSY)$/),
      })
    if (kind !== "changed-bytes") {
      await expect(fs.rename(replacement, filename)).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:EACCES|EPERM|EBUSY)$/),
      })
    }
    expect(await identity()).toBe(before.identity)
    expect(hash(await fs.readFile(filename))).toBe(before.hash)
    child.stdin.write("continue\n")
    child.stdin.end()
    const rest = [ready.text.slice(boundary + 1)]
    for (;;) {
      const value = await reader.read()
      if (value.done) break
      rest.push(new TextDecoder().decode(value.value))
    }
    expect(await child.exited).toBe(0)
    const parsed = JSON.parse(rest.join("")) as { ok: boolean; result: { description: unknown; rechecked: unknown } }
    expect(parsed.ok).toBe(true)
    expect(parsed.result.description).toEqual(captured.description)
    expect(parsed.result.rechecked).toEqual(captured.description)
    expect(rest.join("") + await errors).not.toContain(directory)
    expect(rest.join("") + await errors).not.toContain(privateSentinel)
    // The same owned mutation must work after the original process tree joins;
    // a permanent ACL denial is not evidence of the Native held-file lease.
    if (kind === "changed-bytes") {
      await fs.appendFile(filename, "fixture changed binary bytes")
      expect(hash(await fs.readFile(filename))).not.toBe(before.hash)
    }
    if (kind !== "changed-bytes") {
      await fs.rename(replacement, filename)
      expect(hash(await fs.readFile(filename))).toBe(before.hash)
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await errors
    reader.releaseLock()
  }
}

test("compiled process verifies its own signed executable and immutable local handle", async () => {
  if (state.windows) {
    await windowsAccepted(executable)
    return
  }
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
  if (state.windows) {
    await windowsRejected(item.binary, "NATIVE_SIGNATURE_INVALID", true)
    return
  }
  await rejected(item.binary, "NATIVE_SIGNATURE_INVALID")
})

test.each(["hardlink", "writable"])("rejects unsafe executable identity: %s", async (kind) => {
  const item = await isolated(`binary-${kind}`)
  if (state.windows) {
    if (kind === "hardlink") {
      await fs.link(item.binary, `${item.binary}.link`)
      expect((await fs.stat(item.binary)).nlink).toBe(2)
    }
    if (kind === "writable") await untrustedWriter(item.binary)
    windowsEntryDenied(await output(spawn(item.binary)), kind === "hardlink"
      ? "dac-native-path-lease:singlelink:" : "dac-native-first-load:module-private-dacl:deepagent-code.exe:")
    return
  }
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
  if (state.windows) {
    const manifest = kind === "signature"
      ? CanonicalJson.stringify(new NativeInstallationSchema.Manifest({ payload: state.payload!, signature: "0".repeat(128) }))
      : state.windows.cohort.manifests[kind]!
    expect(typeof manifest).toBe("string")
    if (kind !== "signature") {
      const parsed = JSON.parse(manifest) as NativeInstallationSchema.Manifest
      expect(verify(null, Buffer.from(CanonicalJson.stringify(parsed.payload)), state.windows.publicKey,
        Buffer.from(parsed.signature, "hex"))).toBe(true)
    }
    await fs.writeFile(`${item.binary}${NativeInstallationSchema.SIDECAR_SUFFIX}`, manifest)
    await windowsRejected(item.binary, error, true)
    return
  }
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
    if (kind === "writable" && state.windows) await untrustedWriter(sidecar)
    if (kind === "writable" && !state.windows) await fs.chmod(sidecar, 0o666)
    if (kind === "hardlink") await fs.link(sidecar, `${sidecar}.linked`)
    if (state.windows) {
      if (kind === "symlink") expect((await fs.lstat(sidecar)).isSymbolicLink()).toBe(true)
      if (kind === "hardlink") expect((await fs.stat(sidecar)).nlink).toBe(2)
      await windowsRejected(item.binary, ["excess", "duplicate", "domain", "bom"].includes(kind)
        ? "NATIVE_MANIFEST_INVALID" : "NATIVE_INSTALLATION_UNAVAILABLE", false,
      ["missing", "symlink", "writable", "hardlink", "utf8"].includes(kind)
        ? "dac-native-preload:installation-open:" : undefined)
      return
    }
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

test.each(["sidecar", "executable", "changed-bytes"])(process.platform === "win32" ? "Windows held installation lease denies captured %s mutation" : "requireCurrent refuses post-capture %s drift", async (kind) => {
  const item = await isolated(`drift-${kind}`)
  if (state.windows) {
    await windowsHeld(item.binary, kind)
    return
  }
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
