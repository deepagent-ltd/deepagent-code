import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { LearningCandidate } from "./learning"
import * as Learning from "./learning"
import type { AgentMode } from "./mode"
import type { RoundState } from "./round-state"
import type { ProjectPaths } from "./workspace"
import { DurableKnowledgeStore, openProjectStore, type KnowledgeDocInput } from "./durable-knowledge-store"
import type { DocType, EvidenceStrength } from "./document-store"
import { evidenceFromConfidence } from "./knowledge-retriever"
import { fingerprint as candidateFingerprint, type RejectedBuffer } from "./promotion"
import * as Governance from "./memory-governance"

export const MEMORY_INBOX_SCHEMA_VERSION = "deepagent-code.memory_inbox_item.v1"
export const SKILL_RECORD_SCHEMA_VERSION = "deepagent-code.skill_record.v1"

export type LearningTrigger = "idle" | "pause" | "project_switch" | "session_finalization"
export type LearningPolicy = "auto_merge_safe_project" | "manual_review"

export type LearningWorkerInput = {
  readonly projectID: string
  readonly sessionID: string
  readonly runID: string
  readonly mode: AgentMode
  readonly roundState: RoundState
  readonly totalRounds: number
  readonly finalStatus: "completed" | "failed"
  readonly trigger: LearningTrigger
  readonly policy?: LearningPolicy
}

export type MemoryInboxItem = {
  readonly schema_version: typeof MEMORY_INBOX_SCHEMA_VERSION
  readonly id: string
  readonly project_id: string
  readonly candidate: LearningCandidate
  readonly reason: string
  readonly created_at: string
  readonly status: "pending" | "merged" | "archived"
}

export type LearningWorkerResult = {
  readonly trigger: LearningTrigger
  readonly enqueue_ms: number
  readonly candidate_count: number
  readonly auto_merged_ids: readonly string[]
  readonly inbox_ids: readonly string[]
  readonly skipped_ids: readonly string[]
}

export type SkillRecord = {
  readonly schema_version: typeof SKILL_RECORD_SCHEMA_VERSION
  readonly id: string
  readonly title: string
  readonly body: string
  readonly source_candidate_ids: readonly string[]
  readonly status: "active" | "archived"
  readonly supersedes: readonly string[]
  readonly restored_from?: string
  readonly updated_at: string
}

const safeFileID = (id: string): string => id.replace(/[^A-Za-z0-9._:-]/g, "_").replace(/:/g, "__")

const writeJson = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8")
}

export class LearningWorker {
  private readonly store: DurableKnowledgeStore
  // The durable store is the SINGLE knowledge body (docs/34 §8). Production injects it (opened for
  // this project under the gateway's baseDir); the legacy ProjectPaths-only ctor opens one from the
  // project root for back-compat with existing call sites/tests.
  constructor(
    private readonly paths: ProjectPaths,
    private readonly projectID = readProjectID(paths),
    store?: DurableKnowledgeStore,
    // The durable RejectedBuffer (the human-`reject` fingerprint cache). Gate 3 (R3 anti-pollution)
    // consults it so a pattern a human explicitly rejected is NOT silently re-learned + auto-admitted on
    // a later run. Injected by the caller that owns the memory-dir path (the reject handler writes the
    // SAME buffer). Omitted ⇒ gate 3 is inert (back-compat for tests / callers without a buffer).
    private readonly rejectedBuffer?: RejectedBuffer,
  ) {
    // ProjectPaths.root is <baseDir>/project/<pid>; the durable knowledge store roots at
    // <baseDir>/project/<pid>/knowledge — i.e. a "knowledge" subdir of the project root.
    this.store = store ?? new DurableKnowledgeStore(path.join(paths.root, "knowledge"))
  }

