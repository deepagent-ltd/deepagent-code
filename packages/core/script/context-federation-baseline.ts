import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { openProjectStore } from "../src/deepagent/durable-knowledge-store"
import { knowledgeSimilarity, type Doc, type DocType, type LinkRel } from "../src/deepagent/document-store"
import { buildSystemPrompt, buildVolatileRoundContext, type PromptContext } from "../src/deepagent/prompt-policy"

const Source = Schema.Struct({
  path: Schema.String,
  anchors: Schema.NonEmptyArray(Schema.String),
})

const Node = Schema.Struct({
  id: Schema.String,
  graph: Schema.Literals(["code", "knowledge", "memory", "documents"]),
  docType: Schema.Literals(["code_symbol", "knowledge", "memory", "design", "requirements", "eval", "failure_dossier"]),
  description: Schema.String,
  source: Source,
})

const Edge = Schema.Struct({
  from: Schema.String,
  relation: Schema.Literals(["derived_from", "implements", "references", "validated_by"]),
  to: Schema.String,
})

const GoldenCase = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["single_graph", "cross_graph"]),
  query: Schema.String,
  nodes: Schema.NonEmptyArray(Node),
  edges: Schema.Array(Edge),
  seedNodeIds: Schema.Array(Schema.String).pipe(Schema.optional),
  expectedNodeIds: Schema.NonEmptyArray(Schema.String),
  expectedGraphs: Schema.NonEmptyArray(Schema.Literals(["code", "knowledge", "memory", "documents"])),
})

const GoldenSet = Schema.Struct({
  schemaVersion: Schema.Literal("context-federation-golden.v1"),
  repository: Schema.Literal("deepagent-code"),
  cases: Schema.NonEmptyArray(GoldenCase),
})

const repoRoot = path.resolve(import.meta.dir, "../../..")
const golden = Schema.decodeUnknownSync(GoldenSet, { onExcessProperty: "error" })(
  await Bun.file(path.join(repoRoot, "packages/core/test/context-federation/fixtures/golden-set.v1.json")).json(),
)
const iterations = Number(Bun.env.CONTEXT_BASELINE_ITERATIONS ?? 25)

if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000) {
  console.error("CONTEXT_BASELINE_ITERATIONS must be an integer between 1 and 1000")
  process.exit(1)
}

const timings: number[] = []
const firstEvidenceTimings: number[] = []
const caseResults: Array<{
  readonly id: string
  readonly passed: boolean
  readonly missingNodeIds: readonly string[]
  readonly missingGraphs: readonly string[]
  readonly sourceEvidenceValid: boolean
}> = []
const temp = mkdtempSync(path.join(tmpdir(), "deepagent-context-baseline-"))

