import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { AgentGateway } from "@deepagent-code/core/agent-gateway"

type ExtendedProblemProfile = Parameters<typeof AgentGateway.DeepAgentDomainPackRegistry.score>[0]

// docs/34 §4.1/§5 — ProfileDetector: build a multi-dimensional ExtendedProblemProfile from real
// workspace signals so domain pack activation is driven by facts, not guesses. Production callers
// pass the workspace-context output (languages/frameworks already detected) plus the current round
// signals and any user overrides. Does NOT do its own fs scanning — delegates to what workspace-
// context already computed and is handed in as input.

export type WorkspaceSignals = {
  readonly cwd: string
  readonly agentMode: "general" | "high" | "max" | "ultra"
  readonly scenarioMode: "direct" | "wish"
  readonly userRequest: string
  readonly languages?: readonly string[]
  readonly frameworks?: readonly string[]
  readonly packageScripts?: Readonly<Record<string, string>>
  // Optional round signals from prior diagnosis / validation
  readonly roundSignals?: readonly string[]
  // User-pinned packs (from settings / HTTP API override)
  readonly userOverrides?: readonly string[]
}

const CODE_RISK_KEYWORDS = /security|auth|payment|billing|crypto|encrypt|secret|vuln|cve|pentest/i
const FINANCE_KEYWORDS = /finance|payment|billing|ledger|accounting|invoice|transaction|audit/i
const HEALTHCARE_KEYWORDS = /health|medical|patient|ehr|phi|hipaa|dicom|clinical/i
const PRIVACY_KEYWORDS = /gdpr|pii|personal.?data|privacy|consent|anonymi/i
const PHI_KEYWORDS = /phi|protected.health|patient.record/i
const READ_ONLY_QUERY_KEYWORDS =
  /\b(query|count|list|show|read|inspect|status|diff|log|config|select|explain|grep|rg|find)\b|查一下|查询|统计|列出|显示|读取|看一下|多少个|有哪些|当前状态|日志里|配置里|数据库里/i
const MUTATION_KEYWORDS =
  /\b(fix|implement|edit|modify|write|delete|deploy|migrate|migration|backfill|transaction|constraint|insert|update|alter|drop|restart|apply|remove)\b|修复|实现|修改|写入|删除|部署|迁移|更新|重启/i

// Detect languages from the workspace (package.json / pyproject / go.mod / Cargo.toml etc.).
const detectLanguages = (cwd: string): string[] => {
  const langs: string[] = []
  if (existsSync(path.join(cwd, "package.json"))) {
    langs.push("javascript")
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (deps["typescript"] || deps["@types/node"] || existsSync(path.join(cwd, "tsconfig.json"))) {
        langs.push("typescript")
      }
    } catch { langs.push("typescript") } // assume TS on parse failure
  }
  if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "setup.py"))) langs.push("python")
  if (existsSync(path.join(cwd, "go.mod"))) langs.push("go")
  if (existsSync(path.join(cwd, "Cargo.toml"))) langs.push("rust")
  if (existsSync(path.join(cwd, "CMakeLists.txt"))) langs.push("cpp")
  return [...new Set(langs)]
}

// Detect frameworks from package.json deps.
const detectFrameworks = (cwd: string): string[] => {
  const fw: string[] = []
  const pkgFile = path.join(cwd, "package.json")
  if (!existsSync(pkgFile)) return fw
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps["react"] || deps["react-dom"]) fw.push("react")
    if (deps["solid-js"]) fw.push("solidjs")
    if (deps["vue"]) fw.push("vue")
    if (deps["svelte"]) fw.push("svelte")
    if (deps["next"]) fw.push("next.js")
    if (deps["express"] || deps["fastify"] || deps["hono"] || deps["@hono/core"]) fw.push("backend-framework")
    if (deps["drizzle-orm"] || deps["prisma"] || deps["typeorm"]) fw.push("orm")
    if (deps["bun"]) fw.push("bun")
    if (deps["effect"]) fw.push("effect")
  } catch { /* skip */ }
  return [...new Set(fw)]
}

