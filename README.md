<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>The AI coding agent that remembers, plans, collaborates — and finishes the job</strong></p>

<p align="center">DeepAgent Code <strong>2.0</strong>: a durable, crash-safe agent core that completes real work with fewer tokens</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code-enterprise">Enterprise</a>
</p>

---

DeepAgent Code is an AI coding workspace for work that lasts longer than one prompt. Ask for a small edit, guide a running task without interrupting it, hand over a migration with objective completion criteria, or bring several specialist agents into a decision — the work stays coherent across turns, restarts, tools, people, and projects.

## What Makes It Different

| A typical coding agent | DeepAgent Code |
|---|---|
| Forgets everything when the process exits | **Durable by construction**: every prompt, tool call, and event is recorded before it runs; crash, restart, resume |
| Only understands the current prompt | **Remembers your project**: what you taught it is still there tomorrow, and you can inspect and govern it |
| Burns tokens narrating bash loops | **Spends tokens on the work**: structured tool calls instead of narrating shell output, with about a third of the baseline's output tokens (details below) |
| Does one task at a time, alone | **Plans and collaborates**: goal loops, isolated worktrees, per-SHA review before anything merges |
| Runs in one place, one model | **Fits your setup**: desktop or terminal, 75+ model providers with your own API keys |

## What's New in 2.0: The Durable Core

Version 2.0 rebuilds the runtime around one principle: **record first, then act**. Every prompt, tool call, and event is written to the durable log before it happens.

- **Durable sessions.** A prompt is saved as a durable record before execution starts. If the process dies mid-run, the session resumes exactly where it stopped, and a retry picks up the same work instead of silently starting a second copy.
- **Event-sourced history.** Session activity is an append-only event log written in the same transaction as the state it describes, so replay, audit, and recovery always agree on what actually happened.
- **Durable multi-agent collaboration.** Delegated work is itself a durable record: every write-capable agent works in an isolated git worktree, commits only its own scoped changes, and is reviewed against the exact commit before anything merges. An out-of-date worker can never overwrite newer work.
- **Write isolation.** A strict plan gate is on by default: writes outside the approved plan are rejected with an explicit error instead of silently landing in your tree.
- **Context that stays small.** Four connected project graphs feed one budgeted context window. Stable instructions stay unchanged from turn to turn while changing state is appended at the end; sent history is byte-stable and shrinks only in one batched pass when the budget is crossed, so provider-side prompt caching stays effective.

## Fewer Tokens, Fewer Steps, Better Fixes

On DeepSWE tasks, against the mini-swe-agent baseline with the same model:

- Output tokens drop to roughly a third of the baseline: structured tool calls replace long stretches of shell-output reasoning, and generated tokens are the most expensive part of the bill.
- On the harder tasks, the average fix-to-pass rate rises from 71.8% to 98.4%.
- About 10% fewer steps on average, with end-to-end wall time on par with the baseline.
- Lower total input tokens: total input runs at roughly 40-80% of the baseline on DeepSWE. Old tool outputs are trimmed by fixed rules and past reasoning is never replayed, so the prompt prefix stays byte-stable, with measured prefix-cache hit rates above 96%.

## One Workspace, Three Ways to Work

Choose the collaboration style that fits the task:

| Mode | You provide | DeepAgent does |
|---|---|---|
| **Auto** | A request | Defines the objective, designs and plans as needed, then executes end to end |
| **Loop** | A goal | Writes an editable `goal+plan.md` and advances it through plan, execute, verify, and iterate cycles |
| **Design** | Your `goal+plan.md` | Executes your design faithfully without redefining its objective or completion criteria |

Autonomy and permission are independent. Use **Read-only**, **Request approval**, or **Full access** without changing the collaboration mode.

## Stay in Control While It Works

DeepAgent is built for active collaboration, not fire-and-forget automation.

- **Live steering:** send new guidance while a model turn or tool is running. Your message is saved to the log first, then applied at the next safe pause between model calls. Work in progress is never aborted.
- **Goal steering:** guidance sent to an active goal is folded into the next cycle, preserving the current tool and plan state.
- **Hot plan editing:** edit a running or paused goal. Stable step IDs, evidence, completed work, and the new plan version carry into the next cycle.
- **Explicit queueing:** queue a future task when the instruction should begin after the current one instead of changing it.
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

