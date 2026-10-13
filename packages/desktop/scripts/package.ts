#!/usr/bin/env bun
import { $ } from "bun"

export async function packageEnvironment(input: {
  environment: NodeJS.ProcessEnv
  args: string[]
  platform: NodeJS.Platform
  signingFile: string
}) {
  const environment = { ...input.environment }
  const allowUnsigned =
    environment.DEEPAGENT_CODE_ALLOW_UNSIGNED === "1" || environment.DEEPAGENT_CODE_ALLOW_UNSIGNED === "true"
  if (allowUnsigned) {
    // An explicit unsigned candidate must never import or auto-discover signing credentials.
    // Pass a private child environment so the caller's release configuration is preserved.
    ;[
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "CSC_NAME",
      "CSC_KEYCHAIN",
      "WIN_CSC_LINK",
      "WIN_CSC_KEY_PASSWORD",
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "APPLE_TEAM_ID",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ].forEach((key) => {
      delete environment[key]
    })
    environment.CSC_IDENTITY_AUTO_DISCOVERY = "false"
    return environment
  }
  const signingFile = Bun.file(input.signingFile)

  if (await signingFile.exists()) {
    Object.entries(
      Object.fromEntries(
        (await signingFile.text())
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"))
          .map((line, index) => {
            const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line
            const separator = normalized.indexOf("=")
            if (separator === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized.slice(0, separator).trim()))
              throw new Error(`Invalid signing.env entry at line ${index + 1}`)
            return [normalized.slice(0, separator).trim(), unquote(normalized.slice(separator + 1).trim())] as const
          }),
      ),
    ).forEach(([key, value]) => {
      if (environment[key] === undefined && value.length > 0) environment[key] = value
    })
  }

  // electron-builder 26 rejects a CSC_NAME that still carries the certificate-type
  // prefix ("Developer ID Application: ..."); it wants the subject name only and picks
  // the certificate type automatically. Strip the prefix so signing.env can hold either
  // form (the keychain identity line is the natural thing to copy/paste).
  if (environment.CSC_NAME) environment.CSC_NAME = environment.CSC_NAME.replace(/^Developer ID Application:\s*/i, "")

  // Unsigned builds (e.g. local beta) opt out of the signing requirement with
  // DEEPAGENT_CODE_ALLOW_UNSIGNED=1. The default still requires full signing config so a
  // release build cannot silently ship unsigned.
  const shouldRequireMacSigning = input.platform === "darwin" || input.args.includes("--mac")
  const missing = shouldRequireMacSigning
    ? ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "CSC_NAME"].filter(
        (key) => !environment[key] || environment[key] === "REPLACE_WITH_APP_SPECIFIC_PASSWORD",
      )
    : []

  if (missing.length > 0) {
    throw new Error(`Missing macOS signing config in packages/desktop/signing.env: ${missing.join(", ")}`)
  }

  return environment
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  const environment = await packageEnvironment({
    environment: Bun.env,
    args,
    platform: process.platform,
    signingFile: "signing.env",
  })
  const { prepareBuildOutput } = (await import(
    new URL("../../deepagent-code/script/build-output.ts", import.meta.url).href
  )) as {
    prepareBuildOutput(directory: string, args: readonly string[]): Promise<{ output: string; previous?: string }>
  }
  if (args.some((value) => value.startsWith("--config.directories.output")))
    throw new Error("Use --outdir to retain the previous installer candidate")
  const output = await prepareBuildOutput(process.cwd(), args)
  if (output.previous) console.log(`Previous installer candidate retained at ${output.previous}`)
  const index = args.indexOf("--outdir")
  const forwarded = args.filter((_, position) => index < 0 || (position !== index && position !== index + 1))
  await $`electron-builder ${forwarded} --config electron-builder.config.ts --config.directories.output=${output.output}`.env(
    environment,
  )
}

function unquote(value: string) {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}
