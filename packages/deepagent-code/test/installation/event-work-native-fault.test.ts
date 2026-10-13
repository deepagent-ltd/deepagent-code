import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkCountAcquisitionSchema } from "@deepagent-code/core/session/work-count-acquisition.schema"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"

const faults = [
  "count-unknown",
  "count-over",
  "count-revoked",
  "credential-change",
  "config-change",
  "source-pause",
  "operator-rotation",
  "generation-partial",
  "generation-usage-missing",
  "generation-usage-over",
] as const
const assets = process.env.DAC_EVENT_NATIVE_ASSETS
const enabled = process.platform === "darwin" && process.arch === "arm64" && !!assets
const actual = enabled ? test : test.skip
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const census = Schema.Struct({
  receipts: rows,
  work: rows,
  counts: rows,
  dispatches: rows,
  providers: rows,
  tools: rows,
})
const output = Schema.Struct({
  stage: Schema.String,
  productionSource: Schema.Boolean,
  availabilityOverride: Schema.Boolean,
  sourceSessionID: Schema.optional(Schema.String),
  before: Schema.optional(census),
  after: Schema.optional(census),
  error: Schema.optional(Schema.String),
  mutation: Schema.optional(Schema.String),
  currentModelDisabled: Schema.optional(Schema.Boolean),
  currentCredentialChanged: Schema.optional(Schema.Boolean),
  ordinary: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String, accepted: Schema.Boolean }))),
  native: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String, accepted: Schema.Boolean }))),
})
const shared = { current: undefined as Awaited<ReturnType<typeof prepare>> | undefined }
const scenario = {
  current: undefined as EventInvestigationInstallation.NativeCase | undefined,
  fault: "",
  generations: 0,
  requests: [] as { path: string; authenticated: boolean; method: string; bodyHash: string; body: unknown }[],
}

beforeAll(async () => {
  if (enabled) shared.current = await prepare()
}, 120_000)
afterAll(async () => {
  await shared.current?.provider.stop(true)
})
;(process.env.DAC_NATIVE_FAULT_CASES ? test.skip : actual)(
  "ordinary and builtin Native transport retain canonical gates and reject unmatched provider URLs",
  async () => {
    const installed = requireShared()
    const current = await EventInvestigationInstallation.caseFor({
      installation: installed.installation,
      directory: path.join(installed.directory, "transport-probe"),
      sourceText: "// Transport only\n",
    })
    scenario.current = current
    const probe = await execute(current, "transport-probe")
    expect(probe.stage).toBe("ordinary-native-physical-transport-probed-no-work-authority")
    expect(probe.ordinary?.map((entry) => entry.accepted)).toEqual([true, true, true, false, false, false, false])
    expect(probe.native?.map((entry) => entry.accepted)).toEqual([true, true, true, false, false, false, false])
    expect(scenario.requests.map((entry) => entry.path)).toEqual([
      "/v1/responses",
      "/v1/responses/input_tokens",
      "/responses",
      "/v1/responses",
      "/v1/responses/input_tokens",
      "/responses",
    ])
    expect(scenario.requests.every((entry) => entry.method === "POST" && entry.authenticated)).toBe(true)
    await fs.writeFile(
      path.join(installed.directory, "transport-probe.json"),
      JSON.stringify({ probe, requests: scenario.requests }),
      { mode: 0o600 },
    )
    scenario.requests.length = 0
  },
)

