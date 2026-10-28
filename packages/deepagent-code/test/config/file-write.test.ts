import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { parse } from "jsonc-parser"
import { ConfigFileWrite } from "@/config/file-write"
import type { WindowsNativeCliCohort } from "../fixture/windows-native-cli-cohort"

const native: { cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const { WindowsNativeCliCohort } = await import("../fixture/windows-native-cli-cohort")
  const directory = path.resolve(import.meta.dir, "../../.artifacts/windows-native-config")
  await fs.mkdir(directory, { recursive: true })
  native.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "fixture/file-write-process.ts"),
    extraSources: [import.meta.path, ...["auth", "account", "npm"].map((name) =>
      path.resolve(import.meta.dir, `../fake/${name}.ts`))],
  })
}, 240_000)
afterAll(async () => { await native.cohort?.dispose() })

async function tmpdir() {
  if (process.platform !== "win32") {
    const { tmpdir } = await import("../fixture/fixture")
    return tmpdir()
  }
  const directory = await fs.realpath(await fs.mkdtemp(path.join(native.cohort!.root, "config-case-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() { await fs.rm(directory, { recursive: true, force: true }) },
  }
}

const original =
  '// original comment\n{"$schema":"https://ai.deepagent.ltd/config.schema.json","mcp":{"original":{"type":"local","command":["original"],"environment":{"KEEP":"${FIXTURE_KEEP}"}}}}'

test("Windows ACL codec uses a static encoded script and literal paths in a minimal child environment", () => {
  const source = "C:\\fixture O'Brien\\配置[1];$x\\config.jsonc"
  const target = "C:\\fixture O'Brien\\配置[1];$x\\.replacement.tmp"
  const invocation = ConfigFileWrite.windowsACLInvocation("C:\\Windows", source, target)
  expect(invocation.cmd[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  expect(invocation.cmd.slice(1, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
  expect(invocation.env).toEqual({
    SystemRoot: "C:\\Windows",
    DAC_CONFIG_ACL_SOURCE: source,
    DAC_CONFIG_ACL_TARGET: target,
  })
  const script = Buffer.from(invocation.cmd.at(-1)!, "base64").toString("utf16le")
  expect(script).toContain("Get-Acl -LiteralPath $env:DAC_CONFIG_ACL_SOURCE")
  expect(script).toContain("Set-Acl -LiteralPath $env:DAC_CONFIG_ACL_TARGET -AclObject $source")
  expect(script).toContain("$source.Owner -ne $target.Owner")
  expect(script).toContain("GetSecurityDescriptorSddlForm($sections)")
  expect(script).not.toContain(source)
  expect(script).not.toContain(target)
  expect(script).not.toContain("Invoke-Expression")
  expect(() => ConfigFileWrite.windowsACLInvocation("relative", source, target)).toThrow(
    "Configuration file unavailable",
  )
  expect(() => ConfigFileWrite.windowsACLInvocation("C:\\Windows", "\\root-relative", target)).toThrow(
    "Configuration file unavailable",
  )
  expect(() => ConfigFileWrite.windowsACLInvocation("C:\\Windows", `${source}\0`, target)).toThrow(
    "Configuration file unavailable",
  )
})

async function child(root: string, role: string, expected?: string) {
  const privateRoot = path.join(root, `.process-${role}`)
  await Promise.all(
    ["home", "config", "data", "state", "cache", "tmp"].map((name) =>
      fs.mkdir(path.join(privateRoot, name), { recursive: true }),
    ),
  )
  const env = {
    ...(globalThis.process.platform === "win32" ? {
      SystemRoot: globalThis.process.env.SystemRoot ?? globalThis.process.env.SYSTEMROOT,
      WINDIR: globalThis.process.env.WINDIR,
      ComSpec: globalThis.process.env.ComSpec ?? globalThis.process.env.COMSPEC,
      SystemDrive: globalThis.process.env.SystemDrive,
      USERPROFILE: path.join(privateRoot, "home"),
      APPDATA: path.join(privateRoot, "config"),
      LOCALAPPDATA: path.join(privateRoot, "data"),
      TEMP: path.join(privateRoot, "tmp"),
      TMP: path.join(privateRoot, "tmp"),
      DEEPAGENT_CODE_HOME: path.join(privateRoot, "home", ".deepagent", "code"),
    } : {}),
    PATH: globalThis.process.env.PATH,
    HOME: path.join(privateRoot, "home"),
    DEEPAGENT_CODE_TEST_HOME: path.join(privateRoot, "home"),
    XDG_CONFIG_HOME: path.join(privateRoot, "config"),
    XDG_DATA_HOME: path.join(privateRoot, "data"),
    XDG_STATE_HOME: path.join(privateRoot, "state"),
    XDG_CACHE_HOME: path.join(privateRoot, "cache"),
    TMPDIR: path.join(privateRoot, "tmp"),
    DEEPAGENT_CODE_DB: path.join(privateRoot, "database.sqlite"),
    DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(privateRoot, "managed"),
    DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
  }
  if (globalThis.process.platform === "win32") {
    const result = await native.cohort!.run({
      args: [root, role, ...(expected ? [expected] : [])],
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      inheritEnvironment: false,
      milliseconds: 20_000,
    })
    observeChild(role, result)
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const process = Bun.spawn({
    cmd: [
      globalThis.process.execPath,
      "--preload",
      path.join(import.meta.dir, "fixture/file-write-preload.ts"),
      path.join(import.meta.dir, "fixture/file-write-process.ts"),
      root,
      role,
      ...(expected ? [expected] : []),
    ],
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => process.kill(), 20_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    observeChild(role, { code, stderr })
    return { code, stdout, stderr }
  } finally {
    clearTimeout(deadline)
    process.kill()
    await process.exited
  }
}

function observeChild(role: string, result: { code: number | null; stderr: string }) {
  console.info("CONFIG_FILE_WRITE_CHILD_PHASES", JSON.stringify({
    role, code: result.code, phases: result.stderr.split(/\r?\n/).filter((line) => line.startsWith("CONFIG_FILE_WRITE_CHILD_PHASE ")),
  }))
}

test("actual CLI and Config processes use one canonical lock and only one same-expected write succeeds", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "deepagent-code.json")
  await fs.writeFile(file, original)
  const observed = await ConfigFileWrite.run(ConfigFileWrite.read(file))
  const expected = path.join(tmp.path, "expected.json")
  await Bun.write(expected, JSON.stringify({ path: observed.path, stamp: observed.stamp }))
  const results = await Promise.all([child(tmp.path, "cli-add", expected), child(tmp.path, "config", expected)])
  expect(results.map((result) => result.code).sort(), JSON.stringify(results)).toEqual([0, 3])
  const written = await fs.readFile(file, "utf8")
  expect(written).toContain("// original comment")
  expect(written).toContain("${FIXTURE_KEEP}")
  expect(parse(written).mcp.original.command).toEqual(["original"])
  expect(Object.keys(parse(written).mcp)).toHaveLength(2)
  expect((await fs.readdir(tmp.path)).some((name) => name.startsWith(".dac-config-") && name.endsWith(".tmp"))).toBe(
    false,
  )
}, 30_000)

test("fresh CLI and Config patches both survive without losing comments or sibling entries", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "deepagent-code.json")
  await fs.writeFile(file, original)
  const results = await Promise.all([child(tmp.path, "cli-add"), child(tmp.path, "config")])
  expect(
    results.map((result) => result.code),
    JSON.stringify(results),
  ).toEqual([0, 0])
  const written = await fs.readFile(file, "utf8")
  expect(Object.keys(parse(written).mcp).sort()).toEqual(["cli_writer", "config_writer", "original"])
  expect(written).toContain("// original comment")
  expect(written).toContain("${FIXTURE_KEEP}")
}, 30_000)

test("leaf edits and same-byte new inode reject the captured source and preserve the changed file", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "deepagent-code.json")
  await fs.writeFile(file, original)
  const before = await ConfigFileWrite.run(ConfigFileWrite.read(file))
  await fs.writeFile(file, original.replace('"original"]', '"user-changed"]'))
  const changed = await fs.readFile(file)
  const leaf = await Effect.runPromiseExit(
    ConfigFileWrite.edit(file, () => ({ text: "{}", value: undefined }), before).pipe(
      Effect.provide(
        Layer.mergeAll(
          (await import("@deepagent-code/core/fs-util")).FSUtil.defaultLayer,
          (await import("@deepagent-code/core/util/effect-flock")).EffectFlock.defaultLayer,
        ),
      ),
    ),
  )
  expect(Exit.isFailure(leaf)).toBe(true)
  if (Exit.isFailure(leaf)) expect(Cause.squash(leaf.cause)).toMatchObject({ reason: "changed" })
  expect(await fs.readFile(file)).toEqual(changed)
  const sameBytes = await ConfigFileWrite.run(ConfigFileWrite.read(file))
  const replacement = path.join(tmp.path, "replacement")
  await fs.writeFile(replacement, changed)
  await fs.rename(replacement, file)
  const expected = path.join(tmp.path, "expected.json")
  await Bun.write(expected, JSON.stringify({ path: sameBytes.path, stamp: sameBytes.stamp }))
  expect((await child(tmp.path, "cli-remove", expected)).code).toBe(3)
  expect(await fs.readFile(file)).toEqual(changed)
  const escaped = await ConfigFileWrite.run(
    ConfigFileWrite.transaction([file], (tx) => Effect.succeed(tx.write(tx.file(file), "{}"))),
  )
  await expect(ConfigFileWrite.run(escaped)).rejects.toThrow("Configuration file changed")
  expect(await fs.readFile(file)).toEqual(changed)
}, 30_000)

test("CLI add/edit/remove and unused rewrite retain the original file representation", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "deepagent-code.json")
  await fs.writeFile(file, original)
  expect((await child(tmp.path, "cli-edit")).code).toBe(0)
  expect(parse(await fs.readFile(file, "utf8")).mcp.original.command).toEqual(["updated"])
  expect((await child(tmp.path, "rewrite")).code).toBe(0)
  expect(parse(await fs.readFile(file, "utf8")).mcp.original.command).toEqual(["rewritten"])
  expect((await child(tmp.path, "cli-add")).code).toBe(0)
  expect((await child(tmp.path, "cli-remove")).code).toBe(0)
  const written = await fs.readFile(file, "utf8")
  expect(Object.keys(parse(written).mcp)).toEqual(["cli_writer"])
  expect(written).toContain("// original comment")
}, 85_000)

