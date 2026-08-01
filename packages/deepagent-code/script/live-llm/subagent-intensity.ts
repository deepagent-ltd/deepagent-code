import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const inheritMarker = `intensity-inherit-${crypto.randomUUID()}`
const downgradeMarker = `intensity-downgrade-${crypto.randomUUID()}`

const inherit = await runIntensity("inherit", inheritMarker)
assertIntensity(inherit, "inherit", "max", inheritMarker)
const downgrade = await runIntensity("downgrade", downgradeMarker)
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
  const deepagent = nestedRecord(child.users[0]?.metadata, ["deepagent"])
  const override = deepagent.agent_mode_override
  if (intensity === "inherit" ? override !== undefined : override !== expectedMode) {
    throw new Error(`${intensity} intensity injected an invalid child override: ${String(override)}`)
  }
  const fingerprints = child.assembledRequestFingerprints.map((value) => record(value, "request fingerprint"))
  if (fingerprints.length === 0 || fingerprints.some((value) => value.agentMode !== expectedMode)) {
    throw new Error(
      `${intensity} intensity did not reach request preparation as ${expectedMode}: ${JSON.stringify(fingerprints)}`,
    )
  }
  const terminal = nestedRecord(child.metadata, ["deepagent", "subagent"])
  if (terminal.finished !== true || terminal.state !== "completed" || terminal.reason !== "text_output_valid") {
    throw new Error(`${intensity} intensity child did not persist a valid terminal state`)
  }
  if (
    child.parentID !== observation.sessionID ||
    child.assistants.some(
      (assistant) =>
        assistant.providerID !== "live-deepseek" ||
        assistant.modelID !== artifact.fingerprint.modelID ||
        assistant.error !== undefined ||
        assistant.tools.length > 0,
    ) ||
    !child.assistants.some((assistant) => assistant.text.includes(marker))
  ) {
    throw new Error(`${intensity} intensity child has invalid lineage, model identity, or output`)
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function nestedRecord(value: unknown, keys: string[]) {
  const result = keys.reduce<Record<string, unknown> | undefined>(
    (current, key) => {
      if (!current) return undefined
      const next = current[key]
      if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined
      return next as Record<string, unknown>
    },
    record(value, keys[0] ?? "value"),
  )
  if (!result) throw new Error(`Missing object path ${keys.join(".")}`)
  return result
}

finishLiveScript()
