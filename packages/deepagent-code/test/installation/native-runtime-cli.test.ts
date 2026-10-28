import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto"
import { createServer, request } from "node:http"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { buildWorkFileHelper } from "../../script/build-work-file-helper"
import { ownedSecretBuild } from "../fixture/owned-secret-build"

const repository = path.resolve(import.meta.dir, "../../../..")
const host = path.join(repository, "packages/deepagent-code")
const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

const modes = [
  "approval",
  "approval-reopen",
  "historical-at-expiry",
  "historical-expired",
  "historical-revoke",
  "historical-revoked-expired",
  "historical-changed-config",
  "historical-args-snapshot",
  "historical-args-expiry",
  "historical-args-revision",
  "historical-revoke-retry",
  "historical-query",
  "historical-new-unavailable",
  "historical-mac-tamper",
  "historical-missing-identity",
  "historical-legacy",
  "historical-legacy-query",
  "approval-source-copy",
  "approval-source-drift",
  "capture",
  "capture-repeat",
  "capture-other-target",
  "capture-rotated",
  "privacy",
  "privacy-repeat",
  "happy",
  "proxy",
  "ordinary-proxy",
  "auth-rotate",
  "auth-provider-rotate",
  "copy-resolved",
  "copy-handle",
  "request-copy",
  "model-copy",
  "auth-replace",
  "auth-function",
  "unsafe-tls",
  "external-ca",
  "global-drift",
  "env-drift",
  "early-global",
  "early-env",
  "late-drift",
  "requestinit",
  "retry",
  "redirect-policy",
  "manifest-drift",
  "scope",
  "root-close",
  "foreign-root",
  "capacity",
  "redirect",
  "429",
  "503",
  "drop",
  "partial-write",
  "partial-response",
  "cancel-before",
  "cancel-inflight",
]

const groups = [
  { name: "approval and history", start: 0, end: 19 },
  { name: "capture and privacy", start: 19, end: 25 },
  { name: "transport and authentication", start: 25, end: 30 },
  { name: "identity and bootstrap boundaries", start: 30, end: 39 },
  { name: "process and request guardrails", start: 39, end: 47 },
  { name: "runtime isolation", start: 47, end: 51 },
  { name: "transport failures and cancellation", start: 51, end: 59 },
].map((group) => ({ ...group, modes: modes.slice(group.start, group.end) }))
const selection = process.env.DAC_NATIVE_CLI_MODE
if (selection && !modes.includes(selection)) throw new Error(`Unknown Native CLI mode: ${selection}`)
const selectedModes = modes.filter((mode) => !selection || mode === selection)

