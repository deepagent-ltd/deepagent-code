#!/usr/bin/env bun
import { $ } from "bun"

const args = Bun.argv.slice(2)
const signingFile = Bun.file("signing.env")

if (await signingFile.exists()) {
  Object.entries(
    Object.fromEntries(
      (await signingFile.text())
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((line) => {
          const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line
          const separator = normalized.indexOf("=")
          if (separator === -1) throw new Error(`Invalid signing.env line: ${line}`)
          return [normalized.slice(0, separator).trim(), unquote(normalized.slice(separator + 1).trim())] as const
        }),
    ),
  ).forEach(([key, value]) => {
    if (Bun.env[key] === undefined && value.length > 0) Bun.env[key] = value
  })
}

// electron-builder 26 rejects a CSC_NAME that still carries the certificate-type
// prefix ("Developer ID Application: ..."); it wants the subject name only and picks
// the certificate type automatically. Strip the prefix so signing.env can hold either
// form (the keychain identity line is the natural thing to copy/paste).
if (Bun.env.CSC_NAME) {
  Bun.env.CSC_NAME = Bun.env.CSC_NAME.replace(/^Developer ID Application:\s*/i, "")
}

// Unsigned builds (e.g. local beta) opt out of the signing requirement with
// DEEPAGENT_CODE_ALLOW_UNSIGNED=1. The default still requires full signing config so a
// release build cannot silently ship unsigned.
const allowUnsigned = Bun.env.DEEPAGENT_CODE_ALLOW_UNSIGNED === "1" || Bun.env.DEEPAGENT_CODE_ALLOW_UNSIGNED === "true"
const shouldRequireMacSigning = (process.platform === "darwin" || args.includes("--mac")) && !allowUnsigned
const missing = shouldRequireMacSigning
  ? ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "CSC_NAME"].filter(
      (key) => !Bun.env[key] || Bun.env[key] === "REPLACE_WITH_APP_SPECIFIC_PASSWORD",
    )
  : []

if (missing.length > 0) {
  throw new Error(`Missing macOS signing config in packages/desktop/signing.env: ${missing.join(", ")}`)
}

if (allowUnsigned) {
  // electron-builder auto-discovers any identity in the keychain; force it off so an
  // unsigned build does not accidentally pick up an unrelated cert.
  Bun.env.CSC_IDENTITY_AUTO_DISCOVERY = "false"
}

await $`electron-builder ${args} --config electron-builder.config.ts`

function unquote(value: string) {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}
