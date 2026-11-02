import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { prepare, build, readEvidence, environment } from "./fixture/native-node-development-build"

test("ordinary Node development build needs no Cargo or publisher and removes stale Native metadata", async () => {
  const replay = process.env.DAC_NATIVE_NODE_DEVELOPMENT_REPLAY
    ? await readEvidence(process.env.DAC_NATIVE_NODE_DEVELOPMENT_REPLAY)
    : undefined
  const input = replay?.input ?? (await prepare())
  process.stderr.write(`NATIVE_NODE_DEVELOPMENT_EVIDENCE ${input.root}\n`)
  const result = replay ? replay.result : await build(input)
  expect(result.code).toBe(0)
  expect(result.logs).toContain("Build complete")
  const required = [
    "NOTICE",
    "auth-password-worker.node.js",
    "auth-password-worker.node.js.map",
    "node.js",
    "node.js.map",
    "typescript-index.worker.js",
    "typescript-index.worker.js.map",
  ]
  expect(required.every((file) => result.outputs.includes(file))).toBe(true)
  expect(result.outputs.every((file) => required.includes(file) || file.endsWith(".wasm"))).toBe(true)
  for (const file of result.outputs.filter((file) => file.endsWith(".wasm")))
    expect((await fs.readFile(path.join(input.output, file))).subarray(0, 4)).toEqual(Buffer.from([0, 97, 115, 109]))
  expect(await fs.readFile(path.join(input.output, "NOTICE"))).toEqual(
    await fs.readFile(path.join(input.copy, "NOTICE")),
  )
  const bundle = await Bun.file(path.join(input.output, "node.js")).text()
  expect(bundle).toContain('from "@lydell/node-pty"')
  expect(bundle).toContain('from "jsonc-parser"')
  expect(bundle).not.toContain(input.copy)
  expect(bundle).not.toContain('from "bun:')
  expect((await fs.stat(path.join(input.output, "auth-password-worker.node.js"))).size).toBeGreaterThan(0)
  const drift = []
  for (const entry of input.manifest) {
    if (
      createHash("sha256")
        .update(await fs.readFile(path.join(input.copy, entry.path)))
        .digest("hex") !== entry.sha256
    )
      drift.push(entry.path)
  }
  expect(drift).toEqual([])
  await fs.writeFile(
    path.join(input.root, "safe.json"),
    JSON.stringify(
      {
        version: 1,
        root: input.root,
        inputs: input.manifest.length,
        drift,
        outputs: result.outputs,
        noCargo: true,
        noPublisher: true,
        noNativeAssetsOrMetadata: true,
        provider: 0,
        database: 0,
        NativeExecution: 0,
        assertionReplay: Boolean(replay),
        newBuildsInReplay: 0,
        boundary:
          `actual original Node-targeted build on ${process.platform}-${process.arch}; not Desktop runtime or Native capability`,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}, 60_000)

test("Node builds compile an ephemeral owner public pin and reject incomplete issuance inputs", async () => {
  const input = await prepare()
  process.stderr.write(`NATIVE_NODE_OWNER_PIN_EVIDENCE ${input.root}\n`)
  const authorizationFile = path.join(input.root, "owner-authorization.json")
  const mint = Bun.spawn(
    [
      process.execPath,
      "script/mint-owner-campaign.ts",
      "--ephemeral",
      "--build-identity",
      "2.0.3",
      "--db",
      path.join(input.root, "mint.db"),
      "--export",
      authorizationFile,
    ],
    {
      cwd: path.join(input.copy, "packages/deepagent-code"),
      env: environment(input),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const minted = (await new Response(mint.stdout).json()) as { public_key_pem: string }
  await new Response(mint.stderr).text()
  expect(await mint.exited).toBe(0)
  expect(minted.public_key_pem).toContain("-----BEGIN PUBLIC KEY-----")
  const file = path.join(input.root, "release-owner-public.pem")
  await fs.writeFile(file, minted.public_key_pem, { mode: 0o600 })
  const result = await build(input, { publicKey: file, authorizationFile })
  expect(result.code).toBe(0)
  const bundle = await Bun.file(path.join(input.output, "node.js")).text()
  expect(bundle.includes(minted.public_key_pem) || bundle.includes(JSON.stringify(minted.public_key_pem))).toBe(true)
  expect(bundle.includes("typeof DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY")).toBe(false)
  for (const owner of [{ publicKey: file }, { authorizationFile }, { required: true }]) {
    const rejected = await build(input, owner)
    expect(rejected.code).not.toBe(0)
    expect(rejected.logs).toContain("Release owner public key and authorization file must be supplied together")
  }
  await fs.writeFile(file, "")
  const empty = await build(input, { publicKey: file, authorizationFile })
  expect(empty.code).not.toBe(0)
  expect(empty.logs).toContain("DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY is neither an inline PEM nor a path to one")
  const dev = await build(input, { required: true, version: "0.0.0-owner-dev-fixture" })
  expect(dev.code).toBe(0)
  expect(dev.logs).toContain("Build complete")
  expect(await Bun.file(path.join(input.output, "node.js")).text()).toContain("0.0.0-owner-dev-fixture")
}, 60_000)
