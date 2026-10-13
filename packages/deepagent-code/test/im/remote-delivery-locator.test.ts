import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("remote status receipt locator verifies original file-backed transport ACK and rejects substituted tuple without writes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dac-remote-status-receipt-")))
  await Promise.all(["home", "config", "data", "cache", "state", "tmp", "project"].map((name) => mkdir(join(root, name), { mode: 0o700 })))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixture/remote-delivery-locator.ts")], {
    cwd: join(root, "project"), env: { PATH: process.env.PATH, DAC_REMOTE_STATUS_RECEIPT_ROOT: root,
      HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: join(root, "home"), DEEPAGENT_CODE_HOME: join(root, "data"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "",
      DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" })
  const completed = { value: false }
  const deadline = setTimeout(() => child.kill("SIGKILL"), 55_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await Bun.write(join(root, "child.log"), stdout + stderr)
    expect({ code, result: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, result: "ok" })
    expect(await Bun.file(join(root, "receipt.json")).json()).toEqual({ originalReceipt: true, readonly: true,
      rejected: 11, ambiguous: true, corrupted: true, wire: 0, providers: 0, counts: 0 })
    completed.value = true
  } finally {
    clearTimeout(deadline)
    child.kill()
    if (completed.value) await rm(root, { recursive: true, force: true })
    if (!completed.value) process.stderr.write(`REMOTE_STATUS_RECEIPT_PRIVATE_ROOT ${root}\n`)
  }
}, 60_000)
