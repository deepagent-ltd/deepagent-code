import path from "node:path"
import { writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { failLiveScript, finishLiveScript } from "./lifecycle"
import { runLegacyLiveCases } from "./runtime"

const questionAnswer = "Canary"
const artifact = await runLegacyLiveCases({
  suite: "permissions-deny-legacy",
  permission: { "*": "deny" },
  primaryPermission: { "*": "deny", edit: "ask", bash: "ask", question: "allow" },
  permissionReply: { reply: "reject", message: "Live test operator rejected this operation." },
  questionReply: questionAnswer,
  inspectFiles: ["denied-write.txt", "denied-bash.txt"],
  cases: [
    {
      name: "write-rejected",
      prompt: [
        "Call write exactly once to create denied-write.txt containing forbidden.",
        "The permission operator will decide whether it runs.",
        "After the real tool result, reply with DENIED if it did not run. Never claim success after an error.",
      ].join("\n"),
    },
    {
      name: "bash-rejected",
      prompt: [
        "Call bash exactly once with command: printf forbidden > denied-bash.txt",
        "The permission operator will decide whether it runs.",
        "After the real tool result, reply with DENIED if it did not run. Never claim success after an error.",
      ].join("\n"),
    },
    {
      name: "question-answered",
      prompt: [
        "Call question exactly once and ask which deployment lane to use.",
        "Offer Stable and Canary as the two options.",
        "After the user answer arrives, report the selected lane exactly. Do not guess before using the tool.",
      ].join("\n"),
    },
  ],
})

const question = artifact.cases.find((testCase) => testCase.name === "question-answered")
const failures = artifact.cases
  .filter((testCase) => testCase.name !== "question-answered")
  .flatMap((testCase) => {
    const expectedTool = testCase.name === "write-rejected" ? "write" : "bash"
    const attempts = testCase.tools.filter((tool) => tool.name === expectedTool)
    return [
      ...(testCase.permissionRequests.length === 1
        ? []
        : [
            {
              classification: "runtime",
              message: `${testCase.name} expected one permission request, received ${testCase.permissionRequests.length}`,
            },
          ]),
      ...(testCase.permissionRequests[0]?.tool?.callID === testCase.tools[0]?.id
        ? []
        : [{ classification: "runtime", message: `${testCase.name} request is not bound to its durable tool call` }]),
      ...(attempts.length === 1 && attempts[0]?.status === "error"
        ? []
        : [
            {
              classification: "runtime",
              message: `${testCase.name} tool result mismatch: ${testCase.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
            },
          ]),
      ...(testCase.finalText.toUpperCase().includes("DENIED")
        ? []
        : [{ classification: "model-behavior", message: `${testCase.name} did not acknowledge rejection` }]),
    ]
  })
if (!question) failures.push({ classification: "runtime", message: "Missing Question observation" })
if (
  question &&
  (question.questionRequests.length !== 1 || question.questionRequests[0]?.tool?.callID !== question.tools[0]?.id)
) {
  failures.push({ classification: "runtime", message: "Question request is not bound to one durable tool call" })
}
if (
  question &&
  (question.tools.length !== 1 || question.tools[0]?.name !== "question" || question.tools[0].status !== "completed")
) {
  failures.push({
    classification: "runtime",
    message: `Question tool sequence mismatch: ${question.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`,
  })
}
if (question && !(typeof question.tools[0]?.output === "string" && question.tools[0].output.includes(questionAnswer))) {
  failures.push({ classification: "runtime", message: "Question tool output does not contain the injected answer" })
}
if (question && !question.finalText.includes(questionAnswer)) {
  failures.push({ classification: "model-behavior", message: "Model did not continue from the injected Question answer" })
}
if (Object.values(artifact.workspace.files).some((content) => content !== undefined)) {
  failures.push({ classification: "runtime", message: "Rejected operation produced a filesystem side effect" })
}
if (artifact.workspace.status.trim()) {
  failures.push({
    classification: "runtime",
    message: `Rejected operation changed the workspace: ${artifact.workspace.status.trim()}`,
  })
}

const resultArtifact = {
  ...artifact,
  mode: "ext" as const,
  status: failures.length === 0 ? ("passed" as const) : ("failed" as const),
  failures,
  evidence: {
    rejectedRequests: artifact.cases.reduce((total, testCase) => total + testCase.permissionRequests.length, 0),
    erroredTools: artifact.cases.flatMap((testCase) =>
      testCase.tools.filter((tool) => tool.status === "error").map((tool) => tool.name),
    ),
    questionAnswerHash: Bun.hash(questionAnswer).toString(16),
  },
}
await writeLiveArtifact(
  { artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
  resultArtifact.suite,
  resultArtifact,
)
if (failures.length > 0) {
  failLiveScript(
    `permissions-deny-legacy failed: ${failures.map((failure) => `${failure.classification}: ${failure.message}`).join("; ")}`,
  )
}
console.log(
  `${resultArtifact.suite}: passed (${resultArtifact.fingerprint.providerID}/${resultArtifact.fingerprint.modelID}, ` +
    `${resultArtifact.cases.reduce((total, testCase) => total + testCase.usage.input + testCase.usage.output, 0)} tokens)`,
)
finishLiveScript()
