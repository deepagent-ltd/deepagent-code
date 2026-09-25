import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const inheritMarker = `intensity-inherit-${crypto.randomUUID()}`
const downgradeMarker = `intensity-downgrade-${crypto.randomUUID()}`

const inherit = await runIntensity("inherit", inheritMarker)
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${inherit.suite}-observed`,
  inherit,
)
assertIntensity(inherit, "inherit", "max", inheritMarker)
const downgrade = await runIntensity("downgrade", downgradeMarker)
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  `${downgrade.suite}-observed`,
  downgrade,
)
assertIntensity(downgrade, "downgrade", "xhigh", downgradeMarker)

const result = {
  suite: "subagent-intensity-legacy",
  mode: "ext" as const,
  status: "passed" as const,
  fingerprint: inherit.fingerprint,
  runs: { inherit, downgrade },
  evidence: {
    parentMode: "max",
    inheritChildMode: "max",
    downgradeChildMode: "xhigh",
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    "inherit max->max, downgrade max->xhigh)",
)

async function runIntensity(intensity: "inherit" | "downgrade", marker: string) {
  return runLegacyLiveCases({
    suite: `subagent-intensity-${intensity}-legacy`,
    permission: { "*": "deny" },
    primaryPermission: { "*": "deny", task: "allow" },
    agentPermissions: { probe: { "*": "deny" } },
    cases: [
      {
        name: intensity,
        prompt: [
          "Your first assistant response must contain exactly one task tool call and no text.",
          "Call it as a foreground task with subagent_type probe and omit output_schema and isolation.",
          `Use description \"verify ${intensity} intensity\" and prompt \"Reply with exactly ${marker} and do not use tools.\"`,
          "After the task returns, report completion without calling more tools.",
        ].join(" "),
      },
    ],
    subagentIntensity: intensity,
    inspectTaskRuns: true,
    observeAssembledRequestFingerprints: true,
    environment: {
      DEEPAGENT_ENABLED: "false",
      DEEPAGENT_MODE: "max",
    },
    modelMaxTokens: 512,
    maxProviderTurns: 4,
    timeoutMs: 180_000,
  })
}

function assertIntensity(
  artifact: Awaited<ReturnType<typeof runLegacyLiveCases>>,
  intensity: "inherit" | "downgrade",
  expectedMode: "max" | "xhigh",
  marker: string,
) {
  const observation = artifact.cases[0]
  if (!observation || observation.providerErrors.length > 0) {
    throw new Error(`${intensity} intensity provider turn failed: ${JSON.stringify(observation?.providerErrors)}`)
  }
  const task = observation.tools.filter((tool) => tool.name === "task" && tool.status === "completed")
  const children = observation.children.filter((child) => child.agent === "probe")
  if (task.length !== 1 || children.length !== 1) {
    throw new Error(`${intensity} intensity did not execute exactly one production Task child`)
  }
  const child = children[0]!
  const metadata = child.v2Users[0]?.metadata
  const override = metadata && typeof metadata === "object" && "deepagent" in metadata &&
    metadata.deepagent && typeof metadata.deepagent === "object" && "agent_mode_override" in metadata.deepagent
      ? metadata.deepagent.agent_mode_override
      : undefined
  if (intensity === "inherit" ? override !== undefined : override !== expectedMode) {
    throw new Error(`${intensity} intensity injected an invalid child override: ${String(override)}`)
  }
  // The old request-fingerprint event and V1 subagent terminal metadata are not emitted by the
  // Core V2 owner. The durable child prompt and TaskRun receipt are its actual authorities; the
  // Core runner test pins that the prompt override reaches the gateway request.
  if ((observation.taskRuns ?? []).filter((run) =>
    run.childSessionID === child.id && run.executionRuntime === "v2" &&
    run.state === "completed" && run.reason === "core_v2_task_completed").length !== 1) {
    throw new Error(`${intensity} intensity child did not settle one durable V2 TaskRun`)
  }
  if (
    child.parentID !== observation.sessionID ||
    child.assistants.some(
      (assistant) =>
        assistant.providerID !== artifact.fingerprint.runtimeProviderID ||
        assistant.modelID !== artifact.fingerprint.modelID ||
        assistant.error !== undefined ||
        assistant.tools.length > 0,
    ) ||
    !child.assistants.some((assistant) => assistant.text.includes(marker))
  ) {
    throw new Error(`${intensity} intensity child has invalid lineage, model identity, or output`)
  }
}

finishLiveScript()
