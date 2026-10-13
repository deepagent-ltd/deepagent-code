import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"

const assets = process.env.DAC_EVENT_NATIVE_ASSETS
const actual = process.platform === "darwin" && process.arch === "arm64" && assets ? test : test.skip

actual(
  "signed Root consumes its current investigation result and reads reports without executing again",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-event-investigation-result-current-"))
    await fs.writeFile("/tmp/dac-event-investigation-result-current-current", root, { mode: 0o600 })
    const project = path.join(root, "case/project")
    const certificate = await EventInvestigationInstallation.certificate(root)
    const received: { path: string; body: unknown; authenticated: boolean }[] = []
    const state = { generations: 0, readReached: false }
    const guard =
      'import {test,expect} from "bun:test"; test("EXPECT_FAILED_ORIGINAL_NATIVE_SOURCE",()=>expect(true).toBe(false));\n'
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(certificate.keyPath), cert: Bun.file(certificate.certificatePath) },
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        const body: unknown = await request.json()
        received.push({
          path: pathname,
          body,
          authenticated: request.headers.get("authorization") === "Bearer fixture-native-key",
        })
        if (pathname === "/v1/responses/input_tokens")
          return Response.json({ object: "response.input_tokens", input_tokens: 41 })
        if (pathname !== "/v1/responses") return new Response("unavailable", { status: 404 })
        state.generations++
        if (state.generations === 1) {
          const call = {
            type: "function_call",
            id: "item_read",
            call_id: "call_read",
            name: "read",
            arguments: JSON.stringify({ path: "guard.test.ts", byteOffset: 0, pageBytes: 51200 }),
          }
          return new Response(
            [
              { type: "response.output_item.added", item: { ...call, arguments: "" } },
              { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
              { type: "response.output_item.done", item: call },
              {
                type: "response.completed",
                response: { id: "resp_read", usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        const input =
          typeof body === "object" && body !== null && "input" in body && Array.isArray(body.input) ? body.input : []
        state.readReached = input.some(
          (item: unknown) =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "function_call_output" &&
            "call_id" in item &&
            item.call_id === "call_read" &&
            "output" in item &&
            typeof item.output === "string" &&
            item.output.includes("EXPECT_FAILED_ORIGINAL_NATIVE_SOURCE"),
        )
        await fs.writeFile(path.join(root, "read-ready"), "actual second generation reached", { mode: 0o600 })
        // The existing internal verifier only authenticates still-pending Work. Hold
        // this private response until the same Root captures its real read view.
        const deadline = Date.now() + 10000
        while (!(await Bun.file(path.join(root, "read-verified")).exists())) {
          if (Date.now() >= deadline) return new Response("actual proof verification was unavailable", { status: 503 })
          await Bun.sleep(10)
        }
        return new Response(
          'data: {"type":"response.output_text.delta","item_id":"msg_final","delta":"Investigated the original failed test from its authenticated native read."}\n\n' +
            'data: {"type":"response.completed","response":{"id":"resp_final","usage":{"input_tokens":41,"output_tokens":12,"total_tokens":53}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    console.info("EVENT_RESULT_CURRENT_PRIVATE_EVIDENCE", root)
    try {
      const installation = await EventInvestigationInstallation.build({
        directory: root,
        assets: assets!,
        ca: certificate.ca,
        origin: provider.url.origin,
        debugFixturePath: path.join(import.meta.dir, "fixture/event-investigation-result-current.ts"),
      })
      const candidate = await EventInvestigationInstallation.caseFor({
        installation,
        directory: path.join(root, "case"),
        sourceText: guard,
      })
      const reserve = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("private port reservation"),
      })
      const port = String(reserve.port)
      await reserve.stop(true)
      await EventInvestigationInstallation.enroll(candidate)
      const executed = await candidate.run("investigate", ["debug"], {
        DAC_EVENT_NATIVE_RESULT: path.join(root, "result.json"),
        DAC_EVENT_NATIVE_HTTP_PORT: port,
        DAC_EVENT_NATIVE_READ_READY: path.join(root, "read-ready"),
        DAC_EVENT_NATIVE_READ_VERIFIED: path.join(root, "read-verified"),
        DEEPAGENT_CODE_ATTENTION_PROFILE: "implicit-local",
      })
      expect(executed.code, executed.stderr.slice(-2000)).toBe(0)
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result.error).toBeUndefined()
      expect(result.before.receipts).toHaveLength(0)
      expect(result.before.sessions).toHaveLength(0)
      expect(result.before.inputs).toHaveLength(0)
      expect(result.runs).toHaveLength(1)
      expect(result.runs[0]).toMatchObject({
        state: "settled",
        outcome: "failed",
        resultCurrent: true,
        retainedBytes: 0,
        result: { stopConfirmed: true, stdout: { complete: true }, stderr: { complete: true } },
      })
      expect(result.runs[0].releasedAt).not.toBeNull()
      expect(result.rule.configuration).toMatchObject({ investigation: "disabled", autoFix: false })
      expect(result.after.receipts).toHaveLength(1)
      expect(result.after.sessions).toHaveLength(1)
      expect(result.after.inputs).toHaveLength(1)
      expect(result.receipt).toMatchObject({
        runID: result.runs[0].runID,
        contentHash: result.runs[0].contentHash,
        evidence: {
          content: result.runs[0].content,
          resultHash: EventInvestigationInstallation.hash(CanonicalJson.stringify(result.runs[0].result)),
        },
      })
      expect(result.steps).toHaveLength(2)
      expect(result.steps.every((step: { sessionID: string }) => step.sessionID === result.receipt.sessionID)).toBe(true)
      expect(result.steps[1].providerStates).toEqual(["settled", "streaming"])
      expect(result.execution).toBe("normal idle")
      expect(result.sourceAuthority).toBe("current source")
      expect(result.after.work).toEqual([
        expect.objectContaining({ admission_state: "ready", control_state: "active", outcome: "succeeded" }),
      ])
      expect(result.after.counts.map((entry: { state: string }) => entry.state)).toEqual(["settled", "settled"])
      expect(result.after.dispatches).toEqual([
        { state: "settled", reserved_total_tokens: 4137, charged_tokens: 53 },
        { state: "settled", reserved_total_tokens: 4137, charged_tokens: 53 },
      ])
      expect(result.after.providers.map((entry: { state: string }) => entry.state)).toEqual(["settled", "settled"])
      expect(result.after.providers.every((entry: { outcome_hash: string | null; error_code: string | null }) =>
        entry.outcome_hash !== null && entry.error_code === null)).toBe(true)
      expect(result.after.attempts.map((entry: { state: string }) => entry.state)).toEqual(["settled", "settled"])
      expect(result.after.activities).toEqual([expect.objectContaining({ state: "settled" })])
      expect(result.after.activities[0].final_message_id).toBe(result.steps[1].assistantMessageID)
      expect(result.after.sessions[0].execution_claim_token).toBeNull()
      expect(result.activeSessions).toEqual([])
      expect(result.reconcileCandidates).toEqual([])
      expect(result.reports).toEqual([expect.objectContaining({
        receiptID: result.receipt.receiptID, deadline: result.receipt.deadline,
        work: { admissionState: "ready", controlState: "active", controlRevision: 1, outcome: "succeeded" },
      })])
      expect(result.attention.data).toEqual([])
      expect(result.afterReads).toEqual(result.after)
      expect(result.after.tools).toEqual([expect.objectContaining({ state: "settled", effect_kind: "read_only" })])
      expect(result.after.tools[0].known_read_proof).not.toBeNull()
      expect(result.knownReads).toHaveLength(1)
      expect(result.knownReads[0]).toMatchObject({
        workID: result.receipt.workID,
        rootWorkID: result.receipt.workID,
        profileHash: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE_HASH,
        relative: "guard.test.ts",
        fileIdentity: result.runs[0].content.files[0].identity,
        fileBytes: Buffer.byteLength(guard),
        scannedBytes: Buffer.byteLength(guard),
        observedHash: EventInvestigationInstallation.hash(guard),
        snapshot: "stream_observation",
      })
      expect(state).toEqual({ generations: 2, readReached: true })
      expect(received.filter((entry) => entry.path === "/v1/responses/input_tokens")).toHaveLength(2)
      expect(received.every((entry) => entry.authenticated)).toBe(true)
      expect(await fs.readFile(path.join(project, "guard.test.ts"), "utf8")).toBe(guard)
    } finally {
      await provider.stop(true)
      await fs.writeFile(
        path.join(root, "physical.json"),
        JSON.stringify({
          received,
          state,
          sourceUnchanged: (await Bun.file(path.join(project, "guard.test.ts")).exists())
            ? EventInvestigationInstallation.hash(await fs.readFile(path.join(project, "guard.test.ts"))) ===
              EventInvestigationInstallation.hash(guard)
            : null,
          tlsVerify: true,
          globalCAEnvironment: false,
          fixtureSourceOverlays: [
            "packages/deepagent-code/src/cli/cmd/debug/index.ts",
            "packages/llm/src/route/executor.ts",
            "packages/deepagent-code/src/installation/work-provider-contract.ts",
            "packages/core/src/session/work-route-policy.ts",
          ],
          ownHTTPSStopped: true,
          scope: "test-transport-diagnostic",
        }),
        { mode: 0o600 },
      )
    }
  },
  240000,
)