test("global startup consolidation and schema insertion keep raw references and comments", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, ".process-load", "home", ".deepagent", "code")
  await fs.mkdir(global, { recursive: true })
  await fs.writeFile(
    path.join(global, "deepagent-code.jsonc"),
    '// global comment\n{"shell":"bash","mcp":{"global":{"type":"local","command":["fixture"]}}}',
  )
  await fs.writeFile(
    path.join(tmp.path, "deepagent-code.json"),
    original.replace('"$schema":"https://ai.deepagent.ltd/config.schema.json",', ""),
  )
  const result = await child(tmp.path, "load")
  expect(result.code, result.stderr).toBe(0)
  const canonical = await fs.readFile(path.join(global, "config.jsonc"), "utf8")
  expect(canonical).toContain("// global comment")
  expect(parse(canonical).mcp.global.command).toEqual(["fixture"])
  expect(
    await fs.stat(path.join(global, "deepagent-code.jsonc")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  const local = await fs.readFile(path.join(tmp.path, "deepagent-code.json"), "utf8")
  expect(local).toContain("$schema")
  expect(local).toContain("${FIXTURE_KEEP}")
  expect(local).toContain("// original comment")
}, 30_000)

test("invalid JSONC cannot be rewritten as an empty configuration", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "deepagent-code.json")
  const bytes = '{"mcp":{"retained":'
  await fs.writeFile(file, bytes)
  const result = await child(tmp.path, "cli-add")
  expect(result.code).toBe(1)
  expect(await fs.readFile(file, "utf8")).toBe(bytes)
}, 30_000)

test("old Location binding stays rejected and equal basenames remain distinct", async () => {
  await using tmp = await tmpdir()
  const { Database } = await import("@deepagent-code/core/database/database")
  const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
  const { AbsolutePath } = await import("@deepagent-code/core/schema")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const a = path.join(tmp.path, "a", "project")
  const b = path.join(tmp.path, "b", "project")
  await Promise.all([fs.mkdir(a, { recursive: true }), fs.mkdir(b, { recursive: true })])
  const database = Database.layerFromPath(path.join(tmp.path, "identity.sqlite"))
  await Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* LocationIdentity.Service
      const first = yield* identity.resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(a),
        project: { kind: "registered_root" },
      })
      const second = yield* identity.resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(b),
        project: { kind: "registered_root" },
      })
      expect(first.locationKey).not.toBe(second.locationKey)
      expect(first.projectScopeKey).not.toBe(second.projectScopeKey)
      const before = first
      const result = yield* identity
        .lookup({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(a),
          project: { kind: "registered_root", observedProjectId: "changed-project-binding" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({ _tag: "LocationIdentity.ConflictError" })
      expect(
        yield* identity.lookup({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(a),
          project: { kind: "registered_root" },
        }),
      ).toEqual(before)
    }).pipe(Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer)))),
  )
})
