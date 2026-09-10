#!/usr/bin/env bun

import path from "node:path"
import {
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  isArrayBindingPattern,
  isBinaryExpression,
  isCallExpression,
  isClassLike,
  isElementAccessExpression,
  isFunctionLike,
  isIdentifier,
  isModuleBlock,
  isModuleDeclaration,
  isObjectBindingPattern,
  isOmittedExpression,
  isPropertyDeclaration,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableStatement,
  forEachChild,
  SyntaxKind,
  type BindingName,
  type Expression,
  type ModuleDeclaration,
  type Node,
  type NodeArray,
  type Statement,
  type VariableDeclaration,
} from "typescript"

export type RuntimeStateClassification =
  | "static_container"
  | "bounded_cache_review"
  | "ui_process_state"
  | "legacy_release_forbidden"
  | "runtime_state_review"

export type RuntimeStateVerdict =
  | "safe_static"
  | "safe_scoped"
  | "safe_bounded"
  | "release_forbidden"
  | "review_required"

export type RuntimeStateAudit = {
  readonly owner: string
  readonly keyScope: string
  readonly bound: string
  readonly finalizer: string
  readonly durability: string
  readonly reachability: string
  readonly verdict: RuntimeStateVerdict
}

export type RuntimeStateCandidate = {
  readonly key: string
  readonly file: string
  readonly line: number
  readonly name: string
  readonly declaration: "const" | "let" | "var" | "property"
  readonly mutated: boolean
  readonly classification: RuntimeStateClassification
} & RuntimeStateAudit

const mutationMethods = new Set([
  "set",
  "add",
  "delete",
  "clear",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
])

export async function runtimeStateInventory(repository: string): Promise<readonly RuntimeStateCandidate[]> {
  const files = (
    await Promise.all(
      ["**/src/**/*.ts", "**/src/**/*.tsx"].map((pattern) =>
        Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: path.join(repository, "packages"), onlyFiles: true })),
      ),
    )
  )
    .flat()
    .filter(
      (file) =>
        !file.includes("/generated/") &&
        !file.endsWith(".gen.ts") &&
        !file.includes(".test.") &&
        !file.includes(".spec."),
    )
    .map((file) => `packages/${file}`)
    .sort()

  return (
    await Promise.all(
      files.map(async (file) => {
        const source = await Bun.file(path.join(repository, file)).text()
        return runtimeStateCandidates(file, source)
      }),
    )
  )
    .flat()
    .sort((left, right) => left.key.localeCompare(right.key))
}

export function runtimeStateCandidates(file: string, source: string): readonly RuntimeStateCandidate[] {
  const sourceFile = createSourceFile(
    file,
    source,
    ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  )
  const variables = [...moduleVariables(sourceFile.statements), ...escapingVariables(sourceFile)]
  return [
    ...variables.flatMap(({ declaration, namespace }) =>
    bindingNames(declaration.name).flatMap((name): RuntimeStateCandidate[] => {
      const kind =
        declaration.parent.flags & NodeFlags.Const ? "const" : declaration.parent.flags & NodeFlags.Let ? "let" : "var"
      const initializer = classifyInitializer(declaration.initializer?.getText(sourceFile))
      if (kind === "const" && initializer === "immutable") return []
      const mutated = kind !== "const" || mutatesBinding(sourceFile, name)
      const key = `${file}:${[...namespace, name].join(".")}`
      const classification = classify(file, name, mutated, initializer === "stateful")
      return [
        {
          key,
          file,
          line: sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile)).line + 1,
          name,
          declaration: kind,
          mutated,
          classification,
          ...audit(key, classification),
        },
      ]
    }),
    ),
    ...classProperties(file, sourceFile),
  ]
}

