import { cmd } from "./cmd"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { effectCmd, fail } from "../effect-cmd"
import { Cause } from "effect"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpOAuthState } from "../../mcp/oauth-state"
import { Config } from "@/config/config"
import { ConfigFileWrite } from "@/config/file-write"
import { SecretRefScope } from "@/mcp/secret-ref-scope"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { AppRuntime } from "@/effect/app-runtime"
import path from "path"
import { Global } from "@deepagent-code/core/global"
import { modify, applyEdits, parse } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { Effect, Schema } from "effect"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
    case "unknown":
    case "legacy_unverified":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
    case "unknown":
      return "outcome unknown; automatic retry is blocked"
    case "legacy_unverified":
      return "legacy credentials retained; authenticate explicitly for this account and location"
  }
}

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

type McpConfigured = ConfigMCPV1.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: ConfigV1.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: ConfigV1.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = cfg.mcpSnapshot ? (yield* cfg.mcpSnapshot()).config : yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: 16 },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = cfg.mcpSnapshot ? (yield* cfg.mcpSnapshot()).config : yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: 16 },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpRemoveCommand)
      .command(McpEditCommand)
      .command(McpListCommand)
      .command(McpCatalogCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .command(McpSecretCommand)
      .demandCommand(),
  async handler() {},
})