for (const fault of faults) {
  const selected = !process.env.DAC_NATIVE_FAULT_CASES || process.env.DAC_NATIVE_FAULT_CASES.split(",").includes(fault)
  ;(enabled && selected && process.env.DAC_NATIVE_FAULT_TRANSPORT_ONLY !== "1" ? test : test.skip)(
    `${fault}: actual current server_rule seals and cold no replay`,
    async () => {
      const installed = requireShared()
      const current = await EventInvestigationInstallation.caseFor({
        installation: installed.installation,
        directory: path.join(installed.directory, fault),
        sourceText: "// Current Native readonly source\n",
      })
      scenario.current = current
      scenario.fault = fault
      scenario.generations = 0
      scenario.requests.length = 0
      for (const args of [
        ["init", "-q"],
        ["add", "guard.test.ts"],
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Native Fixture",
          "-c",
          "user.email=native-fixture@localhost",
          "commit",
          "-qm",
          "fixture initial source",
        ],
      ]) {
        const git = Bun.spawnSync(["git", ...args], { cwd: current.project, stdout: "pipe", stderr: "pipe" })
        if (git.exitCode !== 0) throw new Error("The isolated actual Git source could not be initialized")
      }
      const source = await execute(current, "setup-source")
      if (!source.sourceSessionID) throw new Error("Real ordinary source was not created")
      expect(scenario.requests).toEqual([])
      const old = Schema.decodeUnknownSync(
        Schema.Struct({
          targets: Schema.Array(Schema.Struct({ project: Schema.Struct({ fileScope: Schema.Unknown }) })),
        }),
      )(await Bun.file(current.policy).json())
      await fs.writeFile(
        current.policy,
        JSON.stringify({
          version: 8,
          targets: [
            {
              id: "readonly",
              directory: current.project,
              agentID: "auto",
              providerID: "openai",
              modelID: "gpt-4.1-2025-04-14",
              budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxChildren: 0 },
              project: { tools: ["read"], fileScope: old.targets[0]!.project.fileScope },
            },
          ],
          eventOrigins: [
            {
              id: "ordinary-terminal",
              targetID: "readonly",
              source: "ordinary_session_activity_terminal_v1",
              sourceSessionID: source.sourceSessionID,
            },
          ],
        }),
        { mode: 0o600 },
      )
      const enroll = await current.run("enroll", [
        "operator",
        "enroll",
        "--request-id",
        "current-source-enroll",
        "--policy",
        current.policy,
      ])
      expect(enroll.code).toBe(0)
      const approval = await current.run("approve", [
        "operator",
        "approve-route",
        "--request-id",
        "current-source-approve",
        "--target",
        "readonly",
        "--snapshot",
        "gpt-4.1-2025-04-14",
        "--expected-revision",
        "1",
        "--expected-route-revision",
        "0",
        "--expires-at",
        String(Date.now() + 300_000),
      ])
      expect(approval.code).toBe(0)
      expect(scenario.requests).toEqual([])
      const result = await execute(current, "run", source.sourceSessionID, fault)
      expect(result.stage).toBe("current-server-rule-fault-settled")
      expect(result.availabilityOverride).toBe(false)
      expect(result.after?.receipts).toHaveLength(1)
      expect(result.after?.work).toHaveLength(1)
      expect(result.after?.work[0]).toMatchObject({ source_kind: "server_rule", admission_state: "ready" })
      expect(String(result.after?.work[0]?.authority_id)).toStartWith("evwork_")
      expect(result.after?.counts).toHaveLength(1)
      const count = Schema.decodeUnknownSync(Schema.fromJsonString(WorkCountAcquisitionSchema.ProjectRecord))(
        String(result.after?.counts[0]?.record),
      )
      expect(count.binding.countBodyHash).toBe(
        scenario.requests.find((entry) => entry.path === "/v1/responses/input_tokens")!.bodyHash,
      )
      expect(result.after?.providers).toHaveLength(2) // Ordinary source and the attempted Work turn are separate facts.
      expect(result.after?.tools).toEqual([])
      expect(scenario.requests.every((entry) => entry.authenticated)).toBe(true)
      const generationFault = fault.startsWith("generation-")
      const capturedTurn = ["credential-change", "config-change"].includes(fault)
      expect(scenario.requests.map((entry) => entry.path)).toEqual(
        generationFault || capturedTurn
          ? ["/v1/responses", "/v1/responses/input_tokens", "/v1/responses"]
          : ["/v1/responses", "/v1/responses/input_tokens"],
      )
      if (generationFault) {
        expect(count.state).toBe("settled")
        expect(result.after?.work[0]?.outcome).toBe("unknown")
        expect(result.after?.dispatches).toHaveLength(1)
        const reservation = result.after!.dispatches[0]!
        expect(reservation.state).toBe("unknown")
        expect(reservation.charged_tokens).toBe(
          fault === "generation-usage-over" ? 1_000_041 : reservation.reserved_total_tokens,
        )
        if (fault === "generation-usage-over")
          expect(reservation.charged_tokens).toBeGreaterThan(Number(reservation.reserved_total_tokens))
        expect(count.binding.generationBodyHash).toBe(scenario.requests.at(-1)!.bodyHash)
      } else if (capturedTurn) {
        // This Location intentionally retains the approved configuration until it closes.
        // Mutating env/file cannot lend the old count to a newly authenticated wire request.
        expect(count.state).toBe("settled")
        expect(result.after?.work[0]?.outcome).toBe("succeeded")
        expect(result.after?.dispatches).toHaveLength(1)
        expect(result.after?.dispatches[0]).toMatchObject({ state: "settled", charged_tokens: 53 })
        expect(count.binding.generationBodyHash).toBe(scenario.requests.at(-1)!.bodyHash)
        expect(result.mutation).toBe(fault)
      } else {
        expect(result.after?.dispatches).toEqual([])
        expect(count.state).toBe(fault === "count-over" ? "settled" : "unknown")
        if (fault === "count-over") expect(count.result?.inputTokens).toBe(1_000_000)
        if (!["count-unknown", "count-over"].includes(fault)) expect(result.mutation).toBe(fault)
      }
      const physical = scenario.requests.length
      const cold = await execute(current, "cold", source.sourceSessionID, fault)
      expect(cold.stage).toBe("cold-original-reconcile-no-replay")
      if (fault === "config-change") expect(cold.currentModelDisabled).toBe(true)
      if (fault === "credential-change") expect(cold.currentCredentialChanged).toBe(true)
      expect(cold.before).toEqual(result.after)
      expect(cold.after).toEqual(cold.before)
      expect(scenario.requests).toHaveLength(physical)
      await fs.writeFile(
        path.join(current.directory, "physical.json"),
        JSON.stringify({
          fault,
          requests: scenario.requests,
          physicalGenerations: scenario.generations,
          physicalCounts: scenario.requests.filter((entry) => entry.path.endsWith("input_tokens")).length,
          componentsHash: installed.installation.componentsHash,
          coldNoReplay: true,
        }),
        { mode: 0o600 },
      )
      console.info("EVENT_WORK_NATIVE_FAULT", fault, current.directory)
    },
    90_000,
  )
}