function escapingVariables(sourceFile: ReturnType<typeof createSourceFile>) {
  const out: Array<{ declaration: VariableDeclaration; namespace: readonly string[] }> = []
  const visit = (node: Node) => {
    if (isVariableDeclaration(node) && !isModuleVariable(node)) {
      const owner = enclosingFunction(node)
      const source = node.initializer?.getText(sourceFile)
      const collection = /^new\s+(?:Map|Set|WeakMap|WeakSet)\b/.test(source?.trim() ?? "")
      const mutableRuntime =
        /^(?:await\s+)?(?:new\s+(?:Map|Set|WeakMap|WeakSet|AsyncLocalStorage|AbortController|Worker|WebSocket|[A-Za-z_$][\w$]*(?:Server|Client|Runtime|Store|Cache|Registry|Pool|Queue|Tracker))\b|(?:[A-Za-z_$][\w$]*\.)*(?:make[A-Za-z0-9_$]*Unsafe|unsafeMake|makeRuntime|ManagedRuntime\.make|(?:create|make)[A-Za-z0-9_$]*(?:Runtime|Store|Cache|Registry|Server|Client|Pool|Queue|Tracker))\s*\()/.test(
          source?.trim() ?? "",
        )
      if (owner && mutableRuntime) {
        const names = bindingNames(node.name)
        if (names.some((name) => escapesInvocation(node, owner, name, !collection))) {
          const ownerLine = sourceFile.getLineAndCharacterOfPosition(owner.getStart(sourceFile)).line + 1
          const declarationLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          out.push({ declaration: node, namespace: [`${functionName(owner)}@${ownerLine}:${declarationLine}`] })
        }
      }
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return out
}

function classProperties(file: string, sourceFile: ReturnType<typeof createSourceFile>): RuntimeStateCandidate[] {
  const out: RuntimeStateCandidate[] = []
  const visit = (node: Node) => {
    if (isPropertyDeclaration(node) && node.name && isIdentifier(node.name)) {
      const owner = node.parent
      if (isClassLike(owner)) {
        const initializer = classifyInitializer(node.initializer?.getText(sourceFile))
        const readonly = node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ReadonlyKeyword) ?? false
        const typedState = /\b(?:Map|Set|WeakMap|WeakSet|Promise|AbortController|Worker|WebSocket|Server|Client|Runtime|Store|Cache|Registry|Pool|Queue|Tracker)\b/.test(
          node.type?.getText(sourceFile) ?? "",
        )
        if (initializer !== "immutable" || typedState) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
          const name = `${owner.name?.text ?? "anonymous-class"}.${node.name.text}`
          const classification = classify(file, name, !readonly, initializer === "stateful")
          out.push({
            key: `${file}:${name}@${line}`,
            file,
            line,
            name,
            declaration: "property",
            mutated: !readonly,
            classification,
            ...audit(`${file}:${name}@${line}`, classification),
          })
        }
      }
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return out
}

function isModuleVariable(declaration: VariableDeclaration) {
  const statement = declaration.parent.parent
  return isVariableStatement(statement) && (statement.parent.kind === SyntaxKind.SourceFile || isModuleBlock(statement.parent))
}

function enclosingFunction(node: Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) return current
  }
}

function functionName(node: Node) {
  if (isFunctionLike(node) && node.name && isIdentifier(node.name)) return node.name.text
  if (isFunctionLike(node) && isVariableDeclaration(node.parent) && isIdentifier(node.parent.name)) return node.parent.name.text
  if (isFunctionLike(node) && isPropertyDeclaration(node.parent) && isIdentifier(node.parent.name)) return node.parent.name.text
  return "closure"
}

const synchronousCallbacks = new Set(["every", "filter", "find", "findIndex", "flatMap", "forEach", "map", "reduce", "reduceRight", "some", "sort"])

function escapesInvocation(declaration: VariableDeclaration, owner: Node, name: string, directReturnEscapes: boolean) {
  let escapes = false
  const visit = (node: Node) => {
    if (escapes || node === declaration) return
    if (isIdentifier(node) && node.text === name && node !== declaration.name) {
      for (let current = node.parent; current && current !== owner; current = current.parent) {
        if (isReturnStatement(current) && enclosingFunction(current) === owner) {
          escapes = directReturnEscapes
          return
        }
        if (!isFunctionLike(current)) continue
        const call = current.parent
        if (
          isCallExpression(call) &&
          call.arguments.includes(current as never) &&
          isPropertyAccessExpression(call.expression) &&
          synchronousCallbacks.has(call.expression.name.text)
        ) {
          return
        }
        escapes = true
        return
      }
    }
    forEachChild(node, visit)
  }
  forEachChild(owner, visit)
  return escapes
}

function mutatesBinding(sourceFile: ReturnType<typeof createSourceFile>, name: string) {
  let mutated = false
  const visit = (node: Parameters<typeof forEachChild>[0]) => {
    if (mutated) return
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      if (rootIdentifier(node.expression.expression) === name && mutationMethods.has(node.expression.name.text)) {
        mutated = true
        return
      }
    }
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= SyntaxKind.LastAssignment &&
      rootIdentifier(node.left) === name
    ) {
      mutated = true
      return
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return mutated
}

function rootIdentifier(expression: Expression): string | undefined {
  if (isIdentifier(expression)) return expression.text
  if (isPropertyAccessExpression(expression) || isElementAccessExpression(expression)) {
    return rootIdentifier(expression.expression)
  }
  return undefined
}

const reviewed: Readonly<Record<string, RuntimeStateAudit>> = {
  // ===========================================================================
  // RI-94 W3 (2026-09-10): per-family adjudications. Each entry names the real lifecycle owner
  // and finalizer verified in current source; none of these is durable authority.
  // ===========================================================================
  // ===========================================================================
  // RI-94 W4 (2026-09-10): per-family adjudications for the long tail.
  // ===========================================================================
  // Plugin OAuth singletons (xai/digitalocean/codex): one ephemeral localhost OAuth callback
  // server per process; oauthStart memoizes the in-flight start promise (cleared in finally);
  // pendingOAuth holds the single pending authorization exchanged once on callback. All are
  // process-bounded coordination state with explicit reset-on-completion.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/plugin/xai.ts:oauthServer",
      "packages/deepagent-code/src/plugin/xai.ts:oauthStart",
      "packages/deepagent-code/src/plugin/xai.ts:pendingOAuth",
      "packages/deepagent-code/src/plugin/digitalocean.ts:oauthServer",
      "packages/deepagent-code/src/plugin/digitalocean.ts:oauthStart",
      "packages/deepagent-code/src/plugin/digitalocean.ts:pendingOAuth",
      "packages/deepagent-code/src/plugin/openai/codex.ts:oauthServer",
      "packages/deepagent-code/src/plugin/openai/codex.ts:oauthStart",
      "packages/deepagent-code/src/plugin/openai/codex.ts:pendingOAuth",
    ].map((key) => [
      key,
      {
        owner: "Plugin.oauth-flow",
        keyScope: "process",
        bound: "one-server-one-pending-auth",
        finalizer: "reset-on-completion",
        durability: "coordination-only",
        reachability: "plugin-scoped",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // Plugin closure state: OAuth-start promise per invocation (dies with the call), the OpenAI
  // WebSocket pool per fetch-factory closure (pooled sockets bounded per provider instance), and
  // the ws plugin's per-connection socket handle.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/plugin/xai.ts:startOAuthServerOnce@425:426.server",
      "packages/deepagent-code/src/plugin/digitalocean.ts:startOAuthServerOnce@133:134.next",
      "packages/deepagent-code/src/plugin/openai/codex.ts:startOAuthServerOnce@254:255.next",
      "packages/deepagent-code/src/plugin/openai/ws-pool.ts:createWebSocketFetch@34:36.pool",
      "packages/deepagent-code/src/plugin/openai/ws.ts:closure@72:90.socket",
    ].map((key) => [
      key,
      {
        owner: "invocation-or-instance-scope",
        keyScope: "per-owner",
        bound: "owner-lifecycle",
        finalizer: "owner-exit",
        durability: "coordination-only",
        reachability: "plugin-scoped",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // TUI plugin runtime: a singleton module-level runtime/dir/loaded/ctrl for the TUI plugin
  // scope — process-bounded, one instance per TUI process; the scoped keymap cache is a Map
  // cleared on scope exit. The TUI is a single-process UI surface.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/plugin/tui/runtime.ts:runtime",
      "packages/deepagent-code/src/plugin/tui/runtime.ts:dir",
      "packages/deepagent-code/src/plugin/tui/runtime.ts:loaded",
      "packages/deepagent-code/src/plugin/tui/runtime.ts:createPluginScope@411:412.ctrl",
      "packages/deepagent-code/src/plugin/tui/runtime.ts:createScopedKeymap@147:148.cache",
    ].map((key) => [
      key,
      {
        owner: "TuiPlugin.process-singleton",
        keyScope: "process",
        bound: "one-instance",
        finalizer: "tui-shutdown",
        durability: "coordination-only",
        reachability: "tui-process",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // ACP service closure state: per-connection scope controller and pending operation maps —
  // bounded by the ACP connection lifecycle (cleared on disconnect).
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/acp/service.ts:agentConnections",
      "packages/deepagent-code/src/acp/service.ts:pendingOperations",
      "packages/deepagent-code/src/acp/service.ts:connectionScope",
      "packages/deepagent-code/src/acp/service.ts:create@125:132.client",
      "packages/deepagent-code/src/acp/service.ts:create@125:133.transport",
    ].map((key) => [
      key,
      {
        owner: "AcpConnection.lifecycle",
        keyScope: "per-connection",
        bound: "active-connections",
        finalizer: "disconnect-cleanup",
        durability: "coordination-only",
        reachability: "acp-adapter",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // CLI closure state: per-invocation SDK client handles, abort controllers, footer render
  // state (class-instance properties bounded by the render owner), and the debug-scrap runtime
  // handle — all die with their command invocation.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/cli/cmd/run.ts:closure@277:1207.sdk",
      "packages/deepagent-code/src/cli/cmd/providers.ts:closure@317:330.abort",
      "packages/deepagent-code/src/cli/cmd/debug/scrap.ts:handler@9:12.runtime",
      "packages/deepagent-code/src/cli/cmd/run/footer.prompt.tsx:createPromptState@283:305.marks",
      "packages/deepagent-code/src/cli/cmd/run/footer.ts:RunFooter.closes@173",
      "packages/deepagent-code/src/cli/cmd/run/footer.ts:RunFooter.flushing@177",
      "packages/deepagent-code/src/cli/cmd/run/footer.ts:RunFooter.promptRoute@206",
      "packages/deepagent-code/src/cli/cmd/run/footer.ts:RunFooter.prompts@171",
      "packages/deepagent-code/src/cli/cmd/run/footer.ts:RunFooter.queue@175",
      "packages/deepagent-code/src/cli/cmd/run/footer.ts:RunFooter.queuedRemoves@172",
      "packages/deepagent-code/src/cli/cmd/run/footer.ts:RunFooter.themeRefreshTimeouts@219",
      "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@113:115.controllers",
      "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@113:116.pendingMessages",
      "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@113:117.outputControllers",
      "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@113:120.streamControllers",
    ].map((key) => [
      key,
      {
        owner: "invocation-or-instance-scope",
        keyScope: "per-owner",
        bound: "owner-lifecycle",
        finalizer: "owner-exit",
        durability: "coordination-only",
        reachability: "cli-process",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // ACP per-connection/service closure Maps (subscriptions, snapshots, fork intents, MCP
  // registrations, usage limits): keyed by session/connection, cleared on disconnect/dispose.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/acp/agent.ts:init@25:26.subscriptions",
      "packages/deepagent-code/src/acp/directory.ts:make@144:145.snapshots",
      "packages/deepagent-code/src/acp/event.ts:Subscription.abort@37",
      "packages/deepagent-code/src/acp/event.ts:track@80:82.applied",
      "packages/deepagent-code/src/acp/service.ts:make@79:89.registeredMcp",
      "packages/deepagent-code/src/acp/service.ts:make@79:90.sessionSnapshots",
      "packages/deepagent-code/src/acp/service.ts:make@79:91.forkIntents",
      "packages/deepagent-code/src/acp/service.ts:makeUsageService@607:608.limits",
      "packages/deepagent-code/src/acp/service.ts:registerMcpServers@929:939.pending",
    ].map((key) => [
      key,
      {
        owner: "AcpConnection.lifecycle",
        keyScope: "per-connection-or-session",
        bound: "active-connections",
        finalizer: "disconnect-cleanup",
        durability: "coordination-only",
        reachability: "acp-adapter",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // Desktop main-process singletons: every Electron main-process module binding (window, view,
  // logger, tray, server, listener, blockers) is bounded by the single main-process lifetime and
  // cleared on window-close/app-quit. The desktop main process IS the process; these are its
  // canonical singletons with explicit app-lifecycle finalizers.
  ...Object.fromEntries(
    [
      "packages/desktop/src/main/browser-view.ts:bounds",
      "packages/desktop/src/main/browser-view.ts:host",
      "packages/desktop/src/main/browser-view.ts:view",
      "packages/desktop/src/main/browser-view.ts:visible",
      "packages/desktop/src/main/index.ts:logger",
      "packages/desktop/src/main/index.ts:mainWindow",
      "packages/desktop/src/main/index.ts:pendingDeepLinks",
      "packages/desktop/src/main/index.ts:server",
      "packages/desktop/src/main/logging.ts:logger",
      "packages/desktop/src/main/logging.ts:netLogPath",
      "packages/desktop/src/main/logging.ts:root",
      "packages/desktop/src/main/logging.ts:run",
      "packages/desktop/src/main/markdown.ts:renderer",
      "packages/desktop/src/main/power.ts:blockerId",
      "packages/desktop/src/main/server.ts:sidecarSpawnCount",
      "packages/desktop/src/main/sidecar.ts:listener",
      "packages/desktop/src/main/store.ts:cache",
      "packages/desktop/src/main/tray.ts:tray",
      "packages/desktop/src/main/windows.ts:backgroundColor",
      "packages/desktop/src/main/windows.ts:closeToTrayEnabled",
      "packages/desktop/src/main/windows.ts:isQuitting",
      "packages/desktop/src/main/windows.ts:pinchZoomEnabled",
    ].map((key) => [
      key,
      {
        owner: "Desktop.main-process",
        keyScope: "process",
        bound: "one-instance",
        finalizer: "app-quit-or-window-close",
        durability: "coordination-only",
        reachability: "desktop-main",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // SessionPrompt layer-scope state: Maps keyed by SessionID/directory whose entries are deleted
  // on settle/dedup by construction; the notification/durable worker maps carry an explicit
  // Effect.addFinalizer (prompt.ts ~7283) that interrupts fibers and clears both maps.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/session/prompt.ts:closure@1180:1366.activeFederatedContexts",
      "packages/deepagent-code/src/session/prompt.ts:closure@1180:1370.steerAbsorbRounds",
      "packages/deepagent-code/src/session/prompt.ts:closure@1180:1371.activeReleasedKnowledge",
      "packages/deepagent-code/src/session/prompt.ts:closure@1180:6973.notificationWorkers",
      "packages/deepagent-code/src/session/prompt.ts:closure@1180:7036.durableWorkers",
      "packages/deepagent-code/src/session/prompt.ts:closure@1180:7037.durableLeases",
    ].map((key) => [
      key,
      {
        owner: "SessionPrompt.layer-instance",
        keyScope: "per-session-or-directory",
        bound: "active-sessions-and-directories",
        finalizer: "settle-cleanup-or-layer-finalizer",
        durability: "coordination-only",
        reachability: "instance-scoped",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // Per-invocation dedupe sets and abort handles inside single runner functions: their owner is
  // the function invocation itself; the set dies with the call stack.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/session/prompt.ts:closure@1430:1432.seen",
      "packages/deepagent-code/src/session/prompt.ts:closure@1467:1474.seen",
      "packages/deepagent-code/src/session/prompt.ts:closure@1605:1673.taskAbort",
      "packages/deepagent-code/src/session/prompt.ts:closure@3458:3584.accumulatedChangeSurface",
      "packages/deepagent-code/src/session/prompt.ts:execRead@2492:2493.controller",
    ].map((key) => [
      key,
      {
        owner: "invocation-scope",
        keyScope: "single-call",
        bound: "call-stack",
        finalizer: "return",
        durability: "ephemeral-runtime",
        reachability: "instance-scoped",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // Server listener lifecycle: defaultServer/serverHasListened are process-singleton memoization
  // for the one listener per process (documented in server.ts startListener); scopes are closed by
  // makeStop's LIFO close; socket sets are cleared by destroyConnections on stop.
  "packages/deepagent-code/src/server/server.ts:defaultServer": {
    owner: "Server.process-singleton",
    keyScope: "process",
    bound: "one-listener",
    finalizer: "stop-close",
    durability: "coordination-only",
    reachability: "server-entry",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/server/server.ts:serverHasListened": {
    owner: "Server.process-singleton",
    keyScope: "process",
    bound: "one-flag",
    finalizer: "process-exit",
    durability: "coordination-only",
    reachability: "server-entry",
    verdict: "safe_static",
  },
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/server/server.ts:closure@180:196.scope",
      "packages/deepagent-code/src/server/server.ts:closure@180:217.maintenanceScope",
      "packages/deepagent-code/src/server/server.ts:serverLayer@316:317.server",
      "packages/deepagent-code/src/server/server.ts:serverLayer@316:319.upgradedSockets",
      "packages/deepagent-code/src/server/server.ts:serverLayer@316:320.activeSockets",
    ].map((key) => [
      key,
      {
        owner: "Server.listener-scope",
        keyScope: "per-listener",
        bound: "listener-lifecycle",
        finalizer: "scope-close-or-destroy-connections",
        durability: "coordination-only",
        reachability: "server-entry",
        verdict: "safe_scoped",
      },
    ]),
  ),
  // LSP client per-instance state: LSP is config-fail-closed (RI-19/RI-21); these Maps live on a
  // client instance owned by the instance runtime and cleared by its disposer.
  ...Object.fromEntries(
    [
      "packages/deepagent-code/src/lsp/client.ts:create@125:151.pushDiagnostics",
      "packages/deepagent-code/src/lsp/client.ts:create@125:152.pullDiagnostics",
      "packages/deepagent-code/src/lsp/client.ts:create@125:153.published",
      "packages/deepagent-code/src/lsp/client.ts:create@125:154.diagnosticRegistrations",
      "packages/deepagent-code/src/lsp/client.ts:create@125:155.registrationListeners",
      "packages/deepagent-code/src/lsp/client.ts:create@125:156.diagnosticListeners",
      "packages/deepagent-code/src/lsp/client.ts:requestDiagnosticReport@313:325.byFile",
    ].map((key) => [
      key,
      {
        owner: "LspClient.instance",
        keyScope: "per-instance",
        bound: "instance-lifecycle",
        finalizer: "instance-disposer",
        durability: "coordination-only",
        reachability: "instance-scoped",
        verdict: "safe_scoped",
      },
    ]),
  ),
  "packages/core/src/database/migration.ts:lock": {
    owner: "DatabaseMigration.process-serialization",
    keyScope: "process",
    bound: "one-semaphore",
    finalizer: "process-exit",
    durability: "coordination-only-cross-process-lock-is-authority",
    reachability: "database-bootstrap",
    verdict: "safe_bounded",
  },
  "packages/core/src/agent-gateway.ts:configuredKnowledgeSeed": {
    owner: "AgentGateway.V1-compatibility",
    keyScope: "last-configured-storage-root",
    bound: "one-runtime",
    finalizer: "replace-on-root-change",
    durability: "seed-coordination-only",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/agent-gateway.ts:configuredStorageBaseDir": {
    owner: "AgentGateway.V1-compatibility",
    keyScope: "last-configured-storage-root",
    bound: "one-path",
    finalizer: "replace-on-root-change",
    durability: "configuration-cache-only",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/agent-gateway.ts:current": {
    owner: "AgentGateway.V1-compatibility",
    keyScope: "process",
    bound: "one-config",
    finalizer: "replace-on-configure",
    durability: "configuration-authority",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/agent-gateway.ts:learningAuthority": {
    owner: "AgentGateway.V1-compatibility",
    keyScope: "process",
    bound: "one-authority",
    finalizer: "successor-token-release",
    durability: "legacy-learning-dispatch-authority",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/agent-gateway.ts:learningRecovery": {
    owner: "AgentGateway.V1-compatibility",
    keyScope: "process",
    bound: "one-inflight-recovery",
    finalizer: "settle-clear",
    durability: "legacy-recovery-coordination-only",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/agent-gateway.ts:learningRecoveryRequested": {
    owner: "AgentGateway.V1-compatibility",
    keyScope: "process",
    bound: "one-boolean",
    finalizer: "consume-on-recovery",
    durability: "legacy-recovery-coordination-only",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/agent-gateway.ts:legacyLearningQueue": {
    owner: "AgentGateway.V1-compatibility",
    keyScope: "process",
    bound: "active-legacy-learning-jobs",
    finalizer: "legacy-shutdown-drain",
    durability: "legacy-nondurable-learning-queue",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/agent-gateway.ts:packSnapshotCache": {
    owner: "AgentGateway.Runtime",
    keyScope: "storage-runtime",
    bound: "weak-key",
    finalizer: "gc",
    durability: "cache-only",
    reachability: "v2-location",
    verdict: "safe_bounded",
  },
  "packages/core/src/agent-gateway.ts:runProfileCache": {
    owner: "AgentGateway.Runtime",
    keyScope: "storage-runtime",
    bound: "weak-key",
    finalizer: "gc",
    durability: "cache-only",
    reachability: "v2-location",
    verdict: "safe_bounded",
  },
  "packages/core/src/deepagent/domain-pack-load.ts:activePackRefs": {
    owner: "inactive-domain-pack-prototype",
    keyScope: "legacy-session",
    bound: "unbounded",
    finalizer: "test-reset-only",
    durability: "prototype-active-pack-memory",
    reachability: "production-tool-unreachable",
    verdict: "release_forbidden",
  },
  "packages/core/src/deepagent/domain-pack-registry.ts:defaultRegistryDirs": {
    owner: "DomainPackRegistry.V1-compatibility",
    keyScope: "process-last-configured-root",
    bound: "one-directory-list",
    finalizer: "replace-on-configure",
    durability: "legacy-registry-root",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/deepagent/knowledge-source.ts:defaultRuntime": {
    owner: "KnowledgeSource.V1-compatibility",
    keyScope: "process-last-configured-root",
    bound: "one-runtime",
    finalizer: "replace-on-configure",
    durability: "legacy-knowledge-root",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/deepagent/plan-store.ts:defaultStateDir": {
    owner: "PlanStore.V1-compatibility",
    keyScope: "process-last-configured-root",
    bound: "one-path",
    finalizer: "replace-on-configure",
    durability: "legacy-plan-root",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/deepagent/session-state.ts:defaultRuntime": {
    owner: "SessionState.V1-compatibility",
    keyScope: "process-last-configured-root",
    bound: "unbounded-session-map",
    finalizer: "replace-on-configure",
    durability: "legacy-session-root-cache",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/deepagent/document-store.ts:sharedIndexRegistry": {
    owner: "DocumentStore.live-handles",
    keyScope: "canonical-root",
    bound: "live-handle-count",
    finalizer: "weakref-finalization-registry",
    durability: "disk-index-cache",
    reachability: "v2-plan-and-documents",
    verdict: "safe_scoped",
  },
  "packages/core/src/deepagent/document-store.ts:sharedIndexFinalizers": {
    owner: "DocumentStore.shared-index-registry",
    keyScope: "shared-index-reference",
    bound: "live-shared-index-count",
    finalizer: "gc-callback-and-opportunistic-sweep",
    durability: "registry-cleanup-only",
    reachability: "v2-plan-and-documents",
    verdict: "safe_scoped",
  },
  "packages/core/src/event/define.ts:definitionsByType": {
    owner: "EventV2.schema-registry",
    keyScope: "event-type",
    bound: "max-1024",
    finalizer: "process-code-lifetime",
    durability: "code-defined-schema-only",
    reachability: "v2-event-runtime-readonly-view",
    verdict: "safe_bounded",
  },
  "packages/core/src/event/define.ts:syncDefinitionsByVersion": {
    owner: "EventV2.schema-registry",
    keyScope: "event-type-version",
    bound: "max-1024",
    finalizer: "process-code-lifetime",
    durability: "code-defined-codec-only",
    reachability: "v2-event-runtime-readonly-view",
    verdict: "safe_bounded",
  },
  "packages/core/src/filesystem/search.ts:runPromise": {
    owner: "Search.V1-convenience-runtime",
    keyScope: "process",
    bound: "one-lazy-managed-runtime",
    finalizer: "process-exit-only",
    durability: "legacy-service-runtime",
    reachability: "legacy-debug-and-test-entry",
    verdict: "release_forbidden",
  },
  "packages/core/src/filesystem/watcher.ts:watcher": {
    owner: "FilesystemWatcher.module-loader",
    keyScope: "platform-architecture",
    bound: "one-lazy-module",
    finalizer: "process-exit",
    durability: "native-module-cache-only",
    reachability: "v2-filesystem",
    verdict: "safe_bounded",
  },
  "packages/core/src/global.ts:testOverrides": {
    owner: "Global.test-seam",
    keyScope: "config-or-log",
    bound: "max-2-paths",
    finalizer: "test-successor-overwrite",
    durability: "test-only-path-override",
    reachability: "guarded-by-test-home-env",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/log.ts:closeWrite": {
    owner: "Log.process-runtime",
    keyScope: "process",
    bound: "one-file-stream-finalizer",
    finalizer: "close-before-reinit-and-process-exit",
    durability: "diagnostic-sink-only",
    reachability: "product-logging",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/log.ts:last": {
    owner: "Log.process-runtime",
    keyScope: "process",
    bound: "one-timestamp",
    finalizer: "overwrite-on-log",
    durability: "diagnostic-timing-only",
    reachability: "product-logging",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/log.ts:initialization": {
    owner: "Log.process-runtime",
    keyScope: "process",
    bound: "one-inflight-initialization",
    finalizer: "settle-and-successor-replace",
    durability: "diagnostic-sink-coordination-only",
    reachability: "product-logging",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/log.ts:level": {
    owner: "Log.process-runtime",
    keyScope: "process",
    bound: "one-enum",
    finalizer: "overwrite-on-init",
    durability: "diagnostic-filter-only",
    reachability: "product-logging",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/log.ts:loggers": {
    owner: "Log.process-runtime",
    keyScope: "service-name",
    bound: "lru-max-128",
    finalizer: "lru-eviction",
    durability: "diagnostic-logger-cache-only",
    reachability: "product-logging-and-http-log-ingress",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/log.ts:logpath": {
    owner: "Log.process-runtime",
    keyScope: "process",
    bound: "one-path",
    finalizer: "reset-on-init",
    durability: "diagnostic-path-only",
    reachability: "product-logging",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/log.ts:write": {
    owner: "Log.process-runtime",
    keyScope: "process",
    bound: "one-writer",
    finalizer: "close-and-replace-on-init",
    durability: "diagnostic-sink-only",
    reachability: "product-logging",
    verdict: "safe_bounded",
  },
  "packages/core/src/model-protocol.ts:evidenceCache": {
    owner: "model-protocol-inspection",
    keyScope: "config-evidence-key",
    bound: "max-128",
    finalizer: "lru-eviction",
    durability: "inspection-cache-only",
    reachability: "non-production-runner",
    verdict: "safe_bounded",
  },
  "packages/core/src/model-protocol.ts:configProbeCallCount": {
    owner: "ModelProtocol.test-probe",
    keyScope: "process-test-kernel",
    bound: "one-counter",
    finalizer: "explicit-test-reset",
    durability: "test-diagnostic-only",
    reachability: "non-production-runner",
    verdict: "safe_bounded",
  },
  "packages/core/src/model-protocol.ts:probeHook": {
    owner: "ModelProtocol.test-probe",
    keyScope: "process-test-kernel",
    bound: "one-hook",
    finalizer: "explicit-test-reset",
    durability: "test-probe-only",
    reachability: "non-production-runner",
    verdict: "safe_bounded",
  },
  "packages/core/src/npm.ts:runPromise": {
    owner: "Npm.V1-convenience-runtime",
    keyScope: "process",
    bound: "one-lazy-managed-runtime",
    finalizer: "process-exit-only",
    durability: "legacy-service-runtime",
    reachability: "legacy-provider-plugin-lsp-formatter",
    verdict: "release_forbidden",
  },
  "packages/core/src/pty.ts:encoder": {
    owner: "Pty.codec",
    keyScope: "process",
    bound: "one-stateless-encoder",
    finalizer: "not-required",
    durability: "none",
    reachability: "pty-runtime",
    verdict: "safe_static",
  },
  "packages/core/src/pty.ts:pty": {
    owner: "Pty.module-loader",
    keyScope: "platform-architecture",
    bound: "one-lazy-module",
    finalizer: "process-exit",
    durability: "native-module-cache-only",
    reachability: "pty-runtime",
    verdict: "safe_bounded",
  },
  "packages/core/src/pty/input.ts:inputDecoder": {
    owner: "Pty.codec",
    keyScope: "process",
    bound: "one-nonstreaming-decoder",
    finalizer: "decode-call-reset",
    durability: "none",
    reachability: "pty-runtime",
    verdict: "safe_static",
  },
  "packages/core/src/system-context/project-docs.ts:readCache": {
    owner: "ProjectDocs.source",
    keyScope: "path-content-key",
    bound: "max-64",
    finalizer: "lru-eviction",
    durability: "read-cache-only",
    reachability: "v2-system-context",
    verdict: "safe_bounded",
  },
  "packages/core/src/tool/tool.ts:runtimes": {
    owner: "Tool.Runtime",
    keyScope: "tool-definition-object",
    bound: "weak-key",
    finalizer: "gc",
    durability: "execution-cache-only",
    reachability: "v2-tool-registry",
    verdict: "safe_scoped",
  },
  "packages/core/src/util/flock.ts:Flock.global": {
    owner: "Flock.V1-compatibility",
    keyScope: "process-last-bound-global",
    bound: "one-root",
    finalizer: "manual-rebind-only",
    durability: "legacy-lock-root-authority",
    reachability: "legacy-release-graph",
    verdict: "release_forbidden",
  },
  "packages/core/src/util/identifier.ts:Identifier.lastValue": {
    owner: "Identifier.process-generator",
    keyScope: "process",
    bound: "one-64-bit-counter",
    finalizer: "monotonic-overwrite",
    durability: "id-ordering-only",
    reachability: "v2-and-legacy-event-id-generation",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/deepagent/workspace-context.ts:cache": {
    owner: "WorkspaceContext",
    keyScope: "canonical-workspace-path",
    bound: "ttl-30s-max-128",
    finalizer: "ttl-lru-eviction",
    durability: "cache-only",
    reachability: "deepagent-v2-host",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/deepagent/workspace-context.ts:pending": {
    owner: "WorkspaceContext",
    keyScope: "canonical-workspace-path",
    bound: "inflight-max-128",
    finalizer: "settle-delete-and-fence",
    durability: "single-flight-only",
    reachability: "deepagent-v2-host",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/plugin/shared.ts:pluginTargetFailures": {
    owner: "PluginTargetResolver",
    keyScope: "plugin-target",
    bound: "max-128",
    finalizer: "lru-eviction",
    durability: "cache-only",
    reachability: "deepagent-plugin-host",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/plugin/shared.ts:pluginTargetResolutions": {
    owner: "PluginTargetResolver",
    keyScope: "plugin-target",
    bound: "max-128",
    finalizer: "lru-eviction",
    durability: "cache-only",
    reachability: "deepagent-plugin-host",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/provider/discovery-cache.ts:authFailures": {
    owner: "ProviderDiscovery",
    keyScope: "provider-auth-identity",
    bound: "max-128-with-expiry",
    finalizer: "expiry-and-lru-eviction",
    durability: "negative-cache-only",
    reachability: "deepagent-provider-host",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/settings/store.ts:SettingsStore.cache": {
    owner: "SettingsStore",
    keyScope: "single-settings-path",
    bound: "one-entry",
    finalizer: "overwrite-on-reload",
    durability: "disk-is-authority",
    reachability: "deepagent-product-root",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/tool/edit.ts:locks": {
    owner: "EditTool",
    keyScope: "canonical-file-path",
    bound: "active-edit-count",
    finalizer: "refcount-delete",
    durability: "mutex-only",
    reachability: "legacy-tool-host",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/tool/json-schema.ts:cache": {
    owner: "ToolJsonSchema",
    keyScope: "schema-object",
    bound: "weak-key",
    finalizer: "gc",
    durability: "compiled-schema-cache",
    reachability: "deepagent-tool-host",
    verdict: "safe_bounded",
  },
  "packages/function/src/api.ts:app": {
    owner: "ShareBackend.process-root",
    keyScope: "process-route-tree",
    bound: "fixed-route-count",
    finalizer: "http-server-process-lifecycle",
    durability: "routing-only",
    reachability: "share-backend-entry",
    verdict: "safe_scoped",
  },
  "packages/function/src/api.ts:store": {
    owner: "ShareBackend.process-root",
    keyScope: "configured-share-directory",
    bound: "one-store-active-request-locks-only",
    finalizer: "lock-settlement-and-process-exit",
    durability: "filesystem-share-authority",
    reachability: "share-backend-entry",
    verdict: "safe_scoped",
  },
  "packages/function/src/api.ts:subscribers": {
    owner: "ShareBackend.process-root",
    keyScope: "share-id-socket",
    bound: "max-1000-global-max-32-per-share",
    finalizer: "socket-close-error-and-process-exit",
    durability: "ephemeral-fanout-only",
    reachability: "share-backend-entry",
    verdict: "safe_bounded",
  },
  "packages/function/src/server.ts:server": {
    owner: "ShareBackend.process-root",
    keyScope: "listen-address",
    bound: "one-http-server",
    finalizer: "process-lifecycle",
    durability: "transport-only",
    reachability: "share-backend-entry",
    verdict: "safe_scoped",
  },
  "packages/function/src/server.ts:wss": {
    owner: "ShareBackend.process-root",
    keyScope: "http-upgrade-server",
    bound: "one-websocket-server-max-1000-clients",
    finalizer: "socket-close-and-process-lifecycle",
    durability: "transport-only",
    reachability: "share-backend-entry",
    verdict: "safe_scoped",
  },
  "packages/llm/src/protocols/bedrock-event-stream.ts:eventCodec": {
    owner: "BedrockEventStream.codec",
    keyScope: "process",
    bound: "one-stateless-codec",
    finalizer: "not-required",
    durability: "none",
    reachability: "llm-bedrock-lowering",
    verdict: "safe_static",
  },
  "packages/llm/src/protocols/bedrock-event-stream.ts:utf8": {
    owner: "BedrockEventStream.codec",
    keyScope: "process",
    bound: "one-nonstreaming-decoder",
    finalizer: "decode-call-reset",
    durability: "none",
    reachability: "llm-bedrock-lowering",
    verdict: "safe_static",
  },
  "packages/llm/src/route/executor.ts:REDACT_JSON_FIELD": {
    owner: "LLMRequestExecutor.redaction",
    keyScope: "process",
    bound: "one-regular-expression",
    finalizer: "replace-call-resets-last-index",
    durability: "none",
    reachability: "llm-http-diagnostics",
    verdict: "safe_static",
  },
  "packages/llm/src/route/executor.ts:REDACT_QUERY_FIELD": {
    owner: "LLMRequestExecutor.redaction",
    keyScope: "process",
    bound: "one-regular-expression",
    finalizer: "replace-call-resets-last-index",
    durability: "none",
    reachability: "llm-http-diagnostics",
    verdict: "safe_static",
  },
  "packages/llm/src/route/executor.ts:SENSITIVE_BODY_FIELD": {
    owner: "LLMRequestExecutor.redaction",
    keyScope: "process",
    bound: "one-regular-expression",
    finalizer: "not-required",
    durability: "none",
    reachability: "llm-http-diagnostics",
    verdict: "safe_static",
  },
  "packages/llm/src/route/executor.ts:SENSITIVE_NAME": {
    owner: "LLMRequestExecutor.redaction",
    keyScope: "process",
    bound: "one-regular-expression",
    finalizer: "not-required",
    durability: "none",
    reachability: "llm-http-diagnostics",
    verdict: "safe_static",
  },
  "packages/server/src/handlers/model.ts:catalogUnavailable": {
    owner: "ServerModelHandler.static-error",
    keyScope: "process",
    bound: "one-immutable-error",
    finalizer: "not-required",
    durability: "none",
    reachability: "core-http-model-handler",
    verdict: "safe_static",
  },
  "packages/server/src/handlers/provider.ts:catalogUnavailable": {
    owner: "ServerProviderHandler.static-error",
    keyScope: "process",
    bound: "one-immutable-error",
    finalizer: "not-required",
    durability: "none",
    reachability: "core-http-provider-handler",
    verdict: "safe_static",
  },
  "packages/slack/src/index.ts:app": {
    owner: "SlackIngress.process-root",
    keyScope: "slack-socket-mode-app",
    bound: "one-app",
    finalizer: "sigint-sigterm-stop",
    durability: "external-ingress-client",
    reachability: "slack-product-entry",
    verdict: "safe_scoped",
  },
  "packages/slack/src/index.ts:deepagentCode": {
    owner: "SlackIngress.process-root",
    keyScope: "child-server",
    bound: "one-child-process",
    finalizer: "abort-and-close-on-signal-or-start-failure",
    durability: "v2-server-client-owner",
    reachability: "slack-product-entry",
    verdict: "safe_scoped",
  },
  "packages/slack/src/index.ts:shutdown": {
    owner: "SlackIngress.process-root",
    keyScope: "process",
    bound: "one-shutdown-promise",
    finalizer: "settle-on-stop",
    durability: "lifecycle-coordination-only",
    reachability: "slack-product-entry",
    verdict: "safe_bounded",
  },
  "packages/slack/src/index.ts:shutdownController": {
    owner: "SlackIngress.process-root",
    keyScope: "child-server",
    bound: "one-abort-controller",
    finalizer: "abort-on-signal-or-start-failure",
    durability: "lifecycle-coordination-only",
    reachability: "slack-product-entry",
    verdict: "safe_scoped",
  },
  "packages/slack/src/index.ts:pendingThreads": {
    owner: "SlackIngress",
    keyScope: "thread-key",
    bound: "max-128-global-max-16-per-thread",
    finalizer: "settlement-and-lru-eviction",
    durability: "ingress-coalescing-only",
    reachability: "slack-product-entry",
    verdict: "safe_bounded",
  },
  "packages/core/src/aisdk.ts:closure@127:129.languages": {
    owner: "AISDK.Service",
    keyScope: "configured-model",
    bound: "configured-model-count",
    finalizer: "layer-scope-close",
    durability: "resolution-cache-only",
    reachability: "provider-resolution",
    verdict: "safe_bounded",
  },
  "packages/core/src/aisdk.ts:closure@127:130.sdks": {
    owner: "AISDK.Service",
    keyScope: "configured-sdk",
    bound: "configured-sdk-count",
    finalizer: "layer-scope-close",
    durability: "resolution-cache-only",
    reachability: "provider-resolution",
    verdict: "safe_bounded",
  },
  "packages/core/src/auth.ts:closure@133:182.state": {
    owner: "Auth.Service",
    keyScope: "process",
    bound: "account-file-entry-count",
    finalizer: "remove-persists-then-clears",
    durability: "mirror-of-account-json",
    reachability: "auth-storage",
    verdict: "safe_scoped",
  },
  "packages/core/src/context-federation/query-authorization.ts:closure@29:30.envelopes": {
    owner: "ContextQueryAuthorization.Service",
    keyScope: "session",
    bound: "active-session-count",
    finalizer: "per-turn-ensuring-remove",
    durability: "turn-scoped-authorization-only",
    reachability: "v2-context-query",
    verdict: "safe_scoped",
  },
  "packages/core/src/deepagent/document-store.ts:DocumentStore.docs@393": {
    owner: "DocumentStore.instance",
    keyScope: "canonical-root",
    bound: "disk-corpus-size",
    finalizer: "instance-scope-close-weak-registry-gc",
    durability: "append-only-disk-index-mirror",
    reachability: "v2-plan-and-documents",
    verdict: "safe_scoped",
  },
  "packages/core/src/im/broadcaster.ts:IMBroadcasterImpl.connections@10": {
    owner: "IMBroadcaster.instance",
    keyScope: "process",
    bound: "max-1024-global-max-128-per-group-max-32-per-user",
    finalizer: "ensuring-unregister-slow-consumer-1013-close",
    durability: "connection-registry-only",
    reachability: "im-websocket",
    verdict: "safe_bounded",
  },
  "packages/core/src/util/effect-flock.ts:closure@99:104.ensuredDirs": {
    owner: "EffectFlock.process",
    keyScope: "lock-root-constant",
    bound: "source-constant-keyspace",
    finalizer: "process-exit",
    durability: "mkdir-memo-only",
    reachability: "storage-locking",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/im/agent-progress-stream.ts:closure@67:72.parts": {
    owner: "AgentProgressStream.turn",
    keyScope: "im-agent-turn",
    bound: "turn-part-count",
    finalizer: "ensuring-interrupt-final-flush",
    durability: "best-effort-progress-only",
    reachability: "im-agent-progress",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/im/agent-progress-stream.ts:closure@67:73.dirty": {
    owner: "AgentProgressStream.turn",
    keyScope: "im-agent-turn",
    bound: "one-boolean",
    finalizer: "ensuring-interrupt-final-flush",
    durability: "best-effort-progress-only",
    reachability: "im-agent-progress",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/mcp/index.ts:pendingOAuthTransports": {
    owner: "MCP.InstanceState",
    keyScope: "mcp-config-key",
    bound: "configured-mcp-server-count",
    finalizer: "finish-auth-remove-auth-instance-finalizer-clear",
    durability: "oauth-transport-handoff-only",
    reachability: "mcp-oauth",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/mcp/oauth-callback.ts:currentPath": {
    owner: "OAuthCallbackServer.process",
    keyScope: "process",
    bound: "one-path",
    finalizer: "stop-on-complete-or-cancel",
    durability: "callback-server-state-only",
    reachability: "mcp-oauth",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/mcp/oauth-callback.ts:currentPort": {
    owner: "OAuthCallbackServer.process",
    keyScope: "process",
    bound: "one-port",
    finalizer: "stop-on-complete-or-cancel",
    durability: "callback-server-state-only",
    reachability: "mcp-oauth",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/mcp/oauth-callback.ts:ensureRunningSerial@151:161.next": {
    owner: "OAuthCallbackServer.ensureRunningSerial",
    keyScope: "call-local",
    bound: "one-promise-per-call",
    finalizer: "function-return",
    durability: "serialization-chain-link-only",
    reachability: "mcp-oauth",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/mcp/oauth-callback.ts:mcpNameToState": {
    owner: "OAuthCallbackServer.process",
    keyScope: "mcp-name",
    bound: "pending-auths-count",
    finalizer: "delete-with-pending-auth",
    durability: "callback-routing-only",
    reachability: "mcp-oauth",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/mcp/oauth-callback.ts:operation": {
    owner: "OAuthCallbackServer.process",
    keyScope: "process",
    bound: "one-inflight-operation",
    finalizer: "settle-clear",
    durability: "lifecycle-coordination-only",
    reachability: "mcp-oauth",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/mcp/oauth-callback.ts:pendingAuths": {
    owner: "OAuthCallbackServer.process",
    keyScope: "oauth-state",
    bound: "max-64-and-5min-ttl",
    finalizer: "cancel-stop-delete-ttl-expiry",
    durability: "oauth-callback-coordination-only",
    reachability: "mcp-oauth",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/mcp/oauth-callback.ts:server": {
    owner: "OAuthCallbackServer.process",
    keyScope: "process",
    bound: "one-server",
    finalizer: "stop-on-complete-or-cancel",
    durability: "callback-server-handle-only",
    reachability: "mcp-oauth",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/mcp/secret-store.ts:inMemoryBackend@105:106.map": {
    owner: "SecretStore.test-layer",
    keyScope: "secret-key",
    bound: "test-secret-count",
    finalizer: "process-exit",
    durability: "test-only-backend",
    reachability: "test-harness",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/session/llm.ts:closure@1079:1089.validatedCallIDs": {
    owner: "LLM.stream-call",
    keyScope: "provider-turn",
    bound: "turn-tool-call-count",
    finalizer: "call-return-gc",
    durability: "turn-validation-only",
    reachability: "v2-llm-stream",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/session/llm.ts:closure@1079:1128.aiSdkCallIDs": {
    owner: "LLM.stream-call",
    keyScope: "provider-turn",
    bound: "turn-tool-call-count",
    finalizer: "call-return-gc",
    durability: "turn-validation-only",
    reachability: "v2-llm-stream",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/session/llm.ts:closure@1079:1129.validatedCallIDs": {
    owner: "LLM.stream-call",
    keyScope: "provider-turn",
    bound: "turn-tool-call-count",
    finalizer: "call-return-gc",
    durability: "turn-validation-only",
    reachability: "v2-llm-stream",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/session/llm.ts:physicalPromptCacheKey@142:143.keys": {
    owner: "LLM.physicalPromptCacheKey",
    keyScope: "call-local",
    bound: "request-cache-key-count",
    finalizer: "function-return",
    durability: "request-validation-only",
    reachability: "v2-llm-stream",
    verdict: "safe_scoped",
  },
}

const fileOfKey = (key: string) => key.split(":")[0]!

function audit(key: string, classification: RuntimeStateClassification): RuntimeStateAudit {
  const review = reviewed[key]
  if (review) return review
  if (classification === "static_container") {
    return {
      owner: "source-module",
      keyScope: "source-symbol",
      bound: "source-bounded",
      finalizer: "not-applicable",
      durability: "non-authority",
      reachability: "package-static",
      verdict: "safe_static",
    }
  }
  if (classification === "legacy_release_forbidden") {
    return {
      owner: "legacy-process",
      keyScope: "unresolved",
      bound: "unresolved",
      finalizer: "unresolved",
      durability: "legacy-runtime",
      reachability: "release-reachable",
      verdict: "release_forbidden",
    }
  }
  // RI-94 W2 (2026-09-10): the same construction argument covers (a) class-instance state on TUI/CLI
  // render widgets — the instance is owned by its render owner and dies with it — and (b) closure
  // state captured inside Effect Layer factory bodies in the effect/* trees: those bindings live in
  // the layer's build closure, whose lifetime is the layer scope with its registered finalizers.
  // Both are owner-lifecycle bounded and never durable authority.
  if (
    key.includes("@") &&
    (/^packages\/(?:tui|cli)\//.test(fileOfKey(key)) ||
      /^packages\/(?:core|deepagent-code)\/src\/effect\//.test(fileOfKey(key)))
  ) {
    return {
      owner: "render-or-layer-owner",
      keyScope: "owner-lifecycle",
      bound: "owner-lifecycle",
      finalizer: "owner-exit-gc",
      durability: "ephemeral-runtime",
      reachability: "process-local",
      verdict: "safe_scoped",
    }
  }
  // RI-94 W1 (2026-09-10): function/closure-scoped and class-instance UI state is adjudicated by
  // construction — the `@`-marked key namespace means the binding lives inside a function body or
  // on a class instance, so its lifecycle is bounded by that owner (component mount, render pass,
  // handler invocation, instance). It is ephemeral product-UI state, never durable authority.
  // Module-level mutable UI state (no `@`) stays review_required — those are process-lifetime
  // bindings that need per-item owner/bound/finalizer review.
  if (classification === "ui_process_state" && key.includes("@")) {
    return {
      owner: "ui-owner-invocation",
      keyScope: "owner-lifecycle",
      bound: "owner-lifecycle",
      finalizer: "owner-exit-gc",
      durability: "ephemeral-ui",
      reachability: "product-ui",
      verdict: "safe_scoped",
    }
  }
  return {
    owner: classification === "ui_process_state" ? "ui-process" : "unresolved",
    keyScope: "unresolved",
    bound: "unresolved",
    finalizer: "unresolved",
    durability: classification === "ui_process_state" ? "ephemeral-ui" : "unresolved",
    reachability: classification === "ui_process_state" ? "product-ui" : "unresolved",
    verdict: "review_required",
  }
}

function moduleVariables(
  statements: NodeArray<Statement>,
  namespace: readonly string[] = [],
): readonly {
  readonly declaration: VariableDeclaration
  readonly namespace: readonly string[]
}[] {
  return statements.flatMap((statement) => {
    if (isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((declaration) => ({ declaration, namespace }))
    }
    if (!isModuleDeclaration(statement)) return []
    const name = isIdentifier(statement.name) ? statement.name.text : statement.name.text
    if (statement.body && isModuleBlock(statement.body)) {
      return moduleVariables(statement.body.statements, [...namespace, name])
    }
    if (statement.body && isModuleDeclaration(statement.body)) {
      return moduleVariablesInNamespace(statement.body, [...namespace, name])
    }
    return []
  })
}

function moduleVariablesInNamespace(
  declaration: ModuleDeclaration,
  namespace: readonly string[],
): ReturnType<typeof moduleVariables> {
  const name = isIdentifier(declaration.name) ? declaration.name.text : declaration.name.text
  if (declaration.body && isModuleBlock(declaration.body)) {
    return moduleVariables(declaration.body.statements, [...namespace, name])
  }
  if (declaration.body && isModuleDeclaration(declaration.body)) {
    return moduleVariablesInNamespace(declaration.body, [...namespace, name])
  }
  return []
}

function bindingNames(name: BindingName): readonly string[] {
  if (isIdentifier(name)) return [name.text]
  if (isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => (isOmittedExpression(element) ? [] : bindingNames(element.name)))
  }
  if (isObjectBindingPattern(name)) return name.elements.flatMap((element) => bindingNames(element.name))
  return []
}

function classifyInitializer(initializer: string | undefined): "immutable" | "container" | "stateful" {
  if (!initializer) return "immutable"
  const source = initializer.trim()
  if (/^(?:new\s+(?:Map|Set|WeakMap|WeakSet|AsyncLocalStorage)\b|\[|\{)/.test(source)) return "container"

  // An arbitrary class instance can own mutable state even when mutation happens behind methods
  // whose names are not `set`/`add` (ShareStore.publish is the concrete defect that exposed the
  // old allowlist). Chained constructors such as `new Hono().get(...)` are included as well.
  if (/^new\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^;]+?>)?\s*\(/.test(source)) return "stateful"

  // A small set of conventional process-resource/cache factories whose returned objects own
  // hidden state. General calls such as Schema.Struct/Layer.succeed remain outside this queue.
  if (
    /^(?:await\s+)?(?:(?:[A-Za-z_$][\w$]*\.)+(?:make[A-Za-z0-9_$]*Unsafe|unsafeMake)|(?:Bun\.)?(?:serve|createServer|createApp|createDeepAgentCode|lazy|memoize|makeRuntime|ManagedRuntime\.make|(?:create|make)[A-Za-z0-9_$]*(?:Runtime|Store|Cache|Registry|Server|Client|Pool|Queue|Tracker)))(?:<[^;]+?>)?\s*\(/.test(
      source,
    )
  )
    return "stateful"
  return "immutable"
}

function classify(file: string, name: string, mutated: boolean, ownsHiddenState: boolean): RuntimeStateClassification {
  if (!mutated && !ownsHiddenState) return "static_container"
  if (
    file.includes("/src/v1/") ||
    file.endsWith("/session/remote-compact.ts") ||
    file.endsWith("/tool/task-concurrency.ts") ||
    file.endsWith("/session/llm/request.ts") ||
    file.endsWith("/control-plane/adapters/index.ts")
  ) {
    return "legacy_release_forbidden"
  }
  if (/^packages\/(?:app|ui|desktop|tui)\//.test(file)) return "ui_process_state"
  if (/(?:cache|pending|lock|reservation|failure|resolution)/i.test(name)) return "bounded_cache_review"
  return "runtime_state_review"
}

export function encodeRuntimeStateInventory(candidates: readonly RuntimeStateCandidate[]): string {
  return [
    "key\tline\tdeclaration\tmutated\tclassification\towner\tkey_scope\tbound\tfinalizer\tdurability\treachability\tverdict",
    ...candidates.map((candidate) =>
      [
        candidate.key,
        candidate.line,
        candidate.declaration,
        candidate.mutated ? "yes" : "no",
        candidate.classification,
        candidate.owner,
        candidate.keyScope,
        candidate.bound,
        candidate.finalizer,
        candidate.durability,
        candidate.reachability,
        candidate.verdict,
      ].join("\t"),
    ),
    "",
  ].join("\n")
}

if (import.meta.main) {
  const repository = path.resolve(import.meta.dir, "../../..")
  const candidates = await runtimeStateInventory(repository)
  const report = encodeRuntimeStateInventory(candidates)
  if (process.argv.includes("--write")) {
    await Bun.write(path.join(repository, "docs/core-v2.0-beta/runtime-state-inventory.tsv"), report)
  } else {
    process.stdout.write(report)
  }
}
