# Security Policy

## Reporting vulnerabilities

Please report security issues privately before publishing details. Send a concise report with reproduction steps, affected version, impact, and any relevant logs or patches to the project maintainers through the private security channel configured for this repository.

Do not include live secrets in reports. Use redacted examples or synthetic credentials.

## Supported versions

Before the first public stable tag, the supported line is the current `main` branch and the latest published pre-release. Security fixes may be released as patch versions.

## Source availability

DeepAgent Code is licensed under AGPL-3.0-or-later. If you interact with a modified DeepAgent Code service over a network, you are entitled to the corresponding source code for that service under AGPL section 13.

## MCP security model

Preset MCP servers are opt-in. The preset catalog records intended risk tiers, but the live permission gate derives a server's tier at runtime from catalog template matching rather than trusting user-writable configuration. If a hand-written or forged server does not match a known template, it falls back to the normal approval path.

Read-only database presets are intended to use restricted server modes and SQL guardrails. Guardrails are defense in depth, not a substitute for least-privilege database users.

## Known limitation: preset MCP credentials in V3.4.1

When enabling preset MCP servers that require credentials, credential values may currently be persisted in local configuration. Until V3.5 M-CRED lands:

- Do not commit DeepAgent Code configuration files containing secrets.
- Prefer environment-variable indirection where a server supports it.
- Use least-privilege tokens and database users.
- Rotate credentials if they were accidentally committed or shared.

The planned V3.5 M-CRED work stores secrets in OS-backed secret storage where available (macOS Keychain, Windows Credential Manager, Linux Secret Service), passes only variable names or references through configuration, and resolves values at runtime.
