# DeepAgent Code CLI

DeepAgent Code is a document-centered AI coding agent. This package contains the CLI/server runtime used by the terminal and desktop applications.

DeepAgent Code keeps the opencode runtime foundation and adds the DeepAgent control plane:

- typed-document memory for run state, durable knowledge, worklogs, decisions, diagnosis, and context snapshots.
- deterministic context assembly with context epochs, safe provider-turn admission, and progressive disclosure.
- work strength modes: `general`, `high`, `xhigh`, `max`, and `ultra`.
- `direct` and `wish` scenario modes.
- retrieval gates for top-k, evidence strength, conflicts, snapshot locking, and anti-misleading behavior.
- domain adapter packs that expose document refs, skills, validation, diagnosis, and policy profiles without owning a separate agent loop.
- learning and promotion flows for candidate memory, skills, facts, failure dossiers, strategies, and methodologies.

## Install

> **Note:** The `deepagent-code` npm package is not yet publicly published.
> Install via the desktop app or the install script:

```bash
curl -fsSL https://deepagent.ltd/install | bash
```

## Usage

```bash
deepagent-code
```

For full documentation, desktop downloads, and configuration guides, see the repository README and https://deepagent.ltd/docs.
