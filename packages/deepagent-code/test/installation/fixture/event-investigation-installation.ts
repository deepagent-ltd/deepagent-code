import fs from "node:fs/promises"
import path from "node:path"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { NativeInstallationSchema } from "../../../src/installation/native-installation.schema"

export const repository = path.resolve(import.meta.dir, "../../../../..")
const host = path.join(repository, "packages/deepagent-code")
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

/** Private test CA only; no environment or user trust-store changes. */
export async function certificate(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const certificatePath = path.join(directory, "ca.pem")
  const keyPath = path.join(directory, "ca-key.pem")
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=DAC event private transport",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  if (generated.exitCode !== 0) throw new Error("Private fixture certificate creation failed")
  await fs.chmod(keyPath, 0o600)
  return { ca: await fs.readFile(certificatePath, "utf8"), keyPath, certificatePath }
}

/** Actual signed installation. Fixed overlays are test transport/CLI only;
 * the production bootstrap, source verifier, profile, count and dispatch gates are captured unchanged. */
export async function build(input: {
  directory: string
  assets: string
  storageCleanupAsset?: string
  target?: "darwin-arm64" | "linux-arm64" | "linux-x64"
  supervisorAssets?: { supervisor: string; runtimeClosure: readonly { source: string; mountPath: string }[] }
  ca: string
  origin: string
  debugFixturePath: string
}) {
  const endpoint = new URL(input.origin)
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.origin !== input.origin ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("The signed test transport requires its exact private loopback HTTPS origin")
  const directory = await fs.realpath(input.directory)
  const install = path.join(directory, "install")
  await Promise.all(
    ["install", "overlays"].map((name) => fs.mkdir(path.join(directory, name), { recursive: true, mode: 0o700 })),
  )
  const replacements = new Map<string, string>()
  replacements.set(
    "packages/deepagent-code/src/cli/cmd/debug/index.ts",
    await fs.readFile(input.debugFixturePath, "utf8"),
  )
  const executorPath = "packages/llm/src/route/executor.ts"
  const executor = await fs.readFile(path.join(repository, executorPath), "utf8")
  if (executor.match(/tls: \{ rejectUnauthorized: true \}/g)?.length !== 2)
    throw new Error("The original two verified TLS request sites changed")
  const ordinary = "export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))"
  if (executor.split(ordinary).length !== 2) throw new Error("The original ordinary HTTP layer changed")
  const fixedFetch = `Object.assign((resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof resource === "string" ? resource : resource instanceof URL ? resource.href : resource.url)
    const mapped = fixturePhysicalURL(url.href)
    return globalThis.fetch(resource instanceof Request ? new Request(mapped, resource) : mapped,
      { ...init, tls: { rejectUnauthorized: true, ca: ${JSON.stringify(input.ca)} } })
  }, { preconnect: globalThis.fetch.preconnect })`
  const physical = `function fixturePhysicalURL(canonical: string) {
    if (!["https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses/input_tokens", "https://api.deepseek.com/responses"].includes(canonical))
      throw new Error("Unmatched fixture provider dispatch denied")
    return ${JSON.stringify(input.origin)} + new URL(canonical).pathname
  }
  `
  const nativeTLS = "...(boundary ? { keepalive: false, tls: { rejectUnauthorized: true } } : {}),"
  const ordinaryExecute = "          .execute(request)\n          .pipe("
  if (
    executor.split(nativeTLS).length !== 2 ||
    executor.split("boundary.fetch(url.href, {").length !== 2 ||
    executor.split("fetch(url.href, {").length !== 3
  )
    throw new Error("The original two native HTTP call sites changed")
  if (executor.split(ordinaryExecute).length !== 2) throw new Error("The original ordinary HTTP call site changed")
  replacements.set(
    executorPath,
    executor
      .replace(
        nativeTLS,
        `...(boundary ? { keepalive: false } : {}), tls: { rejectUnauthorized: true, ca: ${JSON.stringify(input.ca)} },`,
      )
      .replaceAll(
        "tls: { rejectUnauthorized: true }",
        `tls: { rejectUnauthorized: true, ca: ${JSON.stringify(input.ca)} }`,
      )
      .replace(ordinary, physical + ordinary)
      .replace(
        ordinaryExecute,
        `          .execute(request)\n          .pipe(Effect.provideService(FetchHttpClient.Fetch, ${fixedFetch}),`,
      )
      .replaceAll("fetch(url.href, {", "fetch(fixturePhysicalURL(url.href), {"),
  )
  await Promise.all(
    [...replacements].map(async ([name, contents]) => {
      await fs.writeFile(
        path.join(directory, "overlays", name.replaceAll("/", "__") + ".before"),
        await fs.readFile(path.join(repository, name)),
      )
      await fs.writeFile(path.join(directory, "overlays", name.replaceAll("/", "__") + ".after"), contents)
    }),
  )
  const assets = await Promise.all(
    [
      "deepagent-work-file-helper",
      "bun-command-runtime",
      ...(input.storageCleanupAsset ? ["deepagent-work-storage-cleanup"] : []),
    ].map(async (name) => {
      const source = await fs.realpath(
        name === "deepagent-work-storage-cleanup" ? input.storageCleanupAsset! : path.join(input.assets, name),
      )
      const before = await fs.lstat(source, { bigint: true })
      const bytes = await fs.readFile(source)
      const after = await fs.lstat(source, { bigint: true })
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        (before.mode & 0o022n) !== 0n ||
        (before.mode & 0o111n) === 0n ||
        [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":") !==
          [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":")
      )
        throw new Error("Actual native assets are unavailable or changed while copying")
      await fs.writeFile(path.join(install, name), bytes, { mode: 0o755 })
      return {
        path: `packages/work-file-helper/bin/${input.target ?? "darwin-arm64"}/${name}`,
        bytes: bytes.byteLength,
        sha256: hash(bytes),
      }
    }),
  )
  if (input.supervisorAssets) {
    if (!input.target?.startsWith("linux-") || input.supervisorAssets.runtimeClosure.length > 128)
      throw new Error("Supervisor assets require their actual Linux target")
    for (const asset of [
      { source: input.supervisorAssets.supervisor, relative: "deepagent-work-process-supervisor", executable: true },
      ...input.supervisorAssets.runtimeClosure.map((library) => ({
        source: library.source,
        relative: `runtime-closure${library.mountPath}`,
        executable: false,
      })),
    ]) {
      if (
        !/^(deepagent-work-process-supervisor|runtime-closure\/(?:lib|lib64|usr\/lib|usr\/lib64)\/[^\0]+)$/.test(
          asset.relative,
        ) ||
        asset.relative.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Invalid installed supervisor closure")
      const source = await fs.realpath(asset.source)
      const before = await fs.lstat(source, { bigint: true })
      const bytes = await fs.readFile(source)
      const after = await fs.lstat(source, { bigint: true })
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        (before.mode & 0o022n) !== 0n ||
        bytes.length > 268435456 ||
        [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":") !==
          [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":")
      )
        throw new Error("Supervisor asset changed during capture")
      await fs.mkdir(path.dirname(path.join(install, asset.relative)), { recursive: true })
      await fs.writeFile(path.join(install, asset.relative), bytes, {
        mode: asset.executable || (before.mode & 0o111n) !== 0n ? 0o755 : 0o644,
      })
      assets.push({
        path: `packages/work-file-helper/bin/${input.target}/${asset.relative}`,
        bytes: bytes.length,
        sha256: hash(bytes),
      })
    }
  }
  const pair = generateKeyPairSync("ed25519")
  const sources = new Map<string, Buffer>()
  const originals = new Map<string, string>()
  // These binaries implement Rust capabilities; their current source closure belongs
  // to the signed installation even though Bun does not import Rust files.
  const nativePaths = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "packages/work-file-helper/src",
      "packages/work-file-helper/Cargo.toml",
      "packages/work-file-helper/Cargo.lock",
      "packages/work-file-helper/LICENSE",
      "packages/work-file-helper/NOTICE",
      "packages/work-file-helper/UPSTREAM.json",
      "packages/work-file-helper/ed25519-dalek.LICENSE",
      "packages/work-file-helper/curve25519-dalek.LICENSE",
    ],
    { cwd: repository },
  )
  if (nativePaths.exitCode !== 0) throw new Error("Current Native source inventory is unavailable")
  await Promise.all(
    [...new Set(nativePaths.stdout.toString().trim().split("\n"))].filter(Boolean).map(async (name) => {
      const bytes = await fs.readFile(path.join(repository, name))
      if (!bytes.length) return
      sources.set(name, bytes)
      originals.set(name, hash(bytes))
    }),
  )
  const plugin = {
    name: "signed-private-fixed-https",
    setup(builder: Parameters<NonNullable<Bun.BuildConfig["plugins"]>[number]["setup"]>[0]) {
      builder.onLoad({ filter: /\.(?:ts|tsx|js|mjs|json)$/ }, async (args) => {
        const name = path.relative(repository, args.path)
        if (name.startsWith("../") || name.startsWith("node_modules/") || name.includes("/node_modules/"))
          return undefined
        if (!sources.has(name)) {
          const bytes = await fs.readFile(args.path)
          originals.set(name, hash(bytes))
          sources.set(name, replacements.has(name) ? Buffer.from(replacements.get(name)!) : bytes)
        }
        if (name.endsWith(".tsx")) return undefined
        return { contents: sources.get(name)!, loader: name.endsWith(".json") ? ("json" as const) : ("ts" as const) }
      })
    },
  }
  const parser = await fs.realpath(path.join(host, "node_modules/@opentui/core/parser.worker.js"))
  const options = {
    entrypoints: [path.join(host, "src/index.ts"), parser, path.join(host, "src/cli/tui/worker.ts")],
    tsconfig: path.join(host, "tsconfig.json"),
    conditions: ["node"],
    target: "bun" as const,
    format: "esm" as const,
    splitting: true,
    external: ["node-gyp"],
    plugins: [plugin, createSolidTransformPlugin()],
    define: {
      DEEPAGENT_CODE_VERSION: JSON.stringify("2.0.3-dev"),
      DEEPAGENT_CODE_CHANNEL: JSON.stringify("dev"),
      DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(
        pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
      DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: '""',
      DEEPAGENT_CODE_WORKER_PATH: JSON.stringify("./src/cli/tui/worker.ts"),
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(`/$bunfs/root/${path.relative(host, parser)}`),
    },
  }
  const discovered = await Bun.build({
    ...options,
    define: {
      ...options.define,
      ...(!input.target || input.target === `${process.platform}-${process.arch}`
        ? {
            "process.platform": JSON.stringify(process.platform),
            "process.arch": JSON.stringify(process.arch),
          }
        : {}),
    },
  })
  if (!discovered.success) throw new Error(discovered.logs.join("\n"))
  const components = new NativeInstallationSchema.Components({
    schemaVersion: "dac.native-components.v1",
    target: input.target ?? "darwin-arm64",
    sourceCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository }).stdout.toString().trim(),
    sourceTree: Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: repository }).stdout.toString().trim(),
    components: [
      ...[...sources].map(([name, bytes]) => ({ path: name, bytes: bytes.byteLength, sha256: hash(bytes) })),
      ...assets,
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  })
  const componentText = CanonicalJson.stringify(components)
  const executable = path.join(install, "deepagent-code")
  const compiled = await Bun.build({
    ...options,
    compile: {
      outfile: executable,
      ...(input.target?.startsWith("linux-")
        ? { target: `bun-${input.target}` as "bun-linux-arm64" | "bun-linux-x64" }
        : {}),
      autoloadDotenv: false,
      autoloadBunfig: false,
      execArgv: ["--use-system-ca", "--"],
    },
    define: { ...options.define, DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(componentText) },
  })
  await fs.writeFile(
    path.join(directory, "build.json"),
    JSON.stringify({ success: compiled.success, logs: compiled.logs.map((item) => item.message) }),
    { mode: 0o600 },
  )
  if (!compiled.success) throw new Error(compiled.logs.join("\n"))
  const drift = (
    await Promise.all(
      [...originals].map(async ([name, digest]) =>
        hash(await fs.readFile(path.join(repository, name))) === digest ? undefined : name,
      ),
    )
  ).filter(Boolean)
  await fs.writeFile(
    path.join(directory, "source-cohort.json"),
    JSON.stringify({ checked: originals.size, drift, originals: Object.fromEntries(originals) }),
    { mode: 0o600 },
  )
  if (drift.length) throw new Error(`Signed source capture changed: ${drift.join(", ")}`)
  const bytes = await fs.readFile(executable)
  const payload = new NativeInstallationSchema.Payload({
    domain: NativeInstallationSchema.DOMAIN,
    releaseID: "event-investigation-local-https-test-transport",
    target: input.target ?? "darwin-arm64",
    sourceCommit: components.sourceCommit,
    sourceTree: components.sourceTree,
    componentsHash: hash(componentText),
    executable: { bytes: bytes.byteLength, sha256: hash(bytes) },
  })
  await fs.writeFile(
    executable + NativeInstallationSchema.SIDECAR_SUFFIX,
    CanonicalJson.stringify({
      payload,
      signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), pair.privateKey).toString("hex"),
    }),
    { mode: 0o600 },
  )
  await fs.writeFile(path.join(directory, "components.json"), componentText, { mode: 0o600 })
  return Object.freeze({ directory, install, executable, origin: input.origin, componentsHash: payload.componentsHash })
}
export type SignedInstallation = Awaited<ReturnType<typeof build>>

