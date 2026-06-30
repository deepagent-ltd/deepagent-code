# Privacy

DeepAgent Code runs locally by default and sends data to model providers only as required to answer your prompts or execute configured tools.

## Data that may leave your machine

Depending on the provider and tools you enable, prompts, selected context, tool results, file excerpts, diagnostics, and MCP server responses may be sent to the configured model provider or service endpoint.

## Local data

DeepAgent Code may store sessions, documents, memories, configuration, logs, and MCP settings on disk. Treat local project and user configuration as sensitive when it contains provider keys, MCP credentials, repository paths, or private code excerpts.

## Telemetry and sharing

Do not enable telemetry, prompt sharing, log upload, or public share links unless you have reviewed what will be sent. Public share URLs may expose session content to anyone with the link.

## Secrets

Never paste production secrets into prompts unless the configured workflow requires it and you understand which provider or tool will receive them. Prefer environment variables, least-privilege tokens, and short-lived credentials.
