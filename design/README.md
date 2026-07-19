# DeepAgent Code Architecture & Design

> **Public design overview for DeepAgent Core V4.0.4 / Desktop 1.4.2.** Internal implementation details and roadmap documents live in the private `docs/` tree and are intentionally not version-controlled.

DeepAgent Code is a document-centered, event-driven AI coding system. It combines a coding-agent runtime with a durable control plane that owns context, planning, learning, collaboration, safety, and human oversight.

The architecture is designed around one requirement: a long-running agent must remain correct and governable after many model turns, tool calls, user interventions, process restarts, and worker handoffs.

## Design Principles

- **Durable document and project memory** — atomic, recoverable storage with retrieval gates, provenance, governance, and conflict detection
- **Connected context** — selective, evidence-backed assembly across code, knowledge, project memory, and execution documents
- **Plans and long-running goals** — structured plans, stale-state detection, validation evidence, bounded retries, and human control
- **Event-driven coordination** — durable delivery, priority routing, offline catch-up, idempotent goal ticks, and observable queue state
- **Isolated agent collaboration** — bounded subagents, worktree isolation for write-capable workers, and conflict-aware change return
- **AI IDE microservice** — LSP-backed semantic code navigation via `code_intel`
- **Secure MCP catalog** — curated integrations, derived safety tiers, environment references, and native OS secret storage

Sessions, inputs, plans, documents, goals, events, approvals, and learning decisions each have one authoritative durable representation. In-memory state is a cache or an ownership hint, never a competing source of truth.

### Admission is separate from execution

A user instruction is durably admitted before execution is scheduled. A successful API response therefore means the instruction is recorded, not merely present in a process-local queue.

DeepAgent is built **on top of** the opencode agent/runtime/session/tool/MCP stack. V4.0.4 strengthens the control plane without replacing the current turn engine, tool system, or provider layer.

### 2. One durable authority per concern

Documents, plans, event delivery state, knowledge promotion, and goal progress each have one authoritative durable store. In-memory state may accelerate delivery, but it cannot become a second source of truth.

The model receives a bounded working set assembled from explicit Context Sources. Full tool output and durable history remain referenceable artifacts; only admitted summaries, evidence, and snippets enter the active context.

### Safety fails closed

External events, credentials, tools, paths, autonomy, worker placement, and outbound messages are checked at their execution boundaries. Missing identity, trust, capability, or approval never widens access.

### Humans can always intervene

### 5. Keep execution boundaries explicit

Write-capable subagents run in isolated worktrees by default. Event consumers claim durable work with idempotency and retry boundaries. Users retain explicit paths to approve, steer, pause, resume, take over, or roll back long-running work.

---

## System Map

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

## Session V2

Session V2 separates durable prompt admission from model execution.

### Prompt admission

- Each prompt creates one durable `session_input` before scheduling work.
- Reusing a Session ID adopts that Session rather than creating a parallel execution entity.
- Reusing a prompt message ID is accepted only for an exact retry with the same Session, content, and delivery mode.
- Conflicting ID reuse fails instead of silently reconciling different user intent.
- A prompt can be admitted without waking execution when the caller requests admit-only behavior.

### Delivery vocabulary

| Delivery | Meaning |
|---|---|
| normal turn | Start a normal activity when the Session is idle |
| `steer` | Add guidance to the active activity at the next safe provider-turn boundary |
| `goal_steer` | Add guidance to the next Goal tick |
| `queue` | Open a future FIFO activity after the active activity settles |
| interrupt | Target the active process-local ownership chain immediately |

Steering never aborts an in-flight tool or stream. The input is persisted first, absorbed in stable order, and materialized into history exactly once.

### Execution ownership

`SessionExecution` is process-global and keyed by Session ID. A drain discovers placement from durable Session location only when it starts. SessionRunner, model resolution, tools, permissions, and filesystem services remain Location-scoped.

Same-Session resumes join one coordinator; advisory wakes coalesce; different Sessions can run concurrently. Every provider turn performs one explicit `llm.stream(request)` call and reloads projected history before durable continuation.

**Credentials** are declared by key name in the catalog template (`CredentialSpec`). Configuration stores environment references or `secret://` handles instead of plaintext values. Handles resolve at connection time through macOS Keychain, Linux Secret Service (`libsecret`), or Windows DPAPI-backed credential storage.

- Agent instructions, stable policy, and System Context baseline stay in the prefix.
- Round state, budgets, plan snapshots, prior results, fan-out decisions, and steering stay in the tail.
- OpenAI-compatible providers use a stable Session cache key; providers with cache markers use their protocol-native breakpoint.
- Prefix hash and cache outcomes distinguish normal compaction misses from accidental prefix drift.

## Document System

