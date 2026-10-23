import fs from "node:fs/promises"
import path from "node:path"
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
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-native-node-development-"))
  await fs.chmod(root, 0o700)
  const copy = path.join(root, "repository")
  const listed = Bun.spawnSync(["/usr/bin/git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
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
      await fs.symlink(path.join(source, entry), path.join(destination, entry))
    }
    await Promise.all(
      workspace.map(async (entry) => {
        const target = path.join(destination, entry.name)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.symlink(entry.directory, target)
      }),
    )
  }
  const bin = path.join(root, "bin")
  await fs.mkdir(bin)
  await fs.symlink(await fs.realpath(process.execPath), path.join(bin, "bun"))
  const home = path.join(root, "home")
  await fs.mkdir(home, { mode: 0o700 })
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
        dependencies: "local ARM third-party symlinks; workspace packages resolve exclusively to private source copy",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  return { root, copy, output, manifest, home, bin }
}

export async function build(
  input: Pick<Awaited<ReturnType<typeof prepare>>, "root" | "copy" | "output" | "home" | "bin">,
  owner?: { publicKey?: string; authorizationFile?: string; required?: boolean },
) {
  const child = Bun.spawn([path.join(input.bin, "bun"), "script/build-node.ts"], {
    cwd: path.join(input.copy, "packages/deepagent-code"),
    env: {
      PATH: input.bin,
      HOME: input.home,
      TMPDIR: input.root,
      XDG_CONFIG_HOME: path.join(input.home, "config"),
      XDG_DATA_HOME: path.join(input.home, "data"),
      XDG_CACHE_HOME: path.join(input.home, "cache"),
      DEEPAGENT_CODE_CHANNEL: "native-dev-fixture",
      DEEPAGENT_CODE_VERSION: "2.0.3",
      ...(owner?.publicKey ? { DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY: owner.publicKey } : {}),
      ...(owner?.authorizationFile ? { DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE: owner.authorizationFile } : {}),
      ...(owner?.required ? { DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED: "1" } : {}),
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
        buildScope: "actual original build-node.ts; private source/output; Darwin ARM module only",
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