async function execute(
  current: EventInvestigationInstallation.NativeCase,
  mode: "transport-probe" | "setup-source" | "run" | "cold",
  sourceSessionID?: string,
  fault?: (typeof faults)[number],
) {
  const descriptor = path.join(current.directory, `${mode}-input.json`)
  const result = path.join(current.directory, `${mode}-result.json`)
  await fs.writeFile(
    descriptor,
    JSON.stringify({
      mode,
      directory: current.project,
      ...(sourceSessionID ? { sourceSessionID } : {}),
      ...(fault ? { fault } : {}),
    }),
    { mode: 0o600 },
  )
  const child = await current.run(mode, ["debug"], {
    DAC_EVENT_WORK_FAULT_INPUT: descriptor,
    DAC_EVENT_WORK_FAULT_RESULT: result,
    ...(mode === "cold" && fault === "credential-change"
      ? { DAC_FIXTURE_NATIVE_KEY: "changed-fixture-native-key" }
      : {}),
  })
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(output))(await fs.readFile(result, "utf8"))
  expect(value.error).toBeUndefined()
  expect(child.code).toBe(0)
  return value
}

function requireShared() {
  if (!shared.current) throw new Error("The actual signed installation is unavailable")
  return shared.current
}

async function prepare() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(process.env.DAC_NATIVE_FAULT_EVIDENCE ?? "/tmp", "dac-event-work-count-fault-")),
  )
  await fs.writeFile("/tmp/dac-event-work-count-fault-current", directory, { mode: 0o600 })
  const certificate = await EventInvestigationInstallation.certificate(directory)
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(certificate.keyPath), cert: Bun.file(certificate.certificatePath) },
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const authenticated = request.headers.get("authorization") === "Bearer fixture-native-key"
      const raw = await request.text()
      const body: unknown = JSON.parse(raw)
      scenario.requests.push({
        path: pathname,
        authenticated,
        method: request.method,
        bodyHash: EventInvestigationInstallation.hash(raw),
        body,
      })
      if (request.method !== "POST" || !authenticated) return new Response("denied", { status: 403 })
      if (typeof body === "object" && body !== null && "transport_probe" in body)
        return Response.json({ transport: "private-loopback" })
      if (pathname === "/v1/responses/input_tokens") {
        if (
          ["count-revoked", "credential-change", "config-change", "source-pause", "operator-rotation"].includes(
            scenario.fault,
          )
        ) {
          const deadline = Date.now() + 8000
          while (
            scenario.current &&
            !(await Bun.file(path.join(scenario.current.project, "count-release")).exists()) &&
            Date.now() < deadline
          )
            await Bun.sleep(10)
          if (!scenario.current || !(await Bun.file(path.join(scenario.current.project, "count-release")).exists()))
            return new Response("mutation not observed", { status: 503 })
        }
        if (scenario.fault === "count-unknown")
          return new Response('{"object":"response.input_tokens",', { headers: { "content-type": "application/json" } })
        return Response.json({
          object: "response.input_tokens",
          input_tokens: scenario.fault === "count-over" ? 1_000_000 : 41,
        })
      }
      if (pathname !== "/v1/responses" || ++scenario.generations > 2)
        return new Response("unexpected generation denied", { status: 403 })
      if (scenario.generations === 2 && scenario.fault === "generation-partial")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","item_id":"partial","delta":"unconfirmed fragment"}\n\n',
                ),
              )
              setTimeout(() => controller.error(new Error("Fixture stream disconnected")), 25)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      const text = scenario.generations === 1 ? "ordinary source settled" : "untrusted generated answer"
      const item = {
        type: "message",
        id: `message-${scenario.generations}`,
        role: "assistant",
        content: [{ type: "output_text", text }],
      }
      const usage =
        scenario.generations === 2 && scenario.fault === "generation-usage-missing"
          ? undefined
          : scenario.generations === 2 && scenario.fault === "generation-usage-over"
            ? { input_tokens: 41, output_tokens: 1_000_000, total_tokens: 1_000_041 }
            : { input_tokens: 41, output_tokens: 12, total_tokens: 53 }
      return new Response(
        [
          { type: "response.output_item.added", item: { ...item, content: [] } },
          {
            type: "response.content_part.added",
            item_id: item.id,
            content_index: 0,
            part: { type: "output_text", text: "" },
          },
          { type: "response.output_text.delta", item_id: item.id, content_index: 0, delta: text },
          { type: "response.output_text.done", item_id: item.id, content_index: 0, text },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: { id: `response-${scenario.generations}`, ...(usage ? { usage } : {}) },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const installation = await EventInvestigationInstallation.build({
    directory,
    assets: assets!,
    ca: certificate.ca,
    origin: provider.url.origin,
    debugFixturePath: path.join(import.meta.dir, "fixture/event-work-native-fault.ts"),
  })
  return { directory, provider, installation }
}