| Mechanism | Status |
|-----------|--------|
| MCP risk tier — catalog-derived, not config-injectable | Available |
| MCP catalog defaults to not connected | Available |
| Dangerous writes: approval gate (`ctx.ask`) | Available |
| Read-only DB: restricted mode enforced at server | Available |
| Credential indirection (`${VAR}` / `secret://`) | Available |
| Native secret storage (macOS / Linux / Windows) | Available in V4.0.4 |
| Subagent write isolation and conflict-aware return | Available in V4.0.4 |

- a stable ID and monotonic version;
- type, scope, status, domain, tags, and description;
- provenance and evidence references;
- confidence, sensitivity, and approval risk;
- typed links such as `supports`, `blocks`, `conflicts`, `validates`, `supersedes`, `contains`, `imports`, and `calls`.

Writes use atomic replacement and conflict detection. Concurrent handles observe one authority, process-level writers coordinate through lock/CAS semantics, and migrations are incremental, restartable, and integrity-checked.

DeepAgent Code is licensed under **AGPL-3.0-or-later**.
Source code: [github.com/deepagent-ltd/deepagent-code](https://github.com/deepagent-ltd/deepagent-code)

| Scope | Purpose |
|---|---|
| `session-private` | Current conversation and run-local state |
| `project-shared` | Knowledge and decisions shared by one project |
| `user-global` | Cross-project preferences and explicitly promoted knowledge |
| `public-system` | Built-in skills and domain-pack documents |
| `sealed` | Audit/evaluator material that cannot enter model context |

Plans, run context, worklogs, designs, diagnoses, evaluations, knowledge, memory, strategies, methodologies, skills, and failure dossiers share this document algebra instead of maintaining separate storage models.

## System Context and the Four Graphs

The Context System connects four projections over the same durable knowledge surface:

1. **Code:** files, symbols, imports, calls, definitions, references, diagnostics.
2. **Knowledge:** facts, strategies, methodologies, skills, and failure dossiers.
3. **Memory:** decisions, constraints, project conventions, environment facts, and handoffs.
4. **Documents:** plans, designs, run context, evidence, worklogs, and evaluations.

Context Sources produce typed observations from their domains. Session-owned selection applies budget, relevance, scope, sensitivity, evidence strength, conflict, and snapshot rules. A Context Epoch records the selected baseline so a provider turn is reproducible and observable.

The Event Router can attach a context strategy to an event. SessionRunner executes that strategy in the target Location, records query and admission decisions in trace, and degrades safely when an optional source is unavailable.

Compaction preserves a stable structure: goal, constraints, completed and active work, blockers, decisions, next steps, critical facts/open questions, and relevant files. Durable references remain outside the prose summary and can be reloaded when needed.

## Planning and Goal Execution

### Plan authority

A structural plan is a versioned DocumentStore document. Session hot state keeps only its plan pointer/version and stale latch. The model plan tool, human plan editor, Goal worker, UI, Grader, and archive all read and update the same plan through version-aware writes.

The runtime derives plan staleness from facts it already observes:

- the user adds new guidance;
- a tool or execution step fails;
- validation fails;
- repeated work makes no progress;
- the active domain-pack snapshot changes.

Read and diagnosis tools remain available while stale. Mutating tools require the plan to be synchronized, with bounded anti-deadlock behavior.

### Goal Loop

A Goal has objective completion criteria, a plan, a durable run context, a budget ledger, and a bounded controller. Each tick:

1. claims the expected durable Goal/plan version;
2. applies pending user plan edits and steering;
3. executes one coherent step;
4. records tools, tokens, cost, time, evidence, and progress;
5. evaluates objective criteria and stall state;
6. emits facts and schedules the next tick only when eligible.

`goal.tick.requested` is a durable command, not a post-hoc trace marker. Duplicate delivery cannot repeat provider or tool side effects. Pause, stop, takeover, hard limits, quiet hours, needs-human, and terminal state all stop self-continuation.

Hot plan edits preserve reusable step IDs and completed evidence, increment the plan version, and reset progress/stall baselines without interrupting the in-flight tick.

## Event-Driven Agent Runtime

The Event Bus provides persist-before-dispatch delivery, idempotency, priority, retry, acknowledgement, dead-letter handling, retention, replay, and correlation. Local deployments use the embedded backend; distributed deployments use Redis Streams or Kafka through the same backend contract.

The Router combines event type, trusted source, actor identity, Agent trigger/capability metadata, autonomy ceiling, approval intent, context strategy, deduplication, priority, and workspace backpressure into one traceable route decision.

The Worker Pool owns bounded concurrency, placement, claims, leases, renewal, recovery, and handoff. Independent DAG nodes run concurrently; dependency edges remain ordered. File and symbol claims are shared across Workers so conflicting writes cannot run together.

Write-capable Agents use isolated worktrees by default. Parent Agents receive bounded summaries, status, artifact/session references, and necessary diffs; complete child transcripts remain in their own Sessions.

## Human Collaboration and Oversight

### Repo & Wiki

Repo & Wiki is a human-facing projection, never a second source of truth. It exposes document and code navigation, full-text search, docs-to-code links, knowledge governance, and execution archives. Organization and workspace identity are enforced on query, index, archive, and promotion paths.

### Expert Panel

Panelists receive the same frozen question and evidence under differentiated lenses. Anonymous multi-round debate avoids identity anchoring. A deterministic Arbiter applies quorum, preserves minority opinions, and routes unsafe ambiguity to the Approval Queue. Distributed panelists run through the Worker Pool.

### IM and proactive delivery

Project IM supports groups, direct conversations, threads, search, attachments, agent mentions, progress streaming, and permission revalidation when project bindings change. Event-driven notifications and digests pass through content safety, path ACL, external-link, rate, and quiet-hours policies before delivery.

### Oversight

Correlation IDs connect event, route, context, worker claim, Session, provider turn, tool, artifact, approval, and outbound action. Operators can inspect Approval Queue items, dead letters, budgets, conflicts, takeovers, rollbacks, and final delivery without reconstructing state from logs.

## Learning and Knowledge Governance

Learning runs outside the interactive turn on idle, pause, project switch, and Session finalization triggers. Candidates enter the same DocumentStore lifecycle used by human governance.

- Low-risk project candidates can pass deterministic auto-review.
- Medium-risk/global candidates use an isolated blank-thread reviewer with no Session history.
- Sensitive, strategic, regulated, or irreversible candidates require human review.
- Rejection status, reason, and fingerprint remain authoritative in DocumentStore; auxiliary indexes are rebuildable projections.
- Promotion changes the same document's status/version instead of copying it into a second identity.
- Released retrieval sets name a snapshot and carry evaluation matrix, baseline, repeats, and ablation verdict.

A failed release gate restores the previous knowledge snapshot. Selected and rejected refs remain reproducible in run artifacts.

## Code Intelligence

The AI IDE surface combines:

- semantic symbol lookup and intent-oriented `code_intel` queries;
- definitions, references, calls, imports, type hierarchy, diagnostics, and rename preview;
- unsaved-buffer `textDocument/didOpen`, `didChange`, `didSave`, and `didClose` synchronization;
- incremental code indexing with exact mtime I/O hints and content-SHA correctness authority;
- deterministic fallback to repository search/read when a language server is unavailable.

Full LSP output stays in evidence artifacts. The model receives bounded summaries and precise source references.

## MCP and Credential Security

MCP servers can be added from the curated catalog or configured manually through Desktop, HTTP, or CLI. Catalog risk tiers are derived from trusted templates rather than mutable user configuration. Servers default to disconnected; writes, external fetches, and privileged actions pass through runtime permission gates.

Credentials use indirection rather than plaintext project configuration:

- `${VAR}` and `${VAR:-default}` resolve at connection time;
- `secret://` handles resolve through macOS Keychain, Linux Secret Service, or Windows Credential Manager/DPAPI;
- environments without a native keyring require explicit approval for an audited local fallback outside the project repository;
- logs, artifacts, outbound messages, and config views redact resolved values.

## Security Boundaries

Autonomous execution passes four independent gates:

1. the event source is trusted for the workspace;
2. the actor has permission for the project and resource;
3. the Agent descriptor permits the trigger, capability, and autonomy level;
4. the runtime permits the concrete tool, path, network target, and side effect.

Additional controls include durable budgets, rate limits, quiet hours, secret/path/link filtering, worktree isolation, hardened read-only Git, human approval, takeover, rollback, and complete audit correlation.

## Repository Map

| Area | Path |
|---|---|
| Core Session, documents, context, event, and policy algebra | `packages/core/src/` |
| CLI/server runtime, tools, Goal and event wiring | `packages/deepagent-code/src/` |
| Desktop/Web application UI | `packages/app/src/` |
| Electron host and isolated browser views | `packages/desktop/src/` |
| Provider abstraction | `packages/llm/` |
| Domain knowledge packs | `packages/domain-packs/` |
| Generated JavaScript SDK | `packages/sdk/js/` |

## License and Source

DeepAgent Code is licensed under **AGPL-3.0-or-later**. The canonical repository is [github.com/deepagent-ltd/deepagent-code](https://github.com/deepagent-ltd/deepagent-code).

The project is derived from [opencode](https://github.com/sst/opencode) under the MIT License. Upstream attribution is preserved in [NOTICE](../NOTICE).
