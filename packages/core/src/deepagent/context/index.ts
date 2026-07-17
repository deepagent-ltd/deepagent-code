// V3.8 Appendix-A — context-management redesign (Working Set + Ledger + Bridge + Conversation Log +
// Curator + chunked ingest). Greenfield module. See each file for the C-section it implements.
export * as ContextConfig from "./config"
export * as ContextTokenMeter from "./token-meter"
export * as SessionLedger from "./ledger"
export * as WorkingSet from "./working-set"
export * as ContextCurator from "./curator"
export * as ConversationLog from "./conversation-log"
export * as ProjectBridge from "./bridge"
export * as ContextIngest from "./ingest"
// V4.0.1 P1 — World State (snapshot-diff volatile facts, re-injected as a tail block, never the prefix).
export * as WorldState from "./world-state"
