import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { storageUsage } from "../../../core/test/fixture/work-storage-cleanup"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"

const actual = process.platform === "darwin" && process.arch === "arm64" && process.env.DAC_WORK_STORAGE_CLEANUP_ACTUAL === "1"
  ? test : test.skip
const cleanupAsset = process.env.DAC_WORK_STORAGE_CLEANUP_ASSET
const assets = "/var/folders/cs/___vcxjx2cq69pr_mqhzl_fm0000gn/T/dac-event-validation-ui-e5_dupyf/live/install"

actual("explicit signed cleanup retires known write and command storage after a real crash, with durable checkpoint and atomic meters", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-work-storage-cleanup-production-"))
  await fs.writeFile("/tmp/dac-work-storage-cleanup-production-current", root, { mode: 0o600 })
  const reused = process.env.DAC_WORK_STORAGE_CLEANUP_REUSE
  const origins = reused ? [...new Set((await fs.readFile(path.join(reused, "overlays/packages__core__src__session__work-route-policy.ts.after"), "utf8")).match(/https:\/\/127\.0\.0\.1:\d+/g))] : []
  assert(!reused || origins.length === 1, "The original signed loopback origin must be unique")
  const certificate = reused ? { ca: await fs.readFile(path.join(reused, "ca.pem"), "utf8"),
    keyPath: path.join(reused, "ca-key.pem"), certificatePath: path.join(reused, "ca.pem") }
    : await EventInvestigationInstallation.certificate(root)
  const scenario = { tool: "write", generations: 0 }
  const requests: { tool: string; path: string; authenticated: boolean; body: unknown }[] = []
  const results: Record<string, unknown>[] = []
  const child: { value?: ReturnType<EventInvestigationInstallation.NativeCase["spawn"]> } = {}
  const provider = Bun.serve({ hostname: "127.0.0.1", port: reused ? Number(new URL(origins[0]!).port) : 0,
    tls: { key: Bun.file(certificate.keyPath), cert: Bun.file(certificate.certificatePath) },
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const body: unknown = await request.json()
      requests.push({ tool: scenario.tool, path: pathname, body,
        authenticated: request.headers.get("authorization") === "Bearer fixture-native-key" })
      if (pathname === "/v1/responses/input_tokens") return Response.json({ object: "response.input_tokens", input_tokens: 41 })
      if (pathname !== "/v1/responses") return new Response("unavailable", { status: 404 })
      scenario.generations++
      if (scenario.generations === 1) {
        const call = { type: "function_call", id: "item_known_effect", call_id: "call_known_effect", name: scenario.tool,
          arguments: JSON.stringify(scenario.tool === "write"
            ? { path: "created.txt", content: "Original Native write survived the crash.\n" }
            : { commandID: "build", parameters: [] }) }
        return new Response([
          { type: "response.output_item.added", item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
          { type: "response.output_item.done", item: call },
          { type: "response.completed", response: { id: "response_known_effect",
            usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      }
      assert.equal(scenario.generations, 2, "Cleanup caused an unexpected provider dispatch")
      return new Response('data: {"type":"response.output_text.delta","item_id":"msg_known_resume","delta":"Original known effect is preserved; explicit continuation completed."}\n\n' +
        'data: {"type":"response.completed","response":{"id":"response_known_resume","usage":{"input_tokens":41,"output_tokens":12,"total_tokens":53}}}\n\n',
        { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    assert(cleanupAsset, "The independent Root-built cleanup asset is required")
    expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(assets, "deepagent-work-file-helper"))))
      .toBe("9d141352a9fa0e86635b248d1ffd9f3a00548adba879c9847a3c8ef5a01ccde0")
    expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(assets, "bun-command-runtime"))))
      .toBe("b36d2e9d9bd50e3a3b6a8f2d481839417d6600d4c1753411b094ee0da3222cef")
    const signed = reused ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
      payload: NativeInstallationSchema.Payload, signature: Schema.String,
    })))(await fs.readFile(path.join(reused, "install/deepagent-code") + NativeInstallationSchema.SIDECAR_SUFFIX, "utf8")) : undefined
    if (signed) expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(reused!, "install/deepagent-code"))))
      .toBe(signed.payload.executable.sha256)
    const installation = reused && signed ? { directory: reused, install: path.join(reused, "install"),
      executable: path.join(reused, "install/deepagent-code"), origin: provider.url.origin, componentsHash: signed.payload.componentsHash }
      : await EventInvestigationInstallation.build({ directory: root, assets, ca: certificate.ca,
        origin: provider.url.origin, storageCleanupAsset: cleanupAsset, debugFixturePath: path.join(import.meta.dir, "fixture/work-production-cli.ts") })
    await fs.writeFile(path.join(root, "candidate.json"), JSON.stringify({ original: installation.directory,
      origin: installation.origin, executableHash: EventInvestigationInstallation.hash(await fs.readFile(installation.executable)),
      componentsHash: installation.componentsHash, sourceCohort: path.join(installation.directory, "source-cohort.json") }), { mode: 0o600 })
    for (const mode of [{ tool: "write", cold: true }, { tool: "managed_command", cold: true }, { tool: "write", cold: false }]) {
      const tool = mode.tool
      scenario.tool = tool
      scenario.generations = 0
      const candidate = await EventInvestigationInstallation.caseFor({ installation, directory: path.join(root, mode.cold ? tool : "warm-write"),
        sourceText: "export const originalGuard = true;\n" })
      await fs.writeFile(path.join(candidate.project, "approved.txt"), "Original approved input.\n")
      await fs.writeFile(path.join(candidate.project, "input.ts"), "export const answer: number = 42;\n")
      await fs.writeFile(candidate.policy, JSON.stringify({ version: tool === "write" ? 3 : 4, targets: [{
        id: "review", directory: candidate.project, agentID: "auto", providerID: "openai", modelID: "gpt-4.1-2025-04-14",
        budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxChildren: 0, maxTotalTokens: 20000,
          maxDurationMs: 120000, maxProviderDispatches: 2, maxToolCalls: 1 },
        project: { tools: [tool], fileScope: {
          read: [{ kind: "file", path: tool === "write" ? "approved.txt" : "input.ts" }],
          write: tool === "write" ? [{ kind: "file", path: "created.txt" }] : [], deny: [],
          maxReadBytes: 65536, maxPageBytes: 51200, maxHashBytes: 16777216,
          maxWriteBytes: tool === "write" ? 51200 : 0, symlinks: "deny",
        }, ...(tool === "managed_command" ? { commandRecipes: [{
          schemaVersion: "work-command-recipe.v1", logicalID: "build", revision: 1, executable: "installed-bun-v1",
          argv: ["build", "input.ts", "--outfile", "output.js", "--target", "bun"].map((value) => ({ kind: "literal", value })),
          parameters: [], cwd: null, inputs: ["input.ts"], outputs: ["output.js"], environment: [{ name: "CI", value: "1" }],
          workspace: "private_explicit_files.v1", sandbox: { id: "darwin-single-process-workspace-v1", revision: 1,
            network: "deny", processes: 1, openFiles: 64, maxInputFiles: 256, maxInputFileBytes: 16777216,
            maxInputBytes: 67108864, maxDepth: 16, maxOutputFiles: 32, maxOutputFileBytes: 1048576, maxOutputBytes: 33554432 },
          timeoutMs: 10000, stdoutBytes: 65536, stderrBytes: 65536,
        }] } : {}) },
      }] }), { mode: 0o600 })
      const extra = { DAC_WORK_PROJECT: "1", DAC_WORK_WRITE_CASE: tool === "write" ? "project-write-create" : undefined,
        DAC_WORK_COMMAND_CASE: tool === "managed_command" ? "1" : undefined }
      const run = async (name: string, args: string[]) => {
        const result = await candidate.run(name, args, { ...extra, DAC_WORK_PRODUCTION_RESULT: path.join(candidate.directory, `${name}.json`) })
        assert.equal(result.code, 0, `${tool}/${name}: ${result.stderr.slice(-2500)} ${result.stdout.slice(-1500)}`)
        return result
      }
      await run("enroll", ["operator", "enroll", "--request-id", "known-effect-enroll", "--policy", candidate.policy])
      await run("approve", ["operator", "approve-route", "--request-id", "known-effect-route", "--target", "review",
        "--snapshot", "gpt-4.1-2025-04-14", "--expected-revision", "1", "--expected-route-revision", "0",
        "--expires-at", String(Date.now() + 3600000)])
      const start = requests.length
      if (!mode.cold) {
        await run("normal-warm", ["debug","project"])
        const warm = snapshot(candidate.dbPath)
        expect(warm.outcome).toBe("succeeded")
        expect(warm.custody.releasedAt).toBeGreaterThan(0)
        expect(warm.meter).toMatchObject({ custody_count: 0,retained_bytes: 0,audit_count: 1 })
        expect(warm.cleanup).toMatchObject({ phase: "retained",journal: null,revision: 1 })
        const observed = await storageUsage(candidate.dbPath,warm.cleanup.manifest.instanceID)
        expect(observed).toEqual({ records: 1,active: 0,bytes: Buffer.byteLength(JSON.stringify(warm.cleanup.manifest)) })
        expect(scenario.generations).toBe(2)
        results.push({ tool,mode:"normal-warm",directory:candidate.directory,warm,observed })
        await fs.writeFile(path.join(root,"results.json"),JSON.stringify(results,null,2),{ mode: 0o600 })
        continue
      }
      child.value = candidate.spawn(["debug", "project-cold-known"], { ...extra,
        DAC_WORK_PRODUCTION_RESULT: path.join(candidate.directory, "original.json") })
      const stdout = new Response(child.value.stdout).text()
      const stderr = new Response(child.value.stderr).text()
      const marker = path.join(candidate.project, "known-read-committed")
      const deadline = Date.now() + 20000
      while (!(await Bun.file(marker).exists())) {
        if (child.value.exitCode !== null || Date.now() >= deadline) break
        await Bun.sleep(10)
      }
      const committed = await Bun.file(marker).exists()
      child.value.kill("SIGKILL")
      const killed = await child.value.exited
      await fs.writeFile(path.join(candidate.directory, "original.log"), (await stdout) + (await stderr), { mode: 0o600 })
      expect({ committed, killed, root, tool }).toMatchObject({ committed: true, killed: 137 })
      const before = snapshot(candidate.dbPath)
      expect(before.tools).toHaveLength(1)
      expect(before.tools[0]).toMatchObject({ tool_name: tool, state: "settled", error_code: null })
      expect(before.tools[0].proofHash).toBeTruthy()
      expect(before.reservations.map((item) => item.charged_tokens)).toEqual([53])
      expect(before.providers.map((item) => item.state)).toEqual(["settled"])
      expect(before.claim).toBeGreaterThan(0)
      expect(before.recoveries).toBe(0)
      expect(scenario.generations).toBe(1)
      await run("ordinary-cold", ["debug", "cold"])
      const ordinary = await Bun.file(path.join(candidate.directory, "ordinary-cold.json")).json()
      expect(["WORK_RECOVERY_REQUIRED", "SessionRunner.ExecutionRecoveryRequiredError"]).toContain(ordinary.executionCode)
      expect(snapshot(candidate.dbPath)).toEqual(before)
      expect(requests.length).toBe(start + 2)
      // Wait the real lease without rewriting owner/claim/terminal rows.
      while (Date.now() <= before.leaseExpiry) await Bun.sleep(Math.min(500, before.leaseExpiry - Date.now() + 1))
      const recoverArgs = ["im", "work", "recover-known", before.workID, "--session-id", before.sessionID,
        "--request-id", "known-effect-recovery", "--expected-claim-token", String(before.claim), "--expected-control-revision", "1"]
      const recovered = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
        receipt: Schema.Struct({ recoveryID: Schema.String, replayed: Schema.Boolean }), execution: Schema.String,
      })))( (await run("recover-only", recoverArgs)).stdout.trim())
      expect(recovered.execution).toBe("not_started")
      expect(recovered.receipt.replayed).toBe(false)
      const recoverOnly = snapshot(candidate.dbPath)
      const pendingClose = await candidate.run("cleanup-still-pending", ["im","work","cleanup-known",recovered.receipt.recoveryID,
        "--admission-id",recoverOnly.custody.admissionID,"--request-id","explicit-known-retirement",
        "--expected-custody-revision",String(recoverOnly.custody.revision)], extra)
      expect(pendingClose.code).not.toBe(0)
      expect(snapshot(candidate.dbPath)).toEqual(recoverOnly)
      expect(requests.length).toBe(start+2)
      const resumed = await run("explicit-original-resume", ["im","work","resume-recovered",recovered.receipt.recoveryID,
        "--request-id","original-explicit-finish","--expected-control-revision","1"])
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ execution: Schema.String })),
        { onExcessProperty: "ignore" })(resumed.stdout.trim()).execution).toBe("drained")
      const recovery = snapshot(candidate.dbPath)
      expect(recovery.outcome).toBe("succeeded")
      expect(recovery.tools).toEqual(before.tools)
      expect(recovery.claim).toBeNull()
      expect(recovery.recoveries).toBe(1)
      expect(recovery.cleanup.phase).toBe("retained")
      expect(recovery.cleanup.manifest.captureKind).toBe("native_live")
      expect(recovery.cleanup.manifest.files).toHaveLength(tool === "write" ? 1 : 2)
      const fixed = ["im", "work", "cleanup-known", recovered.receipt.recoveryID,
        "--admission-id", recovery.custody.admissionID, "--request-id", "explicit-known-retirement",
        "--expected-custody-revision", String(recovery.custody.revision)]
      const stale = await candidate.run("cleanup-stale", [...fixed.slice(0,-1), String(recovery.custody.revision+1)], extra)
      expect(stale.code).not.toBe(0)
      expect(snapshot(candidate.dbPath)).toEqual(recovery)
      const denied = await candidate.run("cleanup-foreign-credential", fixed,
        { ...extra, DEEPAGENT_CODE_SERVER_PASSWORD: "different-private-test-credential" })
      expect(denied.code).not.toBe(0)
      expect(snapshot(candidate.dbPath)).toEqual(recovery)
      const storage = path.join(recovery.cleanup.manifest.data,
        tool === "write" ? "work-write-stage" : "work-command-stage", recovery.cleanup.manifest.basename)
      if (tool === "managed_command") {
        await fs.writeFile(path.join(storage,"foreign-preserve.txt"), "foreign preserved", { mode: 0o600 })
        const refused = await candidate.run("cleanup-foreign-file", fixed, extra)
        expect(refused.code).not.toBe(0)
        const retained = snapshot(candidate.dbPath)
        expect(retained.cleanup.phase).toBe("cleanup_recovery")
        expect(retained.custody).toEqual(recovery.custody)
        expect(retained.meter).toEqual(recovery.meter)
        expect(retained.tools).toEqual(before.tools)
        const quarantine = path.join(recovery.cleanup.manifest.data, "work-command-stage", retained.cleanup.journal!.quarantine)
        expect(await fs.readFile(path.join(quarantine,"foreign-preserve.txt"),"utf8")).toBe("foreign preserved")
        await fs.unlink(path.join(quarantine,"foreign-preserve.txt"))
      }
      // This fault aborts only the final accounting transaction after the Native empty
      // checkpoint. It never writes claims, execution terminal state or proof grants.
      using writer = new Database(candidate.dbPath)
      writer.exec("CREATE TRIGGER cleanup_test_abort BEFORE UPDATE OF phase ON work_storage_cleanup WHEN new.phase='released' BEGIN SELECT RAISE(ABORT,'private cleanup accounting fault'); END")
      const interrupted = await candidate.run("cleanup-accounting-fault", fixed, extra)
      expect(interrupted.code).not.toBe(0)
      const pending = snapshot(candidate.dbPath)
      expect(["cleanup_pending","cleanup_recovery"]).toContain(pending.cleanup.phase)
      expect(pending.custody).toEqual(recovery.custody)
      expect(pending.meter).toEqual(recovery.meter)
      expect(pending.tools).toEqual(before.tools)
      expect(await fs.lstat(storage).catch(() => null)).toBeNull()
      const quarantine = path.join(recovery.cleanup.manifest.data,
        tool === "write" ? "work-write-stage" : "work-command-stage", pending.cleanup.journal!.quarantine)
      expect(await fs.lstat(quarantine).catch(() => null)).toBeNull()
      writer.exec("DROP TRIGGER cleanup_test_abort")
      const cleared = Schema.decodeUnknownSync(Schema.fromJsonString(WorkStorageCleanupSchema.Receipt))(
        (await run("cleanup-exact-after-sql-fault", fixed)).stdout.trim())
      expect(cleared.phase).toBe("released")
      expect(cleared.replayed).toBe(true)
      const final = snapshot(candidate.dbPath)
      expect(final.custody.releasedAt).toBeGreaterThan(0)
      expect(final.custody.reservedBytes).toBe(0)
      expect(final.custody.observedRetainedBytes).toBe(0)
      expect(final.meter).toMatchObject({ custody_count: recovery.meter.custody_count-1,
        audit_count: recovery.meter.audit_count,
        retained_bytes: recovery.meter.retained_bytes-Math.max(recovery.custody.reservedBytes,recovery.custody.observedRetainedBytes) })
      expect(final.tools).toEqual(before.tools)
      expect(final.providers).toEqual(recovery.providers)
      expect(final.reservations).toEqual(recovery.reservations)
      expect(final.counts).toEqual(recovery.counts)
      expect(final.inputs).toEqual(recovery.inputs)
      expect(final.outcome).toBe(recovery.outcome)
      expect(final.claim).toBeNull()
      expect(final.resumes).toBe(1)
      const exact = Schema.decodeUnknownSync(Schema.fromJsonString(WorkStorageCleanupSchema.Receipt))(
        (await run("cleanup-released-exact", fixed)).stdout.trim())
      expect(exact).toEqual({ ...cleared, replayed: true })
      expect(snapshot(candidate.dbPath)).toEqual(final)
      await run("cleanup-ordinary-cold", ["debug", "cold"])
      expect(snapshot(candidate.dbPath)).toEqual(final)
      expect(requests.length).toBe(start+4)
      expect(scenario.generations).toBe(2)
      if (tool === "write") expect(await fs.readFile(path.join(candidate.project,"created.txt"),"utf8"))
        .toBe("Original Native write survived the crash.\n")
      results.push({ tool, directory: candidate.directory, before, recovery, final,
        requests: requests.slice(start).map((item) => ({ path: item.path, authenticated: item.authenticated })),
        originalToolExecutions: before.tools.length, coldExtraProviderRequests: 0, explicitTerminalContinuationProviderRequests: 1, cleanupExtraProviderRequests: 0 })
      await fs.writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 })
    }
    expect(requests.every((item) => item.authenticated)).toBe(true)
    expect(results).toHaveLength(3)
  } finally {
    if (child.value && child.value.exitCode === null) { child.value.kill("SIGKILL"); await child.value.exited }
    await fs.writeFile(path.join(root, "provider-ledger.json"), JSON.stringify(requests, null, 2), { mode: 0o600 })
    await fs.writeFile(path.join(root, "cleanup.json"), JSON.stringify({ ownChildExited: !child.value || child.value.signalCode!==null || child.value.exitCode !== null,
      providerStopped: true, ownChildExitObserved: !child.value || child.value.signalCode!==null || child.value.exitCode!==null }), { mode: 0o600 })
    provider.stop(true)
    console.info("STORAGE_CLEANUP_PRODUCTION_ARTIFACTS", root)
  }
}, 240000)