export const McpSecretCommand = effectCmd({
  command: "secrets <action> [name]",
  describe: "explicitly initialize scoped MCP binding, migrate credentials, or inspect a migration",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", {
        choices: ["init", "preview", "commit", "status", "reconcile", "binding-preview", "binding-repair"],
        type: "string",
        demandOption: true,
      })
      .positional("name", { type: "string" })
      .option("request-id", { type: "string" }),
  handler: Effect.fn("Cli.mcp.secrets")(function* (args) {
    const migration = (yield* MCP.Service).secretMigration
    if (!migration) return yield* fail("Scoped MCP credential migration is unavailable")
    const operation = Effect.gen(function* () {
      if (args.action === "status" || args.action === "reconcile") {
        if (!args.requestId) return yield* fail("An original --request-id is required")
        const status = yield* (
          args.action === "status" ? migration.status(args.requestId) : migration.reconcile(args.requestId)
        ).pipe(Effect.mapError((error) => ({ ...error, message: error.message })))
        if (!status) return yield* fail("The migration receipt is unavailable in this location")
        console.log(JSON.stringify(status))
        return
      }
      if (!args.name) return yield* fail("A configured MCP name is required")
      if (args.action === "binding-preview" || args.action === "binding-repair") {
        const preview = yield* migration.previewBinding(args.name)
        console.log(
          JSON.stringify({
            name: preview.name,
            source: preview.source,
            old: preview.old,
            nextObservedProjectId: preview.nextObservedProjectId,
          }),
        )
        console.log(
          "Commit rechecks this exact binding and current Config leaf. Pending or unknown Work blocks repair. OAuth, grants, routes and Work are not migrated.",
        )
        if (args.action === "binding-preview") return
        const confirmed = yield* Effect.promise(() =>
          prompts.confirm({
            message:
              "Repair only these observed project IDs in this same namespace and root? Existing execution approvals are not renewed.",
          }),
        )
        if (prompts.isCancel(confirmed) || !confirmed) return
        console.log(JSON.stringify(yield* migration.repairBinding(preview.previewID)))
        return
      }
      if (args.action === "init") {
        const confirmed = yield* Effect.promise(() =>
          prompts.confirm({
            message:
              "Initialize the private installation and this directory's current MCP binding? Existing conflicting bindings remain blocked. Credentials and OAuth are not moved.",
          }),
        )
        if (prompts.isCancel(confirmed) || !confirmed) return
        console.log(JSON.stringify(yield* migration.initialize(args.name)))
        return
      }
      const preview = yield* migration.preview(args.name)
      console.log(JSON.stringify({ name: preview.name, source: preview.source, fields: preview.fields }))
      if (args.action === "preview" || !preview.fields.length) return
      if (!args.requestId)
        return yield* fail("Choose an original --request-id before committing; keep it for status or reconcile")
      const confirmed = yield* Effect.promise(() =>
        prompts.confirm({
          message:
            "Move exactly these credentials into scoped secret storage? The old OAuth credentials remain unchanged.",
        }),
      )
      if (prompts.isCancel(confirmed) || !confirmed) return
      const status = yield* migration.commit({ previewID: preview.previewID, requestID: args.requestId })
      console.log(JSON.stringify(status))
    }).pipe(
      Effect.provideService(SecretRefScope.CliDirectory, process.cwd()),
      Effect.mapError((error) => ({ ...error, message: error.message })),
    )
    return yield* operation.pipe(Effect.catch((error) => fail(error.message)))
  }),
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro("MCP Servers")

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No MCP servers configured")
      prompts.outro("Add servers with: deepagent-code mcp add")
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = "not initialized"
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = "connected"
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = "disabled"
      } else if (status.status === "disconnected") {
        statusIcon = "○"
        statusText = `disconnected; ${getAuthStatusText(status.authStatus)}`
        hint =
          status.reason === "unknown_outcome"
            ? " (inspect the unknown operation before authenticating again)"
            : " (connect explicitly)"
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = "needs authentication"
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = "needs client registration"
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = "failed"
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(`${servers.length} server(s)`)
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Authentication")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in deepagent-code.json:")
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to authenticate",
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(`MCP server not found: ${serverName}`)
      prompts.outro("Done")
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(`MCP server ${serverName} is not an OAuth-capable remote server`)
      prompts.outro("Done")
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          message: `${serverName} already has valid credentials. Re-authenticate?`,
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro("Cancelled")
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
    }

    const spinner = prompts.spinner()
    spinner.start("Starting OAuth flow...")

    // Subscribe to browser open failure events to show URL for manual opening
    const events = yield* EventV2Bridge.Service
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== MCP.BrowserOpenFailed.type) return Effect.void
      const data = event.data as EventV2.Data<typeof MCP.BrowserOpenFailed>
      if (data.mcpName === serverName) {
        spinner.stop("Could not open browser automatically")
        prompts.log.warn("Please open this URL in your browser to authenticate:")
        prompts.log.info(data.url)
        spinner.start("Waiting for authorization...")
      }
      return Effect.void
    })

    yield* MCP.Service.use((mcp) => mcp.authenticate(serverName)).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop("Authentication successful!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
            prompts.log.info("Add clientId to your MCP server config:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "expectedIssuer": "https://your-authorization-server.example"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Unexpected status: " + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Authentication failed", 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
      Effect.ensuring(unsubscribe),
    )

    prompts.outro("Done")
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro("MCP OAuth Status")

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.outro("Done")
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(`${servers.length} OAuth-capable server(s)`)
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Logout")

    const configuration = yield* Config.Service
    const current = configuration.mcpSnapshot ? (yield* configuration.mcpSnapshot()).config : yield* configuration.get()
    const servers = Object.entries(current.mcp ?? {}).filter(
      (entry) => "type" in entry[1] && entry[1].type === "remote" && entry[1].oauth !== false,
    )
    const serverNames = servers.map(([name]) => name)

    if (serverNames.length === 0) {
      prompts.log.warn(
        "No OAuth-capable MCP server is configured in this location; legacy credentials remain unchanged",
      )
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to logout",
          options: serverNames.map((name) => ({ label: name, value: name, hint: "current account and location" })),
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    if (!serverNames.includes(serverName))
      return yield* fail(`No OAuth-capable MCP server configured here: ${serverName}`)

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName)).pipe(
      Effect.catchTag("MCP.OAuthFlowError", (error) => fail(error.message)),
    )
    prompts.log.success(`Removed scoped OAuth credentials for ${serverName}; legacy credentials remain unchanged`)
    prompts.outro("Done")
  }),
})

