<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>The AI coding agent that remembers, plans, collaborates, and finishes</strong></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code-enterprise">Enterprise</a>
</p>

<p align="center"><sub>Desktop 1.4.1 · DeepAgent Core V4.1</sub></p>

---

DeepAgent Code is an AI coding workspace for work that lasts longer than one prompt. It combines a production coding-agent runtime with durable sessions, connected project memory, live planning, code intelligence, multi-agent collaboration, and human oversight.

You can ask for a small edit, guide a running task without interrupting it, hand over a migration with objective completion criteria, or bring several specialist agents into a decision. DeepAgent keeps the work coherent across turns, restarts, tools, people, and projects.

## One Workspace, Three Ways to Work

Choose the collaboration style that fits the task:

| Mode | You provide | DeepAgent does |
|---|---|---|
| **Auto** | A request | Defines the objective, designs and plans as needed, then executes end to end |
| **Loop** | A goal | Writes an editable `goal+plan.md` and advances it through plan, execute, verify, and iterate ticks |
| **Design** | Your `goal+plan.md` | Executes your design faithfully without redefining its objective or completion criteria |

Autonomy and permission are independent. Use **Read-only**, **Request approval**, or **Full access** without changing the collaboration mode.

## Stay in Control While It Works

DeepAgent is built for active collaboration, not fire-and-forget automation.

- **Live steering:** send new guidance while a model turn or tool is running. The message is durably admitted and absorbed at the next safe provider-turn boundary without aborting in-flight work.
- **Goal steering:** guidance sent to an active goal is folded into the next tick, preserving the current tool and plan state.
- **Hot plan editing:** edit a running or paused goal. Stable step IDs, evidence, completed work, and the new plan version carry into the next tick.
- **Explicit queueing:** queue a future activity when the instruction should begin after the current activity instead of changing it.
- **Pause, resume, take over, or roll back:** every long-running workflow has a human control path and a durable audit trail.

## Memory You Can Inspect and Govern

DeepAgent does not hide memory in an opaque prompt. Project state lives in typed, versioned documents with provenance, confidence, scope, status, and links.

- Session-private working context stays with the current conversation.
- Project-shared facts and decisions follow the repository.
- User-global preferences can travel across projects.
- Built-in skills and domain packs remain versioned system knowledge.
- Sealed evaluator material stays audit-only and never enters model context.

Learning follows a governed lifecycle: evidence creates a candidate, isolated review or a human decision changes its status, and regression/ablation gates publish a reproducible knowledge snapshot. Rejection reasons remain durable so discarded patterns are not silently relearned.

The **Repo & Wiki** view makes this system readable. Browse knowledge and execution archives, search across the repository, follow docs-to-code links, inspect lineage, and promote useful run evidence into governed knowledge.

## Connected Context, Not a Larger Prompt

DeepAgent connects four views of the project:

1. **Code graph:** files, symbols, imports, calls, diagnostics, and references.
2. **Knowledge graph:** strategies, methodologies, facts, skills, and failure dossiers.
3. **Project memory:** decisions, constraints, environment facts, and learned conventions.
4. **Document graph:** plans, designs, worklogs, evaluations, run context, and evidence.

The Session V2 runner assembles context from explicit sources under a durable Context Epoch. It selects linked evidence within budget, records why each reference was admitted or rejected, and preserves the current goal, constraints, decisions, open questions, next steps, and relevant files during compaction.

Prompt caching remains effective across long runs: stable system instructions stay byte-stable, while plans, steering, budgets, round results, and other volatile state are appended in a dedicated tail block.

## Built for Difficult Work

### AI IDE

Query code by symbol and intent instead of guessing file locations. DeepAgent combines LSP definitions, references, call chains, type information, diagnostics, rename previews, and cross-file evidence. Unsaved editor buffers participate in LSP updates, so analysis follows the code you are actually editing.

### Domain packs

Composable domain packs add language, framework, platform, hardware, business, and risk expertise without hardcoding it into the core. Packs activate from the problem profile, resolve conflicts with stricter-policy-wins semantics, and are snapshot-locked for reproducible runs.

### Specialist agents and Expert Panel

DeepAgent can partition independent work across bounded, isolated workers. Write-capable subagents receive dedicated worktrees, return compact summaries and artifact references, and leave their full transcripts available for inspection.

For high-risk decisions, convene an **Expert Panel**. Correctness, security, performance, architecture, and reproducibility lenses review the same frozen question, debate anonymously for up to three rounds, and feed a deterministic arbiter that preserves minority opinions and fails closed to human review.

### Team and agent messaging

Project IM brings people and agents into the same thread. Mention an agent to start a scoped run with project context, stream its progress, inspect its artifacts, and keep the answer attached to the conversation that requested it.

## DeepAgent Core V4.1

V4.1 brings the complete DeepAgent control plane together:

