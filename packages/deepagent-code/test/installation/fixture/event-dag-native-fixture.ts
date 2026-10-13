export * as EventDagNativeFixture from "./event-dag-native-fixture"

import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { EventInvestigationInstallation } from "./event-investigation-installation"
import type { EventDagNativeCrash } from "./event-dag-native-crash"

/** Fixed fake protocol supplier; no credentials or network from the developer environment. */
export function provider(certificate: Awaited<ReturnType<typeof EventInvestigationInstallation.certificate>>) {
  const requests: { pathname: string; authenticated: boolean; node: boolean; tool?: string; body: unknown }[] = []
  const state = { tool: "write" as "write" | "managed_command", nodeCalls: 0 }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(certificate.keyPath), cert: Bun.file(certificate.certificatePath) },
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer fixture-native-key")
        return new Response("Fixture authentication refused", { status: 403 })
      const body: unknown = await request.json()
      const node = JSON.stringify(body).includes("DAC_NATIVE_FAULT_NODE")
      requests.push({ pathname, authenticated: request.headers.get("authorization") === "Bearer fixture-native-key",
        node, ...(node ? { tool: state.tool } : {}), body })
      if (pathname !== "/responses") return new Response("Unknown fixture endpoint", { status: 404 })
      if (node && ++state.nodeCalls === 1) {
        const call = { type: "function_call", id: "native_fault_effect", call_id: "native_fault_call", name: state.tool,
          arguments: JSON.stringify(state.tool === "write"
            ? { path: "created.txt", content: "Native current DAG committed bytes.\n" }
            : { commandID: "build", parameters: [] }) }
        return new Response([
          { type: "response.output_item.added", item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
          { type: "response.output_item.done", item: call },
          { type: "response.completed", response: { id: "native_fault_tool_response",
            usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      }
      return new Response([
        { type: "response.output_text.delta", item_id: "native_fault_final",
          delta: node ? "Original Native node completed." : "Ordinary current source terminal." },
        { type: "response.completed", response: { id: "native_fault_final_response",
          usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, requests, select(tool: "write" | "managed_command") { state.tool = tool; state.nodeCalls = 0 } }
}

/** One fresh project/DB per scenario; only the signed installation can be shared. Source
 * facts are produced by real ordinary Session execution and public operator/rule controls. */
export async function prepare(input: {
  installation: EventInvestigationInstallation.SignedInstallation
  directory: string
  tool: "write" | "managed_command"
}) {
  const candidate = await EventInvestigationInstallation.caseFor({ installation: input.installation,
    directory: input.directory, sourceText: "export const ordinaryGuard = true;\n", provider: "deepseek" })
  await projectBaseline(candidate)
  const env = { DEEPAGENT_CODE_EVENT_V2_ADMISSION: "true", DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME: "true",
    DEEPAGENT_CODE_V4_DAG_COORDINATION: "true" }
  const invoke = async (name: string, body: typeof EventDagNativeCrash.Input.Type) => {
    const descriptor = path.join(candidate.directory, `${name}.input.json`)
    const result = path.join(candidate.directory, `${name}.result.json`)
    await fs.writeFile(descriptor, JSON.stringify(body), { mode: 0o600 })
    return { result, env: { ...env, DAC_EVENT_DAG_FAULT_INPUT: descriptor, DAC_EVENT_DAG_FAULT_RESULT: result } }
  }
  const run = async (name: string, body: typeof EventDagNativeCrash.Input.Type) => {
    const descriptor = await invoke(name, body)
    const process = await candidate.run(name, ["debug"], descriptor.env)
    const output: unknown = await Bun.file(descriptor.result).exists() ? await Bun.file(descriptor.result).json() : undefined
    return { ...process, output }
  }
  const spawn = async (name: string, body: typeof EventDagNativeCrash.Input.Type) => {
    const descriptor = await invoke(name, body)
    return { child: candidate.spawn(["debug"], descriptor.env), result: descriptor.result }
  }
  const created = await run("source", { mode: "setup-source", directory: candidate.project })
  if (created.code !== 0 || typeof created.output !== "object" || !created.output ||
    !("sourceSessionID" in created.output) || typeof created.output.sourceSessionID !== "string")
    throw new Error(`Original source creation failed: ${JSON.stringify(created.output)} ${created.stderr.slice(-1500)}`)
  const sourceSessionID = created.output.sourceSessionID
  const originID = `native-fault-origin-${input.tool}`
  const ruleID = `native-fault-rule-${input.tool}`
  const budget = { ...WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget, maxTotalTokens: 2_105_344,
    hourTokensMax: 2_105_344, maxProviderDispatches: 2, maxToolCalls: 1, maxChildren: 0, maxDurationMs: 300_000 }
  const fileScope = { read: input.tool === "write"
    ? [{ kind: "file", path: "approved.txt" }, { kind: "file", path: "created.txt" }]
    : [{ kind: "file", path: "input.ts" }],
    write: input.tool === "write" ? [{ kind: "file", path: "created.txt" }] : [], deny: [],
    maxReadBytes: 65536, maxPageBytes: 51200, maxHashBytes: 16777216,
    maxWriteBytes: input.tool === "write" ? 51200 : 0, symlinks: "deny" }
  const recipe = { schemaVersion: "work-command-recipe.v1", logicalID: "build", revision: 1,
    executable: "installed-bun-v1", argv: ["build", "input.ts", "--outfile", "output.js", "--target", "bun"].map((value) => ({ kind: "literal", value })),
    parameters: [], cwd: null, inputs: ["input.ts"], outputs: ["output.js"], environment: [{ name: "CI", value: "1" }],
    workspace: "private_explicit_files.v1", sandbox: { id: "darwin-single-process-workspace-v1", revision: 1, network: "deny", processes: 1,
      openFiles: 64, maxInputFiles: 256, maxInputFileBytes: 16777216, maxInputBytes: 67108864, maxDepth: 16,
      maxOutputFiles: 32, maxOutputFileBytes: 1048576, maxOutputBytes: 33554432 }, timeoutMs: 10000, stdoutBytes: 65536, stderrBytes: 65536 }
  await fs.writeFile(candidate.policy, JSON.stringify({ version: 9, targets: [{ id: "dag", directory: candidate.project,
    agentID: "auto", providerID: "deepseek", modelID: "deepseek-flash", profile: "event_deepseek_dag_v1",
    budget: { ...budget, maxChildren: 1 },
    children: { kind: "event_dag_v1", maxConcurrent: 1, agents: ["auto"], toolIDs: [input.tool], budget },
    project: { tools: [input.tool], fileScope, ...(input.tool === "managed_command" ? { commandRecipes: [recipe] } : {}) },
  }], eventOrigins: [{ id: originID, targetID: "dag", source: "ordinary_session_activity_terminal_v1", sourceSessionID,
    execution: { kind: "dag", plan: { version: 1, id: `native-fault-plan-${input.tool}`, maxConcurrent: 1,
      nodes: [{ id: "native", agentID: "auto", instruction: `DAC_NATIVE_FAULT_NODE: Execute the approved ${input.tool} exactly once and report.`,
        dependencies: [], toolIDs: [input.tool], budget, requiresWriteIsolation: true }] } } }] }), { mode: 0o600 })
  const enrolled = await candidate.run("enroll", ["operator", "enroll", "--request-id", "native-fault-enroll", "--policy", candidate.policy])
  if (enrolled.code !== 0) throw new Error(`Current DAG enrollment failed: ${enrolled.stderr.slice(-2000)}`)
  const approved = await candidate.run("approve", ["operator", "approve-route", "--request-id", "native-fault-route", "--target", "dag",
    "--snapshot", "deepseek-flash", "--expected-revision", "1", "--expected-route-revision", "0", "--expires-at", String(Date.now() + 600_000)])
  if (approved.code !== 0) throw new Error(`Original Native route approval failed: ${approved.stderr.slice(-2000)}`)
  const enabled = await run("enable", { mode: "enable", originID, ruleID,
    instruction: "Only the original approved Native fault node.", timeoutMs: 300_000 })
  if (enabled.code !== 0) throw new Error(`Original public DAG control failed: ${JSON.stringify(enabled.output)} ${enabled.stderr.slice(-2000)}`)
  return { candidate, sourceSessionID, originID, ruleID, env, run, spawn,
    snapshot: () => snapshot(candidate.dbPath), runInput: { mode: "run" as const, originID, ruleID,
      triggerText: "DAC_NATIVE_FAULT_SOURCE: Produce the ordinary original source terminal.", timeoutMs: 120_000 } }
}

/** The Native fault scenarios and the hostile-ambient-config probe use this same Git
 * boundary. Every subprocess receives only its owned project environment and empty template. */
export async function projectBaseline(candidate: { directory: string; project: string; env: Record<string, string | undefined> }) {
  await fs.writeFile(path.join(candidate.project, "input.ts"), "export const answer: number = 42;\n")
  await fs.writeFile(path.join(candidate.project, "approved.txt"), "Original approved bytes.\n")
  await fs.writeFile(path.join(candidate.project, ".gitignore"), "deepagent-code.json\n")
  const template = path.join(candidate.directory, "empty-git-template")
  await fs.mkdir(template, { recursive: true, mode: 0o700 })
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: candidate.project, env: { ...candidate.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TEMPLATE_DIR: template }, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`Owned fixture git failed: ${result.stderr.toString()}`)
  }
  git(["init", "--quiet"])
  git(["add", "input.ts", "approved.txt", "guard.test.ts", ".gitignore"])
  git(["-c", "user.name=Native fixture", "-c", "user.email=native-fixture@example.invalid", "commit", "--quiet", "-m", "Fixture baseline"])
}

/** Read-only snapshots of the isolated DB, including raw receipts so caller assertions do
 * not replace implementation checks with a reconstructed summary. Never writes an oracle. */
export function snapshot(filename: string) {
  using db = new Database(filename, { readonly: true })
  const rows = (name: string, order: string) => db.query(`SELECT * FROM ${name} ORDER BY ${order}`).all()
  return { providers: rows("session_v2_provider_turn_receipt", "provider_turn_seq,receipt_id"),
    attempts: rows("session_provider_attempt", "attempt_id"),
    effects: rows("session_v2_tool_effect", "effect_id"), admissions: rows("session_v2_tool_effect_admission", "admission_id"),
    counts: rows("work_count_acquisition", "acquisition_id"), reservations: rows("work_dispatch_reservation", "reservation_id"),
    inputs: rows("session_input", "admitted_seq,id"),
    claims: db.query("SELECT id,execution_claim_token FROM session ORDER BY id").all(),
    work: rows("work_execution", "work_id"), controller: rows("event_work_controller", "controller_id"),
    nodes: rows("event_work_node_authority", "authority_id"), workspace: rows("event_task_workspace", "event_id,task_id,generation"),
    commands: rows("work_command_intent", "command_id"), writes: rows("work_write_stage", "stage_id"),
    recoveries: rows("work_known_recovery", "recovery_id"), resumes: rows("work_known_recovery_resume", "recovery_id"),
    taskRecoveries: rows("work_known_recovery_v2", "recovery_id"), taskResumes: rows("work_known_recovery_resume_v2", "recovery_id"),
    ownerLeases: rows("session_provider_owner_lease", "owner_token"),
    providerCount: db.query<{ n: number }, []>("SELECT count(*) n FROM session_v2_provider_turn_receipt").get()!.n }
}
