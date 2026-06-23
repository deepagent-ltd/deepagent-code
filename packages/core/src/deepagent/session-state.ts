import { mkdirSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { writeFileAtomic } from "./atomic-write"
import type { AgentMode } from "./mode"
import { createInitialRoundState, advanceRound, addCandidate, addDiagnosis, updateTokenUsage, type RoundState, type CandidateRef, type DiagnosisRef, type ValidationResult } from "./round-state"
import type { BudgetCheck, BudgetConfig } from "./budget"
import { defaultBudget, check as budgetCheck } from "./budget"
import type { KnowledgeSynthesis } from "./prompt-policy"

export type SessionRunState = {
  sessionId: string
  mode: AgentMode
  roundState: RoundState
  budget: BudgetConfig
  validationCommands: string[]
  lastValidationResults: ValidationResult[]
  lastValidationOutput: string | null
  knowledgeSynthesis: KnowledgeSynthesis | null
  userRequest: string | null
  workspacePath: string | null
  runId: string
  createdAt: string
  completedAt: string | null
}

let stateDir: string | null = null
const sessions = new Map<string, SessionRunState>()

export const configure = (dir: string) => {
  stateDir = dir
  mkdirSync(dir, { recursive: true })
  loadFromDisk()
}

export const getOrCreate = (sessionId: string, mode: AgentMode): SessionRunState => {
  const existing = sessions.get(sessionId)
  if (existing) return normalizeState(existing)
  const state: SessionRunState = {
    sessionId,
    mode,
    roundState: createInitialRoundState(mode),
    budget: defaultBudget(mode),
    validationCommands: [],
    lastValidationResults: [],
    lastValidationOutput: null,
    knowledgeSynthesis: null,
    userRequest: null,
    workspacePath: null,
    runId: `run_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    completedAt: null,
  }
  sessions.set(sessionId, state)
  saveToDisk()
  return state
}

export const get = (sessionId: string): SessionRunState | undefined => sessions.get(sessionId)

export const update = (sessionId: string, patch: Partial<SessionRunState>): SessionRunState => {
  const state = sessions.get(sessionId)
  if (!state) throw new Error(`No DeepAgent session state for ${sessionId}`)
  Object.assign(state, patch)
  sessions.set(sessionId, state)
  saveToDisk()
  return state
}

export const recordTokenUsage = (sessionId: string, inputTokens: number, outputTokens: number): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = updateTokenUsage(state.roundState, inputTokens, outputTokens)
  saveToDisk()
}

export const recordCandidate = (sessionId: string, candidate: CandidateRef): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = addCandidate(state.roundState, candidate)
  saveToDisk()
}

export const recordDiagnosis = (sessionId: string, diagnosis: DiagnosisRef): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = addDiagnosis(state.roundState, diagnosis)
  saveToDisk()
}

export const recordValidation = (sessionId: string, results: ValidationResult[], output: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.lastValidationResults = results
  state.lastValidationOutput = output
  saveToDisk()
}

export const advanceToNextRound = (sessionId: string, decision: import("./mode").RoundDecision): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = advanceRound(state.roundState, decision)
  saveToDisk()
}

export const complete = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = { ...state.roundState, phase: "completed" }
  state.completedAt = new Date().toISOString()
  saveToDisk()
}

export const fail = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = { ...state.roundState, phase: "failed" }
  state.completedAt = new Date().toISOString()
  saveToDisk()
}

export const isBudgetExhausted = (sessionId: string): boolean => {
  const result = budgetStatus(sessionId)
  if (!result) return false
  return result.status === "exhausted" || result.status === "exceeded"
}

export const budgetStatus = (sessionId: string): BudgetCheck | undefined => {
  const state = sessions.get(sessionId)
  if (!state) return
  return budgetCheck(state.roundState, state.budget)
}

export const cleanup = (sessionId: string): void => {
  sessions.delete(sessionId)
  saveToDisk()
}

export const allSessions = (): ReadonlyMap<string, SessionRunState> => sessions

export const pruneCompleted = (maxAge_ms = 24 * 60 * 60 * 1000): void => {
  const now = Date.now()
  for (const [id, state] of sessions) {
    if (state.completedAt && now - new Date(state.completedAt).getTime() > maxAge_ms) {
      sessions.delete(id)
    }
  }
  saveToDisk()
}

function saveToDisk() {
  if (!stateDir) return
  // P2-G: atomic rewrite so a crash can't truncate sessions.json. P2-D: surface write failures to
  // stderr instead of silently dropping run state (a lost session-state write is a real data loss,
  // not something to swallow). Still non-throwing: persistence failure must not crash the turn.
  try {
    const data = Object.fromEntries(sessions)
    writeFileAtomic(path.join(stateDir, "sessions.json"), JSON.stringify(data, null, 2))
  } catch (error) {
    console.error("deepagent session-state: failed to persist sessions.json", error)
  }
}

function normalizeState(state: SessionRunState): SessionRunState {
  const nextBudget = defaultBudget(state.mode)
  const normalized = {
    ...state,
    budget: {
      ...state.budget,
      maxTotalTokens: nextBudget.maxTotalTokens,
      maxRounds: nextBudget.maxRounds,
    },
  }
  sessions.set(state.sessionId, normalized)
  return normalized
}

function loadFromDisk() {
  if (!stateDir) return
  try {
    const content = readFileSync(path.join(stateDir, "sessions.json"), "utf8")
    const data = JSON.parse(content) as Record<string, SessionRunState>
    for (const [id, state] of Object.entries(data)) {
      if (!state.completedAt) sessions.set(id, normalizeState(state))
    }
  } catch {}
}
