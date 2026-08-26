# Security Policy

## Reporting vulnerabilities

Please report security issues privately before publishing details. Send a concise report with reproduction steps, affected version, impact, and any relevant logs or patches to the project maintainers through the private security channel configured for this repository.

Do not include live secrets in reports. Use redacted examples or synthetic credentials.

## Supported versions

The active development line is the `dev` branch. The supported release is the latest published version on the `core-v4.0-beta` branch and the desktop app release derived from it. Security fixes are applied to the active line and backported to the latest release where feasible.

## Source availability

DeepAgent Code is licensed under AGPL-3.0-or-later. If you interact with a modified DeepAgent Code service over a network, you are entitled to the corresponding source code for that service under AGPL section 13.

## MCP security model

Preset MCP servers are opt-in. The preset catalog records intended risk tiers, but the live permission gate derives a server's tier at runtime from catalog template matching rather than trusting user-writable configuration. If a hand-written or forged server does not match a known template, it falls back to the normal approval path.

Read-only database presets are intended to use restricted server modes and SQL guardrails. Guardrails are defense in depth, not a substitute for least-privilege database users.

## MCP credential security (V4.0+)

As of V4.0, MCP server credentials are stored in OS-backed secret storage where available (macOS Keychain; Linux and Windows fall back to a 0600 file). Credential values are not persisted in plain-text configuration. Only variable names or references travel through config files; values are resolved at runtime.

If you are running a version older than V4.0:

- Do not commit DeepAgent Code configuration files containing secrets.
- Prefer environment-variable indirection where a server supports it.
- Use least-privilege tokens and database users.
- Rotate credentials if they were accidentally committed or shared.
