import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareManagedBrowserInputAsset } from "../../scripts/managed-browser-input-assets"

const actual = process.env.DAC_BROWSER_PUBLIC_MANAGER_ACTUAL === "1" ? test : test.skip

actual("actual Main manager ↔ utility NativeHost: scoped fileDB public actions, one network router and clipboard guard, AX/PNG and confirmed active cancel", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-public-manager-"))
  await fs.chmod(root, 0o700)
  await fs.mkdir(path.join(root, "project"), { mode: 0o700 })
  for (const args of [
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Private Browser Assembly CA"],
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server-key.pem", "-out", "server.csr", "-subj", "/CN=positive.example.com"],
  ]) {
    const command = Bun.spawnSync(["openssl", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" })
    expect(command.exitCode).toBe(0)
  }
  await fs.writeFile(path.join(root, "server.ext"), "subjectAltName=DNS:positive.example.com,DNS:cloudflare-dns.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
  const certificate = Bun.spawnSync(["openssl", "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem",
    "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "server.ext"], { cwd: root, stdout: "ignore", stderr: "ignore" })
  expect(certificate.exitCode).toBe(0)
  await Promise.all([fs.chmod(path.join(root, "ca-key.pem"), 0o600), fs.chmod(path.join(root, "server-key.pem"), 0o600)])
  await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
  const inputAsset = await prepareManagedBrowserInputAsset({ directory: path.join(root, "managed-browser-input") })
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-public.ts")],
    target: "node", splitting: true, conditions: ["node"], external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"],
    outdir: root, naming: "main.mjs", define: { __DAC_MANAGED_BROWSER_INPUT_ASSET__: inputAsset ? JSON.stringify(inputAsset) : "undefined" } })
  expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
      XDG_CACHE_HOME: root, DAC_BROWSER_PUBLIC_ROOT: root }, stdout: "pipe", stderr: "pipe", timeout: 35_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  console.log("PUBLIC_BROWSER_MANAGER_EVIDENCE", root)
  const failure = await Bun.file(path.join(root, "utility-failure.json")).exists()
    ? await Bun.file(path.join(root, "utility-failure.json")).json()
    : await Bun.file(path.join(root, "failure.json")).exists() ? await Bun.file(path.join(root, "failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(0)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.childExit).toBe(0)
  expect(result.result.node).toBe("24.18.0")
  expect(result.result.electron).toBe("41.10.3")
  expect(result.result.profile).toBe("managed-public-readonly-v1")
  expect(result.result.actions.map((action: { outcome: string }) => action.outcome)).toEqual(["completed", "completed", "completed", "completed", "completed", "unknown"])
  expect(result.result.snapshotText).toContain("Public readonly Manager")
  expect(result.result.image.mime).toBe("image/png")
  expect(result.result.image.bytes).toBeGreaterThan(1000)
  expect(result.result.image.hash).toMatch(/^[0-9a-f]{64}$/)
  expect(result.result.deniedCode).toBe("BROWSER_NETWORK_DENIED")
  expect(result.result.controlState).toBe("stopped")
  expect(result.result.stopConfirmed).toBe(true)
  expect(result.result.closed).toBe(true)
  expect(result.result.readAndExactCancelWrites).toBe(0)
  expect(result.result.providerCalls).toBe(0)
  expect(result.facts.page).toEqual(["/", "/slow"])
  expect(result.facts.doh.filter((type: number) => type === 1)).toHaveLength(2)
  expect(result.facts.doh.filter((type: number) => type === 28)).toHaveLength(2)
  expect(result.facts.sni).toContain("cloudflare-dns.com")
  expect(result.facts.sni).toContain("positive.example.com")
  expect(result.facts.connects.every((value: string) => ["1.1.1.1:443", "93.184.216.34:443"].includes(value))).toBe(true)
  expect(result.facts.proxyAuthenticated.every(Boolean)).toBe(true)
  expect(result.facts.authLeak).toBe(false)
  expect(result.facts.debuggerListeners).toEqual(Array(5).fill(2))
  expect(result.windows).toBe(0)
  expect(result.remainingPeerSockets).toBe(0)
}, 45_000)
