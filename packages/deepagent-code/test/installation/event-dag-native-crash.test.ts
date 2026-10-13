import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { WorkCountAcquisitionSchema } from "@deepagent-code/core/session/work-count-acquisition.schema"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"
import { EventDagNativeFixture } from "./fixture/event-dag-native-fixture"

const actual = process.platform === "darwin" && process.arch === "arm64" && process.env.DAC_EVENT_DAG_CRASH_ACTUAL === "1"
const state: { root?: string; installation?: EventInvestigationInstallation.SignedInstallation;
  provider?: ReturnType<typeof EventDagNativeFixture.provider>; results: unknown[] } = { results: [] }

beforeAll(async () => {
  if (!actual) return
  const assets = process.env.DAC_NATIVE_FAULT_ASSETS
  if (!assets) throw new Error("Actual native fault tests require the owned Native assets directory")
  state.root = process.env.DAC_EVENT_DAG_CRASH_OUTPUT ?? await fs.mkdtemp("/tmp/dac-current-dag-crash-")
  await fs.mkdir(state.root, { recursive: true, mode: 0o700 })
  const certificate = await EventInvestigationInstallation.certificate(state.root)
  state.provider = EventDagNativeFixture.provider(certificate)
  state.installation = await EventInvestigationInstallation.build({ directory: state.root, assets,
    storageCleanupAsset: path.join(assets, "deepagent-work-storage-cleanup"), ca: certificate.ca,
    origin: state.provider.server.url.origin, debugFixturePath: path.join(import.meta.dir, "fixture/event-dag-native-crash.ts") })
}, 180_000)

afterAll(async () => {
  if (!actual || !state.root) return
  state.provider?.server.stop(true)
  await fs.writeFile(path.join(state.root, "results.json"), JSON.stringify({ results: state.results,
    providerRequests: state.provider?.requests.map((request) => ({ pathname: request.pathname,
      authenticated: request.authenticated, node: request.node, tool: request.tool })),
    scope: "actual signed Native gate + public current Event source + settled effect crash + cold/recovery denial",
    sourceRowForgery: false, availabilityOverride: false, verifierOverride: false, realModelCalls: 0 }), { mode: 0o600 })
})

