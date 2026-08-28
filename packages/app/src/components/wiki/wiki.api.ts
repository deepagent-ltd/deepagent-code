// Pure HTTP client functions + types for the V3.9 §B Repo & Wiki dialog. Split from the .tsx so it
// carries NO UI imports (the route-contract test imports THIS module). Mirrors the review dialog's
// raw-request pattern (client.client.request by path). The /deepagent/wiki/* routes are served by
// path and are NOT in the typed generated SDK, so we use the raw escape hatch. Directory is baked
// into the per-dir SDK client the dialog is opened with.

export type WikiPageSummary = {
  docId: string
  type: string
  title: string
  scope: string
  editable: boolean
  version: number
}

export type WikiCodeRef = {
  docId: string
  rel: string
  path: string | null
  line: number | null
  symbolPath: string | null
  stale: boolean
}
export type WikiDocRef = {
  docId: string
  rel: string
  type: string | null
  title: string
  stale: boolean
}
export type WikiPage = {
  docId: string
  type: string
  title: string
  markdown: string
  editable: boolean
  version: number
  crossLinks: { toCode: WikiCodeRef[]; toDocs: WikiDocRef[] }
}

export type WikiSearchHit = {
  docId: string
  type: string
  scope: string
  title: string
  score: number
}

export type ExecutionArchiveEntry = {
  docId: string
  type: string
  title: string
  body: string
  version: number
}
export type ExecutionArchive = {
  sessionId: string
  title: string
  markdown: string
  entries: ExecutionArchiveEntry[]
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

export type WikiClient = RawSdkClient

const JSON_HEADERS = { "Content-Type": "application/json" }

/** List projectable Wiki page summaries (sealed excluded), optionally filtered by doc type. */
export const listWikiPages = async (client: WikiClient, type?: string): Promise<WikiPageSummary[]> => {
  const url = type ? `/deepagent/wiki/pages?type=${encodeURIComponent(type)}` : "/deepagent/wiki/pages"
  const response = await client.client.request<{ pages: WikiPageSummary[] }>({ method: "GET", url })
  return response.data?.pages ?? []
}

/** Render one Wiki page (markdown + cross-links). */
export const getWikiPage = async (client: WikiClient, docId: string, scope: string): Promise<WikiPage | undefined> => {
  const response = await client.client.request<WikiPage>({
    method: "GET",
    url: `/deepagent/wiki/page?docId=${encodeURIComponent(docId)}&scope=${encodeURIComponent(scope)}`,
  })
  return response.data
}

/** Full-text search over the Wiki projection. */
export const searchWiki = async (
  client: WikiClient,
  input: { text: string; type?: string; scope?: string },
): Promise<WikiSearchHit[]> => {
  const params = new URLSearchParams({ text: input.text })
  if (input.type) params.set("type", input.type)
  if (input.scope) params.set("scope", input.scope)
  const response = await client.client.request<{ hits: WikiSearchHit[] }>({
    method: "GET",
    url: `/deepagent/wiki/search?${params.toString()}`,
  })
  return response.data?.hits ?? []
}

/**
 * Read a completed session's execution archive (§B.6 read side): the aggregated run-scoped trajectory
 * (plan + worklog + diagnosis + decision + eval) as markdown + entries. Returns undefined on an older
 * server without the route. `sessionID` is required — the archive is scoped to that session's run store.
 */
export const getExecutionArchive = async (
  client: WikiClient,
  sessionID: string,
): Promise<ExecutionArchive | undefined> => {
  const response = await client.client.request<ExecutionArchive>({
    method: "GET",
    url: `/deepagent/wiki/execution-archive?sessionID=${encodeURIComponent(sessionID)}`,
  })
  return response.data
}

/** Governed edit of a Knowledge/Memory page (real evidence-gate + human provenance). */
export const editWikiKnowledge = async (
  client: WikiClient,
  input: { docId: string; scope: string; body: string; editor: { id: string; name?: string } },
): Promise<WikiPage | undefined> => {
  const response = await client.client.request<WikiPage>({
    method: "POST",
    url: "/deepagent/wiki/edit",
    body: input,
    headers: JSON_HEADERS,
  })
  return response.data
}
