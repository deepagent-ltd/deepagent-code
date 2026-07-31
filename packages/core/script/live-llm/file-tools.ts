import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { runV2LiveCases } from "./runtime"

const mode = Bun.argv[2]
const extended = Bun.argv.includes("--extended")
if (mode !== "read" && mode !== "mutations") {
  throw new Error("Usage: file-tools.ts <read|mutations> [--extended]")
}

const artifact = mode === "read" ? await readSuite() : await mutationSuite()
await writeLiveArtifact(
  {
    artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm"),
  },
  artifact.suite,
  artifact,
)
console.log(
  `${artifact.suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
    `${artifact.cases.reduce((total, testCase) => total + testCase.usage.input + testCase.usage.output, 0)} tokens)`,
)

async function readSuite() {
  const marker = `read-${crypto.randomUUID()}`
  const hiddenName = `secret-${crypto.randomUUID()}.txt`
  const cases = [
    {
      name: "read",
      agent: "read-test",
      prompt: "Use read exactly once on fixtures/read/target.txt. Reply with the exact marker in that file.",
    },
    ...(extended
      ? [
          {
            name: "glob-read",
            agent: "search-test",
            prompt:
              "Use glob to locate fixtures/search/secret-*.txt without guessing the generated filename, then read the matched file and reply with its exact marker.",
          },
          {
            name: "grep-read",
            agent: "search-test",
            prompt:
              "Use grep to find the file under fixtures/search containing the literal prefix TARGET_MARKER, then read that exact file and reply with the complete marker value.",
          },
        ]
      : []),
  ]
  const artifact = await runV2LiveCases({
    suite: extended ? "file-read-search-ext-v2" : "file-read-search-v2",
    agents: {
      "read-test": {
        prompt: "Follow the requested file-read procedure exactly. Never invent file contents.",
        permission: { "*": "deny", read: "allow" },
      },
      "search-test": {
        prompt: "Use search tools to discover paths before reading them. Never invent file contents.",
        permission: { "*": "deny", glob: "allow", grep: "allow", read: "allow" },
      },
    },
    cases,
    files: {
      "fixtures/read/decoy.txt": "not the target\n",
      "fixtures/read/target.txt": `${marker}\n`,
      "fixtures/search/decoy.txt": "TARGET_MARKER=decoy-not-valid\n",
      [`fixtures/search/${hiddenName}`]: `TARGET_MARKER=${marker}\n`,
    },
  })
  await writeLiveArtifact(
    { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
    `${artifact.suite}-observed`,
    artifact,
  )

  const read = requireCase(artifact.cases, "read")
  requireCompletedTools(read, ["read"])
  requireMarker(read.finalText, marker, "read final answer")
  if (extended) {
    const glob = requireCase(artifact.cases, "glob-read")
    requireToolSequence(glob, ["glob", "read"])
    requireMarker(glob.finalText, marker, "glob/read final answer")
    const grep = requireCase(artifact.cases, "grep-read")
    requireToolSequence(grep, ["grep", "read"])
    requireMarker(grep.finalText, marker, "grep/read final answer")
  }
  artifact.cases.forEach((testCase) => requireRuntimeMetadata(testCase, artifact.fingerprint.modelID))
  return {
    ...artifact,
    evidence: { markerHash: Bun.hash(marker).toString(16), extended },
  }
}

async function mutationSuite() {
  const writeMarker = `write-${crypto.randomUUID()}`
  const editMarker = `edit-${crypto.randomUUID()}`
  const writeContent = `first line\nquoted: "value"\nunicode: \u4F60\u597D\nmarker: ${writeMarker}\n`
  const oldEdit = "header\nstate: pending\nneighbor: unchanged\n"
  const newEdit = `header\nstate: ${editMarker}\nneighbor: unchanged\n`
  const patchText = [
    "*** Begin Patch",
    "*** Update File: patches/one.txt",
    "@@",
    "-before ONE_OLD after",
    "+before ONE_NEW after",
    "*** Update File: patches/two.txt",
    "@@",
    "-before TWO_OLD after",
    "+before TWO_NEW after",
    "*** End Patch",
  ].join("\n")
  const cases = [
    {
      name: "write",
      agent: "write-test",
      prompt:
        `Call write exactly once to create generated/note.txt. Set the content argument to the decoded string ` +
        `represented by this JSON literal (do not include the outer quotes; interpret JSON escapes): ${JSON.stringify(writeContent)}. Then stop.`,
    },
    {
      name: "edit",
      agent: "edit-test",
      prompt:
        `First read fixtures/edit.txt, then call edit exactly once. Replace the exact string ${JSON.stringify("state: pending")} ` +
        `with ${JSON.stringify(`state: ${editMarker}`)}. Preserve every other byte. Then stop.`,
    },
    ...(extended
      ? [
          {
            name: "apply-patch",
            agent: "patch-test",
            prompt:
              `Call apply_patch exactly once with patchText exactly ${JSON.stringify(patchText)}. ` +
              "Do not call edit, write, read, or any other tool.",
          },
        ]
      : []),
  ]
  const artifact = await runV2LiveCases({
    suite: extended ? "file-mutations-ext-v2" : "file-mutations-v2",
    agents: {
      "write-test": {
        prompt: "Perform exactly the requested write operation and no other mutation.",
        permission: { "*": "deny", edit: { "*": "deny", "generated/note.txt": "allow" } },
      },
      "edit-test": {
        prompt: "Perform exactly the requested exact edit and no other mutation.",
        permission: {
          "*": "deny",
          read: { "*": "deny", "fixtures/edit.txt": "allow" },
          edit: { "*": "deny", "fixtures/edit.txt": "allow" },
        },
      },
      "patch-test": {
        prompt: "Perform exactly the requested patch and no other mutation.",
        permission: {
          "*": "deny",
          edit: { "*": "deny", "patches/one.txt": "allow", "patches/two.txt": "allow" },
        },
      },
    },
    cases,
    files: {
      "fixtures/edit.txt": oldEdit,
      "patches/one.txt": "before ONE_OLD after\n",
      "patches/two.txt": "before TWO_OLD after\n",
    },
    inspectFiles: ["generated/note.txt", "fixtures/edit.txt", "patches/one.txt", "patches/two.txt"],
  })
  await writeLiveArtifact(
    { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
    `${artifact.suite}-observed`,
    artifact,
  )

  requireCompletedTools(requireCase(artifact.cases, "write"), ["write"])
  requireCompletedTools(requireCase(artifact.cases, "edit"), ["read", "edit"])
  if (artifact.workspace.files["generated/note.txt"] !== writeContent) {
    throw new Error("write did not persist the exact requested bytes")
  }
  if (artifact.workspace.files["fixtures/edit.txt"] !== newEdit) {
    throw new Error("edit changed the wrong bytes or did not persist")
  }
  const expectedPaths = new Set(["fixtures/edit.txt", "generated/note.txt"])
  if (extended) {
    requireCompletedTools(requireCase(artifact.cases, "apply-patch"), ["apply_patch"])
    if (artifact.workspace.files["patches/one.txt"] !== "before ONE_NEW after\n") {
      throw new Error("apply_patch did not update patches/one.txt exactly")
    }
    if (artifact.workspace.files["patches/two.txt"] !== "before TWO_NEW after\n") {
      throw new Error("apply_patch did not update patches/two.txt exactly")
    }
    expectedPaths.add("patches/one.txt")
    expectedPaths.add("patches/two.txt")
  }
  const changedPaths = artifact.workspace.status
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.slice(3).replace(/\/$/, ""))
  if (changedPaths.length !== expectedPaths.size || changedPaths.some((file) => !expectedPaths.has(file))) {
    throw new Error(`Mutation allowlist mismatch: ${changedPaths.join(", ") || "no changes"}`)
  }
  artifact.cases.forEach((testCase) => requireRuntimeMetadata(testCase, artifact.fingerprint.modelID))
  return {
    ...artifact,
    evidence: {
      writeMarkerHash: Bun.hash(writeMarker).toString(16),
      editMarkerHash: Bun.hash(editMarker).toString(16),
      changedPaths: changedPaths.toSorted(),
      rejectedToolCalls: artifact.cases.flatMap((testCase) =>
        testCase.tools.filter((tool) => tool.status === "error").map((tool) => tool.name),
      ),
      extended,
    },
  }
}

function requireCase<Cases extends ReadonlyArray<{ name: string }>>(cases: Cases, name: string): Cases[number] {
  const testCase = cases.find((value) => value.name === name)
  if (!testCase) throw new Error(`Missing live case ${name}`)
  return testCase
}

function requireCompletedTools(testCase: { name: string; tools: Array<{ name: string; status: string }> }, names: string[]) {
  const completed = testCase.tools.filter((tool) => tool.status === "completed")
  if (
    completed.length !== names.length ||
    completed.some((tool, index) => tool.name !== names[index]) ||
    testCase.tools.some((tool) => tool.status !== "completed")
  ) {
    throw new Error(
      `${testCase.name} tool sequence mismatch: ${testCase.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
    )
  }
}