  run(input: LearningWorkerInput): LearningWorkerResult {
    const started = Date.now()
    const extraction = Learning.extract({
      runId: input.runID,
      mode: input.mode,
      roundState: input.roundState,
      totalRounds: input.totalRounds,
      finalStatus: input.finalStatus,
    })
    const policy = input.policy ?? "auto_merge_safe_project"
    const autoMerged: string[] = []
    const inbox: string[] = []
    const skipped: string[] = []

    for (const candidate of extraction.candidates) {
      // U6 governance pipeline (S1 §P1): default fully automatic; route to a human ONLY for the four
      // cases a machine can't safely decide (sensitive / high-trust contradiction / pack promotion /
      // global promotion). Gates 3/4 (exact dedup + near-dup merge) live in the store's
      // stageCandidate; gate 8 (admit) is approve(). manual_review policy forces ALL candidates to
      // review regardless of route.
      const classification = Governance.classify(candidate)
      const contradictsHighTrust = this.detectHighTrustContradiction(candidate, classification)
      const govRoute = Governance.route({
        classification,
        // Gate 3 (R3): consult the durable RejectedBuffer by fingerprint so a pattern a human explicitly
        // rejected is dropped, not silently re-learned + auto-admitted. Extraction always emits fresh
        // candidates as status "staged" (never "rejected"), so the old `status === "rejected"` check was
        // ALWAYS false — the gate was vacuous and the buffer was never consulted on this path. When no
        // buffer is injected the gate stays inert (back-compat), matching the prior effective behavior.
        inRejectedBuffer:
          (this.rejectedBuffer?.has(candidateFingerprint(candidate)) ?? false) || candidate.status === "rejected",
        contradictsHighTrust,
        // Learning candidates never self-promote into a pack or to global scope; those are explicit
        // human actions (gate 6/7) handled in the review/promote path, so false here.
        promotesIntoPack: false,
        promotesToGlobal: false,
      })

      const forceReview = policy === "manual_review"
      const autoAdmit =
        !forceReview && govRoute.kind === "auto_admit" && Governance.meetsConfidenceFloor(candidate, classification)

      if (govRoute.kind === "drop") {
        skipped.push(candidate.candidate_id)
        continue
      }

      if (autoAdmit || candidate.status === "staged") {
        // Stage into the durable store (gate 3/4 dedup+merge happen here).
        const doc = this.store.stageCandidate(candidateToInput(candidate, this.projectID, input.trigger))
        if (autoAdmit) {
          this.store.approve(doc.id) // gate 8: admit (status -> active, retrievable)
          autoMerged.push(candidate.candidate_id)
        } else {
          // Routed to human review: keep the doc as a pending candidate (unretrievable) AND enqueue
          // an inbox item tagged with the specific review reason so the UI can group it.
          const reason = forceReview
            ? "manual review policy"
            : govRoute.kind === "review"
              ? govRoute.reason
              : "candidate requires review"
          inbox.push(this.enqueueInbox(candidate, input.projectID, reason))
        }
      } else {
        skipped.push(candidate.candidate_id)
      }
    }

    return {
      trigger: input.trigger,
      enqueue_ms: Date.now() - started,
      candidate_count: extraction.candidates.length,
      auto_merged_ids: autoMerged,
      inbox_ids: inbox,
      skipped_ids: skipped,
    }
  }

  listInbox(): MemoryInboxItem[] {
    const dir = inboxDir(this.paths)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as MemoryInboxItem)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  // U6 gate 5: a candidate contradicts existing knowledge when the store already holds a similar doc
  // of the same type/domain that is HIGH-TRUST (curated / pack / global / strong evidence). We reuse
  // the store's similarity search (the same one that drives near-dup merge) to find the neighbor; a
  // high-trust neighbor routes to human review, a low-trust one lets the store's merge/supersede win.
  private detectHighTrustContradiction(
    candidate: LearningCandidate,
    classification: Governance.Classification,
  ): boolean {
    const type: DocType = candidate.type === "anti_pattern" ? "failure_dossier" : candidate.type
    const neighbor = this.store.documentStore.findSimilarKnowledge({
      type,
      scope: `durable:project:${this.projectID}`,
      domain: null,
      description: candidate.summary,
    })
    void classification
    return neighbor ? Governance.isHighTrust(neighbor) : false
  }

  private enqueueInbox(candidate: LearningCandidate, projectID: string, reason: string): string {
    const id = `inbox:${candidate.candidate_id}`
    const item: MemoryInboxItem = {
      schema_version: MEMORY_INBOX_SCHEMA_VERSION,
      id,
      project_id: projectID,
      candidate,
      reason,
      created_at: new Date().toISOString(),
      status: "pending",
    }
    writeJson(path.join(inboxDir(this.paths), `${safeFileID(id)}.json`), item)
    return id
  }
}

const readProjectID = (paths: ProjectPaths): string => {
  try {
    return (
      (JSON.parse(readFileSync(paths.projectJson, "utf8")) as { project_id?: string }).project_id ?? "unknown-project"
    )
  } catch {
    return "unknown-project"
  }
}

const inboxDir = (paths: ProjectPaths): string => path.join(paths.docsDir, "memory-inbox")

// Map a learning candidate to a durable knowledge doc input (docs/34 §8). anti_pattern becomes a
// failure_dossier (negative knowledge — never a positive injection, DAP-12). All learned knowledge
// is project-shared and tagged with the run trigger; sensitivity uses the single governance detector
// (U6 gate 1) so the write-side tag and the routing decision can never diverge.
const candidateToInput = (
  candidate: LearningCandidate,
  projectID: string,
  trigger: LearningTrigger,
): KnowledgeDocInput => {
  const type: DocType = candidate.type === "anti_pattern" ? "failure_dossier" : candidate.type
  const strength: EvidenceStrength = evidenceFromConfidence(candidate.confidence)
  return {
    type,
    description: candidate.summary,
    body: candidate.summary,
    domain: null,
    tags: [candidate.type, "learned", trigger],
    scope: "project-shared",
    projectId: projectID,
    sensitivity: Governance.looksSensitive(candidate.summary) ? "secret_adjacent" : "source_code",
    risk: "low",
    confidence: { evidence_strength: strength, support_count: candidate.evidence_refs.length || 1 },
    provenance: { source: "runner", run_ref: candidate.source_run_id, evidence_refs: candidate.evidence_refs },
    idSlug: candidate.candidate_id,
  }
}

