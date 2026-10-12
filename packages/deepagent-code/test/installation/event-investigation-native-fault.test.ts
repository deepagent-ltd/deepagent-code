import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"

const assets = process.env.DAC_EVENT_NATIVE_ASSETS
const replay = process.env.DAC_EVENT_FAULT_ORACLE_REPLAY
const actual = process.platform === "darwin" && process.arch === "arm64" && assets && !replay ? test : test.skip
const guard = 'import {test,expect} from "bun:test"; test("EXPECT_FAILED_NATIVE_FAULT",()=>expect(true).toBe(false));\n'
const marker = "EXPECT_CHANGED_SOURCE_MUST_NEVER_DISCLOSE"
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const census = Schema.Struct({ receipts: rows, work: rows, sessions: rows, inputs: rows,
  counts: rows, dispatches: rows, providers: rows, tools: rows, admissions: Schema.optional(rows) })
const resultSchema = Schema.Struct({ mode: Schema.String, stage: Schema.String, before: census, after: census,
  rule: EventValidationSchema.RuleRecord, runs: Schema.Array(EventValidationSchema.RunRecord),
  receipt: EventInvestigationSchema.Receipt, activeSessions: Schema.Array(Schema.String),
  error: Schema.optional(Schema.String), paused: Schema.optional(EventValidationSchema.RuleRecord),
  cold: Schema.optional(census), successor: Schema.optional(EventValidationSchema.RunRecord),
  coldClassification: Schema.optional(Schema.Literals(["unknown", "unconfirmed_dispatching"])),
  successorAdmission: Schema.optional(Schema.String), replayed: Schema.optional(Schema.Struct({
    receipt: EventValidationSchema.CommandReceipt, replayed: Schema.Boolean })),
  originalManifest: Schema.optional(EventValidationSchema.File), originalRule: Schema.optional(EventValidationSchema.RuleRecord),
  identityObserved: Schema.optional(Schema.Struct({ changed: Schema.Boolean, rule: EventValidationSchema.RuleRecord })),
  ready: Schema.optional(census), readRefusal: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.optional(Schema.String) })),
  physicalIdentity: Schema.optional(Schema.Struct({ before: Schema.Struct({ device: Schema.String, inode: Schema.String }),
    after: Schema.Struct({ device: Schema.String, inode: Schema.String }), sha256: Schema.String, bytes: Schema.Number, sameBytes: Schema.Boolean })),
})
const physicalSchema = Schema.Struct({ received: Schema.Array(Schema.Struct({ mode: Schema.String, path: Schema.String,
  body: Schema.Unknown, authenticated: Schema.Boolean })), ownHTTPSStopped: Schema.Boolean })

;(replay ? test : test.skip)("oracle replay of retained identity cancellation facts makes no build or physical request", async () => {
  if (!replay) throw new Error("An original private actual evidence directory is required")
  const result = Schema.decodeUnknownSync(Schema.fromJsonString(resultSchema))(
    await fs.readFile(path.join(replay, "identity/result.json"), "utf8"))
  const physical = Schema.decodeUnknownSync(Schema.fromJsonString(physicalSchema))(
    await fs.readFile(path.join(replay, "physical-all.json"), "utf8"))
  assertIdentityCancellation(result, await fs.readFile(path.join(replay, "identity/project/guard.test.ts"), "utf8"), physical.received)
  expect(physical.ownHTTPSStopped).toBe(true)
  console.info("EVENT_IDENTITY_ORACLE_REPLAY", replay, "historical facts only; zero new build or request")
})

