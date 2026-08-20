// FEAT-002: profile construction was lowered into core (packages/core/src/deepagent/profile-
// builder.ts) so the agent gateway (core) can build the SAME ExtendedProblemProfile it hands to
// knowledge retrieval and pack-snapshot recording — one activation authority per run. core cannot
// import deepagent-code, so this module is now a thin re-export: existing deepagent-code callers
// (HTTP handlers, tests) keep their import path and behavior unchanged.

export { buildProfile } from "@deepagent-code/core/deepagent/profile-builder"
export type { WorkspaceSignals } from "@deepagent-code/core/deepagent/profile-builder"
