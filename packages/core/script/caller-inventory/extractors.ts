/**
 * Structural extractors for the 11 production entry surfaces (wave-manifest §2 Lane A).
 *
 * Every surface is read from real code structure only:
 *   - HTTP operations from the Effect HttpApi route-table objects (HttpApiEndpoint calls);
 *   - CLI commands from yargs .command(...) registrations and the Effect CLI Spec.make tree;
 *   - service/daemon/consumer entries from named declarations or module self-exports.
 * Comments, string templates, fixtures and documentation can never produce entries
 * because every anchor below is an AST node (call, declaration or export statement).
 */
import ts from "typescript"
import { join } from "node:path"
import {
  declarationLine,
  identifierLine,
  listSourceFiles,
  memberCalls,
  moduleAnchorLine,
  parseModule,
} from "./ast"
import { rootRepoPath } from "./ast"
import type { Entry, EntryWithHandlers, SurfaceId } from "./types"

const ROOT = () => rootRepoPath()

function repoFile(abs: string): string {
  return abs.slice(ROOT().length + 1).replaceAll("\\", "/")
}

function unquote(text: string): string | undefined {
  if (text.length < 2) return undefined
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  if (text.startsWith("`") && text.endsWith("`")) return undefined // computed — never an operation name
  return undefined
}

/** Head identifier of a property-access chain, e.g. `HttpApiEndpoint.get` -> "HttpApiEndpoint". */
function chainHead(expression: ts.Expression): string | undefined {
  let cursor: ts.Expression = expression
  while (ts.isPropertyAccessExpression(cursor)) cursor = cursor.expression
  return ts.isIdentifier(cursor) ? cursor.text : undefined
}

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head"] as const

/** One HTTP/OpenAPI route-table tree: structured groups plus their bound handler modules. */
type HttpExtractionTree = {
  readonly groupsDir: string
  readonly handlersDir: string
  readonly tag: "server" | "instance"
}

type RegisteredHandler = {
  readonly group: string
  readonly op: string
  readonly repoFile: string
  readonly line: number
  /** Local binding named by `.handle(op, fnName)` — resolved to a body root at classification time. */
  readonly bodyDecl?: string
}

/**
 * Walk statements tracking the innermost effective HTTP group context and invoke the
 * matching callbacks for every HttpApiEndpoint.<method> / .handle("<op>", ...) site.
 *
 * Context flows along two real code structures only:
 *   - DOWNWARD through declarations/arguments (a `HttpApiBuilder.group(_, "g", (h) => ...)`
 *     callback body inherits "g");
 *   - LEFT-RIGHT along call-chain receivers (`HttpApiGroup.make("g").add(...)`: every call
 *     whose receiver chain produced a make/group node inherits that group).
 *
 * Both are AST facts, so identical operation names inside different groups never cross-link.
 */
function visitWithHttpContext(
  mod: ReturnType<typeof parseModule>,
  visitEndpoint: (node: ts.CallExpression, method: string, op: string, group: string) => void,
  visitHandle: (node: ts.CallExpression, op: string, group: string) => void,
): void {
  const sf = mod.sourceFile

  /** Group literal created by this exact call when it is a group-maker, else undefined. */
  const makerLiteral = (call: ts.CallExpression): string | undefined => {
    if (!ts.isPropertyAccessExpression(call.expression)) return undefined
    const callee = call.expression
    if (callee.name.text === "make" && chainHead(callee.expression) === "HttpApiGroup")
      return unquote(call.arguments[0]?.getText(sf))
    if (callee.name.text === "group" && chainHead(callee.expression) === "HttpApiBuilder")
      return unquote(call.arguments[1]?.getText(sf))
    return undefined
  }

  /** Latest group literal produced anywhere along a call-chain receiver spine. */
  const makerAlongReceiver = (expr: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(expr)) return makerAlongReceiver(expr.expression)
    if (ts.isCallExpression(expr)) {
      const own = makerLiteral(expr)
      return own ?? makerAlongReceiver(expr.expression)
    }
    return undefined
  }

  const walk = (node: ts.Node, ambient: string | undefined): void => {
    let context = ambient
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression
      const method = callee.name.text
      const selfMade = makerLiteral(node)
      const receiverMade = makerAlongReceiver(callee.expression)
      context = selfMade ?? receiverMade ?? ambient
      if ((HTTP_METHODS as readonly string[]).includes(method) && chainHead(callee.expression) === "HttpApiEndpoint") {
        const op = unquote(node.arguments[0]?.getText(sf))
        if (op !== undefined && context !== undefined) visitEndpoint(node, method, op, context)
      }
      if (method === "handle" || method === "handleRaw") {
        const op = unquote(node.arguments[0]?.getText(sf))
        if (op !== undefined && context !== undefined) visitHandle(node, op, context)
      }
    }
    ts.forEachChild(node, (child) => walk(child, context))
  }
  for (const statement of sf.statements) walk(statement, undefined)
}