// Derive code_domains from languages, frameworks, and user request.
const deriveCodeDomains = (langs: string[], frameworks: string[], request: string): string[] => {
  const d: string[] = ["code"]
  if (frameworks.some((f) => ["react","solidjs","vue","svelte"].includes(f))) d.push("frontend")
  if (frameworks.some((f) => f === "backend-framework")) d.push("backend")
  if (langs.includes("cuda") || langs.includes("cpp") || /\b(kernel|gemm|cuda|gpu|sgemm|rocm)\b/i.test(request)) {
    d.push("gpu_kernel")
    if (!langs.includes("cpp")) langs.push("cpp")
  }
  if (langs.includes("python")) d.push("data")
  if (READ_ONLY_QUERY_KEYWORDS.test(request) && !MUTATION_KEYWORDS.test(request)) {
    d.push("query", "deterministic", "read_only")
  }
  return [...new Set(d)]
}

// Extract risk markers from the user request + repo signals.
const extractRiskMarkers = (request: string, repoSignals: string[]): string[] => {
  const m: string[] = []
  const hay = `${request} ${repoSignals.join(" ")}`.toLowerCase()
  if (CODE_RISK_KEYWORDS.test(hay)) m.push("security")
  if (FINANCE_KEYWORDS.test(hay)) m.push("finance")
  if (HEALTHCARE_KEYWORDS.test(hay)) m.push("healthcare")
  if (PRIVACY_KEYWORDS.test(hay)) m.push("pii", "privacy")
  if (PHI_KEYWORDS.test(hay)) m.push("phi")
  return [...new Set(m)]
}

// Extract business_domains from request + risk markers.
const deriveBusinessDomains = (request: string, riskMarkers: string[]): string[] => {
  const d: string[] = []
  if (FINANCE_KEYWORDS.test(request) || riskMarkers.includes("finance")) d.push("finance")
  if (HEALTHCARE_KEYWORDS.test(request) || riskMarkers.includes("healthcare")) d.push("healthcare")
  return d
}

// Infer a rough task_kind from the user request (heuristic; good enough for pack scoring).
const inferTaskKind = (request: string): ExtendedProblemProfile["task_kind"] => {
  const r = request.toLowerCase()
  if (/\b(fix|bug|error|fail|broken|crash|traceback)\b/.test(r)) return "debug"
  if (/\b(review|audit|check|inspect|scan)\b/.test(r)) return "review"
  if (/\b(test|spec|coverage|unit|e2e|integration)\b/.test(r)) return "test"
  if (/\b(migrat|upgrade|refactor|rename|move|convert)\b/.test(r)) return "migrate"
  if (/\b(optim|improv|speed|perf|latency|memory|throughput)\b/.test(r)) return "optimize"
  if (/\b(explain|document|describe|what|how|why)\b/.test(r)) return "explain"
  if (/\b(deploy|release|ship|produc|operation)\b/.test(r)) return "operate"
  return "implement"
}

// Collect signals from the repo (directory names, config files, README snippet).
const collectRepoSignals = (cwd: string, userRequest: string): string[] => {
  const signals: string[] = [userRequest.slice(0, 200)]
  try {
    const readmePath = ["README.md", "README.txt", "readme.md"].map((f) => path.join(cwd, f)).find(existsSync)
    if (readmePath) signals.push(readFileSync(readmePath, "utf8").slice(0, 500))
  } catch { /* skip */ }
  return signals
}

// Build a full ExtendedProblemProfile from workspace signals. This is the production entry point
// called by the gateway/orchestrator before pack activation (docs/34 §5/§9 S5).
export const buildProfile = (signals: WorkspaceSignals): ExtendedProblemProfile => {
  const langs = signals.languages?.length ? [...signals.languages] : detectLanguages(signals.cwd)
  const frameworks = signals.frameworks?.length ? [...signals.frameworks] : detectFrameworks(signals.cwd)
  const repoSignals = collectRepoSignals(signals.cwd, signals.userRequest)
  const codeDomains = deriveCodeDomains(langs, frameworks, signals.userRequest)
  const riskMarkers = extractRiskMarkers(signals.userRequest, repoSignals)
  const businessDomains = deriveBusinessDomains(signals.userRequest, riskMarkers)

  return {
    scenario_mode: signals.scenarioMode,
    agent_strength: signals.agentMode,
    task_kind: inferTaskKind(signals.userRequest),
    code_domains: codeDomains,
    business_domains: businessDomains,
    platforms: [],
    languages: langs,
    frameworks,
    data_classes: riskMarkers.filter((r) => ["pii","phi"].includes(r)),
    risk_markers: riskMarkers,
    repo_signals: repoSignals.slice(0, 3),
    round_signals: signals.roundSignals ?? [],
    user_overrides: signals.userOverrides ?? [],
  }
}
