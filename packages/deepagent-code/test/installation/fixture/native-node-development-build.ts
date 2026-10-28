import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { Schema } from "effect"

const packages = [
  "core",
  "llm",
  "deepagent-code",
  "effect-drizzle-sqlite",
  "server",
  "sdk/js",
  "plugin",
  "util",
  "script",
  "tui",
  "im-kernel-sdk",
  "http-recorder",
  "work-file-helper",
]
const rootFiles = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "NOTICE",
  ".github/TEAM_MEMBERS",
  "packages/desktop/resources/linux-work-provisioning/write-policy.mjs",
]

/** Only dependency files are shared. Every workspace package and build input is
 * an immutable private copy, so the original build cannot write repository dist. */
export async function prepare() {
  const repository = path.resolve(import.meta.dir, "../../../../..")
  const temporary = process.platform === "win32"
    ? path.join(repository, "packages/deepagent-code/.artifacts/windows-native-node-development") : os.tmpdir()
  if (process.platform === "win32" && path.win32.parse(temporary).root.toUpperCase() !== "D:\\")
    throw new Error("Windows development builds must stay on D:")
  await fs.mkdir(temporary, { recursive: true })
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporary, "dac-native-node-development-")))
  await fs.chmod(root, 0o700)
  const copy = path.join(root, "repository")
  const selectedGit = Bun.which("git")
  if (!selectedGit) throw new Error("The actual Git executable is unavailable")
  const git = await fs.realpath(selectedGit)
  const listed = Bun.spawnSync([git, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (listed.exitCode !== 0) throw new Error("Current build source inventory is unavailable")
  const inputs = [
    ...new Set([
      ...listed.stdout
        .toString()
        .split("\0")
        .filter(
          (file) =>
            rootFiles.includes(file) ||
            packages.some((name) => {
              const prefix = `packages/${name}/`
              if (!file.startsWith(prefix)) return false
              const relative = file.slice(prefix.length)
              return (
                relative.startsWith("src/") ||
                relative.startsWith("script/") ||
                relative.startsWith("upstream/src/") ||
                relative.startsWith("lib/") ||
                (!relative.includes("/") && !relative.startsWith("."))
              )
            }),
        ),
      ...rootFiles,
      "packages/im-kernel-sdk/lib/index.js",
    ]),
  ]
  const manifest: { path: string; bytes: number; sha256: string }[] = []
  for (const offset of Array.from({ length: Math.ceil(inputs.length / 32) }, (_, index) => index * 32)) {
    manifest.push(
      ...(await Promise.all(
        inputs.slice(offset, offset + 32).map(async (file) => {
          const source = path.join(repository, file)
          const bytes = await fs.readFile(source)
          const destination = path.join(copy, file)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.writeFile(destination, bytes)
          const sha256 = createHash("sha256").update(bytes).digest("hex")
          if (
            createHash("sha256")
              .update(await fs.readFile(source))
              .digest("hex") !== sha256 ||
            createHash("sha256")
              .update(await fs.readFile(destination))
              .digest("hex") !== sha256
          )
            throw new Error("A development build input changed during capture")
          return { path: file, bytes: bytes.length, sha256 }
        }),
      )),
    )
  }
  const workspace = (
    await Promise.all(
      packages.map(async (name) => {
        const file = Bun.file(path.join(copy, "packages", name, "package.json"))
        if (!(await file.exists())) return undefined
        const value: unknown = await file.json()
        if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string")
          throw new Error("A copied workspace package has no valid name")
        return { name: value.name, directory: path.join(copy, "packages", name) }
      }),
    )
  ).filter((entry) => entry !== undefined)
  for (const name of ["", ...packages.map((name) => `packages/${name}`)]) {
    const source = path.join(repository, name, "node_modules")
    const destination = path.join(copy, name, "node_modules")
    await fs.mkdir(destination, { recursive: true })
    const entries = await fs.readdir(source).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
      throw error
    })
    for (const entry of entries) {
      if (entry === "@deepagent-code" || workspace.some((value) => value.name === entry)) continue
      const target = path.join(source, entry)
      await fs.symlink(target, path.join(destination, entry), process.platform === "win32"
        ? (await fs.stat(target)).isDirectory() ? "junction" : "file" : undefined)
    }
    await Promise.all(
      workspace.map(async (entry) => {
        const target = path.join(destination, entry.name)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.symlink(entry.directory, target, process.platform === "win32" ? "junction" : "dir")
      }),
    )
  }
  const bin = path.join(root, "bin")
  await fs.mkdir(bin)
  if (process.platform === "win32") await fs.copyFile(await fs.realpath(process.execPath), path.join(bin, "bun.exe"))
  if (process.platform !== "win32") await fs.symlink(await fs.realpath(process.execPath), path.join(bin, "bun"))
  const home = path.join(root, "home")
  await fs.mkdir(home, { mode: 0o700 })
  if (process.platform === "win32") await Promise.all(["appdata", "localappdata", "bun-cache"].map((name) =>
    fs.mkdir(path.join(home, name), { mode: 0o700 })))
  const output = path.join(copy, "packages/deepagent-code/dist/node")
  await fs.mkdir(output, { recursive: true })
  // Stale metadata is deliberately invalid; this test does not create a publisher.
  await fs.writeFile(path.join(output, "node.js.native-installation.json"), "stale-development-receipt")
  await fs.writeFile(path.join(output, "node.js.native-components.json"), "stale-development-inventory")
  await fs.writeFile(
    path.join(root, "source-cohort.json"),
    JSON.stringify(
      {
        version: 1,
        repository,
        copy,
        components: manifest.toSorted((left, right) => left.path.localeCompare(right.path)),
        git,
        dependencies: `local ${process.platform}-${process.arch} third-party links; workspace packages resolve exclusively to private source copy`,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  return { root, copy, output, manifest, home, bin }
}

export function environment(input: { root: string; bin: string; home: string }) {
  return {
    PATH: input.bin, HOME: input.home, TMPDIR: input.root,
    ...(process.platform === "win32" ? {
      USERPROFILE: input.home, APPDATA: path.join(input.home, "appdata"), LOCALAPPDATA: path.join(input.home, "localappdata"),
      TEMP: input.root, TMP: input.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(input.home, "bun-cache"),
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    } : {}),
  }
}

export async function build(
  input: Pick<Awaited<ReturnType<typeof prepare>>, "root" | "copy" | "output" | "home" | "bin">,
  options?: { publicKey?: string; authorizationFile?: string; required?: boolean; version?: string },
) {
  const child = Bun.spawn([path.join(input.bin, process.platform === "win32" ? "bun.exe" : "bun"), "script/build-node.ts"], {
    cwd: path.join(input.copy, "packages/deepagent-code"),
    env: {
      ...environment(input),
      XDG_CONFIG_HOME: path.join(input.home, "config"),
      XDG_DATA_HOME: path.join(input.home, "data"),
      XDG_CACHE_HOME: path.join(input.home, "cache"),
      DEEPAGENT_CODE_CHANNEL: "native-dev-fixture",
      DEEPAGENT_CODE_VERSION: options?.version ?? "2.0.3",
      ...(options?.publicKey ? { DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY: options.publicKey } : {}),
      ...(options?.authorizationFile
        ? { DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE: options.authorizationFile }
        : {}),
      ...(options?.required ? { DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED: "1" } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000)
  const code = await child.exited
  clearTimeout(timer)
  const logs = (await output).join("\n")
  await fs.writeFile(path.join(input.root, "build.log"), logs, { mode: 0o600 })
  const outputs = await fs.readdir(input.output)
  await fs.writeFile(
    path.join(input.root, "result.json"),
    JSON.stringify(
      {
        code,
        outputs,
        cargoOnPath: false,
        publisherPin: false,
        processExited: true,
        NativeExecution: 0,
        provider: 0,
        database: 0,
        buildScope: `actual original build-node.ts; private source/output; ${process.platform}-${process.arch} module only`,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  return { code, logs, outputs }
}

/** Replay the already completed private build after an assertion-only correction. */
export async function readEvidence(directory: string) {
  const root = await fs.realpath(directory)
  if (!path.basename(root).startsWith("dac-native-node-development-"))
    throw new Error("Only a private development build may be replayed")
  const cohort = Schema.decodeUnknownSync(
    Schema.Struct({
      copy: Schema.String,
      components: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Schema.String })),
    }),
  )(await Bun.file(path.join(root, "source-cohort.json")).json())
  if (
    cohort.copy !== path.join(root, "repository") ||
    cohort.components.some((entry) => path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes(".."))
  )
    throw new Error("Development evidence contains a different build scope")
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      code: Schema.Number,
      processExited: Schema.Boolean,
      cargoOnPath: Schema.Boolean,
      publisherPin: Schema.Boolean,
    }),
  )(await Bun.file(path.join(root, "result.json")).json())
  if (!result.processExited || result.cargoOnPath || result.publisherPin)
    throw new Error("Development evidence does not match the original no-Cargo build")
  const output = path.join(cohort.copy, "packages/deepagent-code/dist/node")
  return {
    input: {
      root,
      copy: cohort.copy,
      output,
      manifest: cohort.components,
      home: path.join(root, "home"),
      bin: path.join(root, "bin"),
    },
    result: {
      code: result.code,
      logs: await fs.readFile(path.join(root, "build.log"), "utf8"),
      outputs: await fs.readdir(output),
    },
  }
}