try {
  for (const fixture of golden.cases) {
    const store = openProjectStore(temp, path.join(repoRoot, `.baseline-${fixture.id}`))
    const ids = new Map<string, string>()

    for (const node of fixture.nodes) {
      const created = store.documentStore.create({
        type: node.docType as DocType,
        scope: "durable",
        body: node.description,
        description: node.description,
        tags: [node.graph, fixture.id],
        provenance: { source: "runner", run_ref: `baseline:${fixture.id}`, evidence_refs: [node.source.path] },
        ...(node.graph === "knowledge" || node.graph === "memory"
          ? { confidence: { evidence_strength: "strong" as const, support_count: 1 } }
          : {}),
        idSlug: `${fixture.id}-${node.id}`,
        extensions: { baseline_id: node.id, baseline_graph: node.graph, source_path: node.source.path },
      })
      ids.set(node.id, created.id)
    }

    for (const edge of fixture.edges) {
      const from = ids.get(edge.from)
      const to = ids.get(edge.to)
      if (!from || !to) throw new Error(`Golden edge ${fixture.id}:${edge.from}->${edge.to} has no node`)
      store.documentStore.link(from, edge.relation as LinkRel, to)
    }

    const query = () =>
      runLegacyBaselineQuery(store, {
        task: fixture.query,
        seeds: fixture.seedNodeIds?.map((id) => ids.get(id) ?? id),
        depth: 2,
      })

    const start = performance.now()
    const first = query()
    firstEvidenceTimings.push(performance.now() - start)
    const observed = collect(first)

    for (const _ of Array.from({ length: iterations }, (_, index) => index)) {
      const measuredAt = performance.now()
      query()
      timings.push(performance.now() - measuredAt)
    }

    const sourceEvidenceValid = (
      await Promise.all(
        fixture.nodes.map(async (node) => {
          const file = Bun.file(path.join(repoRoot, node.source.path))
          if (!(await file.exists())) return false
          const content = await file.text()
          return node.source.anchors.every((anchor) => content.includes(anchor))
        }),
      )
    ).every(Boolean)
    const missingNodeIds = fixture.expectedNodeIds.filter((id) => !observed.nodeIds.has(id))
    const missingGraphs = fixture.expectedGraphs.filter((graph) => !observed.graphs.has(graph))
    caseResults.push({
      id: fixture.id,
      passed: sourceEvidenceValid && missingNodeIds.length === 0 && missingGraphs.length === 0,
      missingNodeIds,
      missingGraphs,
      sourceEvidenceValid,
    })
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

const expectedEvidence = golden.cases.reduce((total, fixture) => total + fixture.expectedNodeIds.length, 0)
const missingEvidence = caseResults.reduce((total, result) => total + result.missingNodeIds.length, 0)
const legacyCodeIntel = await Bun.file(path.join(repoRoot, "packages/deepagent-code/src/tool/code_intel.ts")).text()
const legacyPrompt = await Bun.file(path.join(repoRoot, "packages/deepagent-code/src/session/prompt.ts")).text()
const imExecutor = await Bun.file(path.join(repoRoot, "packages/deepagent-code/src/im/agent-executor-server.ts")).text()
const imContextBuilder = await Bun.file(path.join(repoRoot, "packages/core/src/im/context-builder.ts")).text()
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot })
const legacyPromptWithoutKnowledge = promptContext(null)
const legacyPromptWithKnowledge = promptContext({
  synthesis: "Use the persisted decision and verify it against current source evidence.",
  strategyRefs: [],
  methodologyRefs: [],
  memoryRefs: ["memory:project-bridge"],
  knowledgeRefs: ["knowledge:architecture-contract"],
  conflicts: [],
})
const legacyKnowledgeMemoryTail = buildVolatileRoundContext(legacyPromptWithKnowledge)

const report = {
  schemaVersion: "context-federation-baseline.v1",
  repository: golden.repository,
  revision: git.exitCode === 0 ? git.stdout.toString().trim() : "unknown",
  goldenSet: {
    schemaVersion: golden.schemaVersion,
    totalCases: golden.cases.length,
    singleGraphCases: golden.cases.filter((fixture) => fixture.kind === "single_graph").length,
    crossGraphCases: golden.cases.filter((fixture) => fixture.kind === "cross_graph").length,
    passedCases: caseResults.filter((result) => result.passed).length,
    expectedEvidence,
    matchedEvidence: expectedEvidence - missingEvidence,
    citationAccuracy: expectedEvidence === 0 ? 1 : (expectedEvidence - missingEvidence) / expectedEvidence,
    cases: caseResults,
  },
  latencyMs: {
    iterationsPerCase: iterations,
    queryP50: percentile(timings, 0.5),
    queryP95: percentile(timings, 0.95),
    firstEvidenceP95: percentile(firstEvidenceTimings, 0.95),
  },
  tokenAndCache: {
    tokenizer: "utf8_bytes_only",
    legacyKnowledgeMemoryTailBytes: Buffer.byteLength(legacyKnowledgeMemoryTail),
    legacyKnowledgeMemoryTailHash: new Bun.CryptoHasher("sha256").update(legacyKnowledgeMemoryTail).digest("hex"),
    legacyStablePrefixUnchangedWhenKnowledgeAppears:
      buildSystemPrompt(legacyPromptWithoutKnowledge) === buildSystemPrompt(legacyPromptWithKnowledge),
    automaticFederatedProjectionBytes: 0,
    automaticFederatedRuntimeTailMessages: 0,
    providerCacheReadTokens: {
      status: "external_required",
      reason: "Provider-billed cache tokens require a credentialed recorded Session and must not be inferred as zero",
    },
  },
  legacyBaselineFacts: {
    sessionScopedCodeIndexTrigger: true,
    graphQueryListsWholeStore: true,
    imFourGraphBucketsQueried: 4,
    imFourGraphBucketsDelivered: 0,
    imFourGraphBucketLossRate: 1,
  },
  releaseCandidateFacts: {
    sessionScopedCodeIndexTrigger:
      legacyPrompt.includes("indexedSessions") && legacyPrompt.includes("CodeIndexTrigger.indexWorkspace"),
    rollbackCodeIntelBackend: legacyCodeIntel.includes("CodeQueryService") ? "mixed" : "lsp_only",
    rollbackCodeIntelPermission: legacyCodeIntel.includes('permission: "lsp"') ? "lsp" : "unknown",
    rollbackCodeIntelFallbackHints: ["grep", "read"].filter((tool) => legacyCodeIntel.includes(tool)),
    legacyGraphQueryProductionModulePresent: await Bun.file(
      path.join(repoRoot, "packages/core/src/deepagent/graph-query.ts"),
    ).exists(),
    imFourGraphBucketsQueried: /UnifiedContextGraph|knowledge:|documents:/.test(imContextBuilder) ? 4 : 0,
    imConversationAdmittedThroughSession: imExecutor.includes("IM conversation:") && imExecutor.includes("promptOrSteer"),
    contextQueryRegistered: await Bun.file(
      path.join(repoRoot, "packages/deepagent-code/src/tool/context_query.ts"),
    ).exists(),
  },
}

