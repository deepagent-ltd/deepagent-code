/**
 * Static import-graph walk rooted at extracted production entries.
 *
 * The walker resolves workspace specifiers and runs bounded BFS from each
 * entry module, collecting AST-level reference hits for the marker table used
 * by the classifier. Only production source modules reachable through real
 * import statements are ever visited — injected comment/string/fixture/test
 * files cannot enter the denominator (anti-pollution guarantee).
 */
import ts from "typescript"
import { existsSync, readFileSync } from "node:fs"
import type { HandlerSite, Requirement } from "./types"
import { declarationNodes, moduleAnchorLine, parseModule, refsInSubtree, rootRepoPath } from "./ast"
import { DELEGATION_CLIENT_BINDINGS, DELEGATION_SPAWN_BINDINGS, PORTS } from "./authority"

const repoRoot = () => rootRepoPath()

const srcRoots = () => [
  `${repoRoot()}/packages/core/src`,
  `${repoRoot()}/packages/deepagent-code/src`,
  `${repoRoot()}/packages/server/src`,
  `${repoRoot()}/packages/cli/src`,
  `${repoRoot()}/packages/desktop/src`,
  `${repoRoot()}/packages/sdk/js/src`,
]

const normalize = (p: string) => p.replace(/\.js$/, "").replace(/\.tsx$/, ".ts") + (/\.ts$/.test(p.replace(/\.js$/, "")) ? "" : ".ts")

function insideSrcRoots(path: string): boolean {
  return srcRoots().some((root) => path.startsWith(`${root}/`))
}

/** Resolve a module specifier relative to the importing file. Undefined when external/unresolvable. */
export function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".") && !spec.startsWith("@deepagent-code/") && !spec.startsWith("@/")) return undefined
  let target: string | undefined
  if (spec.startsWith(".")) {
    target = new URL(spec, `file://${fromFile}`).pathname
  } else {
    const ownPackageRoot = (file: string): string => {
      const marker = "/packages/"
      const index = file.indexOf(marker)
      if (index === -1) return ""
      const rest = file.slice(index + marker.length)
      const slash = rest.indexOf("/")
      const pkg = slash === -1 ? rest : rest.slice(0, slash)
      return `${marker}${pkg}/src`
    }
    const tail = spec.startsWith("@/")
      ? // "@/" is each product package's own src-root alias (tsconfig paths of deepagent-code).
        `${ownPackageRoot(fromFile)}/${spec.slice(2)}`
      : (() => {
          const sub = spec.slice("@deepagent-code/".length)
          const slash = sub.indexOf("/")
          const pkg = slash === -1 ? sub : sub.slice(0, slash)
          const path = slash === -1 ? undefined : sub.slice(slash + 1)
          return path
            ? `/packages/${pkg}/src/${path}`
            : `/packages/${pkg}/src/index`
        })()
    target = `${repoRoot()}${tail}`
  }
  const candidates = [
    normalize(target),
    `${target.replace(/\.ts$/, "")}/index.ts`,
    ...(target.endsWith(".ts") ? [target] : []),
  ]
  return candidates.find((c) => insideSrcRoots(c) && existsSync(c))
}

export type ImportEdge = { readonly target: string; readonly line: number }

let edgeCache: Map<string, readonly ImportEdge[]> | undefined

/** Resolved outgoing import edges of one module (production workspace modules only). */
export function edges(file: string): readonly ImportEdge[] {
  if (!edgeCache) edgeCache = new Map()
  const cached = edgeCache.get(file)
  if (cached) return cached
  const mod = parseModule(file)
  const sf = mod.sourceFile
  const out: ImportEdge[] = []
  const recordEdge = (spec: string, line: number): void => {
    const target = resolveSpecifier(file, spec)
    if (!target) return
    out.push({ target, line })
  }
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue
    const spec = st.moduleSpecifier.getText(sf).slice(1, -1)
    recordEdge(spec, sf.getLineAndCharacterOfPosition(st.getStart()).line + 1)
  }
  // Dynamic import() edges are REAL runtime imports (e.g. the lildax CLI lazily loads command
  // handlers and their authority-bearing modules). Ignoring them makes the reach closure
  // under-approximate and lets noReach be falsely satisfied, so always follow them.
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteralLike(arg)) {
        recordEdge(arg.text, sf.getLineAndCharacterOfPosition(node.getStart()).line + 1)
      }
    }
    ts.forEachChild(node, walk)
  }
  for (const st of sf.statements) walk(st)
  const frozen = out.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  edgeCache.set(file, frozen)
  return frozen
}