describe.serial("signed compiled actual CLI uses Root catalog and native factory through the real bootstrap", () => {
  const fixture: { run?: Awaited<ReturnType<typeof prepareFixture>> } = {}
  const servers: ReturnType<typeof createServer>[] = []
  const verified: string[] = []

  beforeAll(async () => {
    fixture.run = await prepareFixture((server) => servers.push(server))
  }, 240_000)

  afterAll(async () => {
    servers.forEach((server) => server.closeAllConnections())
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  for (const group of groups)
    describe.serial(group.name, () => {
      for (const mode of group.modes.filter((mode) => selectedModes.includes(mode)))
        test.serial(mode, async () => {
          if (!fixture.run) throw new Error("Signed Native CLI fixture setup is unavailable")
          await fixture.run(mode)
          verified.push(mode)
        }, 75_000)
    })

  test.serial("verifies complete ordered mode coverage", () => {
    expect(modes).toHaveLength(59)
    expect(new Set(modes).size).toBe(59)
    expect(groups.flatMap((group) => group.modes)).toEqual(modes)
    expect(verified).toEqual(selectedModes)
    expect(new Set(verified).size).toBe(selectedModes.length)
    expect(verified).toHaveLength(selection ? 1 : 59)
    console.info("NATIVE_CLI_COVERAGE", JSON.stringify({
      full: !selection,
      expected: selectedModes,
      verified,
    }))
  })
})

// Windows accepts the original compiled entry and offline publisher receipt,
// rather than a JavaScript signature around a source-style executable.
async function prepareWindowsCLI(root: string) {
  if (process.platform !== "win32") return
  const { prepareTestNativePublisher, verifyNativePublisherKeys } = await import("../../../desktop/scripts/test-native-publisher")
  const { buildWindowsNativeBootstrap } = await import("../../script/build-windows-native-bootstrap")
  const environmentFile = path.join(root, "publisher.env")
  await fs.writeFile(environmentFile, "", { flag: "wx", mode: 0o600 })
  const publisher = await prepareTestNativePublisher({ runnerTemp: root, environmentFile,
    target: `win32-${process.arch}`, releaseID: "signed-cli-test" })
  const previousCargoHome = process.env.CARGO_HOME
  process.env.CARGO_HOME = path.join(publisher.directory, "cargo-cache")
  try {
    const verified = await verifyNativePublisherKeys(publisher.privateKeyFile, publisher.publicKeyFile)
    const publicKey = createPublicKey(await fs.readFile(publisher.publicKeyFile))
    const assets = await buildWindowsNativeBootstrap({ repository, staging: publisher.directory, publicKey })
    const cargo = path.join(publisher.directory, "native-bootstrap-cargo")
    const child = Bun.spawn(["cargo", "build", "--locked", "--release", "--bin", "deepagent-work-file-helper"], {
      cwd: path.join(repository, "packages/work-file-helper"),
      env: { ...process.env, CARGO_TARGET_DIR: cargo, DAC_NATIVE_PRELOADER_PUBLISHER_HEX: assets.publisherPin },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    })
    if (await child.exited !== 0) throw new Error("Windows Native CLI helper build failed")
    const filename = "deepagent-work-file-helper.exe"
    await fs.copyFile(path.join(cargo, "release", filename), path.join(publisher.directory, filename))
    const bytes = await fs.readFile(path.join(publisher.directory, filename))
    const helper = { path: `packages/work-file-helper/bin/win32-${process.arch}/${filename}`,
      bytes: bytes.byteLength, sha256: hash(bytes) }
    return { root: publisher.directory, publisher, keys: { privateKey: verified.privateKey, publicKey }, assets, helper,
      [Symbol.asyncDispose]: () => Promise.all([publisher.privateKeyFile, environmentFile]
        .map((file) => fs.rm(file, { force: true }))).then(() => undefined),
    }
  } catch (error) {
    await Promise.all([publisher.privateKeyFile, environmentFile].map((file) => fs.rm(file, { force: true })))
    throw error
  } finally {
    // This file's serial setup restores the caller after its owned D: build.
    if (previousCargoHome === undefined) delete process.env.CARGO_HOME
    if (previousCargoHome !== undefined) process.env.CARGO_HOME = previousCargoHome
  }
}

async function prepareFixture(registerServer: (server: ReturnType<typeof createServer>) => void) {
  const temporary = process.platform === "win32" ? path.join(host, ".artifacts/unit") : os.tmpdir()
  if (process.platform === "win32") await fs.mkdir(temporary, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(temporary, "dac-native-cli-")))
  await using windows = await prepareWindowsCLI(directory)
  const root = windows?.root ?? directory
  const executable = path.join(root, process.platform === "win32" ? "deepagent-code.exe" : "deepagent-code")
  const pair = windows?.keys ?? generateKeyPairSync("ed25519")
  const pin = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const fixture = path.join(import.meta.dir, "fixture/native-runtime-cli-command.ts")
  const helper = windows?.helper ?? await buildWorkFileHelper({ os: process.platform, arch: process.arch, destination: root })
  const files = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "packages/core/src",
      "packages/llm/src",
      "packages/deepagent-code/src",
      "packages/deepagent-code/script/build.ts",
      "packages/deepagent-code/script/build-work-file-helper.ts",
      "packages/work-file-helper/src",
      "packages/work-file-helper/Cargo.toml",
      "packages/work-file-helper/Cargo.lock",
      "packages/core/package.json",
      "packages/llm/package.json",
      "packages/deepagent-code/package.json",
      "bun.lock",
      "patches",
    ],
    { cwd: repository },
  )
    .stdout.toString()
    .trim()
    .split("\n")
  const sourceComponents = await Promise.all(
    [
      ...new Set([...files, path.relative(repository, fixture), "packages/deepagent-code/test/fixture/owned-secret-build.ts"]),
    ]
      .toSorted()
      .map(async (entry) => {
        const bytes = await fs.readFile(path.join(repository, entry))
        return new NativeInstallationSchema.Component({ path: entry.replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: hash(bytes) })
      }),
  )
  const components = new NativeInstallationSchema.Components({
    schemaVersion: "dac.native-components.v1",
    target: `${process.platform}-${process.arch}`,
    sourceCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository }).stdout.toString().trim(),
    sourceTree: Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: repository }).stdout.toString().trim(),
    components: [...sourceComponents, new NativeInstallationSchema.Component(helper),
      ...(windows ? [windows.assets, ...windows.assets.assets, ...windows.assets.licenses].map((entry) =>
        new NativeInstallationSchema.Component({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })) : []),
    ].toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  })
  const componentsText = CanonicalJson.stringify(components)
  const parserWorker = await fs.realpath(Bun.resolveSync("@opentui/core/parser.worker", host))
  const build = await Bun.build({
    entrypoints: [
      path.join(host, process.platform === "win32" ? "src/windows-cli.ts" : "src/index.ts"),
      parserWorker,
      path.join(host, "src/cli/tui/worker.ts"),
      path.join(host, "src/location-index/typescript-index.worker.ts"),
    ],
    tsconfig: path.join(host, "tsconfig.json"),
    conditions: ["node"],
    target: "bun",
    format: "esm",
    splitting: true,
    external: ["node-gyp"],
    plugins: [
      createSolidTransformPlugin(),
      ownedSecretBuild,
      {
        name: "signed-test-debug-command",
        setup(builder) {
          builder.onLoad({ filter: /[/\\]cli[/\\]cmd[/\\]debug[/\\]index\.ts$/ }, async () => ({
            contents: await fs.readFile(fixture, "utf8"),
            loader: "ts",
          }))
        },
      },
    ],
    compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false, execArgv: ["--use-system-ca", "--"] },
    define: {
      DEEPAGENT_CODE_VERSION: JSON.stringify("2.0.3-dev"),
      DEEPAGENT_CODE_CHANNEL: JSON.stringify("dev"),
      DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(pin),
      DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(componentsText),
      DEEPAGENT_CODE_WORKER_PATH: JSON.stringify("./src/cli/tui/worker.ts"),
      DEEPAGENT_CODE_INDEX_WORKER_PATH: JSON.stringify("./src/location-index/typescript-index.worker.ts"),
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(`${process.platform === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"}${path.relative(host, parserWorker).replaceAll("\\", "/")}`),
    },
  })
  await fs.writeFile(
    path.join(root, "build.json"),
    JSON.stringify({ success: build.success, logs: build.logs.map((item) => item.message) }),
  )
  console.info("NATIVE_CLI_EVIDENCE", root)
  const changedDuringBuild = (
    await Promise.all(
      sourceComponents.map(async (component) =>
        hash(await fs.readFile(path.join(repository, component.path))) === component.sha256
          ? undefined
          : component.path,
      ),
    )
  ).filter(Boolean)
  await fs.writeFile(
    path.join(root, "build-source-cohort.json"),
    JSON.stringify({ checked: components.components.length, changedDuringBuild }),
  )
  expect(changedDuringBuild).toEqual([])
  expect(hash(await fs.readFile(path.join(root, path.basename(helper.path))))).toBe(helper.sha256)
  expect(build.success).toBe(true)
  const bytes = await fs.readFile(executable)
  const payload = new NativeInstallationSchema.Payload({
    domain: NativeInstallationSchema.DOMAIN,
    releaseID: "signed-cli-test",
    target: components.target,
    sourceCommit: components.sourceCommit,
    sourceTree: components.sourceTree,
    componentsHash: hash(componentsText),
    executable: new NativeInstallationSchema.Executable({ bytes: bytes.byteLength, sha256: hash(bytes) }),
  })
  if (windows) {
    const { sealTestNativeCLI } = await import("../../../desktop/scripts/test-native-publisher")
    await fs.writeFile(`${executable}.native-components.json`, componentsText, { flag: "wx" })
    await sealTestNativeCLI({ executable, target: components.target, releaseID: "signed-cli-test",
      privateKeyFile: windows.publisher.privateKeyFile, publicKeyFile: windows.publisher.publicKeyFile })
  }
  if (!windows)
    await fs.writeFile(
      `${executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`,
      CanonicalJson.stringify(
        new NativeInstallationSchema.Manifest({
          payload,
          signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), pair.privateKey).toString("hex"),
        }),
      ),
    )
  await fs.writeFile(path.join(root, "components.json"), componentsText)
  await fs.writeFile(path.join(root, "public-key.pem"), pin)
  const state = { mode: "happy", proxy: 0 }
  const hits: { mode: string; body: string; authorization?: string; header?: string | string[]; url: string }[] = []
  const physical: { mode: string; url: string }[] = []
  const partial: number[] = []
  const provider = createServer((incoming, response) => {
    physical.push({ mode: state.mode, url: incoming.url ?? "" })
    const chunks: Buffer[] = []
    incoming.on("data", (chunk: Buffer) => {
      if (state.mode === "partial-write") {
        partial.push(chunk.byteLength)
        response.destroy()
        return
      }
      chunks.push(chunk)
    })
    incoming.on("end", () => {
      hits.push({
        mode: state.mode,
        body: Buffer.concat(chunks).toString(),
        authorization: incoming.headers.authorization,
        header: incoming.headers["x-native-fixture"],
        url: incoming.url ?? "",
      })
      if (state.mode === "drop") return response.destroy()
      if (state.mode === "redirect") return response.writeHead(307, { location: "/redirect-target" }).end()
      if (["429", "503"].includes(state.mode))
        return response.writeHead(Number(state.mode), { "retry-after": "0" }).end("refused")
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (state.mode === "cancel-inflight") return response.write(": pending\n\n")
      if (state.mode === "partial-response") {
        response.write('data: {"type":"response.created","response":{"id":"partial"}}\n\n')
        return setTimeout(() => response.destroy(), 20)
      }
      response.end(
        'data: {"type":"response.completed","response":{"id":"fixture","usage":{"input_tokens":8,"output_tokens":1}}}\n\n',
      )
    })
  })
  registerServer(provider)
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const address = provider.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture provider")
  const url = `http://127.0.0.1:${address.port}`
  const proxy = createServer((incoming, response) => {
    state.proxy++
    if (incoming.url !== `${url}/responses`) return response.writeHead(403).end("offline only")
    const upstream = request(incoming.url, { method: incoming.method, headers: incoming.headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers)
      result.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    incoming.pipe(upstream)
  })
  registerServer(proxy)
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing fixture proxy")
  const project = path.join(root, "project")
  await Promise.all(
    ["project", "home", "tmp", "config", "data", "cache", "state", "managed"].map((name) =>
      fs.mkdir(path.join(root, name)),
    ),
  )
  if (windows) await Promise.all(["appdata", "localappdata"].map((name) => fs.mkdir(path.join(root, name))))
  await fs.writeFile(
    path.join(project, "deepagent-code.json"),
    JSON.stringify({
      $schema: "https://ai.deepagent.ltd/config.schema.json",
      formatter: false,
      lsp: false,
      model: "fixture/snapshot",
      providers: {
        fixture: {
          name: "Native loopback",
          env: ["DAC_FIXTURE_NATIVE_KEY"],
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", protocol: "openai-compatible.responses", url },
          models: {
            snapshot: {
              name: "Fixture snapshot",
              api: { id: "snapshot-1" },
              capabilities: { input: ["text", "image"], output: ["text"], tools: false },
              limit: { context: 10000, output: 1000 },
            },
          },
        },
      },
    }),
  )
  const configText = await fs.readFile(path.join(project, "deepagent-code.json"), "utf8")
  const bin = path.join(root, "home/.deepagent/code/cache/bin")
  await fs.mkdir(bin, { recursive: true })
  const rg = Bun.which("rg")
  expect(rg).toBeDefined()
  await fs.copyFile(rg!, path.join(bin, process.platform === "win32" ? "rg.exe" : "rg"))
  const manifest = await fs.readFile(`${executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`)
  const rows: { mode: string; exit: number; requests: number; proxy: number }[] = []

  return async (mode: string) => {
    await fs.writeFile(
      path.join(project, "deepagent-code.json"),
      mode.startsWith("privacy")
        ? JSON.stringify({
            $schema: "https://ai.deepagent.ltd/config.schema.json",
            formatter: false,
            lsp: false,
            model: "fixture/snapshot",
            providers: {
              fixture: {
                name: "Native loopback",
                env: ["DAC_FIXTURE_NATIVE_KEY"],
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  protocol: "openai-compatible.responses",
                  url,
                },
                models: {
                  snapshot: {
                    name: "Fixture snapshot",
                    api: { id: "snapshot-1" },
                    request: { body: { apiKey: "1234" } },
                    capabilities: { input: ["text", "image"], output: ["text"], tools: false },
                    limit: { context: 10000, output: 1000 },
                  },
                },
              },
            },
          })
        : mode.startsWith("approval")
          ? JSON.stringify({
              $schema: "https://ai.deepagent.ltd/config.schema.json",
              formatter: false,
              lsp: false,
              model: "fixture/snapshot-1",
              providers: {
                fixture: {
                  env: ["DAC_FIXTURE_NATIVE_KEY"],
                  api: {
                    type: "native",
                    settings: {},
                    protocol: "openai.responses",
                    url: "https://127.0.0.1:1/v1/responses",
                  },
                  models: {
                    "snapshot-1": {
                      api: { id: "snapshot-1" },
                      capabilities: { input: ["text", "image"], output: ["text"], tools: false },
                      limit: { context: 10000, output: 1000 },
                    },
                  },
                },
              },
            })
          : mode === "historical-changed-config"
            ? configText.replace("Native loopback", "Actual changed configuration")
            : configText,
    )
    state.mode = mode
    const before = hits.length
    const physicalBefore = physical.length
    const proxyBefore = state.proxy
    const success =
      [
        "approval",
        "approval-reopen",
        "capture",
        "capture-repeat",
        "capture-other-target",
        "capture-rotated",
        "privacy",
        "privacy-repeat",
        "happy",
        "proxy",
        "ordinary-proxy",
        "auth-rotate",
        "auth-provider-rotate",
        "scope",
        "root-close",
        "foreign-root",
        "capacity",
      ].includes(mode) || mode.startsWith("historical-")
    const count = [
      "happy",
      "proxy",
      "ordinary-proxy",
      "auth-rotate",
      "auth-provider-rotate",
      "redirect",
      "429",
      "503",
      "drop",
      "partial-write",
      "partial-response",
      "cancel-inflight",
    ].includes(mode)
      ? 1
      : 0
    await fs.writeFile(`${executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`, manifest)
    const child = Bun.spawn([executable, "debug", mode], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        ...(windows ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
          USERPROFILE: path.join(root, "home"), APPDATA: path.join(root, "appdata"),
          LOCALAPPDATA: path.join(root, "localappdata"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
        } : {}),
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
        DEEPAGENT_CODE_HOME: path.join(root, "data"),
        DEEPAGENT_CODE_DB: path.join(
          root,
          `${mode === "approval-reopen" || mode.startsWith("historical-") ? "approval" : mode}.sqlite`,
        ),
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_CODE_MODELS_PATH: path.join(host, "test/tool/fixtures/models-api.json"),
        DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
        DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
        DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DAC_FIXTURE_NATIVE_KEY: "fixture-only-key",
        ...(mode.startsWith("privacy") ? { HTTP_PROXY: "http://fixture:1234@127.0.0.1:1" } : {}),
        ...(mode === "unsafe-tls" ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
        ...(mode === "external-ca" ? { SSL_CERT_FILE: path.join(root, "untrusted-ca.pem") } : {}),
        DAC_NATIVE_FACTORY_RESULT: path.join(root, `${mode}-result.json`),
        NO_COLOR: "1",
        ...(["proxy", "ordinary-proxy"].includes(mode)
          ? {
              HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
              HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
            }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await fs.writeFile(path.join(root, `${mode}-child.log`), stdout + stderr)
      await fs.writeFile(path.join(root, "http.json"), JSON.stringify({ hits, physical, partial }, null, 2))
      const row = { mode, exit, requests: physical.length - physicalBefore, proxy: state.proxy - proxyBefore }
      rows.push(row)
      await fs.writeFile(path.join(root, "matrix.json"), JSON.stringify(rows, null, 2))
      console.info("NATIVE_CLI_CASE", JSON.stringify(row))
      const result = await Bun.file(path.join(root, `${mode}-result.json`)).json()
      // Native selection maps its first cause to a public refusal. Only its fixed
      // classifications may leave the owned child log; raw stderr can contain secrets.
      const classifications = stderr.split(/\r?\n/).filter((line) =>
        /^\{"stage":"windows-cli-native","operation":"(?:addon-load|current|preloaded|compiled-cli|prepare-runtime|launch|poll|close-child|close-capture)","tag":"(?:[A-Za-z][A-Za-z0-9_.]{0,63}|unknown)","code":"(?:WINDOWS_[A-Z_]{1,96}|UNCLASSIFIED)"\}$/.test(line) ||
        /^Local operator diagnostic: \{"version":1,"stage":"(?:operator-command|factory-load|project-select|contract-select|location-open|model-descriptor|model-resolve|runtime-approve|request-bind|credential-capture|encoder)","kind":"(?:interrupted|defect|failure)","tag":"(?:NativeRuntimeError|NativeInstallationError|WorkRouteApproval\.Error|LocalOperator\.Error|WorkFileCapability\.Error|CatalogV2\.(?:ProviderNotFound|ModelNotFound)|SessionRunnerModel\.(?:ModelNotSelectedError|UnsupportedApiError|ModelProtocolDisabledError)|LocationIdentity\.(?:RootUnavailableError|NotFoundError|RetiredError|ConflictError|WorkUnsettledError)|unknown)","code":"[A-Z][A-Z0-9_]{0,79}"\}$/.test(line) ||
        /^WINDOWS_WORK_(?:CHILD|FACTORY|HELPER)_FAILURE (?:stage|phase)=[a-z][a-z-]{0,47} kind=[A-Za-z]{1,40} os=-?\d{1,10}(?: exit_known=(?:true|false) exit_code=\d{1,10})?$/.test(line) ||
        /^dac-native-preload:(?:installation-open|installation-read|accept):[A-Za-z]{1,40}:(?:None|Some\(-?\d{1,10}\))$/.test(line) ||
        /^dac-native-installation-current:(?:original-current|preload-current|manifest-current|manifest-trusted|artifact-trusted|artifact-stamp|manifest-stamp|runtime-stamp):[A-Za-z]{1,40}:(?:None|Some\(-?\d{1,10}\))$/.test(line) ||
        /^dac-native-first-load-current:(?:bootstrap|runtime|system|module):(?:system-lease|system-machine|image-lease|mapped-path|stamp|identity|image-machine|private-trust|work-import-lease|work-import-machine|work-import-mapped-path|work-import-stamp):(?:none|creation|write|change|attrs|size-high|size-low|links|identity):[A-Za-z]{1,40}:(?:None|Some\(-?\d{1,10}\))$/.test(line),
      ).slice(-32)
      expect({ mode, exit, diagnostic: exit === (success ? 0 : 2) ? "expected" : { result, classifications } }).toEqual({
        mode,
        exit: success ? 0 : 2,
        diagnostic: "expected",
      })
      expect(result.liveAfter).toBe(mode === "root-close" ? 1 : 0)
      expect(row.requests).toBe(count)
      expect(row.proxy).toBe(["proxy", "ordinary-proxy"].includes(mode) ? 1 : 0)
      if (["happy", "proxy", "ordinary-proxy", "auth-rotate", "auth-provider-rotate"].includes(mode)) {
        expect(result.result.sameClient).toBe(true)
        expect(result.result.bootstrap).toBe(true)
        expect(hits[before]!.authorization).toBe(
          mode === "auth-provider-rotate" ? "Bearer fixture-rotated-key" : "Bearer fixture-only-key",
        )
        expect(hits[before]!.header).toBe("final-header")
        expect(
          JSON.parse(hits[before]!.body).input[1].content.some(
            (item: { type: string; image_url?: string }) =>
              item.type === "input_image" && item.image_url?.startsWith("data:image/png;base64,"),
          ),
        ).toBe(true)
        expect(hash(hits[before]!.body)).toBe(result.result.observations[0].bodyHash)
      }
      if (mode.startsWith("historical-")) {
        const expected = mode.startsWith("historical-args-")
          ? "ROUTE_BINDING_CONFLICT"
          : mode === "historical-legacy"
            ? "ROUTE_COMMAND_IDENTITY_UNAVAILABLE"
            : mode === "historical-new-unavailable"
              ? "ROUTE_PROOF_UNAVAILABLE"
              : ["historical-mac-tamper", "historical-missing-identity"].includes(mode)
                ? "ROUTE_INVALID_RECORD"
                : "success"
        expect(result.result.code).toBe(expected)
        expect(result.result.rowsUnchanged).toBe(mode !== "historical-revoke")
        expect(result.result.noCaptureFactoryInstalled).toBe(true)
        if (expected === "success") {
          expect(result.result.value.authorization).toBe("not_checked")
          expect(result.result.value.currentRecord.state).toBe(
            ["historical-at-expiry", "historical-expired"].includes(mode) ? "active" : "revoked",
          )
          if (!["historical-revoke", "historical-revoke-retry"].includes(mode))
            expect(result.result.value.commandReceipt).toEqual(result.result.originalReceipt)
          if (mode === "historical-legacy-query")
            expect(result.result.value.identityAvailability).toBe("legacy_unavailable")
        }
      }
      if (mode === "approval-source-copy" || mode === "approval-source-drift") {
        const db = new Database(path.join(root, `${mode}.sqlite`), { readonly: true })
        try {
          expect(db.query("SELECT revision,credential_generation FROM local_operator_authority").get()).toEqual({
            revision: 1,
            credential_generation: 1,
          })
          expect(db.query("SELECT count(*) count FROM work_route_approval").get()).toEqual({ count: 0 })
        } finally {
          db.close()
        }
      }
      if (mode === "approval" || mode === "approval-reopen") {
        expect(result.result).toMatchObject({
          coldReused: mode === "approval-reopen",
          macVerified: true,
          tamperRejected: true,
          basicGeneration: 1,
          operatorRevision: 2,
          schemaRevision: 1,
          fixtureOnlyContract: true,
        })
        if (mode === "approval-reopen" && !process.env.DAC_NATIVE_CLI_MODE)
          expect(result.result.receipt).toEqual(
            (await Bun.file(path.join(root, "approval-result.json")).json()).result.receipt,
          )
      }
      if (mode.startsWith("privacy")) {
        expect(result.result).toMatchObject({
          bootstrapGuessMatch: false,
          executorGuessMatch: false,
          modelGuessMatch: false,
          staticCredentialPresent: true,
          sameObjectStable: true,
          freshExecutorDifferent: true,
          freshResolutionDifferent: true,
        })
        if (mode === "privacy-repeat" && !process.env.DAC_NATIVE_CLI_MODE) {
          const previous = await Bun.file(path.join(root, "privacy-result.json")).json()
          for (const index of [0, 1, 2])
            expect(result.result.fingerprints[index]).not.toBe(previous.result.fingerprints[index])
        }
      }
      if (mode.startsWith("capture")) {
        expect(result.result).toMatchObject({ copied: "Failure", copiedObservation: "Failure", closed: "Failure" })
        expect(JSON.stringify(result.result)).not.toContain("fixture-only-key")
        expect(result.result.configurationStamp).toMatch(/^[a-f0-9]{64}$/)
        if (mode !== "capture" && !process.env.DAC_NATIVE_CLI_MODE) {
          const prior = await Bun.file(path.join(root, "capture-result.json")).json()
          expect(result.result.publicFingerprint).not.toBe(prior.result.publicFingerprint)
          if (mode === "capture-repeat") {
            expect(result.result.configurationStamp).toBe(prior.result.configurationStamp)
            expect(result.result.credentialFingerprint).toBe(prior.result.credentialFingerprint)
          }
          if (mode === "capture-other-target") {
            expect(result.result.configurationStamp).not.toBe(prior.result.configurationStamp)
            expect(result.result.credentialFingerprint).not.toBe(prior.result.credentialFingerprint)
          }
          if (mode === "capture-rotated") {
            expect(result.result.configurationStamp).toBe(prior.result.configurationStamp)
            expect(result.result.credentialFingerprint).not.toBe(prior.result.credentialFingerprint)
          }
        }
      }
      if (mode === "root-close") expect(result.progress.closedRoot).toEqual({ live: 0, handle: "Failure" })
      if (mode === "scope") expect(result.result).toEqual({ closed: "Failure", live: 1 })
      if (mode === "foreign-root") expect(result.result).toEqual({ handle: "Failure", resolved: "Failure" })
      if (mode === "capacity") expect(result.result).toEqual({ full: "Failure", live: 32, after: 1 })
      if (mode === "partial-write") {
        expect(partial.length).toBeGreaterThan(0)
        expect(partial.reduce((sum, size) => sum + size, 0)).toBeLessThan(1_048_576)
      }
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  }
}
