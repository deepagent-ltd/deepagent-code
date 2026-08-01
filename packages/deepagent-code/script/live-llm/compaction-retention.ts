import { copyFile, lstat, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const markers = Array.from({ length: 3 }, () => `c1-${crypto.randomUUID()}`)
const markerFiles = markers.map((marker) => `.deepagent-c1/${marker}.state`)
const expectedOutput = `${markers.toSorted().join("\n")}\n`
const filler = Array.from({ length: 6_000 }, (_, index) => `context-padding-${index}`).join(" ")
const outputCaseName = "recover-from-world-state"

const artifact = await runLegacyLiveCases({
  suite: "automatic-compaction-world-state-legacy",
  permission: { "*": "deny", edit: { "*": "deny", "output.txt": "allow" } },
  cases: [
    {
      name: "fill-context-window",
      prompt: `Retain no facts from this padding. Reply only READY.\n${filler}`,
    },
    {
      name: outputCaseName,
      prompt: [
        "An automatic compaction must complete before you act on this instruction.",
        "Use only the latest <world-state> Version Control changed-file list.",
        "It contains exactly three files under .deepagent-c1/ whose basenames end in .state.",
        "Call write exactly once to create output.txt with the three filename stems in sorted order, one per line, including a final newline.",
        "Do not call any discovery, read, shell, task, or validation tool.",
      ].join(" "),
    },
  ],
  sharedSession: true,
  beforeCase: async ({ caseName, directory }) => {
    if (caseName === "fill-context-window") {
      await Promise.all(
        markerFiles.map(async (file) => {
          await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
          await Bun.write(path.join(directory, file), "world-state source\n")
        }),
      )
      return
    }
    if (caseName === outputCaseName && (await Bun.file(path.join(directory, "output.txt")).exists())) {
      throw new Error("C1 output.txt existed before the recovery instruction")
    }
  },
  inspectFiles: ["output.txt"],
  toolSandbox: {
    initialVerifier: "fail",
    verifierScript: [
      "#!/bin/sh",
      "set -eu",
      "test -f output.txt",
      `test "$(cat output.txt)" = ${quote(markers.toSorted().join("\n"))}`,
      "",
    ].join("\n"),
  },
  evaluateWorkspace: evaluateFreshCopy,
  primaryPrompt:
    "This is a constrained automatic-compaction contract. Follow the current user instruction exactly and use no tool except the one explicitly requested.",
  modelMaxTokens: 768,
  modelContextTokens: 12_000,
  maxProviderTurns: 6,
  environment: {
    DEEPAGENT_CODE_SOFT_LANDING_COMPACTION: "false",
    DEEPAGENT_CODE_WORLD_STATE_REINJECTION: "true",
    DEEPAGENT_CODE_EXPERIMENTAL_CONTEXT_LEDGER: "true",
  },
})

if (artifact.initialVerifier?.expected !== "fail" || artifact.initialVerifier.exitCode === 0) {
  throw new Error("C1 hidden verifier did not fail before the model mutation")
}
if (!artifact.sandbox?.hostReadDenied || !artifact.sandbox.systemHostReadDenied || !artifact.sandbox.networkDenied) {
  throw new Error("C1 did not run in the qualified tool sandbox")
}

const fill = requireCase(artifact.cases, "fill-context-window")
const recovery = requireCase(artifact.cases, outputCaseName)
const automatic = fill.newCompactions.filter((compaction) => compaction.auto)
if (automatic.length !== 1) {
  throw new Error(`Expected exactly one automatic compaction, received ${automatic.length}`)
}
if (fill.compactionCount !== 1 || recovery.compactionCount !== 1 || recovery.newCompactions.length !== 0) {
  throw new Error(`Unexpected compaction counts: fill=${fill.compactionCount}, recovery=${recovery.compactionCount}`)
}
if (fill.summaryTexts.length !== 1 || fill.summaryTexts.some((text) => markers.some((marker) => text.includes(marker)))) {
  throw new Error("C1 marker leaked into or was missing from the automatic compaction summary boundary")
}

const worldState = fill.users.map((user) => user.syntheticText).find((text) => text.includes("<world-state>"))
if (!worldState || markers.some((marker) => !worldState.includes(marker))) {
  throw new Error("C1 markers were not re-injected through the World State tail")
}
const ordinaryUserText = artifact.cases.flatMap((testCase) => testCase.users.map((user) => user.text)).join("\n")
if (markers.some((marker) => ordinaryUserText.includes(marker))) {
  throw new Error("C1 hidden marker leaked into an ordinary user prompt")
}

const completedTools = recovery.newTools.filter((tool) => tool.status === "completed")
if (completedTools.length !== 1 || completedTools[0]?.name !== "write") {
  throw new Error(`C1 tool sequence was ${recovery.newTools.map((tool) => `${tool.name}:${tool.status}`).join(" -> ")}`)
}
if (recovery.newTools.some((tool) => tool.status !== "completed")) {
  throw new Error("C1 produced a failed or non-terminal tool call")
}
const writeInput = record(completedTools[0]?.input, "write input")
if (typeof writeInput.filePath !== "string" || path.basename(writeInput.filePath) !== "output.txt") {
  throw new Error("C1 write did not target output.txt")
}
if (writeInput.content !== expectedOutput || artifact.workspace.files["output.txt"] !== expectedOutput) {
  throw new Error("C1 output.txt did not contain the exact three World State markers")
}
if (recovery.permissionRequests.length !== 0 || recovery.questionRequests.length !== 0) {
  throw new Error("C1 requested undeclared permission or question input")
}

const evaluation = record(artifact.evaluation, "fresh-copy evaluation")
if (evaluation.passed !== true || evaluation.exitCode !== 0 || evaluation.sandboxed !== true) {
  throw new Error(`C1 fresh-copy verifier failed: ${JSON.stringify(evaluation)}`)
}

const result = {
  ...artifact,
  mode: "ext" as const,
  evidence: {
    markerHashes: markers.map((marker) => Bun.hash(marker).toString(16)),
    automaticCompactions: automatic.length,
    summaryExcludedMarkers: true,
    worldStateSuppliedMarkers: true,
    changedPaths: evaluation.changedPaths,
    freshCopyVerifierExitCode: evaluation.exitCode,
    permissionRequestCount: recovery.permissionRequests.length,
  },
}

await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  result.suite,
  result,
  {
    redactions: [
      {
        value: filler,
        replacement: `<context-padding count=6000 hash=${Bun.hash(filler).toString(16)}>`,
      },
      ...markers.map((marker) => ({
        value: marker,
        replacement: `<hidden-marker hash=${Bun.hash(marker).toString(16)}>`,
      })),
    ],
  },
)
console.log(
  `${result.suite}: passed (${result.fingerprint.providerID}/${result.fingerprint.modelID}, ` +
    `${automatic.length} automatic compaction, ${recovery.usage.input + recovery.usage.output} recovery tokens)`,
)

