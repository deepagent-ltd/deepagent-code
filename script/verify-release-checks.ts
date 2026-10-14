#!/usr/bin/env bun

export const releaseCheckWorkflows = ["test.yml", "branding-check.yml", "generate.yml", "desktop-build.yml"]

export function assertReleaseChecksReceipt(value: unknown, input: {
  repository: string
  candidateCommit: string
  candidateTree: string
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new Error("release source checks repository is invalid")
  if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== "release-source-checks.v1" ||
    !("repository" in value) || value.repository !== input.repository || !("candidateCommit" in value) || value.candidateCommit !== input.candidateCommit ||
    !("candidateTree" in value) || value.candidateTree !== input.candidateTree || !("sourceCommit" in value) ||
    typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    !("checks" in value) || !Array.isArray(value.checks) || value.checks.length !== releaseCheckWorkflows.length ||
    !value.checks.every((check: unknown, index: number) => Boolean(check && typeof check === "object" &&
      "workflow" in check && check.workflow === releaseCheckWorkflows[index] && "passed" in check && check.passed === true &&
      "runID" in check && typeof check.runID === "number" && Number.isSafeInteger(check.runID) && check.runID > 0)) ||
    new Set(value.checks.map((check: unknown) => check && typeof check === "object" && "runID" in check ? check.runID : undefined)).size !== releaseCheckWorkflows.length)
    throw new Error("release source checks receipt is incomplete or belongs to another candidate")
  return value.sourceCommit
}

export async function verifyReleaseChecks(input: {
  repository: string
  sourceCommit: string
  token?: string
  timeoutMs?: number
  intervalMs?: number
  apiOrigin?: string
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !/^[a-f0-9]{40}$/.test(input.sourceCommit))
    throw new Error("release checks require an exact repository and source commit")
  const deadline = Date.now() + (input.timeoutMs ?? 30 * 60_000)
  const read = async (resource: string) => {
    const response = await fetch(`${input.apiOrigin ?? "https://api.github.com"}/repos/${input.repository}/${resource}`, {
      headers: { Accept: "application/vnd.github+json", ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`release checks read failed: HTTP ${response.status}`)
    return await response.json() as unknown
  }
  while (true) {
    const main = await read("git/ref/heads/main")
    if (!main || typeof main !== "object" || !("object" in main) || !main.object ||
      typeof main.object !== "object" || !("sha" in main.object) || main.object.sha !== input.sourceCommit)
      throw new Error("release source is no longer the current main commit")
    const results = await Promise.all(releaseCheckWorkflows.map(async (workflow) => {
      const value = await read(`actions/workflows/${workflow}/runs?head_sha=${input.sourceCommit}&event=push&per_page=100`)
      if (!value || typeof value !== "object" || !("workflow_runs" in value) || !Array.isArray(value.workflow_runs))
        throw new Error(`release check response is invalid: ${workflow}`)
      const runs = value.workflow_runs.filter((run: unknown): run is {
        id: number; head_sha: string; head_branch: string; event: string; status: string; conclusion: string | null
      } => Boolean(run && typeof run === "object" && "id" in run && typeof run.id === "number" && Number.isSafeInteger(run.id) && run.id > 0 &&
        "head_sha" in run && run.head_sha === input.sourceCommit && "head_branch" in run && run.head_branch === "main" &&
        "event" in run && run.event === "push" && "status" in run && typeof run.status === "string" &&
        "conclusion" in run && (run.conclusion === null || typeof run.conclusion === "string")))
        .toSorted((a, b) => b.id - a.id)
      const run = runs[0]
      if (run?.status === "completed" && run.conclusion !== "success")
        throw new Error(`release check failed: ${workflow} run ${run.id} (${run.conclusion})`)
      return { workflow, runID: run?.id, passed: run?.status === "completed" && run.conclusion === "success" }
    }))
    if (results.every((result) => result.passed)) {
      const current = await read("git/ref/heads/main")
      if (!current || typeof current !== "object" || !("object" in current) || !current.object ||
        typeof current.object !== "object" || !("sha" in current.object) || current.object.sha !== input.sourceCommit)
        throw new Error("release source changed while checking workflows")
      return results
    }
    if (Date.now() >= deadline) throw new Error("release checks timed out waiting for exact-source main workflows")
    console.log(`Waiting for existing release checks: ${results.filter((result) => !result.passed).map((result) => result.workflow).join(", ")}`)
    await Bun.sleep(Math.min(input.intervalMs ?? 30_000, Math.max(0, deadline - Date.now())))
  }
}

if (import.meta.main) {
  if (!/^[a-f0-9]{40}$/.test(process.env.RELEASE_CANDIDATE_COMMIT ?? "") || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_CANDIDATE_TREE ?? ""))
    throw new Error("release source checks require frozen candidate commit and tree")
  const results = await verifyReleaseChecks({
    repository: process.env.GH_REPO ?? "",
    sourceCommit: process.env.RELEASE_SOURCE_COMMIT ?? "",
    token: process.env.GH_TOKEN,
  })
  const receipt = { schemaVersion: "release-source-checks.v1", repository: process.env.GH_REPO,
    sourceCommit: process.env.RELEASE_SOURCE_COMMIT, candidateCommit: process.env.RELEASE_CANDIDATE_COMMIT,
    candidateTree: process.env.RELEASE_CANDIDATE_TREE, checks: results }
  if (!process.env.RELEASE_CHECKS_RECEIPT) throw new Error("release checks receipt output is required")
  await Bun.write(process.env.RELEASE_CHECKS_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log("Exact-source main checks passed; no workflows were triggered")
}