/**
 * Every HttpApiEndpoint.<method>("<op>", ...) call inside the structured route-table
 * group modules is one HTTP/OpenAPI operation entry (`http.<tag>.<group>.<op>`).
 * Handler implementations register via `<builders>.handle("<op>", fn)` inside the matching
 * `HttpApiBuilder.group(_, "<name>")` context and attach as structural handler sites.
 */
function httpSurface(trees: readonly HttpExtractionTree[]): EntryWithHandlers[] {
  const entries: EntryWithHandlers[] = []
  for (const tree of trees) {
    const handlerIndex = new Map<string, RegisteredHandler[]>()
    for (const file of listSourceFiles(join(ROOT(), tree.handlersDir), true)) {
      const mod = parseModule(file)
      visitWithHttpContext(
        mod,
        () => {},
        (node, op, group) => {
          const target = node.arguments[1]
          const bodyDecl = target !== undefined && ts.isIdentifier(target) ? target.text : undefined
          const site: RegisteredHandler = {
            group,
            op,
            repoFile: repoFile(file),
            // A chained `handlers.handle(op, fn).handle(op2, fn2)` expression makes node.getStart()
            // return the START of the whole receiver chain, so every .handle() in the chain would
            // share one line and bodyScopes would resolve all ops to the first handler. Anchor the
            // site to this specific .handle call's own property access instead (each call gets its
            // own line), which is what lets bodyChain verify each op's true handler body.
            line: mod.sourceFile.getLineAndCharacterOfPosition(
              (node.expression as ts.PropertyAccessExpression).name.getStart(),
            ).line + 1,
            ...(bodyDecl ? { bodyDecl } : {}),
          }
          const key = `${tree.tag}\u0000${group}\u0000${op}`
          const list = handlerIndex.get(key) ?? []
          list.push(site)
          handlerIndex.set(key, list)
        },
      )
    }
    for (const file of listSourceFiles(join(ROOT(), tree.groupsDir), true)) {
      const mod = parseModule(file)
      visitWithHttpContext(
        mod,
        (_node, _method, op, group) => {
          const key = `${tree.tag}\u0000${group}\u0000${op}`
          entries.push({
            entry: {
              id: `http.${tree.tag}.${group}.${op}`,
              surface: "http",
              kind: "http-operation",
              name: op,
              repoFile: repoFile(file),
              line: mod.sourceFile.getLineAndCharacterOfPosition(_node.getStart()).line + 1,
            },
            handlers: (handlerIndex.get(key) ?? []).map((site) => ({
              name: `handle:${op}`,
              repoFile: site.repoFile,
              line: site.line,
              ...(site.bodyDecl ? { bodyDecl: site.bodyDecl } : {}),
              group: site.group,
            })),
          })
        },
        () => {},
      )
    }
  }
  return entries.sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
}

/** yargs `.command(XCommand)` registrations in the dacode composition root. */
function dacodeCliSurface(): EntryWithHandlers[] {
  const indexTs = join(ROOT(), "packages/deepagent-code/src/index.ts")
  const mod = parseModule(indexTs)
  const commands = memberCalls(mod, ["command"]).flatMap((site) => {
    const argument = site.args[0]
    const match = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(argument ?? "")
    if (!match) return []
    const identifier = match[1]
    const line = mod.sourceFile.getLineAndCharacterOfPosition(site.node.getStart()).line + 1
    return [
      {
        entry: {
          id: `cli.dacode.${kebab(identifier.replace(/Command$/, ""))}`,
          surface: "cli-deepagent-code" as SurfaceId,
          kind: "yargs-command",
          name: identifier,
          repoFile: repoFile(indexTs),
          line,
        },
        handlers: [],
      },
    ]
  })
  return commands.sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
}

function kebab(value: string): string {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
}