The session runtime assembles context only from explicit, recorded sources. It selects linked evidence within budget, records why each reference was kept or dropped, and preserves the current goal, constraints, decisions, open questions, next steps, and relevant files during compaction.

Prompt caching remains effective across long runs: stable system instructions stay byte-stable, while plans, steering, budgets, round results, and other volatile state are appended in a dedicated tail block.

## Built for Difficult Work

### AI IDE

Query code by symbol and intent instead of guessing file locations. DeepAgent combines LSP definitions, references, call chains, type information, diagnostics, rename previews, and cross-file evidence. Unsaved editor buffers participate in LSP updates, so analysis follows the code you are actually editing.

### Domain packs

Composable domain packs add language, framework, platform, hardware, business, and risk expertise without hardcoding it into the core. Packs activate from the problem profile, resolve conflicts with stricter-policy-wins semantics, and are snapshot-locked for reproducible runs.

### Specialist agents and Expert Panel

DeepAgent can partition independent work across bounded, isolated workers. Every delegated run is a durable record of who owns it, what stage it is in, its outcome, and which parent task it reports back to, so a retry resumes that same run instead of silently spawning a duplicate. Write-capable subagents receive dedicated worktrees, return compact summaries and artifact references, and leave their full transcripts available for inspection.

Automatic write collaboration follows a durable Git/PR path. Workers commit only their scoped changes; one Reviewer session checks each exact worker SHA, the coordinator performs serial `--no-ff` merges on the Session branch, and one Senior Reviewer examines the merged batch. Resume, timeout, cancellation, takeover, review feedback, and cleanup are versioned with the work itself, so a stale worker can never finalize or overwrite newer work.

For high-risk decisions, convene an **Expert Panel**. Correctness, security, performance, architecture, and reproducibility lenses review the same frozen question, debate anonymously for up to three rounds, and feed a deterministic arbiter that preserves minority opinions and defers to human review when it cannot reach a safe verdict.

### Team and agent messaging

Project IM brings people and agents into the same thread. Mention an agent to start a scoped run with project context, stream its progress, inspect its artifacts, and keep the answer attached to the conversation that requested it.

## Installation

> **Note:** The `deepagent-code` npm package is not yet publicly published.
> Install via the desktop app or the install script below.

```bash
# Install script (macOS / Linux)
curl -fsSL https://ai.deepagent.ltd/download/install | bash
```

Then run:

```bash
deepagent-code
# or use the alias:
deepagent
```

## Adding a Model Provider

### DeepAgent API: the official platform (recommended)