export type VerifiedHit = { readonly marker: string; readonly file: string; readonly line: number }

const normalizePath = (p: string) => p.replace(/\\/g, "/")

/**
 * Import-graph BFS from the entry module. Returns every reachable production module
 * with the import-statement line through which it was first entered.
 */
export function reachable(entryFile: string, opts?: { maxDepth?: number }): ReadonlyMap<string, number> {
  return reachableFromRoots([entryFile], opts)
}

const defaultMaxDepth = 24
const reachCache = new Map<string, ReadonlyMap<string, number>>()

/**
 * Union BFS over several root modules (entry module plus any structurally linked
 * handler modules). Roots are visited in lexicographic order so the first-entry
 * line recorded per reached module is deterministic regardless of extraction order.
 */
export function reachableFromRoots(rootFiles: readonly string[], opts?: { maxDepth?: number }): ReadonlyMap<string, number> {
  const maxDepth = opts?.maxDepth ?? defaultMaxDepth
  const key = `${maxDepth}\u0000${[...rootFiles].sort().join("\u0000")}`
  const cached = reachCache.get(key)
  if (cached) return cached
  const reached = new Map<string, number>()
  for (const root of [...rootFiles].sort()) {
    if (!existsSync(root)) continue
    if (!reached.has(root)) reached.set(root, 1)
    let frontier: { file: string; depth: number }[] = [{ file: root, depth: 0 }]
    while (frontier.length > 0) {
      const next: { file: string; depth: number }[] = []
      for (const node of frontier) {
        if (node.depth >= maxDepth) continue
        for (const edge of edges(node.file)) {
          if (reached.has(edge.target)) continue
          reached.set(edge.target, edge.line)
          next.push({ file: edge.target, depth: node.depth + 1 })
        }
      }
      frontier = next
    }
  }
  reachCache.set(key, reached)
  return reached
}

/**
 * Handler-body scope: chain keys -> resolving site, collected from this entry's own
 * resolved handler bodies. A site resolves to either the same-file declaration named by
 * `.handle(op, fnName)` or, for inline handlers (`Effect.fn(function* ...)`), the argument
 * subtree itself; a bounded set of same-file callee declarations referenced inside those
 * bodies is expanded too. Out-of-file helpers are intentionally not followed — body claims
 * stay scoped to what this registration site itself executes.
 */
export type BodyScope = {
  readonly chains: ReadonlyMap<string, { readonly repoFile: string; readonly line: number }>
  readonly files: readonly string[]
}

const bodyScopeCache = new Map<string, BodyScope>()

