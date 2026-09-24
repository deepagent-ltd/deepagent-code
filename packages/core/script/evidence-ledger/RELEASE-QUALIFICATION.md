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