async function resolveConfigPath(baseDir: string, global = false) {
  // Check for existing config files (prefer .jsonc over .json, check .deepagent-code/ subdirectory too)
  const candidates = [path.join(baseDir, "deepagent-code.json"), path.join(baseDir, "deepagent-code.jsonc")]

  if (!global) {
    candidates.push(
      path.join(baseDir, ".deepagent-code", "deepagent-code.json"),
      path.join(baseDir, ".deepagent-code", "deepagent-code.jsonc"),
    )
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to deepagent-code.json if none exist
  return candidates[0]
}

export async function addMcpToConfig(
  name: string,
  mcpConfig: ConfigMCPV1.Info,
  configPath: string,
  expected?: ConfigFileWrite.Observation,
) {
  return ConfigFileWrite.run(
    ConfigFileWrite.edit(
      configPath,
      (file) => ({
        text: applyEdits(
          file.text ?? "{}",
          modify(file.text ?? "{}", ["mcp", name], mcpConfig, {
            formattingOptions: { tabSize: 2, insertSpaces: true },
          }),
        ),
        value: configPath,
      }),
      expected,
    ),
  )
}

// PARITY-004 quick-win: `mcp remove` parity with the GUI delete button
// (dialog-select-mcp.tsx). The server definition lives in a jsonc config file
// (project or global), so removal is a jsonc edit that preserves comments —
// same mechanism as addMcpToConfig above.
function projectMcpConfigCandidates(baseDir: string) {
  return [
    path.join(baseDir, "deepagent-code.json"),
    path.join(baseDir, "deepagent-code.jsonc"),
    path.join(baseDir, ".deepagent-code", "deepagent-code.json"),
    path.join(baseDir, ".deepagent-code", "deepagent-code.jsonc"),
  ]
}

function globalMcpConfigCandidates() {
  // Matches the files Config.get merges for the global scope (config/config.ts).
  return ["config.jsonc", "config.json", "deepagent-code.jsonc", "deepagent-code.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
}

export async function removeMcpFromConfig(name: string, configPath: string, expected?: ConfigFileWrite.Observation) {
  return ConfigFileWrite.run(
    ConfigFileWrite.edit(
      configPath,
      (file) => {
        const text = file.text
        if (text === undefined) return { value: false }
        const parsed = parse(text) as { mcp?: Record<string, unknown> } | undefined
        if (!parsed || typeof parsed !== "object" || !parsed.mcp || !(name in parsed.mcp)) return { value: false }
        const edits = modify(text, ["mcp", name], undefined, {
          formattingOptions: { tabSize: 2, insertSpaces: true },
        })
        return { text: applyEdits(text, edits), value: true }
      },
      expected,
    ),
  )
}

// PARITY-004 long-tail: `mcp edit` modifies an EXISTING server definition in
// place (updateMcpConfig semantics — the GUI edit dialog rewrites the same
// entry). Same jsonc-preserving mechanism as add/remove: field-level edits via
// jsonc-parser so comments and sibling keys survive.
type McpEditPatch = {
  url?: string
  environment?: Record<string, string>
  headers?: Record<string, string>
  command?: string[]
}

export async function editMcpInConfig(
  name: string,
  configPath: string,
  patch: McpEditPatch,
  expected?: ConfigFileWrite.Observation,
): Promise<{ edited: boolean; error?: string }> {
  return ConfigFileWrite.run(
    ConfigFileWrite.edit<{ edited: boolean; error?: string }>(
      configPath,
      (file) => {
        const text = file.text
        if (text === undefined) return { value: { edited: false } }
        const parsed = parse(text) as { mcp?: Record<string, ConfigMCPV1.Info> } | undefined
        const existing = parsed && typeof parsed === "object" ? parsed.mcp?.[name] : undefined
        if (!existing || typeof existing !== "object" || !("type" in existing)) return { value: { edited: false } }
        if ((patch.url !== undefined || patch.headers !== undefined) && existing.type !== "remote") {
          return {
            value: {
              edited: false,
              error: `--url/--header only apply to remote servers ("${name}" is ${existing.type} in ${configPath})`,
            },
          }
        }
        if ((patch.environment !== undefined || patch.command?.length) && existing.type !== "local") {
          return {
            value: {
              edited: false,
              error: `--env/command only apply to local servers ("${name}" is ${existing.type} in ${configPath})`,
            },
          }
        }
        let result = text
        const apply = (jsonPath: (string | number)[], value: unknown) => {
          result = applyEdits(
            result,
            modify(result, jsonPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
          )
        }
        if (patch.url !== undefined) apply(["mcp", name, "url"], patch.url)
        if (patch.command?.length) apply(["mcp", name, "command"], patch.command)
        for (const [key, value] of Object.entries(patch.environment ?? {}))
          apply(["mcp", name, "environment", key], value)
        for (const [key, value] of Object.entries(patch.headers ?? {})) apply(["mcp", name, "headers", key], value)
        return { text: result, value: { edited: true } }
      },
      expected,
    ),
  )
}

export const McpEditCommand = effectCmd({
  command: "edit <name>",
  describe: "edit an existing MCP server's configuration (url/env/header/command)",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
        demandOption: true,
      })
      .option("url", {
        describe: "new URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE, merged)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE, merged)",
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.mcp.edit")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const command = (args["--"] ?? []) as string[]
    if (!args.url && !args.env?.length && !args.header?.length && !command.length) {
      return yield* fail("No changes provided. Use --url, --env, --header, or a command after --.")
    }
    if (args.url && !URL.canParse(args.url)) return yield* fail(`Invalid URL: ${args.url}`)
    const entries = (values: string[], kind: string) =>
      Object.fromEntries(
        values.map((entry) => {
          const index = entry.indexOf("=")
          if (index < 1) throw new Error(`Invalid ${kind}: ${entry}. Expected KEY=VALUE`)
          return [entry.slice(0, index), entry.slice(index + 1)]
        }),
      )
    const patch: McpEditPatch = {
      ...(args.url ? { url: args.url } : {}),
      ...(args.env?.length ? { environment: entries(args.env, "environment variable") } : {}),
      ...(args.header?.length ? { headers: entries(args.header, "HTTP header") } : {}),
      ...(command.length ? { command } : {}),
    }
    const outcome = yield* Effect.promise(async () => {
      const candidates = [...projectMcpConfigCandidates(ctx.worktree), ...globalMcpConfigCandidates()]
      const editedFrom: string[] = []
      let error: string | undefined
      for (const configPath of candidates) {
        const result = await editMcpInConfig(args.name, configPath, patch)
        if (result.error) error ??= result.error
        else if (result.edited) editedFrom.push(configPath)
      }
      return { editedFrom, error }
    })
    if (outcome.editedFrom.length === 0) return yield* fail(outcome.error ?? `MCP server not found: ${args.name}`)
    for (const configPath of outcome.editedFrom) {
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + `Updated MCP server "${args.name}" in ${configPath}` + UI.Style.TEXT_NORMAL,
      )
    }
  }),
})

