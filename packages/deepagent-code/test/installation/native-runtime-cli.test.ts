import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { createServer, request } from "node:http"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { buildWorkFileHelper } from "../../script/build-work-file-helper"
import { ownedSecretBuild } from "../fixture/owned-secret-build"

const repository = path.resolve(import.meta.dir, "../../../..")
const host = path.join(repository, "packages/deepagent-code")
const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

test("signed compiled actual CLI uses Root catalog and native factory through the real bootstrap", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-cli-")))
  const executable = path.join(root, "deepagent-code")
  const pair = generateKeyPairSync("ed25519")
  const pin = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const fixture = path.join(import.meta.dir, "fixture/native-runtime-cli-command.ts")
  const helper = await buildWorkFileHelper({ os: process.platform, arch: process.arch, destination: root })
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
        return new NativeInstallationSchema.Component({ path: entry, bytes: bytes.byteLength, sha256: hash(bytes) })
      }),
  )
  const components = new NativeInstallationSchema.Components({
    schemaVersion: "dac.native-components.v1",
    target: `${process.platform}-${process.arch}`,
    sourceCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository }).stdout.toString().trim(),
    sourceTree: Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: repository }).stdout.toString().trim(),
    components: [...sourceComponents, new NativeInstallationSchema.Component(helper)].toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  })
  const componentsText = CanonicalJson.stringify(components)
  const parserWorker = await fs.realpath(path.join(host, "node_modules/@opentui/core/parser.worker.js"))
  const build = await Bun.build({
    entrypoints: [
      path.join(host, "src/index.ts"),
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
          builder.onLoad({ filter: /\/cli\/cmd\/debug\/index\.ts$/ }, async () => ({
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
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(`/$bunfs/root/${path.relative(host, parserWorker)}`),
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
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing fixture proxy")
  const project = path.join(root, "project")
  await Promise.all(
    ["project", "home", "tmp", "config", "data", "cache", "state", "managed"].map((name) =>
      fs.mkdir(path.join(root, name)),
    ),
  )
  await fs.writeFile(
    path.join(project, "deepagent-code.json"),
    JSON.stringify({
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
  await fs.copyFile(rg!, path.join(bin, "rg"))
  const manifest = await fs.readFile(`${executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`)
  const rows: { mode: string; exit: number; requests: number; proxy: number }[] = []
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
  try {
    for (const mode of modes.filter(
      (mode) => !process.env.DAC_NATIVE_CLI_MODE || mode === process.env.DAC_NATIVE_CLI_MODE,
    )) {
      await fs.writeFile(
        path.join(project, "deepagent-code.json"),
        mode.startsWith("privacy")
          ? JSON.stringify({
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
        expect({ mode, exit, diagnostic: exit === (success ? 0 : 2) ? "expected" : result }).toEqual({
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
      }
    }
  } finally {
    provider.closeAllConnections()
    proxy.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => provider.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ])
  }
}, 240_000)