test.skipIf(!actual).each(["write", "managed_command"] as const)(
  "current DAG %s settled effect survives SIGKILL without cold replay or an unsupported recovery grant", async (tool) => {
    if (!state.root || !state.installation || !state.provider) throw new Error("Actual signed fixture setup is unavailable")
    state.provider.select(tool)
    const start = state.provider.requests.length
    const prepared = await EventDagNativeFixture.prepare({ installation: state.installation,
      directory: path.join(state.root, tool), tool })
    expect(state.provider.requests.length).toBe(start)
    const checkpointPath = path.join(prepared.candidate.directory, "settled-native-effect.json")
    const original = await prepared.spawn("original", { ...prepared.runInput, checkpointPath })
    const stdout = new Response(original.child.stdout).text()
    const stderr = new Response(original.child.stderr).text()
    try {
      const deadline = Date.now() + 60_000
      while (!(await Bun.file(checkpointPath).exists()) && original.child.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
      const committed = await Bun.file(checkpointPath).exists()
      original.child.kill("SIGKILL")
      const exit = await original.child.exited
      const log = { stdout: await stdout, stderr: await stderr, exit, committed }
      await fs.writeFile(path.join(prepared.candidate.directory, "original.process.json"), JSON.stringify(log), { mode: 0o600 })
      expect({ committed, exit }, JSON.stringify(log)).toEqual({ committed: true, exit: 137 })
      const checkpoint = await Bun.file(checkpointPath).json() as { workID: string; sessionID: string;
        tool: string; state: string; claim: number; controlRevision: number; stage: string }
      expect(checkpoint).toMatchObject({ tool, state: "settled", stage: "original-native-effect-committed" })
      expect(checkpoint.claim).toBeGreaterThan(0)
      const before = prepared.snapshot()
      const effect = before.effects[0] as Record<string, unknown>
      expect(before.effects).toHaveLength(1)
      expect(effect).toMatchObject({ session_id: checkpoint.sessionID, tool_name: tool, state: "settled", error_code: null })
      expect(effect[tool === "write" ? "known_write_proof" : "known_command_proof"]).toBeTruthy()
      expect(before.providerCount).toBe(2)
      expect(before.counts).toHaveLength(1)
      expect(before.reservations).toHaveLength(1)
      const count = Schema.decodeUnknownSync(Schema.fromJsonString(WorkCountAcquisitionSchema.ProjectRecord))(
        (before.counts[0] as { record: string }).record)
      expect(count.binding).toMatchObject({ counterSemantics: "vendor_context_input_upper_bound",
        inputUpperBoundTokens: 1_048_576, inputProjectionVersion: "deepseek-responses-project-context-bound.v1" })
      expect(before.reservations[0]).toMatchObject({ state: "settled", charged_tokens: 53 })
      expect(before.work).toHaveLength(2)
      expect(before.nodes).toHaveLength(1)
      const placement = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
        placement: Schema.Struct({ workspace: Schema.Struct({ directory: Schema.String }) }),
      })), { onExcessProperty: "ignore" })((before.nodes[0] as { record: string }).record).placement
      if (tool === "write") expect(await fs.readFile(path.join(placement.workspace.directory, "created.txt"), "utf8"))
        .toBe("Native current DAG committed bytes.\n")
      if (tool === "managed_command") {
        expect(before.commands).toHaveLength(1)
        const command = Schema.decodeUnknownSync(Schema.fromJsonString(WorkCommandSchema.Record))(
          (before.commands[0] as { record: string }).record)
        expect(command).toMatchObject({ workID: checkpoint.workID, state: "settled", outcome: "exited",
          exitCode: 0, stopConfirmed: true })
        expect(command.outputs).toHaveLength(1)
        expect(command.outputs[0].relative).toBe("output.js")
        expect(command.outputs[0].bytes).toBeGreaterThan(0)
      }
      expect(await Bun.file(path.join(prepared.candidate.project, tool === "write" ? "created.txt" : "output.js")).exists()).toBe(false)
      expect(before.recoveries).toEqual([])
      expect(before.resumes).toEqual([])
      expect(before.taskRecoveries).toEqual([])
      expect(before.taskResumes).toEqual([])
      expect(state.provider.requests.slice(start).map((request) => ({ pathname: request.pathname, node: request.node,
        authenticated: request.authenticated }))).toEqual([
        { pathname: "/responses", node: false, authenticated: true },
        { pathname: "/responses", node: true, authenticated: true },
      ])
      const cold = await prepared.run("cold", { mode: "cold", ruleID: prepared.ruleID, expectedProviderCount: before.providerCount })
      expect(cold.code, `${JSON.stringify(cold.output)} ${cold.stderr.slice(-2500)}`).toBe(0)
      const afterCold = prepared.snapshot()
      for (const key of ["providers", "attempts", "effects", "admissions", "counts", "reservations", "inputs", "claims",
        "commands", "writes", "recoveries", "resumes", "taskRecoveries", "taskResumes", "work", "controller", "nodes", "workspace"] as const)
        expect(afterCold[key], `Cold replay changed original ${key}`).toEqual(before[key])
      expect(state.provider.requests.length).toBe(start + 2)
      const recovered = await prepared.run("recover-denied", { mode: "recover", request: {
        workID: checkpoint.workID, sessionID: checkpoint.sessionID, requestID: "current-dag-known-recovery-refusal",
        expectedClaimToken: checkpoint.claim, expectedControlRevision: checkpoint.controlRevision, action: "recover_only" } })
      expect(recovered.code, `${JSON.stringify(recovered.output)} ${recovered.stderr.slice(-2500)}`).toBe(0)
      expect(recovered.output).toMatchObject({ mode: "recover", accepted: false })
      const refusal = recovered.output as { failure: { code?: string } }
      if (!refusal.failure.code) throw new Error("Actual Native recovery refusal has no classified code")
      expect(["RECOVERY_EVIDENCE_UNKNOWN", "RECOVERY_UNAVAILABLE", "RECOVERY_CONFLICT"]).toContain(refusal.failure.code)
      const afterRecovery = prepared.snapshot()
      for (const key of ["providers", "attempts", "effects", "admissions", "counts", "reservations", "inputs", "claims",
        "commands", "writes", "recoveries", "resumes", "taskRecoveries", "taskResumes", "work", "controller", "nodes", "workspace"] as const)
        expect(afterRecovery[key], `Unsupported recovery changed original ${key}`).toEqual(afterCold[key])
      expect(state.provider.requests.length).toBe(start + 2)
      state.results.push({ tool, directory: prepared.candidate.directory, checkpoint,
        publicCurrentSource: true, originalNativeProductGate: true, settledEffects: before.effects.length,
        processExit: exit, before, afterCold, afterRecovery, recoveryRefusal: recovered.output,
        coldExtraRequests: 0, recoveryExtraRequests: 0, originalSettledEffectRepeats: 0 })
      await fs.writeFile(path.join(state.root, "results.current.json"), JSON.stringify(state.results), { mode: 0o600 })
    } finally {
      if (original.child.exitCode === null) { original.child.kill("SIGKILL"); await original.child.exited }
    }
  }, 120_000,
)