/** These are read-only observations. Cleanup mutations only pass through the original authenticated CLI; this is a read-only observation. */
function snapshot(filename: string) {
  using db = new Database(filename, { readonly: true })
  const work = db.query<{ work_id: string; session_id: string; outcome: string }, []>(
    "SELECT work_id,session_id,outcome FROM work_execution",
  ).get()!
  const tools = db.query<{ effect_id: string; tool_name: string; state: string; error_code: string | null; proof: string | null; outcome_hash: string }, []>(
    "SELECT effect_id,tool_name,state,error_code,outcome_hash,coalesce(known_write_proof,known_command_proof) proof FROM session_v2_tool_effect ORDER BY effect_id",
  ).all().map((item) => ({ effect_id: item.effect_id, tool_name: item.tool_name, state: item.state,
    error_code: item.error_code, outcome_hash: item.outcome_hash,
    proofHash: item.proof ? EventInvestigationInstallation.hash(item.proof) : null }))
  const cleanupRow = db.query<{ manifest: string; journal: string|null; phase: string; revision: number }, []>(
    "SELECT manifest,journal,phase,revision FROM work_storage_cleanup").get()!
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(WorkStorageCleanupSchema.Manifest))(cleanupRow.manifest)
  const journal = cleanupRow.journal === null ? null : Schema.decodeUnknownSync(Schema.fromJsonString(WorkStorageCleanupSchema.Journal))(cleanupRow.journal)
  const command = tools[0]?.tool_name === "managed_command"
  const custodyRow = db.query<{ record: string }, []>(`SELECT record FROM ${command ? "work_command_intent" : "work_write_stage"}`).get()!
  const custody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ admissionID: Schema.String, revision: Schema.Int,
    reservedBytes: Schema.Int, observedRetainedBytes: Schema.Int, releasedAt: Schema.NullOr(Schema.Int) })), { onExcessProperty: "ignore" })(custodyRow.record)
  const meter = db.query<{ custody_count: number; audit_count: number; retained_bytes: number; revision: number }, []>(
    `SELECT custody_count,audit_count,retained_bytes,revision FROM ${command ? "work_command_meter" : "work_write_stage_meter"}`).get()!
  return { cleanup: { ...cleanupRow, manifest, journal }, custody, meter, workID: work.work_id, sessionID: work.session_id, outcome: work.outcome, tools,
    providers: db.query<{ receipt_id: string; state: string; outcome_hash: string; wire_request_hash: string }, []>(
      "SELECT receipt_id,state,outcome_hash,wire_request_hash FROM session_v2_provider_turn_receipt ORDER BY provider_turn_seq",
    ).all(),
    reservations: db.query<{ reservation_id: string; state: string; charged_tokens: number }, []>(
      "SELECT reservation_id,state,charged_tokens FROM work_dispatch_reservation ORDER BY created_at,reservation_id",
    ).all(),
    counts: db.query<{ acquisition_id: string; state: string; revision: number }, []>(
      "SELECT acquisition_id,state,revision FROM work_count_acquisition ORDER BY created_at,acquisition_id",
    ).all(),
    inputs: db.query<{ id: string; promoted_seq: number | null }, []>("SELECT id,promoted_seq FROM session_input ORDER BY admitted_seq").all(),
    claim: db.query<{ token: number | null }, [string]>("SELECT execution_claim_token token FROM session WHERE id=?").get(work.session_id)!.token,
    leaseExpiry: db.query<{ expiry: number }, []>("SELECT coalesce(max(lease_expires_at),0) expiry FROM session_provider_owner_lease WHERE released_at IS NULL").get()!.expiry,
    recoveries: db.query<{ n: number }, []>("SELECT count(*) n FROM work_known_recovery").get()!.n,
    resumes: db.query<{ n: number }, []>("SELECT count(*) n FROM work_known_recovery_resume").get()!.n,
  }
}
