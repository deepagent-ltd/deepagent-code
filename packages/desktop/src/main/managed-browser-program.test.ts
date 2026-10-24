import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { compileManagedBrowserProgram, compileManagedBrowserProgramPlan } from "./managed-browser-program"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test.skipIf(process.platform !== "darwin")("actual approved readonly planner mutates only native current leaves, submits once and keeps partial cancellation unknown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-managed-browser-program-"))
  await fs.chmod(root, 0o700)
  const probe = Bun.spawn(["/usr/bin/xcrun", "clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-fobjc-arc", "-DNAPI_VERSION=8", "-DDAC_QA_SOURCE_MASK_ONLY=1", "-framework", "AppKit", "-I",
    path.join(import.meta.dir, "../../native/managed-browser-input/include"),
    path.join(import.meta.dir, "fixture/managed-browser-input-native-qa.mm"), "-o", path.join(root, "qa.node")],
  { stdout: "pipe", stderr: "pipe" })
  const compiled = await Promise.all([probe.exited, new Response(probe.stderr).text()])
  expect({ code: compiled[0], error: compiled[0] ? compiled[1] : null }).toEqual({ code: 0, error: null })
  const main = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-program.ts")],
    outdir: root,
    target: "node",
    external: ["electron"],
    naming: "main.mjs",
    define: await managedBrowserInputFixtureDefine(root),
  })
  const child = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-program-child.ts")],
    outdir: root,
    target: "node",
    external: ["electron"],
    naming: "child.mjs",
  })
  expect(main.logs).toEqual([])
  expect(child.logs).toEqual([])
  expect(main.success && child.success).toBe(true)
  const process = Bun.spawn([managedBrowserInputFixtureExecutable, main.outputs[0]!.path], {
    env: {
      ...managedBrowserInputFixtureEnvironment,
      PATH: globalThis.process.env.PATH,
      HOME: root,
      TMPDIR: root,
      XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
      DAC_BROWSER_TEST_ROOT: root,
      DAC_BROWSER_CHILD: child.outputs[0]!.path,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = { fired: false }
  const timer = setTimeout(() => { timeout.fired = true; process.kill() }, 50_000)
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + "\n" + stderr)
  console.log("MANAGED_BROWSER_PROGRAM_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "result.json")).exists()
    ? await Bun.file(path.join(root, "result.json")).json() : null
  const stages = (code !== 0 || result === null) && await Bun.file(path.join(root, "stages.json")).exists()
    ? (await Bun.file(path.join(root, "stages.json")).json()).slice(-80) : null
  const platformEvents = (code !== 0 || result === null) && await Bun.file(path.join(root, "platform-events.jsonl")).exists()
    ? (await Bun.file(path.join(root, "platform-events.jsonl")).text()).trim().split("\n").slice(-20).map((line) => JSON.parse(line)) : null
  expect({ code, timedOut: timeout.fired, error: code !== 0 || result === null ? { result, stdout, stderr } : null,
    stages, platformEvents }).toEqual({ code: 0, timedOut: false, error: null, stages: null, platformEvents: null })
  expect(result.runtimePaths).toEqual({
    userData: path.join(root, "electron-user"), sessionData: path.join(root, "electron-session"),
  })
  expect(result.message.normal.program.totalSteps).toBe(3)
  expect(result.message.normal.program.completedSteps).toBe(3)
  expect(result.message.normal.program.steps).toEqual([
    { ordinal: 0, operation: "fill" },
    { ordinal: 1, operation: "select" },
    { ordinal: 2, operation: "click" },
  ])
  expect(result.message.normal.program.planHash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.requests.filter((value: { url: string }) => value.url === "/program-submit")).toEqual([
    { method: "POST", url: "/program-submit", body: "name=program+value&choice=b" },
  ])
  expect(
    result.requests.some((value: { url: string }) =>
      ["/program-nonterminal", "/program-planner-network"].includes(value.url),
    ),
  ).toBe(false)
  expect(result.deniedTCP).toBe(0)
  expect(result.message.wrongSource).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.wrongArgs).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.clone).toBe("BROWSER_AUTHORITY_REQUIRED")
  expect(result.message.revoked).toBe("BROWSER_SCOPE_DENIED")
  expect(result.message.staleObservation).toBe("BROWSER_STALE_TARGET")
  expect(result.message.preflight).toEqual(
    ["option", "target"].map((kind) => ({
      kind,
      code: "BROWSER_UNKNOWN",
      observed: { name: "", choice: "a", tail: "untouched", write: null },
    })),
  )
  expect(result.message.failures).toHaveLength(6)
  expect(result.message.failures.every((value: { code: string }) => value.code === "BROWSER_UNKNOWN")).toBe(true)
  expect(result.message.untouched).toEqual({ name: "", choice: "a", tail: "untouched", write: null })
  expect(result.message.stale).toBe("BROWSER_UNKNOWN")
  expect(result.message.prefix).toEqual({ name: "program value", choice: "a", tail: "untouched", write: null })
  expect(result.message.cancelled).toBe("BROWSER_UNKNOWN")
  expect(result.message.repeat).toBe("BROWSER_AUTHORITY_REQUIRED")
  expect(result.message.stopped).toBe(true)
  expect(result.message.verify.stopped).toBe(true)
  expect(result.requests.filter((value: { url: string }) => value.url === "/program-hold-submit")).toHaveLength(1)
  expect(result.lateRequestsCompleted).toBe(1)
  expect(
    result.requests.filter((value: { url: string }) => ["/program-late-get", "/program-late-post"].includes(value.url)),
  ).toEqual([])
}, 55_000)


