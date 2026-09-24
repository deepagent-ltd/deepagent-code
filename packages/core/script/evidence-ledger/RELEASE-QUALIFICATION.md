# Release qualification artifact

The first 2.0.2 publish run freezes a versioned candidate commit and draft tag, then ends at
RI-51 NO-GO when no `qualification_run_id` is supplied. Run the external G0–G8 qualification
workflow with `workflow_dispatch` against that exact candidate SHA. It must upload one artifact
named `release-qualification-v2` containing:

- `qualification.json`: `schemaVersion: "release-qualification.v1"`, `sourceRunID` (decimal string),
  `sourceRepository` (`owner/repo`), `candidateCommit`, `candidateTree`, and `evidence` entries
  `{ "path": "evidence/<name>", "sha256": "<64 lowercase hex>" }`.
- `gates.json`: exactly `G0`–`G8`, each `{ "status": "passed|pending|failed|stale|blocked", "refs": [...] }`.
  A passing gate must cite at least one actual `evidence/` file as `sha256:<file digest>`.
  `G0.refs` must also cite `sha256:<qualification.json digest>` so the ledger binds the
  qualification run ID and candidate identity.
- Every listed `evidence/` file. These files must be real reviewed qualification results; the
  publish workflow never assigns gate statuses or manufactures evidence.

## Produce and review the candidate qualification

The producer is `.github/workflows/release-qualification-v2.yml`. Dispatch it **on the
`release-candidates/v<version>` branch** created by the first publish run, with the exact
`candidate_commit` and `candidate_tree` from that run. GitHub workflow dispatch selects a branch
or tag, not a free-standing SHA; the job checks the dispatch SHA, checked-out HEAD/tree, and remote
branch tip against these inputs before creating evidence. The workflow must exist on the repository's
default branch before GitHub accepts manual dispatch.

Without reviewed evidence, the producer executes candidate-tree static checks and uploads their raw
command output in `evidence/checks.json`, but emits **all nine gates pending**. A successful
workflow run with pending gates is still RI-51 NO-GO. No static check automatically upgrades a gate.

To add reviewed decisions, prepare a separate branch under `release-evidence/` containing
`release-qualification/review.json` and `release-qualification/evidence/*.json`. Dispatch the
producer again on the same frozen candidate branch with `review_ref` (the full
`refs/heads/release-evidence/...` name) and its exact `review_commit`. The producer verifies
the review branch's remote tip, fetches that fixed commit, and reads its data without executing code
from the review branch. Every evidence JSON must contain the same `candidateCommit` and
`candidateTree` as the candidate. The review manifest has this shape:

```json
{
  "schemaVersion": "release-qualification-review.v1",
  "candidateCommit": "<40-hex candidate commit>",
  "candidateTree": "<40-hex candidate tree>",
  "evidence": [
    { "path": "evidence/G0.json", "sha256": "<64-hex SHA-256 of exact file bytes>" }
  ],
  "gates": {
    "G0": { "status": "passed", "refs": ["sha256:<G0.json digest>"] },
    "G1": { "status": "pending", "refs": [] }
  }
}
```

`gates` must contain **all G0–G8**. Each passed gate must cite at least one real reviewed
`evidence/` file; the full evidence inventory must be referenced. The example shows only two
entries for brevity and cannot be submitted as-is. Evidence JSON should preserve the exact command,
working directory, candidate identity, result, source CI run/artifact URL and SHA-256 (or protected
external evidence reference), findings, and reviewer decision appropriate to that gate. G0 is the
contract freeze; G1 static checks; G2 deterministic tests; G3 independent adversarial review; G4
clean integration; G5 dynamic/crash/multiprocess; G6 real provider; G7 exact signed package
install/upgrade/platform; G8 release evidence, rollback, zero P0/P1, and approval. A test result
from a prior source tree, an unreviewed statement, or a green static job cannot satisfy another
gate. Preserve raw logs or immutable external artifacts for the reviewer.

Configure GitHub Environment `release-qualification` with nonempty **required reviewers** and
`prevent_self_review: true` before submitting any reviewed decisions. The workflow checks those
protection rules through GitHub's Environment API; missing configuration, API denial, or a
self-review-allowed rule fails closed. If the default `GITHUB_TOKEN` cannot read this environment,
configure `RELEASE_QUALIFICATION_REVIEW_TOKEN` with read access to the environment API. The
reviewer approves the protected job only after checking the exact review commit and underlying
evidence. The script verifies identity, file inventory, hashes and refs; the reviewer owns semantic
truth of the nine results. In reviewed mode, the job reruns static checks as a prerequisite, but
the final bundle contains only the review branch's explicitly cited evidence. The producer appends
only the run-specific `qualification.json` digest to G0 refs; it preserves every reviewed status
and other ref. The qualification file also records the fixed review branch, commit and manifest
digest for audit.

Re-dispatch the publish workflow for the same version with `qualification_run_id` set to that
completed successful run. The publish job downloads the artifact and fetches its GitHub run
record as `source-run.json`. It requires the run to be a successful `workflow_dispatch` on the
candidate SHA in the same repository, verifies every referenced byte, and archives the inputs
with the authoritative ledger. Any missing, stale, pending, or mismatched input remains NO-GO.

The workflow also probes the frozen Linux x64 package, stages every CLI archive plus desktop
assets, and binds their SHA-256 values into the ledger. After upload it downloads the draft
release assets and compares every byte with the staged manifest before package publication.
The six desktop updater source files are then checked against the staged installer bytes and
version before any package is published. The generated `latest.json` and four `latest*.yml`
files are uploaded to the draft release and read back byte for byte before the draft opens.
The workflow then uploads and reads back `release-updater-evidence.json`, which binds the
candidate commit/tree, tag, RI-51 ledger digest and exact ledger-file SHA-256 to the five updater
metadata sizes and SHA-256 values. This is a separate post-gate audit product: the updater
metadata bytes are not included in the original RI-51 ledger digest.
