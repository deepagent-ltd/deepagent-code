import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database, constants } from "bun:sqlite"
import { pathToFileURL } from "node:url"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

function readAuthority(root: string) {
  // Node checkpoints this owned database before exiting. Explicit URI mode is
  // required on every SQLite build; immutable avoids creating WAL sidecars.
  return new Database(`${pathToFileURL(path.join(root, "authority.sqlite")).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
}

async function run(mode: "identity" | "interaction-redirect-denied" | "interaction-path-denied" | "interaction-body-denied" | "interaction" | "happy" | "unknown" | "permission" | "wrong-root" | "wrong-session" | "retired" | "selection-drift" | "cancel" | "crash" | "control-tamper") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-managed-browser-runner-")))
  await fs.chmod(root, 0o700)
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project", "chunks"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
  await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const server = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../../../deepagent-code/src/node.ts")],
    outdir: path.join(root, "chunks"), naming: "node.js", target: "node", external: ["@lydell/node-pty", "jsonc-parser", "bun"],
    define: { "Bun.main": '""', DEEPAGENT_CODE_VERSION: '"2.0.3"', DEEPAGENT_CODE_CHANNEL: '"dev"' }, files: { "deepagent-code-web-ui.gen.ts": "" } })
  // The real sidecar imports its physical adjacent chunks/node.js entry.
  const sidecar = await Bun.build({ entrypoints: [path.join(import.meta.dir, "sidecar.ts")], outdir: root, naming: "sidecar.js", target: "node" })
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-runner.ts")], outdir: root,
    naming: "main.mjs", target: "node", external: ["electron"], define: await managedBrowserInputFixtureDefine(root) })
  await Bun.write(path.join(root, "build.json"), JSON.stringify([...server.logs, ...sidecar.logs, ...main.logs].map(String)))
  console.log("MANAGED_BROWSER_RUNNER_EVIDENCE", root)
  expect(server.success && sidecar.success && main.success).toBe(true)
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, main.outputs[0]!.path], {
    cwd: path.join(root, "project"), env: { ...managedBrowserInputFixtureEnvironment, PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
      XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_HOME: path.join(root, "data"), DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "", DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off", DAC_BROWSER_TEST_ROOT: root, DAC_BROWSER_TEST_MODE: mode, NO_COLOR: "1" },
    stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 90_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + "\n" + stderr)
  expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
  const result = await Bun.file(path.join(root, "result.json")).json()
  return { root, result }
}

test("actual Desktop sidecar HTTP canonical runner delivers native Browser PNG to the next provider request", async () => {
  const { root, result } = await run("happy")
  expect(result.providerRequests).toBe(6)
  expect(result.browserMissing).toBe(false)
  expect(result.control.nativeVerification).toBe("verified")
  expect(result.stopped.stopConfirmed).toBe(true)
  expect(result.unauthorizedStatus).toBe(401)
  expect(result.queryAuthStatus).toBe(401)
  expect(result.forbiddenActionStatus).toBe(404)
  expect(result.getNoWrites, JSON.stringify({ root, changedTables: result.getChanges })).toBe(true)
  const body = await Bun.file(path.join(root, "provider-6.json")).json()
  const images = body.messages.flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : [])
    .filter((part: { type?: string }) => part.type === "image_url")
  expect(images).toHaveLength(1)
  expect(images[0].image_url.url).toStartWith("data:image/png;base64,")
  expect(result.coldHistory.control.nativeVerification).toBe("unavailable")
  expect(result.coldHistory.control.stopConfirmed).toBe(false)
  expect(result.coldHistory.beforeRead).toEqual(result.coldHistory.afterRead)
  const coldFiles = result.coldHistory.context.data.flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : [])
    .flatMap((part: { type?: string; state?: { content?: unknown } }) => part.type === "tool" && Array.isArray(part.state?.content) ? part.state.content : [])
    .filter((item: { type?: string }) => item.type === "file")
  expect(coldFiles).toHaveLength(1)
  expect(coldFiles[0].source).toEqual({ type: "data", data: images[0].image_url.url.split(",")[1] })
  const db = readAuthority(root)
  try {
    const actions = db.query<{ outcome: string; record: string }, []>("SELECT outcome, record FROM browser_action ORDER BY created_at").all()
    expect(actions).toHaveLength(4)
    expect(actions.every((action) => action.outcome === "completed")).toBe(true)
    const records = actions.map((action) => JSON.parse(action.record))
    const screenshot = records.find((record) => record.command.type === "screenshot")
    const bytes = Buffer.from(images[0].image_url.url.split(",")[1], "base64")
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(screenshot.result.image.hash)
    expect(actions.some((action) => action.record.includes("data:image") || action.record.includes('"png"'))).toBe(false)
    expect(db.query("SELECT * FROM session_v2_tool_effect_admission").all()).toHaveLength(5)
    expect(db.query("SELECT * FROM session_v2_tool_effect_admission WHERE tool_name = 'plan'").all()).toHaveLength(1)
    expect(db.query("SELECT * FROM session_v2_tool_effect WHERE state = 'settled'").all()).toHaveLength(5)
    expect(db.query("SELECT * FROM session_input").all()).toHaveLength(1)
  } finally { db.close() }
}, 100_000)


test("actual finished provider may wait for scoped once approval before each browser action", async () => {
  const { result } = await run("permission")
  expect(result.providerRequests).toBe(6)
  expect(result.permissions).toHaveLength(4)
  expect(result.permissions.every((item: { providerFinished: number }) => item.providerFinished > 0)).toBe(true)
  expect(result.stopped.stopConfirmed).toBe(true)
}, 100_000)

for (const mode of ["unknown", "cancel", "crash"] as const) test(`actual dispatched navigation ${mode} keeps pending ToolEffect admission; cold input retry does not replay`, async () => {
  const { root, result } = await run(mode)
  expect(result.previewRequests).toEqual(["/slow"])
  expect(result.afterUnknown).toBe(3)
  expect(result.sameProcessRequests).toBe(3)
  expect(result.providerRequests).toBe(3)
  expect(result.coldObserved.nativeVerification).toBe("unavailable")
  expect(result.coldObserved.stopConfirmed).toBe(false)
  expect(result.coldAction.nativeVerification).toBe("unavailable")
  expect(result.coldAction.observedOutcome).toBe("unknown")
  expect(result.coldAction.stopConfirmed).toBe(false)
  expect(result.unchangedAction).toBe(true)
  if (mode !== "crash") expect(result.sameProcess.data.id).toBe(result.admitted.data.id)
  if (mode === "cancel") expect(result.explicitCancel.stopConfirmed).toBe(true)
  if (mode === "crash") expect(result.killedPID).toBeGreaterThan(0)
  expect(result.coldRetry.data.id).toBe(result.admitted.data.id)
  const db = readAuthority(root)
  try {
    const actions = db.query<{ outcome: string; record: string }, []>("SELECT outcome, record FROM browser_action ORDER BY created_at").all()
    expect(actions.map((action) => action.outcome)).toEqual(["completed", mode === "crash" ? "pending" : "unknown"])
    expect(db.query("SELECT * FROM session_v2_tool_effect_admission").all()).toHaveLength(3)
    expect(db.query("SELECT * FROM session_v2_tool_effect").all()).toHaveLength(2)
    expect(db.query("SELECT * FROM session_input").all()).toHaveLength(1)
  } finally { db.close() }
}, 100_000)

for (const mode of ["wrong-root", "wrong-session", "retired", "selection-drift", "control-tamper"] as const) {
  test(`actual canonical browser rejects ${mode} before native action or preview network`, async () => {
    const { root, result } = await run(mode)
    expect(result.previewRequests).toEqual([])
    expect(result.providerRequests).toBeGreaterThanOrEqual(2)
    expect(result.providerRequests).toBeLessThanOrEqual(3)
    if (["retired", "selection-drift"].includes(mode)) expect(result.permissions).toHaveLength(1)
    else if (mode !== "control-tamper") expect(result.session.data.id).not.toBe(result.invokeSession.data.id)
    const db = readAuthority(root)
    try {
      expect(db.query("SELECT * FROM browser_action").all()).toHaveLength(0)
      expect(db.query("SELECT * FROM session_v2_tool_effect_admission").all()).toHaveLength(2)
      const outcome = db.query<{ state: string }, []>("SELECT e.state FROM session_v2_tool_effect e JOIN session_v2_tool_effect_admission a ON a.receipt_id = e.receipt_id AND a.tool_call_id = e.tool_call_id WHERE a.tool_name = 'browser'").get()
      // A known Tool.Failure is durably settled as an error result, not a successful browser action.
      expect(outcome?.state).toBe("settled")
      const body = await Bun.file(path.join(root, "provider-3.json")).json()
      const error = body.messages.findLast((item: { role: string }) => item.role === "tool")?.content
      expect(error).toContain(mode === "selection-drift" ? "rejected" : ["retired", "control-tamper"].includes(mode) ? "BROWSER_AUTHORITY_REQUIRED" : "BROWSER_SCOPE_DENIED")
      if (mode === "selection-drift") expect(result.selectionMutationRejected).toBe(true)
    } finally { db.close() }
  }, 100_000)
}


test("actual interaction profile submits one Chinese form through canonical actions and projects AX plus PNG before cancel", async () => {
  const { root, result } = await run("interaction")
  expect(result.providerRequests).toBe(10)
  expect(result.browserMissing).toBe(false)
  expect(result.posted).toHaveLength(1)
  expect(new URLSearchParams(result.posted[0]).get("name")).toBe("真实中文表单一次")
  expect(result.stopped.stopConfirmed).toBe(true)
  expect(result.getNoWrites).toBe(true)
  const body = await Bun.file(path.join(root, "provider-10.json")).json()
  expect(JSON.stringify(body)).toContain("提交成功")
  expect(JSON.stringify(body)).toContain("data:image/png;base64,")
  const db = readAuthority(root)
  try {
    expect(db.query("SELECT * FROM browser_action WHERE outcome = 'completed'").all()).toHaveLength(8)
    expect(db.query("SELECT * FROM session_v2_tool_effect WHERE state = 'settled'").all()).toHaveLength(9)
    expect(db.query("SELECT * FROM session_input").all()).toHaveLength(1)
  } finally { db.close() }
}, 100_000)


for (const mode of ["interaction-path-denied", "interaction-body-denied", "interaction-redirect-denied"] as const) {
  test(`actual interaction broker ${mode} sends no upstream POST and never repeats unknown input`, async () => {
    const { root, result } = await run(mode)
    expect(result.posted).toHaveLength(mode === "interaction-redirect-denied" ? 1 : 0)
    expect(result.outsideRequests).toBe(0)
    expect(result.stopped.stopConfirmed).toBe(true)
    const db = readAuthority(root)
    try {
      const clicks = db.query<{ outcome: string }, []>("SELECT outcome FROM browser_action WHERE json_extract(record, '$.command.type') = 'click'").all()
      expect(clicks).toHaveLength(1)
      expect(["completed", "unknown"]).toContain(clicks[0]?.outcome)
      expect(db.query("SELECT * FROM session_input").all()).toHaveLength(1)
    } finally { db.close() }
  }, 100_000)
}


test("actual HTTP browser create uses current indexed git and non-git identity and rejects filesystem drift", async () => {
  const { result } = await run("identity")
  expect(result.indexed).toHaveLength(2)
  expect(result.indexed.map((item: { kind: string }) => item.kind)).toEqual(["registered_root", "git"])
  expect(result.indexed.every((item: { matched: boolean; stopped: boolean }) => item.matched && item.stopped)).toBe(true)
  expect(result.drift.status).toBe(403)
  expect(result.drift.body).toContain("BROWSER_SCOPE_DENIED")
  expect(result.before).toEqual(result.after)
  expect(result.foreignBinding.status).toBe(403)
  expect(result.foreignBinding.body).toContain("BROWSER_SCOPE_DENIED")
  expect(result.foreignBinding.before).toEqual(result.foreignBinding.after)
  expect(result.windowsAfter).toBe(result.windowsBefore)
  expect(result.providerRequests).toBe(0)
  expect(result.previewRequests).toEqual([])
}, 100_000)