// Pure compiler qualification. Neither the v1 data below nor a compiled plan is a Native capability.
test("pure program compiler preserves v1 bytes and validates shared grants without a fabricated Control", () => {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex")
  const source = "return { version: 1, steps: args.steps }"
  const command: Extract<BrowserSchema.Command, { type: "program" }> = { type: "program", tabID: "tab", generation: 3,
    frameID: "frame", observationRevision: 9, source, scriptHash: hash(source), argsJSON: '{"value":"中文"}',
    targets: [{ name: "entry", ref: "opaque-entry" }, { name: "choice", ref: "opaque-choice" },
      { name: "destination", ref: "opaque-destination" }, { name: "submit", ref: "opaque-submit" }] }
  const grants: typeof BrowserSchema.ProgramGrants.Type = [{ scriptHash: command.scriptHash, argsHash: hash(command.argsJSON),
    operations: ["fill", "select", "scroll", "drag", "press", "click"], maxSteps: 6 }]
  const plan = { version: 1, steps: [{ type: "fill", target: "entry", text: "中文" },
    { type: "select", target: "choice", values: ["b"] }, { type: "scroll", target: "entry", deltaX: 0, deltaY: 120 },
    { type: "drag", target: "entry", targetTo: "destination", steps: 2 }, { type: "press", target: "entry", key: "Tab" },
    { type: "click", target: "submit", waitForNavigation: true }] }
  const json = JSON.stringify(plan)
  const fail = (code: BrowserSchema.Error["code"]): never => { throw new Error(code) }
  const compiled = compileManagedBrowserProgramPlan(grants, command, json, fail)
  expect(compiled.inputs.map((value) => value.type)).toEqual(["fill", "select", "scroll", "drag", "press", "click"])
  expect(compiled.inputs.every((value) => value.tabID === "tab" && value.generation === 3 && value.frameID === "frame" && value.observationRevision === 9)).toBe(true)
  expect(compiled.inputs[0]).toMatchObject({ ref: "opaque-entry", text: "中文" })
  expect(compiled.inputs[3]).toMatchObject({ ref: "opaque-entry", targetRef: "opaque-destination", steps: 2 })
  expect(compiled.inputs[5]).toMatchObject({ ref: "opaque-submit", waitForNavigation: true })
  expect(compiled.planHash).toBe(hash(CanonicalJson.stringify(plan)))
  expect(compileManagedBrowserProgramPlan(grants, command, JSON.stringify(plan, null, 2), fail)).toEqual(compiled)
  const control: BrowserSchema.Control = { version: 1, profile: BrowserSchema.INTERACTION_PROFILE, controlID: "v1-control", requestID: "v1-create",
    requestDigest: "a".repeat(64), hostID: "v1-host", hostIncarnation: "v1-incarnation", resourceID: "v1-resource", credentialBinding: "b".repeat(64),
    origin: "http://127.0.0.1:4455", revision: 1, epoch: 1, policyRevision: 1, state: "active", expiresAt: Date.now() + 30_000,
    createdAt: 1, updatedAt: 1, cancel: null, stopConfirmedAt: null, postPaths: [], programGrants: grants,
    scope: { principal: "owner", securityNamespaceID: "namespace", namespaceBindingHash: "c".repeat(64), locationKey: "location", projectScopeKey: "project-scope",
      sessionID: "session", projectID: "project", directory: "/tmp/v1-program-pure-data", workspaceID: null } }
  expect(compileManagedBrowserProgram(control, command, json, fail)).toEqual(compiled)
  const readonly = Schema.decodeUnknownSync(BrowserSchema.Control)({ ...control, profile: BrowserSchema.PROFILE })
  expect(() => compileManagedBrowserProgram(readonly, command, json, fail)).toThrow("BROWSER_SCOPE_DENIED")
  expect(() => compileManagedBrowserProgramPlan(undefined, command, json, fail)).toThrow("BROWSER_SCOPE_DENIED")
  expect(() => compileManagedBrowserProgramPlan(grants, { ...command, source: source + " " }, json, fail)).toThrow("BROWSER_SCOPE_DENIED")
  expect(() => compileManagedBrowserProgramPlan(grants, { ...command, argsJSON: '{ "value":"中文"}' }, json, fail)).toThrow("BROWSER_SCOPE_DENIED")
  expect(() => compileManagedBrowserProgramPlan([{ ...grants[0]!, maxSteps: 5 }], command, json, fail)).toThrow("BROWSER_SCOPE_DENIED")
  expect(() => compileManagedBrowserProgramPlan([{ ...grants[0]!, operations: ["fill", "select", "scroll", "press", "click"] }], command, json, fail))
    .toThrow("BROWSER_SCOPE_DENIED")
  const invalidGrant = [{ ...grants[0]!, unexpected: true }]
  expect(() => compileManagedBrowserProgramPlan(invalidGrant, command, json, fail)).toThrow("BROWSER_SCOPE_DENIED")
  expect(() => compileManagedBrowserProgramPlan(grants, command, JSON.stringify({ ...plan, unexpected: true }), fail)).toThrow("BROWSER_INVALID_RECORD")
  expect(() => compileManagedBrowserProgramPlan(grants, command, JSON.stringify({ version: 1, steps: [{ ...plan.steps[0], selector: "#secret" }] }), fail))
    .toThrow("BROWSER_INVALID_RECORD")
  expect(() => compileManagedBrowserProgramPlan(grants, command, JSON.stringify({ version: 1, steps: [{ ...plan.steps[0], target: "missing" }] }), fail))
    .toThrow("BROWSER_STALE_TARGET")
  expect(() => compileManagedBrowserProgramPlan(grants, command, JSON.stringify({ version: 1, steps: [{ type: "drag", target: "entry", targetTo: "missing" }] }), fail))
    .toThrow("BROWSER_STALE_TARGET")
  expect(() => compileManagedBrowserProgramPlan(grants, command, JSON.stringify({ version: 1, steps: [{ type: "click", target: "submit", waitForNavigation: true }, plan.steps[0]] }), fail))
    .toThrow("BROWSER_INVALID_RECORD")
  expect(() => compileManagedBrowserProgramPlan(grants, command, JSON.stringify({ version: 1, steps: [{ type: "press", target: "entry", key: "Tab", waitForNavigation: true }] }), fail))
    .toThrow("BROWSER_INVALID_RECORD")
  expect(compileManagedBrowserProgramPlan(grants, command, JSON.stringify({ version: 1, steps: [plan.steps[0], { type: "press", target: "entry", key: "Enter", waitForNavigation: true }] }), fail)
    .inputs[1]).toMatchObject({ type: "press", key: "Enter", waitForNavigation: true })
  expect(() => compileManagedBrowserProgramPlan(grants, { ...command, targets: [...command.targets, command.targets[0]!] }, json, fail)).toThrow("BROWSER_INVALID_RECORD")
  expect(() => compileManagedBrowserProgramPlan([{ ...grants[0]!, argsHash: hash("not-json") }], { ...command, argsJSON: "not-json" }, json, fail)).toThrow("BROWSER_INVALID_RECORD")
  expect(() => compileManagedBrowserProgramPlan(grants, command, " ".repeat(BrowserSchema.MAX_SCRIPT_RESULT_BYTES + 1), fail)).toThrow("BROWSER_OUTPUT_LIMIT")
})