/** Locate the `.handle(...)` call registered at this exact start line in one parsed module. */
function handleCallAtLine(mod: ReturnType<typeof parseModule>, line: number): ts.CallExpression | undefined {
  const sf = mod.sourceFile
  let found: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression
      if (
        (callee.name.text === "handle" || callee.name.text === "handleRaw") &&
        // Anchor to this call's OWN .handle property access, not node.getStart() (which returns
        // the start of the whole receiver chain for chained .handle(op, fn) expressions).
        sf.getLineAndCharacterOfPosition(callee.name.getStart()).line + 1 === line &&
        node.arguments.length >= 1
      ) {
        found = node
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

export function bodyScopes(sites: readonly HandlerSite[]): BodyScope {
  const usable = sites.filter((site) => site.group !== undefined)
  const key = usable.map((site) => `${site.repoFile}:${site.line}:${site.bodyDecl ?? ""}`).join("\u0001")
  const cached = bodyScopeCache.get(key)
  if (cached) return cached
  const byFile = new Map<string, typeof usable>()
  for (const site of usable) {
    const list = byFile.get(site.repoFile) ?? []
    list.push(site)
    byFile.set(site.repoFile, list)
  }
  const chains = new Map<string, { repoFile: string; line: number }>()
  const files: string[] = []
  for (const [repoFile, sitesInFile] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const mod = parseModule(`${rootRepoPath()}/${repoFile}`)
    files.push(repoFile)
    const queue: ts.Node[] = []
    const seenNodes = new Set<ts.Node>()
    const enqueue = (node: ts.Node): void => {
      if (!seenNodes.has(node)) {
        seenNodes.add(node)
        queue.push(node)
      }
    }
    for (const site of sitesInFile.sort((a, b) => a.line - b.line)) {
      const call = handleCallAtLine(mod, site.line)
      if (!call) continue
      const target = call.arguments[1]
      if (!target) continue
      if (ts.isIdentifier(target)) {
        for (const node of declarationNodes(mod, target.text)) enqueue(node)
        continue
      }
      enqueue(target)
    }
    // Bounded expansion of same-file callees referenced as bare identifiers in call position.
    let processed = 0
    while (queue.length > 0 && processed < 24) {
      const node = queue.shift()
      if (!node) break
      processed += 1
      const subRefs = refsInSubtree(mod.sourceFile, node)
      const callees: string[] = []
      const collectCallees = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) callees.push(inner.expression.text)
        ts.forEachChild(inner, collectCallees)
      }
      collectCallees(node)
      for (const callee of [...new Set(callees)].sort()) {
        for (const candidate of declarationNodes(mod, callee)) enqueue(candidate)
      }
      for (const [chainKey, lines] of subRefs) {
        const line = Math.min(...lines)
        const existing = chains.get(chainKey)
        if (existing === undefined || line < existing.line) chains.set(chainKey, { repoFile, line })
      }
    }
  }
  const scope: BodyScope = { chains, files: files.sort() }
  bodyScopeCache.set(key, scope)
  return scope
}

function chainHits(files: Iterable<string>, chain: string, fileSuffix?: string): VerifiedHit | undefined {
  const suffix = `.${chain}`
  for (const file of files) {
    if (fileSuffix && !normalizePath(file).endsWith(normalizePath(fileSuffix))) continue
    const mod = parseModule(file)
    for (const [key, lines] of mod.refLines) {
      // Exact tail match against AST-built dotted property chains; comments and string
      // template contents never produce refLines keys, so they cannot match here.
      if (key !== chain && !key.endsWith(suffix)) continue
      return { marker: chain, file, line: Math.min(...lines) }
    }
  }
  return undefined
}

function importHit(
  files: Iterable<string>,
  fileSuffix: string,
  specifierSuffix: string,
): VerifiedHit | undefined {
  for (const file of files) {
    if (!normalizePath(file).endsWith(normalizePath(fileSuffix))) continue
    for (const binding of parseModule(file).imports.values()) {
      if (binding.specifier === specifierSuffix || binding.specifier.endsWith(specifierSuffix)) {
        return { marker: specifierSuffix, file, line: binding.line }
      }
    }
  }
  return undefined
}

export type RequirementResult = { readonly requirement: Requirement; readonly hit?: VerifiedHit }

export type RequirementVerdict = {
  readonly results: readonly RequirementResult[]
  readonly satisfied: boolean
  readonly evidence: readonly VerifiedHit[]
}

export type VerificationScope = {
  /** Extra BFS roots structurally linked to the entry (its HTTP handler modules). */
  readonly extraRoots?: readonly string[]
  /** Handler registration sites resolved for this entry; defines its handler-body scope. */
  readonly bodies?: readonly HandlerSite[]
}

/**
 * Production-package Core-V2-only profile proof, checked once and cached:
 *   1. the forced-version predicate EXISTS in runtime-flags.ts and its RegExp literal is
 *      extracted from the source itself (no duplicated copy that could silently diverge);
 *   2. that predicate is wired to the injected InstallationVersion (forcedByVersion);
 *   3. the flag folds `forcedByVersion || explicit`, so an explicit override cannot unforce;
 *   4. the production bundler injects DEEPAGENT_CODE_VERSION from the release Script.version;
 *   5. this candidate's frozen package identity (packages/deepagent-code/package.json,
 *      structured release config) satisfies the source-derived regex.
 */
type ProfileProof = { readonly ok: boolean; readonly evidence: readonly VerifiedHit[] }

const FORCED_PREDICATE_DECL = "isCoreV2OnlyVersion"

