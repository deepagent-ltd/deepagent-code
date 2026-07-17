# DeepAgent Code — Architecture & Design

> **Public design overview.** Internal implementation details and roadmap docs live in the private `docs/` tree (not version-controlled). This directory contains the publicly visible architectural narrative.

---

## What is DeepAgent Code?

DeepAgent Code is an AI coding agent that adds a **control plane** on top of the [opencode](https://github.com/sst/opencode) runtime. It keeps the proven opencode foundations (runtime, tool, MCP, session, provider stack) and layers in:

- **Durable document memory** — knowledge base with retrieval gates, dedup, and merge
- **Context assembly** — selective, evidence-backed context building (not raw file dumps)
- **Plan system** — structured task planning with staleness detection and rollback
- **Failure triage** — three-tier classifier (auto-fixable / needs-narrowing / not-auto-fixable)
- **Domain adapters** — pluggable domain packs for specialized workflows
- **AI IDE microservice** — LSP-backed semantic code navigation via `code_intel`
- **MCP catalog** — curated, one-click-enable MCP servers with safety tiers

---

## Architectural Principles

### 1. Enhance, don't replace

DeepAgent is built **on top of** the opencode agent/runtime/session/tool/MCP stack. It does not rewrite the execution engine, tool system, or provider layer. The default agent behavior is not degraded. The lower-strength `general` mode stays close to the inherited runtime contract.

### 2. Control-plane only

DeepAgent is responsible for **strategy / context / budget / audit / verification / document graph**. It does not directly spawn LSP processes or execute MCP tools — those go through the existing `LSP.Service` and `MCP.Service` respectively.

### 3. Full tool output does not enter context

Per the deterministic task control contract: raw LSP results, diagnostic dumps, and capability indexes are written to **evidence artifacts** (ref-linked, tool-only visibility). Only summaries and `file:line` snippets appear in the model context.

### 4. Fail-closed on safety

MCP catalog entries default to **not connected** (zero startup overhead). Dangerous write operations (force-push, DROP, file delete) require explicit approval. Read-only DB connections enforce restricted-mode at the server level.

---

## Component Map

```
┌─────────────────────────────────────────────────────────────┐
│  DeepAgent Control Plane                                    │
│                                                             │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │  Plan System │  │  Doc Memory │  │  Failure Triage   │  │
│  │  (task/plan) │  │  (knowledge │  │  (3-tier classify)│  │
│  └──────┬───────┘  │   store)    │  └─────────┬─────────┘  │
│         │          └──────┬──────┘            │             │
│  ┌──────▼──────────────────▼──────────────────▼───────────┐  │
│  │            Agent Gateway (core)                        │  │
│  │  audit · budget · permission · capability index        │  │
│  └──────┬─────────────────────────────────────────────────┘  │
└─────────│───────────────────────────────────────────────────┘
          │
┌─────────▼──────────────────────────────────────────────────┐
│  opencode Foundation (unchanged)                           │
│                                                            │
│  Session ─── Tool Registry ─── MCP Service                │
│     │              │                  │                    │
│  Provider       LSP Service      38 lang servers           │
│  (Claude/…)   code_intel tool    + MCP catalog             │
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

**Credentials** are declared by key name in the catalog template (`CredentialSpec`). Values are filled at enable-time.

> **Known limitation (V3.4):** credential values are stored in plaintext in the local config file. Do not commit config files containing credentials to version control. A secure-storage mechanism (OS keyring, aligned with the codex approach) is planned for V3.5.

---

## Security Model Summary

| Mechanism | Status |
|-----------|--------|
| MCP risk tier — catalog-derived, not config-injectable | ✅ V3.4 |
| MCP catalog defaults to not connected | ✅ V3.4 |
| Dangerous writes: approval gate (`ctx.ask`) | ✅ V3.4 |
| Read-only DB: restricted-mode enforced at server | ✅ V3.4 |
| Credential secure storage (OS keyring) | ⏳ V3.5 M-CRED |

---

## License

DeepAgent Code is licensed under **AGPL-3.0-or-later**.
Source code: [github.com/lessweb/deepagent-code](https://github.com/lessweb/deepagent-code)

DeepAgent Code is derived from [opencode](https://github.com/sst/opencode) (MIT).
See `NOTICE` in the repository root for the full upstream attribution.