finishLiveScript()

async function evaluateFreshCopy(directory: string, sandbox?: { shell: string }) {
  if (!sandbox) throw new Error("C1 fresh-copy verifier requires the qualified tool sandbox")
  const changedPaths = (await git(directory, "status", "--short", "--untracked-files=all"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.slice(3).replace(/\/$/, ""))
    .toSorted()
  const expectedPaths = [...markerFiles, "output.txt"].toSorted()
  const fresh = path.join(directory, `.live-llm-fresh-${crypto.randomUUID()}`)
  await mkdir(fresh)
  try {
    await copyFile(path.join(directory, "output.txt"), path.join(fresh, "output.txt"))
    const process = Bun.spawn([sandbox.shell, "-c", `cd ${quote(fresh)} && ../verify`], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode, stat] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
      lstat(path.join(fresh, "output.txt")),
    ])
    return {
      passed:
        exitCode === 0 &&
        stat.isFile() &&
        changedPaths.join("\0") === expectedPaths.join("\0"),
      sandboxed: true,
      freshCopy: true,
      exitCode,
      changedPaths,
      outputHash: Bun.hash(`${stdout}\n${stderr}`).toString(16),
    }
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
}

async function git(directory: string, ...args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || exitCode}`)
  return stdout
}

function requireCase<Cases extends ReadonlyArray<{ name: string }>>(cases: Cases, name: string): Cases[number] {
  const testCase = cases.find((value) => value.name === name)
  if (!testCase) throw new Error(`Missing C1 case ${name}`)
  return testCase
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`)
  return value as Record<string, unknown>
}

function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
