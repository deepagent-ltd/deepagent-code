import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
  VcsInfo,
} from "@deepagent-code/sdk/client"
import { NormalizedProviderListResponse } from "@deepagent-code/ui/context"
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

// U2: live plan (goal + steps + progress) mirrored from the backend plan.updated event. Defined
// here (not in server-sync) so both the reducer and the sync context import it without a cycle.
export type SessionPlanStep = {
  step_id: string
  title: string
  status: string // pending | active | done | cancelled | blocked
  acceptance?: string | null
  assigned_agent?: string | null
  evidence?: string[]
  note?: string | null // U10: blocker explanation when status is "blocked"
}
export type SessionPlan = {
  plan_id: string
  plan_version: number
  goal: string
  assumptions: string[]
  active_step_id: string | null
  steps: SessionPlanStep[]
  done: number
  total: number
}

export type SessionPlanUpdateSource = "event" | "snapshot"
export type SessionPlanCursor = Pick<SessionPlan, "plan_id" | "plan_version"> | undefined

export type SessionPlanUpdateOptions = {
  source?: SessionPlanUpdateSource
  snapshotBaseline?: SessionPlanCursor
}

export const sessionPlanCursor = (plan: SessionPlan | undefined): SessionPlanCursor =>
  plan ? { plan_id: plan.plan_id, plan_version: plan.plan_version } : undefined

export const hasSessionPlanIdentityConflict = (
  current: SessionPlan | undefined,
  incoming: SessionPlan | undefined,
): boolean => !!current && !!incoming && current.plan_id !== incoming.plan_id

const sameSessionPlanCursor = (left: SessionPlanCursor, right: SessionPlanCursor): boolean =>
  left?.plan_id === right?.plan_id && left?.plan_version === right?.plan_version

/** Cursor and identity gate shared by live events and reconnect snapshots. */
export const acceptsSessionPlanUpdate = (
  current: SessionPlan | undefined,
  incoming: SessionPlan | undefined,
  options: SessionPlanUpdateOptions = {},
): boolean => {
  const source = options.source ?? "event"
  const snapshotCanRecalibrate =
    source === "snapshot" && sameSessionPlanCursor(sessionPlanCursor(current), options.snapshotBaseline)
  if (!incoming) return snapshotCanRecalibrate || current === undefined
  if (!current) return true
  if (current.plan_id !== incoming.plan_id) return snapshotCanRecalibrate
  return incoming.plan_version >= current.plan_version
}

// V3.9 §D: live Goal Loop status mirrored from the backend goal.updated event. Declared here (not in
// server-sync) so both the reducer and the sync context import it without a cycle. Mirrors the
// GoalManager snapshot + budget ledger the status bar renders.
export type SessionGoal = {
  goalId: string
  planDocId: string
  // running | paused | done | needs_human | rolled_back | stopped
  phase: string
  ledger: { ticks: number; tokens: number; cost: number; wallclockMs: number }
  stallCount: number
  gaps: string[]
}

export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider_ready: boolean
  provider: NormalizedProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_working(id: string): boolean
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp_ready: boolean
  mcp: {
    [name: string]: McpStatus
  }
  lsp_ready: boolean
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta: {
    [partID: string]: string
  }
}

export type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
  mcp?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type RootLoadArgs = {
  directory: string
  limit: number
  list: (query: { directory: string; roots: true; limit?: number }) => Promise<{ data?: Session[] }>
}

export type RootLoadResult = {
  data?: Session[]
  limit: number
  limited: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
