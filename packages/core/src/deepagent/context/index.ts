// V3.8 Appendix-A — context-management substrate. The live members: session Ledger (C2) + Project
// Bridge (C3, cross-session handoff) + Conversation Log (C2.5) + Config knobs. The main-session context
// CURATOR bridge (Working Set / Curator / chunked Ingest / a standalone token-meter) was never wired to
// the main prompt loop — the only live symbol-graph retrieval is the IM @agent path's own
// context-builder — so that dead cluster was removed in V4.1 T2.5. If main-session code-graph retrieval
// is wanted later, design it as an explicit new feature rather than reviving this half-wired layer.
export * as ContextConfig from "./config"
export * as SessionLedger from "./ledger"
export * as ConversationLog from "./conversation-log"
export * as ProjectBridge from "./bridge"
// V4.0.1 P1 — World State (snapshot-diff volatile facts, re-injected as a tail block, never the prefix).
export * as WorldState from "./world-state"