/** Leaf commands of the Effect CLI Spec.make tree (nested containers are not runpoints). */
function lildaxCliSurface(): EntryWithHandlers[] {
  const commandsTs = join(ROOT(), "packages/cli/src/commands/commands.ts")
  const mod = parseModule(commandsTs)
  const isSpecMake = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "make" &&
    chainHead(node.expression.expression) === "Spec"

  const emit = (call: ts.CallExpression, prefix: readonly string[], out: EntryWithHandlers[]): void => {
    const name = unquote(call.arguments[0]?.getText(mod.sourceFile))
    if (!name) return
    const container = call.arguments[1]
    const nested: ts.CallExpression[] = []
    if (container) {
      const visit = (node: ts.Node): void => {
        if (isSpecMake(node)) nested.push(node)
        ts.forEachChild(node, visit)
      }
      visit(container)
    }
    const path = [...prefix, name]
    const sf = mod.sourceFile
    if (nested.length === 0) {
      out.push({
        entry: {
          id: `cli.lildax.${path.join(".")}`,
          surface: "cli-lildax",
          kind: "effect-cli-command",
          name: path.join(" "),
          repoFile: repoFile(commandsTs),
          line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1,
        },
        handlers: [],
      })
      return
    }
    for (const child of nested) emit(child, path, out)
  }

  const out: EntryWithHandlers[] = []
  for (const statement of mod.sourceFile.statements) {
    const visit = (node: ts.Node): void => {
      if (isSpecMake(node)) emit(node, [], out)
      ts.forEachChild(node, visit)
    }
    visit(statement)
  }

  // Runtime dispatch map in cli/src/index.ts links each command path to its lazy handler import.
  const indexMod = parseModule(join(ROOT(), "packages/cli/src/index.ts"))
  const dynamicImports: { name: string; repoFile: string; line: number }[] = []
  const stack: { key?: string; line: number }[] = []
  const walkBindings = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined
      stack.push({ key, line: indexMod.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
      ts.forEachChild(node, walkBindings)
      stack.pop()
      return
    }
    if (ts.isImportDeclaration(node) || (ts.isAwaitExpression(node) && node.expression.getText().includes("import("))) {
      const line = indexMod.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      const key = [...stack].reverse().find((frame) => frame.key)?.key
      if (key) dynamicImports.push({ name: `lazy-handler:${key}`, repoFile: "packages/cli/src/index.ts", line })
    }
    ts.forEachChild(node, walkBindings)
  }
  for (const statement of indexMod.sourceFile.statements) walkBindings(statement)

  return out.map((item) => ({ ...item, handlers: dynamicImports })).sort((a, b) =>
    a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0,
  )
}

const ACP_PROTOCOL_METHODS = [
  "initialize",
  "authenticate",
  "newSession",
  "loadSession",
  "listSessions",
  "resumeSession",
  "closeSession",
  "cancel",
  "forkSession",
  "setSessionConfigOption",
  "setSessionMode",
  "setSessionModel",
  "prompt",
] as const

/** ACP protocol request handlers declared as Effect.fn("ACP.<name>", ...) call factories. */
function acpSurface(): EntryWithHandlers[] {
  const serviceTs = join(ROOT(), "packages/deepagent-code/src/acp/service.ts")
  const mod = parseModule(serviceTs)
  const binding = parseModule(join(ROOT(), "packages/deepagent-code/src/cli/cmd/acp.ts"))
  const connectionSite = identifierLine(binding, "AgentSideConnection")
  const handlers =
    connectionSite === undefined
      ? []
      : [{ name: "AgentSideConnection", repoFile: repoFile(binding.file), line: connectionSite }]
  const entries: EntryWithHandlers[] = []
  for (const site of memberCalls(mod, ["fn"])) {
    const label = unquote(site.args[0] ?? "")
    if (!label?.startsWith("ACP.")) continue
    const tail = label.slice("ACP.".length).split(".").at(-1)!
    if (!(ACP_PROTOCOL_METHODS as readonly string[]).includes(tail)) continue
    const line = mod.sourceFile.getLineAndCharacterOfPosition(site.node.getStart()).line + 1
    entries.push({
      entry: {
        id: `acp.${tail}`,
        surface: "acp",
        kind: "acp-request-handler",
        name: tail,
        repoFile: repoFile(serviceTs),
        line,
      },
      handlers,
    })
  }
  return entries.sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
}

