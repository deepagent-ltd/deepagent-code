#!/usr/bin/env bun
// The external qualification run supplies gate decisions. This only verifies and archives its
// content-addressed inputs; it never turns a pending gate into passed.
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { Hash } from "../../src/util/hash"

const gateIDs = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"] as const
const digest = async (file: string) => Hash.sha256(Buffer.from(await Bun.file(file).arrayBuffer()))

export async function verifyQualificationBundle(input: {
  directory: string
  commit: string
  tree: string
  runID?: string
  repository?: string
}) {
  const metadata = (await Bun.file(path.join(input.directory, "qualification.json")).json()) as {
    schemaVersion?: string
    sourceRunID?: string
    sourceRepository?: string
    candidateCommit?: string
    candidateTree?: string
    evidence?: { path: string; sha256: string }[]
  }
  const sourceRun = (await Bun.file(path.join(input.directory, "source-run.json")).json()) as {
    id?: number
    head_sha?: string
    conclusion?: string
    event?: string
    path?: string
    repository?: { full_name?: string }
  }
  for (const file of ["qualification.json", "gates.json", "source-run.json"])
    if (!(await lstat(path.join(input.directory, file))).isFile())
      throw new Error(`qualification ${file} is not a regular file`)
  if (metadata.schemaVersion !== "release-qualification.v1") throw new Error("qualification schema mismatch")
  if (metadata.candidateCommit !== input.commit || metadata.candidateTree !== input.tree)
    throw new Error("qualification candidate does not match release commit/tree")
  if (!metadata.sourceRunID || !/^\d+$/.test(metadata.sourceRunID) || metadata.sourceRunID !== String(sourceRun.id))
    throw new Error("qualification source run ID mismatch")
  if (input.runID && metadata.sourceRunID !== input.runID) throw new Error("qualification input run ID mismatch")
  if (
    !metadata.sourceRepository ||
    sourceRun.repository?.full_name !== metadata.sourceRepository ||
    (input.repository && metadata.sourceRepository !== input.repository)
  )
    throw new Error("qualification source repository mismatch")
  if (
    sourceRun.head_sha !== input.commit ||
    sourceRun.conclusion !== "success" ||
    sourceRun.event !== "workflow_dispatch" ||
    sourceRun.path?.split("@")[0] !== ".github/workflows/release-qualification-v2.yml"
  )
    throw new Error("qualification producer run did not succeed on candidate SHA")
  if (!Array.isArray(metadata.evidence) || metadata.evidence.length === 0)
    throw new Error("qualification evidence inventory is empty")

  const evidence = await Promise.all(
    metadata.evidence.map(async (entry) => {
      if (
        !/^evidence\/[A-Za-z0-9._/-]+$/.test(entry.path) ||
        entry.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("qualification evidence path is unsafe")
      const file = path.join(input.directory, entry.path)
      if (!(await lstat(file)).isFile()) throw new Error("qualification evidence is not a regular file")
      if (entry.sha256 !== (await digest(file)))
        throw new Error(`qualification evidence digest mismatch: ${entry.path}`)
      return entry
    }),
  )
  if (new Set(evidence.map((entry) => entry.path)).size !== evidence.length)
    throw new Error("qualification evidence path is duplicated")
  const actual = await readdir(path.join(input.directory, "evidence"), { recursive: true, withFileTypes: true })
  if (actual.some((entry) => entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())))
    throw new Error("qualification evidence contains a non-regular file")
  const listed = evidence.map((entry) => entry.path).toSorted()
  const present = actual
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .join("evidence", entry.parentPath.slice(path.join(input.directory, "evidence").length), entry.name)
        .replaceAll(path.sep, "/"),
    )
    .toSorted()
  if (present.join("\n") !== listed.join("\n")) throw new Error("qualification evidence inventory is incomplete")

  const gates = (await Bun.file(path.join(input.directory, "gates.json")).json()) as Record<string, unknown>
  if (Object.keys(gates).toSorted().join("\n") !== [...gateIDs].toSorted().join("\n"))
    throw new Error("qualification must define exactly G0-G8")
  const qualificationRef = `sha256:${await digest(path.join(input.directory, "qualification.json"))}`
  const refs = evidence.map((entry) => `sha256:${entry.sha256}`)
  for (const gate of gateIDs) {
    const entry = gates[gate]
    if (!entry || typeof entry !== "object" || !("status" in entry) || !("refs" in entry))
      throw new Error(`qualification ${gate} is malformed`)
    const status = entry.status
    const gateRefs = entry.refs
    if (!Array.isArray(gateRefs) || gateRefs.some((ref) => typeof ref !== "string"))
      throw new Error(`qualification ${gate} refs are malformed`)
    if (!["pending", "passed", "failed", "stale", "blocked"].includes(String(status)))
      throw new Error(`qualification ${gate} status is invalid`)
    if (status === "passed" && gateRefs.length === 0) throw new Error(`qualification ${gate} passed without refs`)
    if (status === "passed" && !gateRefs.some((ref) => refs.includes(ref)))
      throw new Error(`qualification ${gate} passed without gate evidence`)
    if (gateRefs.some((ref) => !refs.includes(ref) && !(gate === "G0" && ref === qualificationRef)))
      throw new Error(`qualification ${gate} has an unbound ref`)
  }
  if (!(gates.G0 as { refs: string[] }).refs.includes(qualificationRef))
    throw new Error("qualification provenance is not bound by G0")
  const used = gateIDs.flatMap((gate) => (gates[gate] as { refs: string[] }).refs)
  if (refs.some((ref) => !used.includes(ref))) throw new Error("qualification has unbound evidence")
  return { gates, evidence, sourceRunID: metadata.sourceRunID }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
  const directory = option("--dir")
  const commit = option("--commit")
  const tree = option("--tree")
  if (!directory || !commit || !tree)
    throw new Error(
      "usage: verify-qualification-bundle.ts --dir <dir> --commit <sha> --tree <sha> [--run-id <id>] [--repo <owner/name>]",
    )
  await verifyQualificationBundle({ directory, commit, tree, runID: option("--run-id"), repository: option("--repo") })
}
