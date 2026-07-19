# DeepAgent Code — Architecture & Design

> **Public design overview for DeepAgent Core V4.0.4 / Desktop 1.4.2.** Internal implementation details and roadmap documents live in the private `docs/` tree and are intentionally not version-controlled.

---

## What is DeepAgent Code?

DeepAgent Code is an AI coding agent that adds a **control plane** on top of the [opencode](https://github.com/sst/opencode) runtime. It keeps the proven opencode foundations (runtime, tool, MCP, session, provider stack) and layers in:

- **Durable document and project memory** — atomic, recoverable storage with retrieval gates, provenance, governance, and conflict detection
- **Connected context** — selective, evidence-backed assembly across code, knowledge, project memory, and execution documents
- **Plans and long-running goals** — structured plans, stale-state detection, validation evidence, bounded retries, and human control
- **Event-driven coordination** — durable delivery, priority routing, offline catch-up, idempotent goal ticks, and observable queue state
- **Isolated agent collaboration** — bounded subagents, worktree isolation for write-capable workers, and conflict-aware change return
- **AI IDE microservice** — LSP-backed semantic code navigation via `code_intel`
- **Secure MCP catalog** — curated integrations, derived safety tiers, environment references, and native OS secret storage

---

## Architectural Principles

### 1. Enhance, don't replace

DeepAgent is built **on top of** the opencode agent/runtime/session/tool/MCP stack. V4.0.4 strengthens the control plane without replacing the current turn engine, tool system, or provider layer.

### 2. One durable authority per concern

Documents, plans, event delivery state, knowledge promotion, and goal progress each have one authoritative durable store. In-memory state may accelerate delivery, but it cannot become a second source of truth.

### 3. Full tool output does not enter context

Per the deterministic task control contract: raw LSP results, diagnostic dumps, and capability indexes are written to **evidence artifacts** (ref-linked, tool-only visibility). Only summaries and `file:line` snippets appear in the model context.

### 4. Fail-closed on safety

MCP catalog entries default to **not connected** (zero startup overhead). Dangerous write operations (force-push, DROP, file delete) require explicit approval. Read-only DB connections enforce restricted-mode at the server level.

### 5. Keep execution boundaries explicit

Write-capable subagents run in isolated worktrees by default. Event consumers claim durable work with idempotency and retry boundaries. Users retain explicit paths to approve, steer, pause, resume, take over, or roll back long-running work.

---

## Component Map

```
┌─────────────────────────────────────────────────────────────┐
│  DeepAgent Control Plane                                    │
│                                                             │
│  DocumentStore ─ Plan/Goal ─ Knowledge Governance          │
│       │              │                │                     │
│  Context Graph ─ Event Bus ─ Oversight and Audit           │
│       │              │                │                     │
│  ┌────▼──────────────▼────────────────▼──────────────────┐  │
│  │ Agent Gateway: budget · permission · evidence · policy│  │
│  └────┬───────────────────────────────────────────────────┘  │
└───────│─────────────────────────────────────────────────────┘
        │
┌───────▼────────────────────────────────────────────────────┐
│  opencode Foundation                                       │
│  Session · Provider · Tool Registry · LSP · MCP            │
└────────────────────────────────────────────────────────────┘
        │
┌───────▼────────────────────────────────────────────────────┐
│  Execution Boundaries                                      │
│  isolated subagents · worktrees · event consumers · tools  │
└────────────────────────────────────────────────────────────┘
```

---

## code_intel — AI IDE Microservice

The `code_intel` tool wraps the LSP stack as a **symbol-driven semantic API**. The agent specifies a symbol name and an intent; `code_intel` resolves line/column coordinates internally and returns `file:line` + code snippets.

```typescript
code_intel({ symbol: "AgentGateway.open", intent: "overview" })
// → definition + type + references + callers + callees + doc summary
//   full detail → evidence artifact (ref only in context)
```

Supported intents: `definition · references · implementations · type · calls_in · calls_out · supertypes · subtypes · type_hints · hover · rename_preview · quick_fix · outline · diagnostics · overview`

Graceful degradation: if no LSP server is configured for the file type, returns a hint to use `grep/read`. Capability only grows, never drops.

---

## MCP Catalog — Safety Model

Each catalog entry carries a **risk tier** derived at load time from the catalog template. The tier is **not user-writable** — it is computed from the entry definition, preventing config-injection attacks.

| Tier | Examples | Default behavior |
|------|----------|-----------------|
| `read_only` | postgres-readonly | All ops auto-allowed |
| `write_guarded` | filesystem, github, git | Write ops require explicit approval |
| `external_fetch` | fetch, browser (Playwright) | External requests require explicit approval |

**Credentials** are declared by key name in the catalog template (`CredentialSpec`). Configuration stores environment references or `secret://` handles instead of plaintext values. Handles resolve at connection time through macOS Keychain, Linux Secret Service (`libsecret`), or Windows DPAPI-backed credential storage.

---

## Security Model Summary

| Mechanism | Status |
|-----------|--------|
| MCP risk tier — catalog-derived, not config-injectable | Available |
| MCP catalog defaults to not connected | Available |
| Dangerous writes: approval gate (`ctx.ask`) | Available |
| Read-only DB: restricted mode enforced at server | Available |
| Credential indirection (`${VAR}` / `secret://`) | Available |
| Native secret storage (macOS / Linux / Windows) | Available in V4.0.4 |
| Subagent write isolation and conflict-aware return | Available in V4.0.4 |

---

## License

DeepAgent Code is licensed under **AGPL-3.0-or-later**.
Source code: [github.com/deepagent-ltd/deepagent-code](https://github.com/deepagent-ltd/deepagent-code)

DeepAgent Code is derived from [opencode](https://github.com/sst/opencode) (MIT).
See `NOTICE` in the repository root for the full upstream attribution.