- **Durable Session V2:** prompt admission is persisted before execution; exact retries do not duplicate user intent; same-session wakes coalesce safely.
- **One provider-turn contract:** native and AI SDK providers share the same budget, permission, artifact, audit, learning, and close lifecycle.
- **Single durable truth:** DocumentStore owns documents, plans, learning candidates, governance state, and version conflicts through atomic, recoverable writes.
- **Event-driven Agent OS:** durable events, priority routing, backpressure, worker claims, leases, handoffs, retries, dead-letter recovery, and distributed placement coordinate autonomous work.
- **Consumer-driven goals:** `goal.tick.requested` claims and executes one idempotent tick, records facts, and schedules the next tick only when the durable goal remains eligible.
- **Human oversight:** approval queues, trace correlation, takeover, rollback, Wiki archives, notifications, and organization/workspace isolation remain part of the execution path.
- **Secure integrations:** MCP credentials use environment references or native OS secret storage; catalog risk, runtime permissions, trusted sources, and tool capability checks fail closed.

## Installation

```bash
npm install -g deepagent-code
```

Then run:

```bash
deepagent-code
# or use the alias:
deepagent
```

## Quick Example

Start the agent and give it a task:

```bash
deepagent-code "add rate limiting to /api/users endpoint"
```

The agent will:

1. Use LSP to find the endpoint definition and understand its structure
2. Check project memory for existing middleware patterns
3. Activate the relevant domain packs (backend API, the project's language)
4. Implement rate limiting following project conventions
5. Run tests, capture diagnostics, and propose a candidate memory: "This project uses express-rate-limit middleware"

On your next session, when you ask to add rate limiting elsewhere, the agent already knows the pattern.

## Core Concepts

**Document graph** — All persistent state lives in typed documents: `knowledge`, `strategy`, `methodology`, `skill`, `memory`, `design`, `worklog`, `diagnosis`, `eval`. Documents link to each other (supports/blocks/conflicts/validates), forming a graph you can traverse.

**Scope layers** — `session-private` (current conversation), `project-shared` (all sessions in this project), `user-global` (cross-project preferences), `public-system` (built-in skills), `sealed` (audit-only, never enters context).

**Context admission** — Retrieval hits pass through admission gates. Full tool output (raw LSP dumps, diagnostics, capability indexes) is written to evidence artifacts, ref-linked and tool-only; only summaries and `file:line` snippets enter the model context. Sensitive values (SSH hosts, tokens, internal paths) are suggested, never auto-expanded.

**AI IDE microservice** — Query code by symbol name and intent (e.g. `code_intel({ symbol: "AgentGateway.open", intent: "overview" })`), not file:line coordinates. Get definitions, references, call chains, type hierarchies, and diagnostics in one call. Built on LSP with 38 language servers; degrades gracefully to grep/read when no server is configured.

**Preset MCP catalog** — Curated MCP servers for Git platforms, file search, read-only databases, and browser automation. Risk tiers are derived at load time from the catalog template (not user config, so they can't be injected), and servers default to not-connected with write and external-fetch operations behind approval gates.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  Control Plane (DeepAgent additions)                        │
│  • Four-graph unified store (code + knowledge + memory + doc)│
│  • Continuously maintained working state (memory + compaction)│
│  • Domain pack system (composable, auto-activating knowledge)│
│  • Context assembly & admission gates                       │
│  • Multi-agent orchestration & adversarial review           │
│  • Supervised goal loop & expert panel (event-driven)       │
│  • Evidence-gated learning & work-strength ladder           │
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│  Runtime Foundations (from opencode)                        │
│  • Agent loop & tool execution                              │
│  • Session, fork & provider management                      │
│  • MCP client runtime                                       │
│  • Permission system                                        │
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│  Intelligence Layers                                        │
│  • LSP microservice (38 language servers)                   │
│  • Preset MCP servers (git/files/db/browser)                │
│  • Domain adapters (validation & diagnostics)               │
│  • Diagnostic & validation loops                            │
└─────────────────────────────────────────────────────────────┘
```

The full architecture and its invariants are documented in [Architecture & Design](design/README.md).

## Build From Source

DeepAgent Code uses Bun 1.3.14.

```bash
git clone https://github.com/deepagent-ltd/deepagent-code.git
cd deepagent-code
bun install
```

Start the Desktop app:

```bash
bun run dev:desktop
```

Start the terminal experience:

```bash
bun run dev
```

Run a one-shot task:

```bash
bun run --cwd packages/deepagent-code dev run "add rate limiting to /api/users"
```

Import existing Codex or Claude Code history:

```bash
bun run --cwd packages/deepagent-code dev import-history --from codex --dry-run
```

## Documentation

- [Architecture & Design](design/README.md)
- [Security Policy](SECURITY.md)
- [Privacy Policy](PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License & Attribution

DeepAgent Code is licensed under **AGPL-3.0-or-later**. If you modify and run it as a network service, you must make the corresponding source available to its users.

DeepAgent Code is derived from [opencode](https://github.com/sst/opencode) under the MIT License. See [NOTICE](NOTICE) for upstream attribution. No endorsement by opencode or its contributors is implied.

---

<p align="center"><sub>Built by DeepAgent</sub></p>