actual("one signed installation exercises actual pause, changed source and cold custody without successor disclosure", async () => {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/dac-event-investigation-fault-"))
  await fs.writeFile("/tmp/dac-event-investigation-fault-current", directory, { mode: 0o600 })
  const certificate = await EventInvestigationInstallation.certificate(directory)
  const received: { mode: string; path: string; body: unknown; authenticated: boolean }[] = []
  const state = { mode: "", project: "", directory: "", generations: 0, cancelled: 0 }
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(certificate.keyPath), cert: Bun.file(certificate.certificatePath) },
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const body: unknown = await request.json()
      received.push({ mode: state.mode, path: pathname, body,
        authenticated: request.headers.get("authorization") === "Bearer fixture-native-key" })
      if (pathname === "/v1/responses/input_tokens") return Response.json({ object: "response.input_tokens", input_tokens: 41 })
      if (pathname !== "/v1/responses") return new Response("unavailable", { status: 404 })
      state.generations++
      if (state.mode === "pause" || state.mode === "cold") return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(
          'data: {"type":"response.output_text.delta","item_id":"msg_partial","delta":"partial fault stream"}\n\n')) },
        cancel() { state.cancelled++ },
      }), { headers: { "content-type": "text/event-stream" } })
      if (state.mode === "changed" || state.mode === "identity") {
        if (state.mode === "changed") await fs.appendFile(path.join(state.project, "guard.test.ts"), `\n// ${marker}\n`)
        if (state.mode === "identity") {
          const deadline = Date.now() + 10_000
          const manifestReady = path.join(state.directory, "manifest-ready.json")
          while (Date.now() < deadline && !(await Bun.file(manifestReady).exists())) await Bun.sleep(25)
          if (!(await Bun.file(manifestReady).exists())) throw new Error("Actual immutable manifest was not frozen before identity replacement")
          const expected = Schema.decodeUnknownSync(Schema.fromJsonString(EventValidationSchema.File))(
            await fs.readFile(manifestReady, "utf8"))
          const filename = path.join(state.project, "guard.test.ts")
          const before = await fs.stat(filename, { bigint: true })
          const original = await fs.readFile(filename)
          if (expected.identity?.kind !== "posix" || expected.identity.device !== String(before.dev) ||
            expected.identity.inode !== String(before.ino) || expected.sha256 !== createHash("sha256").update(original).digest("hex"))
            throw new Error("Original actual identity differs from the immutable receipt")
          const replacement = path.join(state.project, "identity-replacement.tmp")
          await fs.writeFile(replacement, original, { mode: 0o600 })
          await fs.rename(replacement, filename)
          const after = await fs.stat(filename, { bigint: true })
          if (before.ino === after.ino || !original.equals(await fs.readFile(filename)))
            throw new Error("Actual same-byte new-inode replacement failed")
          await fs.writeFile(path.join(state.directory, "identity-ready.json"), JSON.stringify({
            before: { device: String(before.dev), inode: String(before.ino) },
            after: { device: String(after.dev), inode: String(after.ino) },
            sha256: expected.sha256, bytes: original.byteLength, sameBytes: true }), { mode: 0o600 })
          const observedReady = path.join(state.directory, "observed-ready")
          while (Date.now() < deadline && !(await Bun.file(observedReady).exists())) await Bun.sleep(25)
          if (!(await Bun.file(observedReady).exists())) throw new Error("Actual unchanged observation did not precede the read call")
        }
        const call = { type: "function_call", id: "item_read", call_id: "call_read", name: "read",
          arguments: JSON.stringify({ path: "guard.test.ts", byteOffset: 0, pageBytes: 51200 }) }
        return new Response([
          { type: "response.output_item.added", item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
          { type: "response.output_item.done", item: call },
          { type: "response.completed", response: { id: "resp_read",
            usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } })
      }
      throw new Error("Unexpected fault generation")
    },
  })
  try {
    const installation = await EventInvestigationInstallation.build({ directory, assets: assets!,
      ca: certificate.ca, origin: provider.url.origin,
      debugFixturePath: path.join(import.meta.dir, "fixture/event-investigation-native-fault.ts") })
    const modes = process.env.DAC_EVENT_FAULT_ONLY === "ready-leaf" ? ["ready-leaf"] as const :
      process.env.DAC_EVENT_FAULT_ONLY === "identity" ? ["identity"] as const :
      process.env.DAC_EVENT_FAULT_ONLY === "cold" ? ["cold"] as const : ["pause", "changed", "cold"] as const
    for (const mode of modes) {
      const current = await EventInvestigationInstallation.caseFor({ installation,
        directory: path.join(directory, mode), sourceText: guard })
      state.mode = mode
      state.project = current.project
      state.directory = current.directory
      const initial = received.length
      const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("private fault port reservation") })
      const faultEnv = { DAC_EVENT_NATIVE_RESULT: path.join(current.directory, "result.json"),
        DAC_EVENT_NATIVE_HTTP_PORT: String(reservation.port),
        DAC_EVENT_FAULT_MANIFEST_READY: path.join(current.directory, "manifest-ready.json"),
        DAC_EVENT_FAULT_IDENTITY_READY: path.join(current.directory, "identity-ready.json"),
        DAC_EVENT_FAULT_OBSERVED_READY: path.join(current.directory, "observed-ready") }
      await reservation.stop(true)
      await EventInvestigationInstallation.enroll(current, Date.now() + 600_000)
      if (mode !== "cold") {
        const executed = await current.run("fault", ["debug"], { ...faultEnv, DAC_EVENT_FAULT_MODE: mode })
        expect(executed.code, executed.stderr.slice(-2500)).toBe(0)
      }
      if (mode === "cold") {
        const ready = path.join(current.directory, "cold-ready.json")
        const child = current.spawn(["debug"], { ...faultEnv, DAC_EVENT_FAULT_MODE: "cold-hold", DAC_EVENT_FAULT_READY: ready })
        const stdout = new Response(child.stdout).text()
        const stderr = new Response(child.stderr).text()
        try {
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline && !(await Bun.file(ready).exists())) await Bun.sleep(50)
          expect(await Bun.file(ready).exists()).toBe(true)
          child.kill("SIGKILL")
          expect(await child.exited).not.toBe(0)
        } finally {
          child.kill("SIGKILL")
          await child.exited
          await fs.writeFile(path.join(current.directory, "cold-killed.log"),
            JSON.stringify({ stdout: await stdout, stderr: await stderr, signal: "SIGKILL" }), { mode: 0o600 })
        }
        const resumed = await current.run("cold-check", ["debug"], {
          ...faultEnv, DAC_EVENT_FAULT_MODE: "cold-check", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "0" })
        expect(resumed.code, resumed.stderr.slice(-2500)).toBe(0)
      }
      const result = Schema.decodeUnknownSync(Schema.fromJsonString(resultSchema))(
        await fs.readFile(faultEnv.DAC_EVENT_NATIVE_RESULT, "utf8"))
      expect(result.error).toBeUndefined()
      expect(result.stage).toBe("observed")
      expect(result.activeSessions).toEqual([])
      const physical = received.slice(initial)
      if (mode === "ready-leaf") {
        if (!result.originalRule) throw new Error("The original ready Rule is missing")
        expect(physical).toEqual([])
        expect(result.readRefusal).toEqual({ code: "WORK_FILE_CHANGED", message: "Native read differs from the failed version" })
        expect(result.physicalIdentity?.sameBytes).toBe(true)
        expect(result.physicalIdentity?.before.inode).not.toBe(result.physicalIdentity?.after.inode)
        expect(result.physicalIdentity?.before.inode).toBe(result.receipt.evidence.content.files[0]?.identity?.kind === "posix"
          ? result.receipt.evidence.content.files[0].identity.inode : undefined)
        expect(result.physicalIdentity?.sha256).toBe(createHash("sha256").update(guard).digest("hex"))
        expect(result.physicalIdentity?.bytes).toBe(Buffer.byteLength(guard))
        expect(result.identityObserved?.changed).toBe(false)
        expect(result.identityObserved?.rule).toEqual(result.originalRule)
        expect(result.rule).toEqual(result.originalRule)
        expect(result.ready?.work[0]).toMatchObject({ admission_state: "ready", control_state: "active", control_revision: 1 })
        expect(result.after.work[0]).toMatchObject({ admission_state: "ready", control_state: "revoked", control_revision: 2 })
        for (const key of ["receipts", "work", "sessions", "inputs"] as const) expect(result.after[key]).toHaveLength(1)
        for (const key of ["counts", "dispatches", "providers", "tools"] as const) expect(result.after[key]).toEqual([])
        expect(result.after.admissions).toEqual([])
        expect(result.after.sessions[0]?.execution_claim_token).toBeNull()
        expect(result.after.inputs[0]?.promoted_seq).toBeNull()
        expect(await fs.readFile(path.join(current.project, "guard.test.ts"), "utf8")).toBe(guard)
        await fs.writeFile(path.join(current.directory, "physical.json"), JSON.stringify({ mode, physical,
          tlsVerify: true, globalCAEnvironment: false, componentsHash: installation.componentsHash,
          wrapperRefusal: result.readRefusal }), { mode: 0o600 })
        console.info("EVENT_NATIVE_FAULT_EVIDENCE", mode, current.directory, result.readRefusal?.code)
        continue
      }
      for (const key of ["receipts", "work", "sessions", "inputs", "counts", "dispatches", "providers"] as const)
        expect(result.after[key]).toHaveLength(1)
      expect(result.after.work[0]).toMatchObject({ admission_state: "ready", control_state: "revoked" })
      expect(result.after.counts[0]).toMatchObject({ state: "settled" })
      const dispatch = result.after.dispatches[0]!
      expect(dispatch.reserved_total_tokens).toBe(4137)
      if (typeof dispatch.state !== "string") throw new Error("Actual dispatch state is missing")
      expect(mode === "cold" ? ["dispatching", "unknown"] : ["settled", "unknown"]).toContain(dispatch.state)
      expect(dispatch.charged_tokens).toBe(dispatch.state === "settled" ? 53 : 4137)
      if (mode !== "cold") expect(result.after.providers.map((row) => row.state)).not.toContain("streaming")
      expect(result.receipt.evidence.content.files[0]).toMatchObject({
        relative: "guard.test.ts", sha256: createHash("sha256").update(guard).digest("hex"), bytes: Buffer.byteLength(guard) })
      const original = result.runs.find((run) => run.runID === result.receipt.runID)
      expect(original).toMatchObject({ state: "settled", outcome: "failed", retainedBytes: 0,
        result: { stopConfirmed: true, stdout: { complete: true }, stderr: { complete: true } } })
      expect(original?.releasedAt).not.toBeNull()
      expect(physical.filter((entry) => entry.path === "/v1/responses/input_tokens")).toHaveLength(1)
      expect(physical.filter((entry) => entry.path === "/v1/responses")).toHaveLength(1)
      expect(physical.every((entry) => entry.authenticated)).toBe(true)
      if (mode === "pause") {
        expect(dispatch).toMatchObject({ state: "unknown", charged_tokens: 4137 })
        expect(result.paused).toMatchObject({ state: "paused", investigationAuthority: { epoch: 2, state: "disabled", grant: null } })
        expect(result.rule).toMatchObject({ state: "enabled", investigationAuthority: { epoch: 3, state: "disabled", grant: null } })
        expect(result.replayed).toMatchObject({ replayed: true, receipt: { investigation: { epoch: 1 } } })
        expect(await fs.readFile(path.join(current.project, "guard.test.ts"), "utf8")).toBe(guard)
      }
      if (mode === "changed") {
        expect(await fs.readFile(path.join(current.project, "guard.test.ts"), "utf8")).toContain(marker)
        expect(JSON.stringify(physical)).not.toContain(marker)
        expect(result.after.tools.every((row) => row.known_read_proof === null)).toBe(true)
        expect(result.rule.contentRevision).toBeGreaterThan(result.receipt.contentRevision)
      }
      if (mode === "identity") {
        assertIdentityCancellation(result, await fs.readFile(path.join(current.project, "guard.test.ts"), "utf8"), physical)
      }
      if (mode === "cold") {
        if (!result.cold) throw new Error("Actual cold census is missing")
        expect(dispatch.charged_tokens).toBe(4137)
        expect(result.coldClassification).toBe(dispatch.state === "unknown" ? "unknown" : "unconfirmed_dispatching")
        if (dispatch.state === "unknown") {
          expect(result.after.work[0]?.outcome).toBe("unknown")
          expect(result.after.providers[0]?.state).toBe("indeterminate_after_crash")
        }
        if (dispatch.state === "dispatching") {
          const providerState = result.after.providers[0]?.state
          if (typeof providerState !== "string") throw new Error("Actual cold provider state is missing")
          expect(["streaming", "indeterminate_after_crash"]).toContain(providerState)
        }
        expect(result.before.dispatches).toEqual(result.cold.dispatches)
        expect(result.cold.dispatches).toEqual(result.after.dispatches)
        expect(result.before.counts).toEqual(result.after.counts)
        expect(result.before.receipts).toEqual(result.after.receipts)
        expect(result.successorAdmission).toBe("INVESTIGATION_RECOVERY_REQUIRED")
        expect(result.successor).toMatchObject({ state: "settled", outcome: "failed", resultCurrent: true, retainedBytes: 0 })
        expect(result.successor?.contentRevision).toBeGreaterThan(result.receipt.contentRevision)
        expect(result.successor?.releasedAt).not.toBeNull()
        expect(result.rule.configuration.maxRuns).toBe(2)
        expect(result.rule.investigationAuthority).toMatchObject({ state: "enabled", epoch: 1 })
      }
      await fs.writeFile(path.join(current.directory, "physical.json"), JSON.stringify({ mode, physical,
        tlsVerify: true, globalCAEnvironment: false, componentsHash: installation.componentsHash,
        dispatchClassification: result.coldClassification ?? dispatch.state }), { mode: 0o600 })
      console.info("EVENT_NATIVE_FAULT_EVIDENCE", mode, current.directory, dispatch.state)
    }
  } finally {
    await provider.stop(true)
    await fs.writeFile(path.join(directory, "physical-all.json"), JSON.stringify({ received, state, ownHTTPSStopped: true }), { mode: 0o600 })
  }
}, 420_000)