export class SkillCurator {
  constructor(private readonly paths: ProjectPaths) {
    mkdirSync(this.activeDir, { recursive: true })
    mkdirSync(this.archiveDir, { recursive: true })
  }

  merge(input: {
    readonly id: string
    readonly title: string
    readonly body: string
    readonly sourceCandidateIDs: readonly string[]
    readonly supersedes?: readonly string[]
  }): SkillRecord {
    const record: SkillRecord = {
      schema_version: SKILL_RECORD_SCHEMA_VERSION,
      id: input.id,
      title: input.title,
      body: input.body,
      source_candidate_ids: input.sourceCandidateIDs,
      status: "active",
      supersedes: input.supersedes ?? [],
      updated_at: new Date().toISOString(),
    }
    for (const oldID of record.supersedes) this.archive(oldID)
    writeJson(path.join(this.activeDir, `${safeFileID(record.id)}.json`), record)
    this.rewriteManifest()
    return record
  }

  archive(id: string): SkillRecord | null {
    const current = this.get(id)
    if (!current) return null
    const archived: SkillRecord = { ...current, status: "archived", updated_at: new Date().toISOString() }
    writeJson(path.join(this.archiveDir, `${safeFileID(id)}.json`), archived)
    rmActive(this.activeDir, id)
    this.rewriteManifest()
    return archived
  }

  restore(id: string): SkillRecord | null {
    const archived = this.getArchived(id)
    if (!archived) return null
    const restored: SkillRecord = {
      ...archived,
      status: "active",
      restored_from: id,
      updated_at: new Date().toISOString(),
    }
    writeJson(path.join(this.activeDir, `${safeFileID(id)}.json`), restored)
    this.rewriteManifest()
    return restored
  }

  list(): SkillRecord[] {
    return listRecords(this.activeDir)
  }

  get(id: string): SkillRecord | null {
    const file = path.join(this.activeDir, `${safeFileID(id)}.json`)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, "utf8")) as SkillRecord
  }

  private getArchived(id: string): SkillRecord | null {
    const file = path.join(this.archiveDir, `${safeFileID(id)}.json`)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, "utf8")) as SkillRecord
  }

  private rewriteManifest(): void {
    writeJson(path.join(this.paths.indexesDir, "skill-manifest.json"), {
      schema_version: "deepagent-code.skill_manifest.v1",
      active_skill_ids: this.list().map((skill) => skill.id),
      updated_at: new Date().toISOString(),
    })
  }

  private get activeDir(): string {
    return path.join(this.paths.publicDir, "skills", "active")
  }
  private get archiveDir(): string {
    return path.join(this.paths.publicDir, "skills", "archive")
  }
}

const listRecords = (dir: string): SkillRecord[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as SkillRecord)
    .sort((a, b) => a.id.localeCompare(b.id))
}

const rmActive = (dir: string, id: string): void => {
  const file = path.join(dir, `${safeFileID(id)}.json`)
  rmSync(file, { force: true })
}

// E1: LearningQueue moves background learning OFF the main task thread. The gateway's stream
// close() path enqueues a job (non-blocking) instead of running the worker inline; the queue
// drains asynchronously on a microtask, one job at a time, so a slow or failing learning pass
// never blocks or regresses the user-facing turn. Triggers (idle/pause/project_switch/
// session_finalization) are carried on the job and passed through to the worker.
export type LearningJob = {
  readonly trigger: LearningTrigger
  // Constructed lazily at drain time so I/O (ensureProject) also stays off the main path.
  readonly build: () => { worker: LearningWorker; input: LearningWorkerInput }
}

export class LearningQueue {
  private readonly jobs: LearningJob[] = []
  private draining = false
  private readonly completed: LearningWorkerResult[] = []
  // Injectable scheduler so tests can drain deterministically; defaults to a microtask so the
  // enqueueing turn returns before any learning work runs.
  constructor(private readonly schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn)) {}

  enqueue(job: LearningJob): void {
    this.jobs.push(job)
    if (!this.draining) {
      this.draining = true
      this.schedule(() => this.drain())
    }
  }

  private drain(): void {
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!
        try {
          const { worker, input } = job.build()
          this.completed.push(worker.run(input))
        } catch {
          // A failed learning pass is non-fatal and must not stop the queue or the turn.
        }
      }
    } finally {
      this.draining = false
    }
  }

  // Test/diagnostic helpers.
  get pending(): number {
    return this.jobs.length
  }
  get results(): readonly LearningWorkerResult[] {
    return this.completed
  }
  // Drain synchronously (tests): run all queued jobs now instead of on the scheduler.
  drainNow(): void {
    this.drain()
  }
}
