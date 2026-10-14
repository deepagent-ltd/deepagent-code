import { expect, test } from "bun:test"
import { assertReleaseChecksReceipt, verifyReleaseChecks } from "./verify-release-checks"

const sourceCommit = "a".repeat(40)
const workflows = ["test.yml", "branding-check.yml", "generate.yml", "desktop-build.yml"]

test("release source checks receipt binds the complete workflow set to one candidate", () => {
  const expected = { repository: "deepagent-ltd/deepagent-code", candidateCommit: "b".repeat(40), candidateTree: "c".repeat(40) }
  const receipt = { schemaVersion: "release-source-checks.v1", ...expected, sourceCommit,
    checks: workflows.map((workflow, index) => ({ workflow, runID: index + 1, passed: true })) }
  expect(assertReleaseChecksReceipt(receipt, expected)).toBe(sourceCommit)
  for (const invalid of [null, { ...receipt, repository: "other/repository" }, { ...receipt, sourceCommit: "invalid" },
    { ...receipt, candidateCommit: sourceCommit }, { ...receipt, candidateTree: sourceCommit },
    { ...receipt, checks: receipt.checks.slice(1) }, { ...receipt, checks: receipt.checks.toReversed() },
    { ...receipt, checks: receipt.checks.map((check) => ({ ...check, passed: false })) },
    { ...receipt, checks: receipt.checks.map((check) => ({ ...check, runID: 0 })) },
    { ...receipt, checks: receipt.checks.map((check) => ({ ...check, runID: 1 })) }])
    expect(() => assertReleaseChecksReceipt(invalid, expected)).toThrow()
})

test("release distribution waits for existing exact-main checks and never dispatches a workflow", async () => {
  const methods: string[] = []
  const calls: string[] = []
  const server = Bun.serve({ port: 0, fetch(request) {
    methods.push(request.method)
    const url = new URL(request.url)
    calls.push(url.pathname)
    if (url.pathname.endsWith("/main")) return Response.json({ object: { sha: sourceCommit } })
    const workflow = url.pathname.split("/").at(-2)!
    return Response.json({ workflow_runs: [{ id: workflows.indexOf(workflow) + 1,
      head_sha: sourceCommit, head_branch: "main", event: "push", status: "completed", conclusion: "success" }] })
  } })
  try {
    const result = await verifyReleaseChecks({ repository: "deepagent-ltd/deepagent-code", sourceCommit,
      apiOrigin: server.url.origin, timeoutMs: 1000 })
    expect(result.map((entry) => entry.workflow)).toEqual(workflows)
    expect(result.every((entry) => entry.passed)).toBe(true)
    expect(methods).toEqual(Array(6).fill("GET"))
    expect(calls.filter((entry) => entry.endsWith("/main"))).toHaveLength(2)
  } finally { server.stop(true) }
})

test("release distribution rejects red, unrelated, stale and invalid workflow evidence", async () => {
  for (const scenario of ["failure", "cancelled", "wrong-source", "wrong-branch", "wrong-event", "missing", "bad-response", "old-green", "moved-main"]) {
    const server = Bun.serve({ port: 0, fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/main")) return Response.json({ object: { sha: scenario === "moved-main" ? "b".repeat(40) : sourceCommit } })
      if (scenario === "bad-response") return Response.json({ workflow_runs: {} })
      const run = { id: 2, head_sha: scenario === "wrong-source" ? "b".repeat(40) : sourceCommit,
        head_branch: scenario === "wrong-branch" ? "dev" : "main", event: scenario === "wrong-event" ? "workflow_dispatch" : "push",
        status: "completed", conclusion: ["failure", "cancelled", "old-green"].includes(scenario) ? "failure" : "success" }
      return Response.json({ workflow_runs: scenario === "missing" ? [] : scenario === "old-green"
        ? [{ ...run, id: 1, conclusion: "success" }, run] : [run] })
    } })
    try {
      await expect(verifyReleaseChecks({ repository: "deepagent-ltd/deepagent-code", sourceCommit,
        apiOrigin: server.url.origin, timeoutMs: 0 })).rejects.toThrow()
    } finally { server.stop(true) }
  }
})
