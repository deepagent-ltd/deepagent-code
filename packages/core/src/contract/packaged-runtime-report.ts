export * as PackagedRuntimeReportContract from "./packaged-runtime-report"

import { Schema } from "effect"
import { contentDigest } from "./digest"
import { NonNegativeInt } from "../schema"

/** RI-24/RI-75 report emitted by a packaged runtime probe. */
export const PackagedRuntimeReportVersion = {
  schema: "packaged-runtime-report.v1",
} as const

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const RelativePath = Schema.String.check(Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))\S+$/))

export const PackageArtifact = Schema.Struct({
  path: RelativePath,
  bytes: NonNegativeInt,
  sha256: Digest,
})
export type PackageArtifact = typeof PackageArtifact.Type

export const PackagedRuntimeRun = Schema.Struct({
  entrypoint: Schema.String.check(Schema.isPattern(/^(?=\S)[\s\S]+$/)),
  artifactPath: RelativePath,
  evidenceDigest: Digest,
  sessionID: Schema.String,
  attemptID: Schema.String,
  rootCompositionDigest: Digest,
  toolIDs: Schema.Array(Schema.String),
  physicalCallCount: NonNegativeInt,
  terminalStatus: Schema.Literals([
    "settled",
    "failed_terminal",
    "indeterminate_after_crash",
    "abandoned_before_dispatch",
    "resolved_abandoned",
    "resolved_settled",
  ]),
})
export type PackagedRuntimeRun = typeof PackagedRuntimeRun.Type

export const PackagedRuntimeReport = Schema.Struct({
  schemaVersion: Schema.Literal(PackagedRuntimeReportVersion.schema),
  candidateId: Schema.String,
  commit: Schema.String,
  tree: Schema.String,
  artifacts: Schema.Array(PackageArtifact),
  runs: Schema.Array(PackagedRuntimeRun),
  reportDigest: Digest,
  issuedAt: Schema.String,
})
export type PackagedRuntimeReport = typeof PackagedRuntimeReport.Type

export class PackagedRuntimeReportAuthorityError extends Schema.TaggedErrorClass<PackagedRuntimeReportAuthorityError>()(
  "PackagedRuntimeReportAuthorityError",
  { reason: Schema.String },
) {}

function stableReport(report: Pick<PackagedRuntimeReport, Exclude<keyof PackagedRuntimeReport, "reportDigest" | "issuedAt">>) {
  return {
    schemaVersion: report.schemaVersion,
    candidateId: report.candidateId,
    commit: report.commit,
    tree: report.tree,
    artifacts: [...report.artifacts].toSorted((a, b) => a.path.localeCompare(b.path)),
    runs: [...report.runs].toSorted((a, b) => `${a.entrypoint}\u0000${a.evidenceDigest}`.localeCompare(`${b.entrypoint}\u0000${b.evidenceDigest}`)),
  }
}

export function packagedRuntimeReportDigest(
  report: Pick<PackagedRuntimeReport, Exclude<keyof PackagedRuntimeReport, "reportDigest" | "issuedAt">>,
): string {
  return contentDigest(stableReport(report))
}

export function makePackagedRuntimeReport(input: {
  readonly candidateId: string
  readonly commit: string
  readonly tree: string
  readonly artifacts: readonly PackageArtifact[]
  readonly runs: readonly PackagedRuntimeRun[]
  readonly issuedAt?: string
}): PackagedRuntimeReport {
  const base = {
    schemaVersion: PackagedRuntimeReportVersion.schema,
    candidateId: input.candidateId,
    commit: input.commit,
    tree: input.tree,
    artifacts: [...input.artifacts].toSorted((a, b) => a.path.localeCompare(b.path)),
    runs: [...input.runs].toSorted((a, b) => `${a.entrypoint}\u0000${a.evidenceDigest}`.localeCompare(`${b.entrypoint}\u0000${b.evidenceDigest}`)),
  }
  const report = PackagedRuntimeReport.make({
    ...base,
    reportDigest: packagedRuntimeReportDigest(base),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  })
  return assertPackagedRuntimeReport(report)
}

export function assertPackagedRuntimeReport(input: unknown): PackagedRuntimeReport {
  const report = Schema.decodeUnknownSync(PackagedRuntimeReport, { onExcessProperty: "error" })(input)
  if (report.artifacts.some((artifact, index) => index > 0 && report.artifacts[index - 1]!.path >= artifact.path))
    throw new PackagedRuntimeReportAuthorityError({ reason: "artifacts_must_be_sorted_and_unique" })
  if (new Set(report.artifacts.map((artifact) => artifact.path)).size !== report.artifacts.length)
    throw new PackagedRuntimeReportAuthorityError({ reason: "artifacts_must_be_sorted_and_unique" })
  if (report.runs.some((run, index) => index > 0 && `${report.runs[index - 1]!.entrypoint}\u0000${report.runs[index - 1]!.evidenceDigest}` >= `${run.entrypoint}\u0000${run.evidenceDigest}`))
    throw new PackagedRuntimeReportAuthorityError({ reason: "runs_must_be_sorted_and_unique" })
  if (new Set(report.runs.map((run) => run.evidenceDigest)).size !== report.runs.length)
    throw new PackagedRuntimeReportAuthorityError({ reason: "runs_must_be_sorted_and_unique" })
  for (const run of report.runs) {
    if (!report.artifacts.some((artifact) => artifact.path === run.artifactPath))
      throw new PackagedRuntimeReportAuthorityError({ reason: `run_artifact_missing:${run.artifactPath}` })
    if (new Set(run.toolIDs).size !== run.toolIDs.length || run.toolIDs.join("\n") !== [...run.toolIDs].toSorted().join("\n"))
      throw new PackagedRuntimeReportAuthorityError({ reason: `run_tool_ids_must_be_sorted:${run.entrypoint}` })
  }
  if (report.reportDigest !== packagedRuntimeReportDigest(report))
    throw new PackagedRuntimeReportAuthorityError({ reason: "report_digest_mismatch" })
  return report
}