function requireToolSequence(testCase: { name: string; tools: Array<{ name: string; status: string }> }, names: string[]) {
  const matched = names.reduce(
    (offset, name) => {
      if (offset < 0) return offset
      const next = testCase.tools.findIndex(
        (tool, index) => index >= offset && tool.name === name && tool.status === "completed",
      )
      return next < 0 ? -1 : next + 1
    },
    0,
  )
  if (matched < 0 || testCase.tools.some((tool) => tool.status !== "completed")) {
    throw new Error(`${testCase.name} did not complete ${names.join(" -> ")} without tool errors`)
  }
}

function requireMarker(text: string, marker: string, source: string) {
  if (!text.includes(marker)) throw new Error(`${source} does not contain the file-only marker`)
}

function requireRuntimeMetadata(
  testCase: {
    name: string
    models: Array<{ providerID: string; modelID: string }>
    usage: { input: number; output: number }
    sessionUsage: { input: number; output: number }
  },
  modelID: string,
) {
  if (
    testCase.models.length === 0 ||
    testCase.models.some((model) => model.providerID !== "live-deepseek" || model.modelID !== modelID)
  ) {
    throw new Error(`${testCase.name} persisted the wrong provider/model identity`)
  }
  if (testCase.usage.input <= 0 || testCase.usage.output <= 0) {
    throw new Error(`${testCase.name} did not persist assistant usage`)
  }
  if (testCase.sessionUsage.input <= 0 || testCase.sessionUsage.output <= 0) {
    throw new Error(`${testCase.name} did not aggregate Session usage`)
  }
}
