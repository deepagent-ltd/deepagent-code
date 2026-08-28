export type DeterministicTaskKind =
  | "deterministic_query"
  | "validation_status"
  | "state_inspection"
  | "mutation_request"
  | "repair"
  | "generation"
  | "unknown"

export type DeterministicTaskInput = {
  readonly raw: string
  readonly repoSignals?: readonly string[]
  readonly activePackIds?: readonly string[]
}

export type DeterministicToolPolicy = {
  readonly task_kind: DeterministicTaskKind
  readonly read_only: boolean
  readonly allowed_actions: readonly string[]
  readonly denied_actions: readonly string[]
  readonly reason: string
}

export type DeterministicResultKind = "query" | "git" | "validation" | "environment" | "log" | "database"

export type DeterministicResultInput = {
  readonly kind: DeterministicResultKind
  readonly source: "tool" | "runner" | "git" | "sql" | "filesystem" | "log" | "config"
  readonly commandOrQuery: string
  readonly resultSummary: string
  readonly resultRef?: string
  readonly createdAt?: string
}

export type DeterministicResult = {
  readonly schema_version: "deepagent-code.deterministic_result.v1"
  readonly kind: DeterministicResultKind
  readonly source: DeterministicResultInput["source"]
  readonly command_or_query: string
  readonly result_summary: string
  readonly result_ref: string | null
  readonly truncated: boolean
  readonly created_at: string
}

const QUERY_RE =
  /\b(query|count|list|show|read|inspect|status|diff|log|config|select|explain|grep|rg|find)\b|查一下|查询|统计|列出|显示|读取|看一下|多少个|有哪些|当前状态|日志里|配置里|数据库里/i
const VALIDATION_RE =
  /\b(test result|validation|typecheck|lint|build|tests? pass|tests? fail|exit code|失败在哪里|测试是否|是否通过)\b/i
const STATE_RE =
  /\b(env|environment|config|setting|port|model|provider|workspace|current state|当前配置|当前模型|端口|环境变量)\b/i
const MUTATION_RE =
  /\b(fix|implement|edit|modify|write|delete|deploy|migrate|insert|update|alter|drop|restart|apply|remove)\b|修复|实现|修改|写入|删除|部署|迁移|更新|重启/i
const GENERATION_RE = /\b(write|draft|create|generate|explain|summarize|document|生成|写一|解释|总结|文档)\b/i
const READONLY_SQL_RE = /^\s*(select|show|describe|desc|explain|pragma)\b/i
const SQL_MUTATION_RE =
  /\b(insert|update|delete|alter|drop|create|replace|truncate|merge|grant|revoke|call|execute|vacuum|analyze)\b/i

const textFor = (input: DeterministicTaskInput): string => [input.raw, ...(input.repoSignals ?? [])].join("\n")

export const hasMutationIntent = (input: DeterministicTaskInput | string): boolean =>
  MUTATION_RE.test(typeof input === "string" ? input : textFor(input))

export const hasQueryIntent = (input: DeterministicTaskInput | string): boolean => {
  const text = typeof input === "string" ? input : textFor(input)
  return QUERY_RE.test(text) && !MUTATION_RE.test(text)
}

export const isReadOnlySql = (sql: string): boolean => {
  const normalized = sql.trim().replace(/;+\s*$/g, "")
  if (normalized.length === 0) return false
  if (SQL_MUTATION_RE.test(normalized)) return false
  return READONLY_SQL_RE.test(normalized)
}

export const classifyDeterministicTask = (input: DeterministicTaskInput): DeterministicTaskKind => {
  const text = textFor(input)
  if (MUTATION_RE.test(text)) return "mutation_request"
  if (VALIDATION_RE.test(text)) return "validation_status"
  if (STATE_RE.test(text)) return "state_inspection"
  if (QUERY_RE.test(text)) return "deterministic_query"
  if (GENERATION_RE.test(text)) return "generation"
  return "unknown"
}

export const shouldActivateQueryControls = (input: DeterministicTaskInput): boolean => {
  if (hasMutationIntent(input)) return false
  if (input.activePackIds?.includes("code.query")) return true
  const kind = classifyDeterministicTask(input)
  return kind === "deterministic_query" || kind === "state_inspection" || kind === "validation_status"
}

export const deterministicToolPolicy = (input: DeterministicTaskInput): DeterministicToolPolicy => {
  const taskKind = classifyDeterministicTask(input)
  if (!shouldActivateQueryControls(input)) {
    return {
      task_kind: taskKind,
      read_only: false,
      allowed_actions: [],
      denied_actions: [],
      reason: "deterministic query controls are inactive for this task",
    }
  }

  return {
    task_kind: taskKind,
    read_only: true,
    allowed_actions: ["read", "search", "git_status", "git_diff", "read_log", "read_config", "readonly_sql"],
    denied_actions: ["edit", "write", "delete", "deploy", "migrate", "insert", "update", "alter", "drop", "restart"],
    reason: "deterministic query controls prefer read-only evidence and block mutation drift",
  }
}

export const buildDeterministicResult = (
  input: DeterministicResultInput,
  options: { readonly maxSummaryChars?: number } = {},
): DeterministicResult => {
  const max = options.maxSummaryChars ?? 2000
  const truncated = input.resultSummary.length > max
  return {
    schema_version: "deepagent-code.deterministic_result.v1",
    kind: input.kind,
    source: input.source,
    command_or_query: input.commandOrQuery,
    result_summary: truncated ? input.resultSummary.slice(0, max) : input.resultSummary,
    result_ref: input.resultRef ?? null,
    truncated,
    created_at: input.createdAt ?? new Date().toISOString(),
  }
}