/** Cancellation leaves the actual admitted read pending for recovery. It never
 * projects a known read failure or a successful read proof from the error code. */
function assertIdentityCancellation(result: typeof resultSchema.Type, sourceText: string,
  physical: typeof physicalSchema.Type["received"]) {
  expect(result.mode).toBe("identity")
  expect(result.error).toBeUndefined()
  expect(result.stage).toBe("observed")
  expect(sourceText).toBe(guard)
  expect(result.originalManifest).toEqual(result.receipt.evidence.content.files[0])
  expect(result.identityObserved?.changed).toBe(false)
  expect(result.identityObserved?.rule.revision).toBe(result.originalRule?.revision)
  expect(result.rule.contentRevision).toBe(result.receipt.contentRevision)
  expect(result.rule.contentHash).toBe(result.receipt.contentHash)
  expect(result.rule.investigationAuthority).toEqual(result.originalRule?.investigationAuthority)
  expect(result.after.admissions).toHaveLength(1)
  expect(result.after.admissions?.[0]).toMatchObject({ tool_name: "read", effect_kind: "read_only" })
  expect(result.after.tools).toEqual([])
  expect(result.after.work).toHaveLength(1)
  expect(result.after.work[0]).toMatchObject({ admission_state: "ready", control_state: "revoked", control_revision: 2 })
  expect(result.activeSessions).toEqual([])
  expect(result.after.providers).toHaveLength(1)
  expect(result.after.providers[0]).toMatchObject({ state: "settled", error_code: null })
  expect(result.after.dispatches).toEqual([{ state: "settled", reserved_total_tokens: 4137, charged_tokens: 53 }])
  expect(physical.filter((entry) => entry.path === "/v1/responses/input_tokens")).toHaveLength(1)
  expect(physical.filter((entry) => entry.path === "/v1/responses")).toHaveLength(1)
  expect(physical.every((entry) => entry.authenticated)).toBe(true)
}