console.log(JSON.stringify(report, null, 2))
if (report.goldenSet.passedCases !== report.goldenSet.totalCases) process.exit(1)

function collect(hits: readonly Doc[]) {
  return {
    nodeIds: new Set(
      hits.map((doc) => doc.extensions?.baseline_id).filter((id): id is string => typeof id === "string"),
    ),
    graphs: new Set(
      hits
        .map((doc) => doc.extensions?.baseline_graph)
        .filter((graph): graph is string => typeof graph === "string"),
    ),
  }
}

function runLegacyBaselineQuery(
  store: ReturnType<typeof openProjectStore>,
  input: { readonly task: string; readonly seeds?: readonly string[]; readonly depth: number },
) {
  const documents = new Map<string, Doc>()
  const frontier = [
    ...(input.seeds ?? []),
    ...store.documentStore.list().flatMap((ref) => {
      const doc = store.documentStore.get(ref.id)
      if (!doc) return []
      const text = `${doc.description} ${doc.tags.join(" ")} ${doc.body}`.slice(0, 4_000)
      return knowledgeSimilarity(text, input.task) > 0 ? [doc.id] : []
    }),
  ]
  const relations: readonly LinkRel[] = [
    "references",
    "implements",
    "derived_from",
    "validated_by",
    "refines",
    "depends_on",
    "supports",
    "requires",
    "contains",
    "imports",
    "calls",
  ]
  let level = [...new Set(frontier)]
  for (const id of level) {
    const doc = store.documentStore.get(id)
    if (doc && doc.scope !== "sealed") documents.set(id, doc)
  }
  for (const _ of Array.from({ length: input.depth })) {
    const next = level.flatMap((id) => store.documentStore.neighbors(id, relations, 1).map((ref) => ref.id))
    level = [...new Set(next.filter((id) => !documents.has(id)))]
    for (const id of level) {
      const doc = store.documentStore.get(id)
      if (doc && doc.scope !== "sealed") documents.set(id, doc)
    }
  }
  return [...documents.values()]
}

function percentile(values: readonly number[], quantile: number) {
  const sorted = values.toSorted((a, b) => a - b)
  return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0).toFixed(3))
}

function promptContext(knowledge: PromptContext["knowledge"]): PromptContext {
  return {
    mode: "max",
    round: 1,
    activation: {
      stage: "first_fast_design",
      allowKnowledgeRetrieval: true,
      allowFullRedesign: false,
      maxPromptChars: 10_000,
      maxInlineChars: 2_000,
      requireValidation: true,
      suggestedReasoningEffort: "high",
      guidance: "Work in short design, edit, and validation loops.",
    },
    roundState: {
      round: 1,
      phase: "planning",
      stage: "first_fast_design",
      mode: "max",
      candidates: [],
      diagnoses: [],
      best_candidate: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      budget_remaining_tokens: 100_000,
      started_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    },
    environment: {
      os: "baseline",
      shell: "/bin/sh",
      cwd: "/workspace",
      homedir: "/home/user",
      gitBranch: "dev",
      gitRoot: "/workspace",
      isGitRepo: true,
      date: "Jul 25, 2026",
      platform: "baseline",
    },
    task: {
      userRequest: "trace the architecture requirement to implementation and tests",
      taskType: "code_modification",
      domain: "code",
      goals: ["Trace evidence"],
      successCriteria: ["Citations resolve"],
      riskBoundaries: ["No unauthorized context"],
      validationCommands: ["bun test"],
    },
    tools: { availableTools: [], mcpServers: [], totalToolCount: 0 },
    knowledge,
    previousResults: null,
    userInstructions: null,
  }
}