export const McpRemoveCommand = effectCmd({
  command: "remove <name>",
  aliases: ["rm"],
  describe: "remove an MCP server from the project or global config",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.remove")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const removedFrom = yield* Effect.promise(async () => {
      const candidates = [...projectMcpConfigCandidates(ctx.worktree), ...globalMcpConfigCandidates()]
      const paths: string[] = []
      for (const configPath of candidates) {
        if (await removeMcpFromConfig(args.name, configPath)) paths.push(configPath)
      }
      return paths
    })
    if (removedFrom.length === 0) return yield* fail(`MCP server not found: ${args.name}`)
    for (const configPath of removedFrom) {
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + `Removed MCP server "${args.name}" from ${configPath}` + UI.Style.TEXT_NORMAL,
      )
    }
    UI.println(
      UI.Style.TEXT_DIM +
        "OAuth credentials (if any) remain; drop them with: deepagent-code mcp logout " +
        args.name +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

// PARITY-004 quick-win: `mcp catalog` parity with the GUI preset catalog
// (groups/mcp.ts `catalog` + dialog-add-mcp.tsx). The catalog is static
// metadata (McpCatalog.list()) — listing connects nothing. `--format json`
// keeps the output scriptable.
export const McpCatalogCommand = effectCmd({
  command: "catalog",
  describe: "list preset MCP servers from the vetted catalog (metadata only)",
  builder: (yargs) =>
    yargs.option("format", {
      describe: "output format",
      type: "string",
      choices: ["table", "json"],
      default: "table",
    }),
  handler: Effect.fn("Cli.mcp.catalog")(function* (args) {
    const entries = yield* MCP.Service.use((mcp) => mcp.catalog())
    if (args.format === "json") {
      console.log(JSON.stringify(entries, null, 2))
      return
    }
    UI.empty()
    prompts.intro("MCP Preset Catalog")
    if (entries.length === 0) {
      prompts.log.warn("No preset MCP servers in the catalog")
      prompts.outro("Done")
      return
    }
    for (const entry of entries) {
      const creds = entry.credentials.length
        ? ` (credentials: ${entry.credentials.map((credential) => credential.key).join(", ")})`
        : ""
      prompts.log.info(
        `${entry.id} — ${entry.title} [${entry.transport}/${entry.riskTier}]${creds}\n    ${UI.Style.TEXT_DIM}${entry.description}${UI.Style.TEXT_NORMAL}`,
      )
    }
    prompts.outro(
      `${entries.length} preset(s); enable one from the GUI MCP dialog or add it manually with: deepagent-code mcp add`,
    )
  }),
})

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "add an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("url", {
        describe: "URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    yield* Effect.promise(async () => {
      const command = args["--"] ?? []
      if (!args.name && (args.url || args.env?.length || args.header?.length || command.length)) {
        throw new Error("A server name is required for non-interactive MCP configuration")
      }
      if (args.name) {
        if (!!args.url === !!command.length) {
          throw new Error("Provide either --url <url> or a command after --")
        }
        if (args.url && !URL.canParse(args.url)) {
          throw new Error(`Invalid URL: ${args.url}`)
        }
        if (args.url && args.env?.length) {
          throw new Error("--env is only valid for local MCP servers")
        }
        if (command.length && args.header?.length) {
          throw new Error("--header is only valid for remote MCP servers")
        }

        const entries = (values: string[], kind: string) =>
          Object.fromEntries(
            values.map((entry) => {
              const index = entry.indexOf("=")
              if (index < 1) throw new Error(`Invalid ${kind}: ${entry}. Expected KEY=VALUE`)
              return [entry.slice(0, index), entry.slice(index + 1)]
            }),
          )
        const environment = entries(args.env ?? [], "environment variable")
        const headers = entries(args.header ?? [], "HTTP header")
        const mcpConfig: ConfigMCPV1.Info = args.url
          ? {
              type: "remote",
              url: args.url,
              ...(Object.keys(headers).length ? { headers } : {}),
            }
          : {
              type: "local",
              command,
              ...(Object.keys(environment).length ? { environment } : {}),
            }

        const config = await AppRuntime.runPromise(Config.Service)
        const current = await AppRuntime.runPromise(config.getGlobal())
        await AppRuntime.runPromise(
          config.updateGlobal({
            ...current,
            mcp: {
              ...current.mcp,
              [args.name]: mcpConfig,
            },
          }),
        )
        prompts.log.success(`MCP server "${args.name}" added to ${path.join(Global.Path.config, "config.jsonc")}`)
        return
      }

      UI.empty()
      prompts.intro("Add MCP server")

      const project = ctx.project

      // Resolve config paths eagerly for hints
      const [projectConfigPath, globalConfigPath] = await Promise.all([
        resolveConfigPath(ctx.worktree),
        resolveConfigPath(Global.Path.config, true),
      ])

      // Determine scope
      let configPath = globalConfigPath
      if (project.vcs === "git") {
        const scopeResult = await prompts.select({
          message: "Location",
          options: [
            {
              label: "Current project",
              value: projectConfigPath,
              hint: projectConfigPath,
            },
            {
              label: "Global",
              value: globalConfigPath,
              hint: globalConfigPath,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        configPath = scopeResult
      }

      const name = await prompts.text({
        message: "Enter MCP server name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: "Select MCP server type",
        options: [
          {
            label: "Local",
            value: "local",
            hint: "Run a local command",
          },
          {
            label: "Remote",
            value: "remote",
            hint: "Connect to a remote URL",
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: "Enter command to run",
          placeholder: "e.g., deepagent-code x @modelcontextprotocol/server-filesystem",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: ConfigMCPV1.Info = {
          type: "local",
          command: command.split(" "),
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
        prompts.outro("MCP server added successfully")
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: "Enter MCP server URL",
          placeholder: "e.g., https://example.com/mcp",
          validate: (x) => {
            if (!x) return "Required"
            if (x.length === 0) return "Required"
            return Schema.is(McpOAuthState.Uri)(x) ? undefined : "Enter an HTTP(S) URL without credentials or fragment"
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: "Does this server require OAuth authentication?",
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: ConfigMCPV1.Info

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: "Do you have a pre-registered client ID?",
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: "Enter client ID",
              validate: (x) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: "Do you have a client secret?",
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            let expectedIssuer: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: "Enter client secret",
                validate: (value) => (value ? undefined : "Required"),
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
              const issuer = await prompts.text({
                message: "Enter the authorization server issuer URL",
                placeholder: "e.g., https://auth.example.com",
                validate: (value) =>
                  Schema.is(McpOAuthState.Issuer)(value)
                    ? undefined
                    : "Enter an HTTP(S) issuer URL without credentials, query or fragment",
              })
              if (prompts.isCancel(issuer)) throw new UI.CancelledError()
              expectedIssuer = issuer
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                clientId,
                ...(clientSecret && { clientSecret }),
                ...(expectedIssuer && { expectedIssuer }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
      }

      prompts.outro("MCP server added successfully")
    })
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const configuration = yield* Config.Service
    const config = configuration.mcpSnapshot ? (yield* configuration.mcpSnapshot()).config : yield* configuration.get()
    const mcp = yield* MCP.Service
    UI.empty()
    prompts.intro("MCP OAuth Diagnostics")
    const server = config.mcp?.[args.name]
    if (!server || !isMcpRemote(server)) {
      prompts.log.error(`Remote MCP server not found: ${args.name}`)
      prompts.outro("Done")
      return
    }
    if (server.oauth === false) {
      prompts.log.info("OAuth is disabled for this server")
      prompts.outro("Done")
      return
    }
    const status = yield* mcp.getAuthStatus(args.name)
    prompts.log.info(`Server: ${args.name}`)
    prompts.log.info(`Auth status: ${getAuthStatusIcon(status)} ${getAuthStatusText(status)}`)
    prompts.log.info(
      "This read-only diagnostic does not connect, discover an issuer, register a client or refresh credentials.",
    )
    prompts.log.info(
      status === "unknown"
        ? "The previous OAuth request outcome is unknown. Inspect it before beginning an explicit new authentication."
        : "Use an explicit connect or auth action when you want to contact this server.",
    )
    prompts.outro("Diagnostics complete")
  }),
})