/** Each Root gets one new private DB/home/policy; cold callers reuse this exact object. */
export async function caseFor(input: {
  installation: SignedInstallation
  directory: string
  sourceText: string
  provider?: "openai" | "deepseek"
}) {
  await fs.mkdir(input.directory, { recursive: true, mode: 0o700 })
  const directory = await fs.realpath(input.directory)
  await Promise.all(
    ["project", "home", "tmp", "config", "data", "cache", "state", "managed"].map((name) =>
      fs.mkdir(path.join(directory, name), { recursive: true, mode: 0o700 }),
    ),
  )
  const project = path.join(directory, "project")
  await fs.writeFile(path.join(project, "guard.test.ts"), input.sourceText)
  await fs.writeFile(
    path.join(project, "deepagent-code.json"),
    JSON.stringify({
      formatter: false,
      lsp: false,
      model: input.provider === "deepseek" ? "deepseek/deepseek-flash" : "openai/gpt-4.1-2025-04-14",
      providers: {
        [input.provider ?? "openai"]: {
          env: ["DAC_FIXTURE_NATIVE_KEY"],
          api: {
            type: "native",
            settings: {},
            protocol: input.provider === "deepseek" ? "openai-compatible.responses" : "openai.responses",
            url: input.provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1",
          },
          models: {
            [input.provider === "deepseek" ? "deepseek-flash" : "gpt-4.1-2025-04-14"]: {
              api: { id: input.provider === "deepseek" ? "deepseek-flash" : "gpt-4.1-2025-04-14" },
              capabilities: { input: ["text"], output: ["text"], tools: true },
              limit: { context: input.provider === "deepseek" ? 1048576 : 100000, output: 4096 },
            },
          },
        },
      },
    }),
  )
  const fileScope = {
    read: [{ kind: "file", path: "guard.test.ts" }],
    write: [],
    deny: [],
    maxReadBytes: 67108864,
    maxPageBytes: 51200,
    maxHashBytes: 16777216,
    maxWriteBytes: 0,
    symlinks: "deny",
  }
  const shared = { directory: project, agentID: "auto", providerID: "openai", modelID: "gpt-4.1-2025-04-14" }
  const recipe = {
    schemaVersion: "work-command-recipe.v1",
    logicalID: "test",
    revision: 1,
    executable: "installed-bun-v1",
    argv: ["test", "guard.test.ts", "--timeout", "1000"].map((value) => ({ kind: "literal", value })),
    parameters: [],
    cwd: null,
    inputs: ["guard.test.ts"],
    outputs: [],
    environment: [{ name: "CI", value: "1" }],
    workspace: "private_explicit_files.v1",
    sandbox: {
      id: "darwin-single-process-workspace-v1",
      revision: 1,
      network: "deny",
      processes: 1,
      openFiles: 64,
      maxInputFiles: 256,
      maxInputFileBytes: 16777216,
      maxInputBytes: 67108864,
      maxDepth: 16,
      maxOutputFiles: 32,
      maxOutputFileBytes: 1048576,
      maxOutputBytes: 33554432,
    },
    timeoutMs: 10000,
    stdoutBytes: 65536,
    stderrBytes: 65536,
  }
  const policy = path.join(directory, "policy.json")
  await fs.writeFile(
    policy,
    JSON.stringify({
      version: 5,
      targets: [
        {
          ...shared,
          id: "validation",
          budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxChildren: 0 },
          project: { tools: ["managed_command"], fileScope, commandRecipes: [recipe] },
        },
        {
          ...shared,
          id: "investigation",
          profile: "event_investigate_v1",
          budget: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget,
          project: { tools: ["read"], fileScope },
        },
      ],
    }),
    { mode: 0o600 },
  )
  const bin = path.join(directory, "home/.deepagent/code/cache/bin")
  await fs.mkdir(bin, { recursive: true })
  const rg = Bun.which("rg")
  if (!rg) throw new Error("The offline fixture requires existing rg")
  await fs.copyFile(rg, path.join(bin, "rg"))
  const dbPath = path.join(directory, "database.sqlite")
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(directory, "home"),
    TMPDIR: path.join(directory, "tmp"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"),
    DEEPAGENT_CODE_HOME: path.join(directory, "data"),
    DEEPAGENT_CODE_DB: dbPath,
    DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_CODE_MODELS_PATH: path.join(host, "test/tool/fixtures/models-api.json"),
    DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
    DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
    DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
    DEEPAGENT_CODE_SERVER_USERNAME: "fixture-operator",
    DEEPAGENT_CODE_SERVER_PASSWORD: "fixture-operator-password",
    DEEPAGENT_IM_AGENT_RESPONDER: "off",
    DAC_FIXTURE_NATIVE_KEY: "fixture-native-key",
    NO_COLOR: "1",
  }
  const spawn = (args: string[], extraEnv: Record<string, string | undefined> = {}) =>
    Bun.spawn([input.installation.executable, ...args], {
      cwd: project,
      env: { ...env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90000,
    })
  const run = async (name: string, args: string[], extraEnv: Record<string, string | undefined> = {}) => {
    const child = spawn(args, extraEnv)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await fs.writeFile(path.join(directory, `${name}.log`), JSON.stringify({ stdout, stderr, code }), { mode: 0o600 })
    return { stdout, stderr, code }
  }
  await fs.writeFile(path.join(directory, "private-env.json"), JSON.stringify(env), { mode: 0o600 })
  return { directory, project, dbPath, env, policy, installation: input.installation, spawn, run }
}
export type NativeCase = Awaited<ReturnType<typeof caseFor>>

/** Actual CLI approval, zero model execution. Cold callers must not call enrollment again. */
export async function enroll(candidate: NativeCase, expiresAt = Date.now() + 300000) {
  const enrollment = await candidate.run("enroll", [
    "operator",
    "enroll",
    "--request-id",
    "event-enroll",
    "--policy",
    candidate.policy,
  ])
  if (enrollment.code !== 0) throw new Error(`Actual enrollment failed: ${enrollment.stderr.slice(-2000)}`)
  const route = await candidate.run("approve", [
    "operator",
    "approve-route",
    "--request-id",
    "event-route",
    "--target",
    "investigation",
    "--snapshot",
    "gpt-4.1-2025-04-14",
    "--expected-revision",
    "1",
    "--expected-route-revision",
    "0",
    "--expires-at",
    String(expiresAt),
  ])
  if (route.code !== 0) throw new Error(`Actual route approval failed: ${route.stderr.slice(-2000)}`)
}
export * as EventInvestigationInstallation from "./event-investigation-installation"