function propertyAssignmentLine(mod: ReturnType<typeof parseModule>, propertyName: string): number | undefined {
  const sf = mod.sourceFile
  let found: number | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined
      if (name === propertyName) {
        found = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function chainContainsText(mod: ReturnType<typeof parseModule>, node: ts.Node, text: string): boolean {
  let hit = false
  const visit = (inner: ts.Node): void => {
    if (hit) return
    if (ts.isPropertyAccessExpression(inner) && inner.getText(mod.sourceFile) === text) hit = true
    ts.forEachChild(inner, visit)
  }
  visit(node)
  return hit
}

let cachedProfile: ProfileProof | undefined

export function verifyProductionProfile(): ProfileProof {
  if (cachedProfile) return cachedProfile
  const flagsMod = parseModule(`${rootRepoPath()}/packages/deepagent-code/src/effect/runtime-flags.ts`)
  const buildMod = parseModule(`${rootRepoPath()}/packages/deepagent-code/script/build.ts`)
  const evidence: VerifiedHit[] = []

  // 1. Forced-version predicate declaration carries the authority RegExp literal itself.
  let regexPattern: string | undefined
  let predicateLine: number | undefined
  const findPredicate = (node: ts.Node): void => {
    if (predicateLine !== undefined) return
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (decl) => ts.isIdentifier(decl.name) && decl.name.text === FORCED_PREDICATE_DECL && decl.initializer,
      )
    ) {
      const decl = node.declarationList.declarations.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === FORCED_PREDICATE_DECL,
      )!
      predicateLine = flagsMod.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      const visit = (inner: ts.Node): void => {
        if (regexPattern) return
        if (ts.isRegularExpressionLiteral(inner)) regexPattern = inner.text.slice(1, inner.text.lastIndexOf("/"))
        ts.forEachChild(inner, visit)
      }
      visit(decl.initializer!)
      return
    }
    ts.forEachChild(node, findPredicate)
  }
  findPredicate(flagsMod.sourceFile)

  const wiringLine = propertyAssignmentLine(flagsMod, "forcedByVersion")
  const definesInjection = (() => {
    const sf = buildMod.sourceFile
    let ok = false
    const visit = (node: ts.Node): void => {
      if (ok) return
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) ? node.name.text : undefined
        if (name === "DEEPAGENT_CODE_VERSION") {
          ok = chainContainsText(buildMod, node.initializer, "Script.version")
          return
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return ok
  })()
  const injectionLine = definesInjection
    ? propertyAssignmentLine(buildMod, "DEEPAGENT_CODE_VERSION")
    : undefined

  // 3. Forced bit wins over the explicit opt-out: `forcedByVersion || explicit`.
  const foldLines: number[] = []
  const visitFold = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      chainContainsText(flagsMod, node.left, "value.forcedByVersion") &&
      chainContainsText(flagsMod, node.right, "value.explicit")
    ) {
      foldLines.push(flagsMod.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
    ts.forEachChild(node, visitFold)
  }
  visitFold(flagsMod.sourceFile)

  // 5. Frozen package identity satisfies the source-derived regex (structured release config).
  let identityMatches = false
  try {
    const pkg = JSON.parse(readFileSync(`${rootRepoPath()}/packages/deepagent-code/package.json`, "utf8"))
    identityMatches =
      typeof pkg.version === "string" &&
      typeof regexPattern === "string" &&
      new RegExp(regexPattern).test(pkg.version)
  } catch {
    identityMatches = false
  }

  const anchorsOk =
    predicateLine !== undefined &&
    wiringLine !== undefined &&
    foldLines.length > 0 &&
    injectionLine !== undefined
  if (anchorsOk) {
    evidence.push({ marker: "core-v2-only-predicate", file: flagsMod.file, line: predicateLine! })
    evidence.push({ marker: "core-v2-only-wiring", file: flagsMod.file, line: wiringLine! })
    evidence.push({ marker: "core-v2-only-fold", file: flagsMod.file, line: Math.min(...foldLines) })
    evidence.push({ marker: "core-v2-only-define-injection", file: buildMod.file, line: injectionLine! })
  }
  const proof: ProfileProof = { ok: anchorsOk && identityMatches, evidence }
  cachedProfile = proof
  return proof
}

function tailMatchHit(
  chains: ReadonlyMap<string, { readonly repoFile: string; readonly line: number }>,
  chain: string,
): { readonly repoFile: string; readonly line: number } | undefined {
  const suffix = `.${chain}`
  let best: { repoFile: string; line: number } | undefined
  for (const [key, hit] of chains) {
    if (key !== chain && !key.endsWith(suffix)) continue
    if (best === undefined || hit.line < best.line) best = hit
  }
  return best
}