type FixedEntry = {
  readonly id: string
  readonly surface: SurfaceId
  readonly kind: string
  readonly name: string
  readonly fileFromRoot: string
  /** AST anchor: preferred top-level declaration name, else property chain, else identifier ref. */
  readonly declare?: string
  readonly chain?: string
  readonly identifier?: string
}

const FIXED_ENTRIES: readonly FixedEntry[] = [
  // Composition roots (surface 1): process composition/lifecycle assembly points.
  { id: "composition.dacode-cli-entry", surface: "composition", kind: "process-entry", name: "dacode cli main", fileFromRoot: "packages/deepagent-code/src/index.ts", identifier: "hideBin" },
  { id: "composition.lildax-runtime", surface: "composition", kind: "process-entry", name: "lildax runtime main", fileFromRoot: "packages/cli/src/index.ts", declare: "Handlers" },
  { id: "composition.app-runtime-layers", surface: "composition", kind: "layer-composition", name: "app runtime layer graph", fileFromRoot: "packages/deepagent-code/src/effect/app-runtime.ts", chain: "SessionPrompt.defaultLayer" },
  { id: "composition.server-web-handler", surface: "composition", kind: "layer-composition", name: "server web handler", fileFromRoot: "packages/server/src/routes.ts", declare: "createRoutes" },
  { id: "composition.instance-httpapi-stack", surface: "composition", kind: "layer-composition", name: "instance http api stack", fileFromRoot: "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts", identifier: "rootApiRoutes" },
  { id: "composition.desktop-sidecar-start", surface: "composition", kind: "sidecar-lifecycle", name: "desktop sidecar start", fileFromRoot: "packages/desktop/src/main/sidecar.ts", declare: "start" },

  // Desktop (surface 3): electron main & sidecar spawn face.
  { id: "desktop.app-main", surface: "desktop", kind: "electron-main", name: "electron app main", fileFromRoot: "packages/desktop/src/main/index.ts", chain: "app.setName" },
  { id: "desktop.spawn-local-server", surface: "desktop", kind: "sidecar-spawn", name: "spawnLocalServer", fileFromRoot: "packages/desktop/src/main/server.ts", declare: "spawnLocalServer" },
  { id: "desktop.check-health", surface: "desktop", kind: "sidecar-spawn", name: "checkHealth", fileFromRoot: "packages/desktop/src/main/server.ts", declare: "checkHealth" },
  { id: "desktop.sidecar-server-listen", surface: "desktop", kind: "sidecar-listen", name: "Server.listen", fileFromRoot: "packages/desktop/src/main/sidecar.ts", chain: "Server.listen" },
  { id: "desktop.wsl-sidecar", surface: "desktop", kind: "sidecar-spawn", name: "spawnWslSidecar", fileFromRoot: "packages/desktop/src/main/wsl/sidecar.ts", declare: "spawnWslSidecar" },

  // IM (surface 6): core ingress orchestration + server-side executor face.
  { id: "im.agent-orchestrator", surface: "im", kind: "ingress-orchestrator", name: "IM agent orchestrator", fileFromRoot: "packages/core/src/im/agent-orchestrator.ts" },
  { id: "im.agent-executor", surface: "im", kind: "server-agent-executor", name: "ServerAgentExecutor", fileFromRoot: "packages/deepagent-code/src/im/agent-executor-server.ts", declare: "ServerAgentExecutor" },
  { id: "im.agent-reply-sink", surface: "im", kind: "reply-sink", name: "Agent reply sink (server)", fileFromRoot: "packages/deepagent-code/src/im/agent-reply-sink-server.ts" },
  { id: "im.agent-progress-stream", surface: "im", kind: "progress-stream", name: "Agent progress stream", fileFromRoot: "packages/deepagent-code/src/im/agent-progress-stream.ts", declare: "withAgentProgress" },

  // Event (surface 7): bus / router / bridge / daemon consumers.
  { id: "event.v2-bridge", surface: "event", kind: "event-bridge", name: "EventV2Bridge", fileFromRoot: "packages/deepagent-code/src/event-v2-bridge.ts", declare: "layer" },
  { id: "event.legacy-canonicalizer-daemon", surface: "event", kind: "event-daemon", name: "LegacyEventCanonicalizerRuntime", fileFromRoot: "packages/deepagent-code/src/legacy-event-canonicalizer-runtime.ts", declare: "makeLayer" },
  { id: "event.deepagent-bus", surface: "event", kind: "durable-bus", name: "DeepAgentEventBus", fileFromRoot: "packages/core/src/deepagent/deepagent-event-bus.ts" },
  { id: "event.event-router", surface: "event", kind: "router", name: "EventRouter", fileFromRoot: "packages/core/src/deepagent/event-router.ts" },
  { id: "event.panel-convene-consumer", surface: "event", kind: "bus-consumer", name: "PanelConveneConsumer", fileFromRoot: "packages/deepagent-code/src/panel/panel-convene-consumer.ts", declare: "CONVENE_GROUP" },
  { id: "event.goal-tick-consumer", surface: "event", kind: "bus-consumer", name: "GoalTickConsumer", fileFromRoot: "packages/deepagent-code/src/session/goal-tick-consumer.ts", declare: "TICK_GROUP" },
  { id: "event.wiki-event-driven-archiver", surface: "event", kind: "bus-consumer", name: "EventDrivenArchiver", fileFromRoot: "packages/deepagent-code/src/wiki/event-driven-archiver.ts" },

  // Task / Goal / Panel (surface 8).
  { id: "task.task-run-admission", surface: "task-goal-panel", kind: "child-session-registration", name: "TaskRun admission", fileFromRoot: "packages/deepagent-code/src/tool/task-run.ts", declare: "admitTaskRun" },
  { id: "task.goal-manager", surface: "task-goal-panel", kind: "goal-daemon", name: "GoalManager service", fileFromRoot: "packages/deepagent-code/src/session/goal-manager.ts", declare: "Service" },
  { id: "task.goal-driver", surface: "task-goal-panel", kind: "goal-daemon", name: "GoalDriver", fileFromRoot: "packages/deepagent-code/src/session/goal-driver.ts", declare: "makeGoalSteerRelay" },
  { id: "task.goal-loop-wiring", surface: "task-goal-panel", kind: "goal-daemon", name: "GoalLoop wiring", fileFromRoot: "packages/deepagent-code/src/session/goal-loop-wiring.ts", declare: "makeGoalLoopWiring" },
  { id: "panel.orchestrator", surface: "task-goal-panel", kind: "panel-engine", name: "PanelOrchestrator", fileFromRoot: "packages/deepagent-code/src/panel/orchestrator.ts", declare: "runPanel" },
  { id: "panel.arbiter", surface: "task-goal-panel", kind: "panel-engine", name: "PanelArbiter", fileFromRoot: "packages/deepagent-code/src/panel/arbiter.ts" },
  { id: "panel.consult", surface: "task-goal-panel", kind: "panel-engine", name: "consultPanel", fileFromRoot: "packages/deepagent-code/src/panel/consult.ts", declare: "consultPanel" },
  { id: "panel.panelist-runner", surface: "task-goal-panel", kind: "panel-engine", name: "PanelistRunner", fileFromRoot: "packages/deepagent-code/src/panel/panelist-runner.ts" },
  { id: "background.job", surface: "task-goal-panel", kind: "background-daemon", name: "BackgroundJob", fileFromRoot: "packages/deepagent-code/src/background/job.ts", identifier: "InstanceState" },

  // Provider (surface 9).
  { id: "provider.model-catalog-parse", surface: "provider", kind: "model-resolver", name: "ModelV2.parse", fileFromRoot: "packages/core/src/model.ts", declare: "parse" },
  { id: "provider.provider-v2-schema", surface: "provider", kind: "provider-resolver", name: "ProviderV2", fileFromRoot: "packages/core/src/provider.ts", declare: "Info" },
  { id: "provider.catalog-loader", surface: "provider", kind: "catalog-loader", name: "Catalog loader", fileFromRoot: "packages/core/src/catalog.ts", declare: "Service" },
  { id: "provider.aisdk-stream-bridge", surface: "provider", kind: "stream-bridge", name: "AISDK bridge", fileFromRoot: "packages/core/src/aisdk.ts" },
  { id: "provider.model-request-resolver", surface: "provider", kind: "model-resolver", name: "ModelRequest resolver", fileFromRoot: "packages/core/src/model-request.ts", declare: "normalizeAiSdkOptions" },

  // Tool registry (surface 10).
  { id: "tools.v2-registry", surface: "tools", kind: "registry-writer", name: "ToolRegistry register/materialize/settle", fileFromRoot: "packages/core/src/tool/registry.ts" },
  { id: "tools.dacode-registry", surface: "tools", kind: "registry-writer", name: "dacode ToolRegistry", fileFromRoot: "packages/deepagent-code/src/tool/registry.ts" },

  // Recovery (surface 11).
  { id: "recovery.session-execution-restart", surface: "recovery", kind: "v2-recovery-service", name: "SessionRestart", fileFromRoot: "packages/core/src/session/execution/restart.ts" },
  { id: "recovery.database-binding", surface: "recovery", kind: "recovery-classifier", name: "RecoveryBinding", fileFromRoot: "packages/core/src/database/recovery-binding.ts" },
  { id: "recovery.task-recovery-tool", surface: "recovery", kind: "legacy-tool-entry", name: "TaskRecoveryTool", fileFromRoot: "packages/deepagent-code/src/tool/task_recovery.ts", declare: "TaskRecoveryTool" },
  { id: "recovery.provider-owner-runtime", surface: "recovery", kind: "owner-runtime", name: "ContextFederation provider owner runtime", fileFromRoot: "packages/deepagent-code/src/context-federation/provider-owner-runtime.ts", declare: "nextOwnerToken" },
]

