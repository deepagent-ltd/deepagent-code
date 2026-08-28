// Pure HTTP client functions + types for the DeepAgent Review dialog. Split out from the .tsx so it
// carries NO UI imports (Kobalte/solid-web run client-only code at module eval, which crashes a
// server-side unit test). The route contract test imports THIS module; the component re-exports these
// for back-compat. Keep this file free of any solid-js/UI imports.

export type KnowledgeItem = {
  sourceStore: "user_global" | "project"
  id: string
  version: number
  hash: string
  candidateId: string
  fingerprint: string
  governanceRevision: string
  type: "knowledge" | "strategy" | "methodology" | "memory" | "skill" | "failure_dossier"
  summary: string
  evidence_strength: "strong" | "medium" | "weak" | "none"
  evidence_refs: string[]
  approval_status: "pending" | "approved" | "rejected"
  // Storage scope, for grouping by project vs global: "durable" (global) or
  // "durable:project:<project_id>". Absent from older servers → treated as global.
  scope?: string
}

type RawSdkClient = {
  client: {
    request<TData>(options: {
      method: string
      url: string
      body?: unknown
      headers?: Record<string, string>
    }): Promise<{ data?: TData }>
  }
}

export type ReviewClient = RawSdkClient

export const listPending = async (client: ReviewClient): Promise<KnowledgeItem[]> => {
  const response = await client.client.request<{ items: KnowledgeItem[] }>({
    method: "GET",
    url: "/deepagent/knowledge/pending",
  })
  return response.data?.items ?? []
}

export const reviewSummary = async (client: ReviewClient): Promise<{ pendingCount: number }> => {
  const response = await client.client.request<{ pendingCount?: number }>({
    method: "GET",
    url: "/deepagent/knowledge/review-summary",
  })
  return { pendingCount: response.data?.pendingCount ?? 0 }
}

export const setStatus = async (
  client: ReviewClient,
  action: "approve" | "reject-ids",
  item: KnowledgeItem,
): Promise<void> => {
  await client.client.request<{ updated: KnowledgeItem }>({
    method: "POST",
    url: `/deepagent/knowledge/${action}`,
    body: {
      sourceStore: item.sourceStore,
      id: item.id,
      version: item.version,
      hash: item.hash,
      candidateId: item.candidateId,
      fingerprint: item.fingerprint,
      expectedGovernanceRevision: item.governanceRevision,
    },
    headers: { "Content-Type": "application/json" },
  })
}

export const reviewAuthorityKey = (item: KnowledgeItem) =>
  JSON.stringify([
    item.sourceStore,
    item.id,
    item.version,
    item.hash,
    item.candidateId,
    item.fingerprint,
    item.governanceRevision,
  ])

// V3.8.1 §G environment-fact use-gate. Provisional user-global environment facts surface here so the
// user decides, per project, whether to adopt them (§G.5). Credentials never appear — only secret_ref
// pointers. `degraded` marks a fact whose last connection attempt failed (§G.6).
export type EnvFactBody = {
  host?: string
  port?: number
  container?: string
  purpose?: string
  secret_refs?: string[]
  last_confirmed_at: string
  notes?: string
}
export type EnvFactItem = {
  fact_id: string
  version: number
  description: string
  body: EnvFactBody | null
  degraded: boolean
}
export type EnvFactList = { adopted: EnvFactItem[]; pending: EnvFactItem[] }

export const listEnvFacts = async (client: ReviewClient): Promise<EnvFactList> => {
  const response = await client.client.request<EnvFactList>({ method: "GET", url: "/deepagent/env-facts" })
  return { adopted: response.data?.adopted ?? [], pending: response.data?.pending ?? [] }
}

export const decideEnvFact = async (
  client: ReviewClient,
  factId: string,
  decision: "adopt" | "reject",
): Promise<void> => {
  await client.client.request<{ ok: boolean }>({
    method: "POST",
    url: "/deepagent/env-facts/decide",
    body: { factId, decision },
    headers: { "Content-Type": "application/json" },
  })
}

// §G.5 modify: edit a fact then adopt it. mode=global corrects the shared fact for every project;
// mode=project writes a project-local override, leaving the global fact untouched for others.
export type EnvFactModifyInput = {
  factId: string
  description: string
  body: EnvFactBody
  domain?: string | null
  mode: "global" | "project"
}
export const modifyEnvFact = async (client: ReviewClient, input: EnvFactModifyInput): Promise<void> => {
  await client.client.request<{ ok: boolean; factId: string }>({
    method: "POST",
    url: "/deepagent/env-facts/modify",
    body: input,
    headers: { "Content-Type": "application/json" },
  })
}