/**
 * Static process/CLI/client delegation edge: scan this entry's own module (and its resolved handler
 * modules) for a spawn/fork/exec/fork call whose first STRING-LITERAL argument (or a client endpoint
 * string) resolves, via DELEGATION_SPAWN_BINDINGS, to the target inventory entry id. Returns the
 * call site so the delegation edge is attributed to a real file:line.
 */
function delegationSpawnHit(entryFile: string, extraRoots: readonly string[], targetId: string): VerifiedHit | undefined {
  const roots = [entryFile, ...extraRoots]
  for (const file of roots) {
    if (!existsSync(file)) continue
    const mod = parseModule(file)
    const sf = mod.sourceFile
    let found: VerifiedHit | undefined
    // Collect string fragments a spawn/fork argument could resolve to (string literal directly, or
    // the string literals inside a const initializer like join(dirname(...), "sidecar.js")).
    const stringFragments = (expr: ts.Expression): string[] => {
      const out: string[] = []
      const collect = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) out.push(node.text)
        ts.forEachChild(node, collect)
      }
      collect(expr)
      if (ts.isIdentifier(expr)) {
        for (const decl of declarationNodes(mod, expr.text)) collect(decl)
      }
      return out
    }
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
          : ts.isIdentifier(node.expression) ? node.expression.text : undefined
        if (
          ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          DELEGATION_SPAWN_BINDINGS[node.arguments[0].text] === targetId
        ) {
          found = { marker: `delegates:${targetId}`, file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 }
          return
        }
        if (callee && ["fork", "spawn", "exec", "execFile", "execSync", "forkFile", "forkChild"].includes(callee)) {
          const first = node.arguments[0]
          if (first) {
            const fragments = stringFragments(first)
            if (fragments.some((fragment) => DELEGATION_SPAWN_BINDINGS[fragment] === targetId)) {
              found = { marker: `delegates:${targetId}`, file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 }
              return
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (found) return found
  }
  return undefined
}

/** Machine-checked positive body-shape fact: an entry whose own module performs NO authority/business
 * call — its only calls are log/no-op/registration statements (a no-op lifecycle command). */
const BUSINESS_CALLEES = new Set(["prompt", "promptOrSteer", "loop", "publish", "tryPublish", "register", "materialize", "wake", "executor", "registry", "steer", "resume", "admit", "run", "fork", "spawn", "replay", "snapshotRows"])
export function bodyLogsOnlyHit(entryFile: string, extraRoots: readonly string[] = []): VerifiedHit | undefined {
  // Scan the entry's OWN handler modules (the resolved lazy handler, e.g. migrate.ts), NOT the
  // command-tree registration file (commands.ts, whose Spec.make tree would trivially satisfy).
  // A no-op handler body performs only log/no-op/registration calls; any business callee fails it.
  const roots = [entryFile, ...extraRoots]
  let anchorLine = 1
  let anchorFile = entryFile
  for (const file of roots) {
    if (!existsSync(file)) continue
    const mod = parseModule(file)
    const sf = mod.sourceFile
    let businessFound = false
    const visit = (node: ts.Node): void => {
      if (businessFound) return
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
          : ts.isIdentifier(node.expression) ? node.expression.text : undefined
        if (callee && BUSINESS_CALLEES.has(callee)) businessFound = true
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (businessFound) return undefined
  }
  // Anchor the marker at the resolved handler module (or the entry if none) — its first statement.
  const firstHandler = extraRoots.find((file) => existsSync(file)) ?? entryFile
  anchorFile = firstHandler
  anchorLine = 1
  return { marker: "bodyLogsOnly", file: anchorFile, line: anchorLine }
}

/** A client/service INVOCATION call site in the entry's own handler body: a body chain that performs a
 * member call on a bound client object (e.g. Daemon.Service.start / daemon.client().v2.agent.list).
 * Evidence is the actual call-site chain line — never a module self-export/reference anchor. */
function clientInvocationHit(
  entryFile: string,
  extraRoots: readonly string[],
  targetId: string,
): VerifiedHit | undefined {
  // Scan the entry's OWN module and its resolved handler modules for a client/service INVOCATION call
  // site (member-call or identifier-call) whose chain resolves to targetId. A passive import alone
  // never produces a hit — evidence is always a real CallExpression.
  for (const file of [entryFile, ...extraRoots]) {
    if (!existsSync(file)) continue
    const mod = parseModule(file)
    const sf = mod.sourceFile
    // Match the entry's own handler body against the client-call chain (AST refLines flatten
    // (yield* Daemon.Service).start() into "Daemon.Service.start", so a member-call is matched even
    // through yield*/parentheses — always a genuine invocation, never a passive import).
    for (const [chainKey, lines] of mod.refLines) {
      for (const [binding, target] of Object.entries(DELEGATION_CLIENT_BINDINGS)) {
        if (target !== targetId) continue
        if (chainKey === binding || chainKey.startsWith(binding + ".") || chainKey.endsWith("." + binding)) {
          // Prefer a line that is itself a CALL (contains "(") so the edge is a real invocation site,
          // never a bare field/declaration line.
          const srcLines = readFileSync(file, "utf8").split("\n")
          for (const line of [...lines].sort((a, b) => a - b)) {
            if ((srcLines[line - 1] ?? "").includes("(")) {
              return { marker: `delegates:${targetId}`, file, line }
            }
          }
        }
      }
    }
  }
  return undefined
}

/** A port module provides a service via a static Layer.effect/sync/succeed first-arg = port service. */
function moduleProvidesPortService(mod: ReturnType<typeof parseModule>, service: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const head = ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : undefined
      if (head === "Layer" && (method === "effect" || method === "sync" || method === "succeed")) {
        const first = node.arguments[0]
        if (first && ts.isIdentifier(first) && first.text === service) found = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(mod.sourceFile)
  // Robust fallback: the provider module must export a *Live layer binding the service (e.g.
  // ServerAgentReplySinkLive = Layer.sync(AgentReplySinkService, ...)). Source-text positive fact.
  if (!found) {
    const text = readFileSync(mod.file, "utf8")
    found = new RegExp("Layer\\.(?:effect|sync|succeed)\\(\\s*" + service + "\\b").test(text)
  }
  return found
}

/**
 * Effect service-layer DI binding (layered resolution): the entry imports the port module; the port's
 * canonical production provider module (authority.ts PORTS) exports a static Layer.effect/sync for the
 * port service; and the production composition module imports/provides that provider layer. Returns a
 * hit so the consumer inherits the provider entry's verdict (portBound:<providerEntryId>).
 */
function portBoundHit(entryFile: string, portModule: string): VerifiedHit | undefined {
  const port = PORTS[portModule]
  if (!port) return undefined
  const entryImports = edges(entryFile)
  const importSite = entryImports.find((edge) => normalizePath(edge.target).endsWith(normalizePath(portModule)))
  if (!importSite) return undefined
  const providerFile = `${rootRepoPath()}/${port.providerModule}`
  if (!existsSync(providerFile)) return undefined
  if (!moduleProvidesPortService(parseModule(providerFile), port.service)) return undefined
  const compositionFile = `${rootRepoPath()}/${port.compositionModule}`
  if (!existsSync(compositionFile)) return undefined
  const compProvides = edges(compositionFile).some((edge) => normalizePath(edge.target).endsWith(port.providerModule))
  if (!compProvides) return undefined
  return { marker: `portBound:${port.providerEntryId}`, file: entryFile, line: importSite.line }
}

/**
 * Verify a claim's requirements entirely inside the entry's real import-graph closure
 * plus its own handler-body scope:
 * injected probe files are unreachable modules, so no requirement can ever be satisfied
 * by them; within reachable modules only true AST shapes produce hits.
 */
export function verifyRequirements(
  entryFile: string,
  requirements: readonly Requirement[],
  scope?: VerificationScope,
): RequirementVerdict {
  if (requirements.length === 0) return { results: [], satisfied: false, evidence: [] }
  const extraRoots = scope?.extraRoots ?? []
  const cacheKey =
    `${entryFile}\u0000${[...extraRoots].sort().join("\u0001")}\u0000${(scope?.bodies ?? [])
      .map((site) => `${site.repoFile}:${site.line}:${site.bodyDecl ?? ""}`)
      .sort()
      .join("\u0001")}\u0000${requirements.map((requirement) => JSON.stringify(requirement)).join("\u0001")}`
  const cached = verdictCache.get(cacheKey)
  if (cached) return cached
  const reachMap = reachableFromRoots([entryFile, ...extraRoots])
  const files = [...reachMap.keys()]
  const scopeChains = scope?.bodies && scope.bodies.length > 0 ? bodyScopes(scope.bodies) : { chains: new Map() }
  const results = requirements.map((requirement): RequirementResult => {
    if (requirement.kind === "portBoundTo") {
      const hit = portBoundHit(entryFile, requirement.portModule)
      return { requirement, hit }
    }
    if (requirement.kind === "bodyLogsOnly") {
      return { requirement, hit: bodyLogsOnlyHit(entryFile, extraRoots) }
    }
    if (requirement.kind === "delegatesTo") {
      // NEW-P6-B: delegation is CALL-PATH-ONLY. A delegation edge is sound only when the entry's flow
      // performs an actual invocation — a spawn/fork/exec call whose target resolves to the receiver, or
      // a client/service member-call in the entry's own body that resolves to the receiver. Reach of a
      // module (reference/target-module) is NOT sufficient on its own (it can be a passive import).
      const spawnHit = delegationSpawnHit(entryFile, extraRoots, requirement.targetId)
      if (spawnHit) return { requirement, hit: spawnHit }
      const clientHit = clientInvocationHit(entryFile, extraRoots, requirement.targetId)
      return { requirement, hit: clientHit }
    }
    if (requirement.kind === "reach") {
      const target = files.find((file) => normalizePath(file).endsWith(normalizePath(requirement.pathSuffix)))
      if (!target) return { requirement, hit: undefined }
      // Anchor the marker to a REPO-RELATIVE path (cross-machine byte-stable) and the line to
      // the reached module's OWN anchor — never a line borrowed from the importer, which can
      // exceed the cited file's length and misattribute the fact.
      const relative = normalizePath(target).slice(normalizePath(rootRepoPath()).length + 1)
      const anchorLine = moduleAnchorLine(parseModule(target))
      return {
        requirement,
        hit: { marker: `reach:${relative}`, file: target, line: anchorLine },
      }
    }
    if (requirement.kind === "noReach") {
      // Absence proof: the requirement is met only when NO reachable module's path ends with
      // the suffix. A hit (satisfied) is anchored to the entry module itself, since the claim
      // is about the whole import closure being unable to bring the authority into the flow.
      const present = files.some((file) => normalizePath(file).endsWith(normalizePath(requirement.pathSuffix)))
      return {
        requirement,
        hit: present ? undefined : { marker: `absent:${requirement.pathSuffix}`, file: entryFile, line: 1 },
      }
    }
    if (requirement.kind === "importOf") {
      return {
        requirement,
        hit: importHit(files, requirement.fileSuffix, requirement.specifierSuffix),
      }
    }
    if (requirement.kind === "bodyChain") {
      const site = tailMatchHit(scopeChains.chains, requirement.chain)
      return {
        requirement,
        hit: site === undefined ? undefined : { marker: `body:${requirement.chain}`, file: `${rootRepoPath()}/${site.repoFile}`, line: site.line },
      }
    }
    if (requirement.kind === "noBodyChain") {
      const present = tailMatchHit(scopeChains.chains, requirement.chain)
      // Absence proof anchors to the entry module itself — the claim is about this
      // entry's own handler-body scope, which is exactly what was searched.
      return {
        requirement,
        hit: present === undefined ? { marker: `absent:${requirement.chain}`, file: entryFile, line: 1 } : undefined,
      }
    }
    if (requirement.kind === "productionProfile") {
      const proof = verifyProductionProfile()
      const first = proof.ok ? proof.evidence[0] : undefined
      return {
        requirement,
        hit: first ? { marker: "production-core-v2-only-profile", file: first.file, line: first.line } : undefined,
      }
    }
    return { requirement, hit: chainHits(files, requirement.chain, requirement.fileSuffix) }
  })
  const evidence = results.flatMap((result) => (result.hit ? [result.hit] : []))
  const verdict: RequirementVerdict = { results, satisfied: evidence.length === requirements.length, evidence }
  verdictCache.set(cacheKey, verdict)
  return verdict
}

const verdictCache = new Map<string, RequirementVerdict>()
