import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ProjectPaths } from "./workspace"
import type { AdoptionRecord } from "./environment-fact"
import { useGateAction, type EnvironmentFactBody } from "./environment-fact"
import {
  openUserGlobalStore,
  openProjectStore,
  type DurableKnowledgeStore,
} from "./durable-knowledge-store"
import type { DocRef } from "./document-store"

// V3.8.1 §G.5 use-gate persistence. A project's stance toward each user-global provisional
// environment fact (adopted / rejected, with optional pinned version or project-local override) is
// stored as one small JSON per fact under <project>/docs/env-adoption — mirroring the memory-inbox
// sidecar pattern (background-learning.ts) so it is rebuildable from files and needs no schema
// migration. The provisional facts themselves live once in the user-global store; this sidecar only
// records THIS project's decision, so the same fact can be adopted by one project and rejected by
// another without cross-talk (§G.8 isolation).

export const ENV_ADOPTION_SCHEMA_VERSION = "deepagent-code.env_adoption.v1"

const adoptionDir = (paths: ProjectPaths): string => path.join(paths.docsDir, "env-adoption")

const safeFileID = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, "_")

const writeJson = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

// A provisional fact as the use-gate should present it to a human (§G.5): the summary + parsed body
// (host/port/container/purpose/last_confirmed_at) + whether it is degraded (connect-failed).
export type UseGateFact = {
  readonly fact_id: string
  readonly version: number
  readonly description: string
  readonly body: EnvironmentFactBody | null
  readonly degraded: boolean // quarantined => last connection attempt failed (§G.6)
}

const parseBody = (raw: string): EnvironmentFactBody | null => {
  try {
    return JSON.parse(raw) as EnvironmentFactBody
  } catch {
    return null
  }
}

const toUseGateFact = (ref: DocRef, store: DurableKnowledgeStore): UseGateFact | null => {
  const doc = store.documentStore.get(ref.id)
  if (!doc) return null
  return {
    fact_id: doc.id,
    version: doc.version,
    description: doc.description,
    body: parseBody(doc.body),
    degraded: doc.status === "quarantined",
  }
}

// The use-gate service for one project. `baseDir` is the injected storage home; `paths` locates the
// project's sidecar dir; `workspacePath` roots the project store (for project-local overrides).
export class EnvironmentFactAdoption {
  private readonly userGlobal: DurableKnowledgeStore
  private readonly project: DurableKnowledgeStore

  constructor(
    private readonly baseDir: string,
    private readonly paths: ProjectPaths,
    private readonly workspacePath: string,
  ) {
    this.userGlobal = openUserGlobalStore(baseDir)
    this.project = openProjectStore(baseDir, workspacePath)
  }

  private records(): AdoptionRecord[] {
    const dir = adoptionDir(this.paths)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { record: AdoptionRecord })
      .map((x) => x.record)
  }

  private writeRecord(record: AdoptionRecord): void {
    writeJson(path.join(adoptionDir(this.paths), `${safeFileID(record.fact_id)}.json`), {
      schema_version: ENV_ADOPTION_SCHEMA_VERSION,
      record,
    })
  }

  // Partition the user-global provisional facts (plus already-quarantined ones, still shown with a
  // warning) into what this project should do at the use-gate (§G.5):
  //   adopted -> inject silently   pending -> ASK the human   (rejected/skip -> omitted)
  resolve(): { readonly adopted: readonly UseGateFact[]; readonly pending: readonly UseGateFact[] } {
    const records = this.records()
    const candidates = [
      ...this.userGlobal.listProvisionalEnvironmentFacts(),
      ...this.userGlobal.listByStatusForType("quarantined", "environment_fact"),
      ...this.userGlobal.listByStatusForType("active", "environment_fact"),
    ]
    const seen = new Set<string>()
    const adopted: UseGateFact[] = []
    const pending: UseGateFact[] = []
    for (const ref of candidates) {
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      const gate = useGateAction(ref.id, records)
      if (gate.action === "skip") continue
      // A project-local override replaces the global fact for this project.
      const sourceStore = gate.overrideDocId ? this.project : this.userGlobal
      const sourceId = gate.overrideDocId ?? ref.id
      const sourceRef = sourceStore.documentStore.get(sourceId)
      if (!sourceRef) continue
      const fact = toUseGateFact({ ...ref, id: sourceId }, sourceStore)
      if (!fact) continue
      ;(gate.action === "use" ? adopted : pending).push(fact)
    }
    return { adopted, pending }
  }

  // §G.5 "adopt": this project will silently use the fact (pinned to the current version), never ask
  // again. `now` is injected (no Date.now in the pure layer) for deterministic tests.
  adopt(factId: string, now: string): void {
    const doc = this.userGlobal.documentStore.get(factId)
    this.writeRecord({
      fact_id: factId,
      stance: "adopted",
      decided_at: now,
      ...(doc ? { adopted_version: doc.version } : {}),
    })
  }

  // §G.5 "reject": never ask again in THIS project (other projects unaffected — the sidecar is
  // per-project). Does not touch the global doc.
  reject(factId: string, now: string): void {
    this.writeRecord({ fact_id: factId, stance: "rejected", decided_at: now })
  }

  // §G.5 "modify": the user edited the fact. Two modes:
  //   global correction (default) -> update the user-global doc in place (version+1) AND adopt it.
  //   project override             -> write a project-scoped provisional fact and adopt THAT, leaving
  //                                    the global doc untouched (other projects keep the original).
  modify(input: {
    readonly factId: string
    readonly description: string
    readonly body: EnvironmentFactBody
    readonly domain?: string | null
    readonly mode: "global" | "project"
    readonly now: string
  }): { readonly updatedId: string } {
    const bodyJson = JSON.stringify(input.body)
    if (input.mode === "project") {
      const local = this.project.stageProvisionalEnvironmentFact({
        description: input.description,
        body: bodyJson,
        domain: input.domain ?? null,
        provenance: { source: "human" },
      })
      this.writeRecord({
        fact_id: input.factId,
        stance: "adopted",
        decided_at: input.now,
        override_doc_id: local.id,
      })
      return { updatedId: local.id }
    }
    const updated = this.userGlobal.stageProvisionalEnvironmentFact({
      description: input.description,
      body: bodyJson,
      domain: input.domain ?? null,
      provenance: { source: "human" },
    })
    this.writeRecord({ fact_id: updated.id, stance: "adopted", decided_at: input.now, adopted_version: updated.version })
    return { updatedId: updated.id }
  }

  // The endpoints this project has adopted — fed to matchStaleFacts (§G.6) so a connection failure
  // observed during this project's run can degrade the right global fact.
  adoptedEndpoints(): readonly { fact_id: string; host?: string; port?: number }[] {
    return this.resolve().adopted.map((f) => ({
      fact_id: f.fact_id,
      ...(f.body?.host ? { host: f.body.host } : {}),
      ...(f.body?.port !== undefined ? { port: f.body.port } : {}),
    }))
  }
}