/**
 * AST anchor resolution order for one fixed entry:
 *   preferred declaration name -> property chain -> bare identifier ref -> self-export -> file top.
 * Every step is an AST fact; a vanished anchor must fail loudly instead of silently moving the
 * denominator, so when `declare` was requested but missing we report it via missingAnchors.
 */
function resolveAnchorLine(mod: ReturnType<typeof parseModule>, fixed: FixedEntry): number | undefined {
  if (fixed.declare) return declarationLine(mod, fixed.declare)
  if (fixed.chain) {
    const hit = pinnedChainHit(mod, fixed.chain)
    if (hit) return hit.line
    return undefined
  }
  if (fixed.identifier) return identifierLine(mod, fixed.identifier)
  return moduleAnchorLine(mod)
}

function pinnedChainHit(mod: ReturnType<typeof parseModule>, chain: string): { line: number } | undefined {
  const suffix = `.${chain}`
  let found: number | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(mod.sourceFile)
      if (text === chain || text.endsWith(suffix)) {
        found = mod.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(mod.sourceFile)
  return found ? { line: found } : undefined
}

/** Fixed service-level entries with deterministic AST anchors. */
function fixedSurface(): EntryWithHandlers[] {
  const out: EntryWithHandlers[] = []
  for (const fixed of FIXED_ENTRIES) {
    const abs = join(ROOT(), fixed.fileFromRoot)
    let item: EntryWithHandlers | undefined
    try {
      const mod = parseModule(abs)
      const line = resolveAnchorLine(mod, fixed)
      if (line !== undefined) {
        item = {
          entry: {
            id: fixed.id,
            surface: fixed.surface,
            kind: fixed.kind,
            name: fixed.name,
            repoFile: fixed.fileFromRoot,
            line,
          },
          handlers: [],
        }
      }
    } catch {
      // Missing/unparsable source files are surfaced as missing anchors by the caller.
      item = undefined
    }
    if (item) out.push(item)
  }
  return out.sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
}

export function extractAllEntries(): { entries: EntryWithHandlers[]; missingAnchors: string[] } {
  const produced = [
    ...httpSurface([
      {
        groupsDir: "packages/server/src/groups",
        handlersDir: "packages/server/src/handlers",
        tag: "server",
      },
      {
        groupsDir: "packages/deepagent-code/src/server/routes/instance/httpapi/groups",
        handlersDir: "packages/deepagent-code/src/server/routes/instance/httpapi/handlers",
        tag: "instance",
      },
    ]),
    ...dacodeCliSurface(),
    ...lildaxCliSurface(),
    ...acpSurface(),
    ...fixedSurface(),
  ]
  // Fixed anchors whose files vanished would silently shrink the universe; detect them by re-checking.
  const anchoredIds = new Set(produced.map((item) => item.entry.id))
  const missingAnchors = FIXED_ENTRIES.filter((fixed) => !anchoredIds.has(fixed.id)).map((fixed) => fixed.id)
  const entries = produced.sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
  return { entries, missingAnchors }
}

export function parseModuleForTestOnly(file: string): ReturnType<typeof parseModule> {
  return parseModule(file)
}

export function toPlainEntry(item: EntryWithHandlers): Entry {
  return item.entry
}
