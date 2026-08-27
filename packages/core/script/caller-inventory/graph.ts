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
