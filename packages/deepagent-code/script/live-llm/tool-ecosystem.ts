import path from "node:path"
import { pathToFileURL } from "node:url"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const webMarker = `webfetch-${crypto.randomUUID()}`
const skillMarker = `skill-${crypto.randomUUID()}`
const customMarker = `custom-${crypto.randomUUID()}`
const logMarker = `log-${crypto.randomUUID()}`
const skillName = "live-fixture"
const customToolName = "live_custom"
const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(`<html><body><main>${webMarker}</main><script>forbidden()</script></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
})

try {
  const url = new URL("evidence", server.url).toString()
  const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
  const toolsArtifact = await runLegacyLiveCases({
    suite: "tool-ecosystem-tools-legacy",
    permission: { "*": "deny" },
    primaryPermission: {
      "*": "deny",
      webfetch: "allow",
      skill: "allow",
      plan: "allow",
      query_log: "allow",
      [customToolName]: "allow",
    },
    files: {
      ".deepagent-code/node_modules/.keep": "",
      ".deepagent-code/package.json": JSON.stringify({
        private: true,
        dependencies: { "@deepagent-code/plugin": "workspace:*" },
      }),
      ".deepagent-code/package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { "@deepagent-code/plugin": "workspace:*" } } },
      }),
      [`.deepagent-code/skill/${skillName}/SKILL.md`]: [
        "---",
        `name: ${skillName}`,
        "description: Isolated live LLM fixture skill.",
        "---",
        "",
        "# Live fixture",
        "",
        `The private skill evidence is ${skillMarker}.`,
        "",
      ].join("\n"),
      [`.deepagent-code/tools/${customToolName}.ts`]: [
        `import { tool } from ${JSON.stringify(pluginTool)}`,
        "export default tool({",
        "  description: 'Return private evidence for the exact supplied challenge.',",
        "  args: { challenge: tool.schema.string() },",
        "  execute: async ({ challenge }, context) => {",
        `    await context.ask({ permission: ${JSON.stringify(customToolName)}, patterns: [challenge], always: ['*'], metadata: {} })`,
        `    return ${JSON.stringify(`Custom evidence ${customMarker} for `)} + challenge`,
        "  },",
        "})",
        "",
      ].join("\n"),
    },
    cases: [
      {
        name: "webfetch",
        prompt: [
          `Call webfetch exactly once for ${url} with format text.`,
          "Do not call another tool. Report the private marker returned by the page.",
        ].join("\n"),
      },
      {
        name: "skill",
        prompt: [
          `Call skill exactly once with name ${skillName}.`,
          "Do not call another tool. Report the private evidence from the loaded skill.",
        ].join("\n"),
      },
      {
        name: "custom-tool",
        prompt: [
          `Call ${customToolName} exactly once with challenge set to ecosystem-contract.`,
          "Do not call another tool. Report the private evidence returned by the tool.",
        ].join("\n"),
      },
      {
        name: "plan",
        prompt: [
          "Call plan exactly once with goal 'verify live plan persistence'.",
          "Use one step titled 'Collect evidence' with status active and acceptance 'tool result is durable'.",
          "Set active_step_id to the same step_id. Do not call another tool.",
        ].join("\n"),
      },
    ],
  })
  const codeIntelArtifact = await runLegacyLiveCases({
    suite: "tool-ecosystem-code-intel-legacy",
    permission: { "*": "deny" },
    primaryPermission: { "*": "deny", code_intel: "allow", lsp: "allow" },
    files: { "src/evidence.ts": "export const ecosystemSentinel = 'code-intel-evidence'\n" },
    cases: [
      {
        name: "code-intel",
        prompt: [
          "Call code_intel exactly once with intent outline and file src/evidence.ts.",
          "Do not call another tool. Report the tool's real result, including an unavailable/fallback result if no LSP is installed.",
        ].join("\n"),
      },
    ],
  })
  const logsArtifact = await runLegacyLiveCases({
    suite: "tool-ecosystem-logs-legacy",
    permission: { "*": "deny" },
    primaryPermission: { "*": "deny", query_log: "allow" },
    sharedSession: true,
    cases: [
      {
        name: "seed-log",
        prompt: `Reply with exactly LOG_SEEDED ${logMarker}. Do not call a tool.`,
      },
      {
        name: "query-log",
        prompt: [
          `Call query_log exactly once with keyword ${logMarker} and limit 10.`,
          "Do not rely on conversation memory in place of the tool call. Report whether the log entry was found.",
        ].join("\n"),
      },
    ],
  })
  const artifact = {
    ...toolsArtifact,
    suite: "tool-ecosystem-legacy",
    cases: [...toolsArtifact.cases, ...codeIntelArtifact.cases, ...logsArtifact.cases],
    workspaces: {
      tools: toolsArtifact.workspace,
      codeIntel: codeIntelArtifact.workspace,
      logs: logsArtifact.workspace,
    },
    preflight: {
      durationMs:
        toolsArtifact.preflight.durationMs + codeIntelArtifact.preflight.durationMs + logsArtifact.preflight.durationMs,
    },
    durationMs: toolsArtifact.durationMs + codeIntelArtifact.durationMs + logsArtifact.durationMs,
    completedAt: new Date().toISOString(),
  }

  const expectations = [
    { name: "webfetch", tool: "webfetch", marker: webMarker },
    { name: "skill", tool: "skill", marker: skillMarker },
    { name: "custom-tool", tool: customToolName, marker: customMarker },
    { name: "plan", tool: "plan" },
    { name: "code-intel", tool: "code_intel" },
    { name: "seed-log" },
    { name: "query-log", tool: "query_log", marker: logMarker },
  ]
  expectations.forEach((expectation) => {
    const observation = artifact.cases.find((testCase) => testCase.name === expectation.name)
    if (!observation) throw new Error(`Missing tool ecosystem case ${expectation.name}`)
    const tools = observation.newTools
    if (expectation.tool) {
      if (tools.length !== 1 || tools[0]?.name !== expectation.tool || tools[0].status !== "completed") {
        throw new Error(`${expectation.name} tool sequence mismatch: ${JSON.stringify(tools)}`)
      }
    } else if (tools.length !== 0) {
      throw new Error(`${expectation.name} unexpectedly called ${tools.map((tool) => tool.name).join(", ")}`)
    }
    if (expectation.marker && !observation.finalText.includes(expectation.marker)) {
      throw new Error(`${expectation.name} final answer lost its runtime marker`)
    }
    if (
      observation.models.length === 0 ||
      observation.models.some(
        (model) => model.providerID !== "live-deepseek" || model.modelID !== artifact.fingerprint.modelID,
      )
    ) {
      throw new Error(`${expectation.name} used the wrong provider/model identity`)
    }
  })

  const result = {
    ...artifact,
    evidence: {
      webMarkerHash: Bun.hash(webMarker).toString(16),
      skillMarkerHash: Bun.hash(skillMarker).toString(16),
      customMarkerHash: Bun.hash(customMarker).toString(16),
      logMarkerHash: Bun.hash(logMarker).toString(16),
      toolCalls: artifact.cases.flatMap((testCase) => testCase.newTools.map((tool) => tool.name)),
    },
  }
  await writeLiveArtifact(
    { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
    result.suite,
    result,
  )
  console.log(
    `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
      `${result.cases.reduce((total, testCase) => total + testCase.usage.input + testCase.usage.output, 0)} tokens)`,
  )
} finally {
  server.stop(true)
}

finishLiveScript()