If you want the experience DeepAgent Code is tuned around, use the official
**DeepAgent API Platform** ([api.deepagent.ltd](https://api.deepagent.ltd)), a
secure model API service for DeepAgent applications with GPT and DeepSeek
families over Chat Completions and Responses, plus Anthropic-compatible
endpoints. Get a key from the platform console, check plan prices on
[Model Square pricing](https://api.deepagent.ltd/pricing), then open
**Settings → Providers → DeepAgent → Connect**, paste the key, and you're done.

### Any other provider

DeepAgent Code is provider-agnostic. It supports 75+ providers through the
[AI SDK](https://ai-sdk.dev/) and models.dev, plus any
OpenAI- or Anthropic-compatible endpoint.

### Desktop app (recommended)

Open **Settings → Providers**:

- **Official providers** (DeepAgent, OpenAI, Anthropic, DeepSeek, Google, xAI, ZhipuAI/GLM):
  click **Connect**, paste your API key.
- **Any other provider or gateway**: click **Connect** on *Custom provider*, paste
  the **Base URL** and **API key**. DeepAgent Code infers the API protocol family
  (OpenAI-compatible or Anthropic) from the provider's SDK package and discovers
  the available models from the endpoint's `/models` list — nothing else to fill in.

Model specs (context window, reasoning) are auto-filled by matching each model
against the models.dev catalog. You can reopen a custom provider to override a
model's context/reasoning/temperature; those overrides are best-effort and not
guaranteed to keep the model working.

### Terminal

```bash
# Log in to a provider (official providers, or a plugin auth flow)
deepagent auth login

# See what's connected
deepagent auth list
```

### Config file

Providers also live in `~/.deepagent/code/config.jsonc`. A custom OpenAI-compatible endpoint looks like this: set `discovery: true` to have models refreshed from the endpoint at runtime, or list them explicitly under `models`:

```jsonc
{
  "$schema": "https://ai.deepagent.ltd/config.schema.json",
  "provider": {
    "myprovider": {
      "name": "My Provider",
      "npm": "@ai-sdk/openai-compatible",
      "discovery": true,
      "options": {
        "baseURL": "https://api.myprovider.com/v1",
        "apiKey": "sk-..."
      }
    }
  }
}
```

Official-provider keys added via the app/CLI are stored separately in
`~/.deepagent/code/auth.json`, not in the config file. Full reference
(base URL overrides, headers, per-model config, gateways) lives in the
[DeepAgent API Platform docs](https://api.deepagent.ltd/), or explore
supported models and plans on [Model Square pricing](https://api.deepagent.ltd/pricing).

All DeepAgent Code private filesystem data lives under `~/.deepagent/code/`, including configuration, credential references, databases, Desktop state, logs, caches, and temporary files. Native secret values remain in the operating system's credential store. Tests run against explicitly isolated directories; even environment variables cannot redirect where production data is stored.

## Quick Example

Start the agent and give it a task:

```bash
deepagent-code run "add rate limiting to /api/users endpoint"
```

The agent will:

1. Use LSP to find the endpoint definition and understand its structure
2. Check project memory for existing middleware patterns
3. Activate the relevant domain packs (backend API, the project's language)
4. Implement rate limiting following project conventions
5. Run tests, capture diagnostics, and propose a candidate memory: "This project uses express-rate-limit middleware"

On your next session, when you ask to add rate limiting elsewhere, the agent already knows the pattern.

## How It Works (Under the Hood)

**Durable session core**: Prompts become durable records before execution; a single serialized runner turns them into visible messages at safe points. Steering messages merge into the running task, queued instructions start one at a time after it, and interrupts land precisely on the work that is actually running.

**Event graph**: Session activity, task runs, and evidence are event-sourced, written in the same transaction as the state they describe, so replay and recovery agree with what actually happened.

**Document graph**: All persistent state lives in typed documents: `knowledge`, `strategy`, `methodology`, `skill`, `memory`, `design`, `worklog`, `diagnosis`, `eval`. Documents link to each other (supports/blocks/conflicts/validates), forming a graph you can traverse.

**Scope layers**: `session-private` (current conversation), `project-shared` (all sessions in this project), `user-global` (cross-project preferences), `public-system` (built-in skills), `sealed` (audit-only, never enters context).

**Context admission**: Retrieval hits pass through admission gates. Full tool output (raw LSP dumps, diagnostics, capability indexes) is written to evidence artifacts, ref-linked and tool-only; only summaries and `file:line` snippets enter the model context. The agent may point at sensitive values (SSH hosts, tokens, internal paths) but never pastes the raw value into context.

**AI IDE microservice**: Query code by symbol name and intent (e.g. `code_intel({ symbol: "AgentGateway.open", intent: "overview" })`), not file:line coordinates. Get definitions, references, call chains, type hierarchies, and diagnostics in one call. Built on LSP with 38+ language servers; degrades gracefully to grep/read when no server is configured.

**Preset MCP catalog**: Curated MCP servers for Git platforms, file search, read-only databases, and browser automation. Risk tiers are derived at load time from the catalog template (not user config, so they can't be injected), and servers default to not-connected with write and external-fetch operations behind approval gates.

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

- [DeepAgent API Platform](https://api.deepagent.ltd/) · [Model Square pricing](https://api.deepagent.ltd/pricing)
- [Architecture & Design](design/README.md)
- [Real-LLM Testing Guide](design/real-llm-testing.md)
- [Security Policy](SECURITY.md)
- [Privacy Policy](PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## License & Attribution

DeepAgent Code is licensed under **AGPL-3.0-or-later**. If you modify and run it as a network service, you must make the corresponding source available to its users.

DeepAgent Code is derived from [opencode](https://github.com/sst/opencode) under the MIT License. See [NOTICE](NOTICE) for upstream attribution. No endorsement by opencode or its contributors is implied.

---

<p align="center"><sub>Built by DeepAgent</sub></p>
