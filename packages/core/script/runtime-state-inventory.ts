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
  | "test_only"
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
    .map((file) => file.replaceAll("\\", "/"))
    .filter(
      (file) =>
        !file.split("/").includes("node_modules") &&
        !file.includes("/generated/") &&
        !file.endsWith(".d.ts") &&
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

export function runtimeStateCandidates(filename: string, source: string): readonly RuntimeStateCandidate[] {
  const file = filename.replaceAll("\\", "/")
  // Declaration files cannot instantiate runtime state; dependency internals have their own owners.
  if (file.endsWith(".d.ts") || file.split("/").includes("node_modules")) return []
  const sourceFile = createSourceFile(
    file,
    source,
    ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  )
  const variables = [...moduleVariables(sourceFile.statements), ...escapingVariables(sourceFile)]
  const candidates = [
    ...variables.flatMap(({ declaration, namespace }) =>
      bindingNames(declaration.name).flatMap((name): RuntimeStateCandidate[] => {
        const kind =
          declaration.parent.flags & NodeFlags.Const
            ? "const"
            : declaration.parent.flags & NodeFlags.Let
              ? "let"
              : "var"
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
  const counts = new Map<string, number>()
  candidates.forEach((candidate) => {
    const anchor = ownerAnchor(candidate.key)
    counts.set(anchor, (counts.get(anchor) ?? 0) + 1)
  })
  return candidates.map((candidate): RuntimeStateCandidate => {
    const anchor = ownerAnchor(candidate.key)
    const review = reviewedAnchors.get(anchor)
    if (!review) return candidate
    if (counts.get(anchor) === 1) return { ...candidate, ...review }
    return {
      ...candidate,
      owner: "ambiguous-reviewed-owner",
      keyScope: "unresolved",
      bound: "unresolved",
      finalizer: "unresolved",
      durability: "unresolved",
      reachability: "source-owner-review",
      verdict: "review_required",
    }
  })
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
        const typedState =
          /\b(?:Map|Set|WeakMap|WeakSet|Promise|AbortController|Worker|WebSocket|Server|Client|Runtime|Store|Cache|Registry|Pool|Queue|Tracker)\b/.test(
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
  return (
    isVariableStatement(statement) &&
    (statement.parent.kind === SyntaxKind.SourceFile || isModuleBlock(statement.parent))
  )
}

function enclosingFunction(node: Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) return current
  }
}

function functionName(node: Node) {
  if (isFunctionLike(node) && node.name && isIdentifier(node.name)) return node.name.text
  if (isFunctionLike(node) && isVariableDeclaration(node.parent) && isIdentifier(node.parent.name))
    return node.parent.name.text
  if (isFunctionLike(node) && isPropertyDeclaration(node.parent) && isIdentifier(node.parent.name))
    return node.parent.name.text
  return "closure"
}

const synchronousCallbacks = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
])

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
  // RI-94 ZERO WAVE app/tui/ui/desktop/recorder/sdk/llm (2026-09-11). UI/TUI state is
  // process-bounded render/coordination state (W1/W2 rules re-asserted per key); desktop is the
  // Electron main-process/preload/renderer singleton family (W5); recorder/sdk/llm are per-media
  // coordination maps and client factories.
  // ===========================================================================
  ...Object.fromEntries(
    (
      [
        // ---- app/src: UI process state (ui_process_state), render-tree bounded ----
        [
          "packages/app/src/app.tsx:Session",
          [
            "ui-route-component",
            "ui-process",
            "route-lifetime",
            "unmount-gc",
            "ephemeral-ui",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/app.tsx:HomeRoute",
          [
            "ui-route-component",
            "ui-process",
            "route-lifetime",
            "unmount-gc",
            "ephemeral-ui",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/app.tsx:ReviewRoute",
          [
            "ui-route-component",
            "ui-process",
            "route-lifetime",
            "unmount-gc",
            "ephemeral-ui",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/app.tsx:AgentSystemRoute",
          [
            "ui-route-component",
            "ui-process",
            "route-lifetime",
            "unmount-gc",
            "ephemeral-ui",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/components/code-editor.tsx:BREAKPOINT_MARKER",
          [
            "ui-marker-const",
            "source-module",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/code-editor.tsx:PAUSED_MARKER",
          [
            "ui-marker-const",
            "source-module",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/dialog-custom-provider-form.ts:row",
          [
            "form-component-state",
            "ui-owner-invocation",
            "owner-lifecycle",
            "owner-exit-gc",
            "ephemeral-ui",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/components/prompt-input/scenario-override.ts:listeners",
          [
            "module-listener-set",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/components/prompt-input/scenario-override.ts:scenarioOverride",
          [
            "module-singleton-state",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/components/prompt-input/submit.ts:pending",
          [
            "module-pending-map",
            "per-followup-id",
            "active-followups",
            "resolve-on-response-or-abort",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/components/prompt-input/submit.ts:prepareStreamIdleTimeoutMs",
          [
            "module-test-injection-seam",
            "single-binding",
            "process-lifetime",
            "process-exit",
            "non-authority-constant-default",
            "product-ui-test-setter-only",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/components/settings-keybinds.tsx:ButtonV2",
          [
            "ui-lazy-component",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/settings-keybinds.tsx:IconButtonV2",
          [
            "ui-lazy-component",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/settings-keybinds.tsx:IconV2",
          [
            "ui-lazy-component",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/settings-keybinds.tsx:SettingsListV2",
          [
            "ui-lazy-component",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/settings-keybinds.tsx:TextInputV2",
          [
            "ui-lazy-component",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/settings-v2/general.tsx:demoSoundState",
          [
            "ui-demo-toggle",
            "ui-process",
            "toggle-lifetime",
            "toggle-flip",
            "ephemeral-ui",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/components/status-popover.tsx:ServerBody",
          [
            "ui-lazy-component",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/app/src/components/terminal.tsx:shared",
          [
            "module-lazy-singleton",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/context/file/content-cache.ts:lru",
          [
            "module-lru-cache",
            "per-file-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/file/content-cache.ts:total",
          [
            "module-lru-counter",
            "per-file-key",
            "process-lifetime",
            "lru-eviction",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/global-sync/bootstrap.ts:providerRev",
          [
            "module-revision-counter",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/global-sync/session-prefetch.ts:cache",
          [
            "module-lru-cache",
            "per-session-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/global-sync/session-prefetch.ts:inflight",
          [
            "module-inflight-map",
            "per-session-key",
            "request-duration",
            "response-settle",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/global-sync/session-prefetch.ts:nextRevision",
          [
            "module-revision-counter",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/global-sync/session-prefetch.ts:rev",
          [
            "module-revision-counter",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/language.tsx:dicts",
          [
            "module-dictionary-cache",
            "per-locale",
            "process-lifetime",
            "locale-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/local.tsx:handoff",
          [
            "module-singleton-state",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/terminal.tsx:lruClock",
          [
            "module-lru-counter",
            "per-session-key",
            "process-lifetime",
            "lru-eviction",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/terminal.tsx:sessionTerminalCache",
          [
            "module-lru-cache",
            "per-session-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/terminal.tsx:sessions",
          [
            "module-session-map",
            "per-session-key",
            "process-lifetime",
            "session-close-cleanup",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/context/terminal.tsx:workspaceDiscardFn",
          [
            "module-singleton-callback",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/pages/session/composer/session-question-dock.tsx:cache",
          [
            "component-lru-cache",
            "per-question-key",
            "dock-lifetime",
            "unmount-gc",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/pages/session/message-timeline.tsx:timelineCache",
          [
            "module-lru-cache",
            "per-session-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/id.ts:counter",
          [
            "module-counter",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/id.ts:lastTimestamp",
          [
            "module-counter",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/notification-click.ts:nav",
          [
            "module-singleton-callback",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/persist.ts:cache",
          [
            "module-lru-cache",
            "per-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/persist.ts:cacheTotal",
          [
            "module-lru-counter",
            "per-key",
            "process-lifetime",
            "lru-eviction",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/persist.ts:fallback",
          [
            "module-fallback-store",
            "per-key",
            "process-lifetime",
            "storage-flush",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/server-health.ts:healthCache",
          [
            "module-memoization",
            "per-server-key",
            "ttl-expiry",
            "eviction-on-refresh",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/sound.ts:cache",
          [
            "module-memoization",
            "per-sound-key",
            "process-lifetime",
            "process-exit",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/sound.ts:files",
          [
            "module-lazy-load-map",
            "per-sound-key",
            "process-lifetime",
            "process-exit",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/sound.ts:loads",
          [
            "module-inflight-map",
            "per-sound-key",
            "load-duration",
            "load-settle",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/app/src/utils/toast.tsx:v2",
          [
            "module-lazy-singleton",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/utils/worktree.ts:state",
          [
            "module-singleton-state",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/app/src/utils/worktree.ts:waiters",
          [
            "module-waiter-set",
            "per-request",
            "request-duration",
            "resolve-on-state",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        // ---- tui/src: terminal-UI process state ----
        [
          "packages/tui/src/audio.ts:audio",
          [
            "module-lazy-singleton",
            "tui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-tui",
            "safe_scoped",
          ],
        ],
        [
          "packages/tui/src/audio.ts:sounds",
          [
            "module-lazy-load-map",
            "per-sound-key",
            "process-lifetime",
            "process-exit",
            "memoization-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/clipboard.ts:copyMethod",
          [
            "module-singleton-state",
            "tui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/component/prompt/index.tsx:money",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/tui/src/component/prompt/index.tsx:stashed",
          [
            "component-state",
            "ui-owner-invocation",
            "owner-lifecycle",
            "owner-exit-gc",
            "ephemeral-ui",
            "product-tui",
            "safe_scoped",
          ],
        ],
        [
          "packages/tui/src/context/theme.tsx:setStore",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/tui/src/context/theme.tsx:store",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/tui/src/context/v2-session-journal.ts:pollMsOverride",
          [
            "module-singleton-state",
            "tui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/editor-zed.ts:utf8",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/tui/src/feature-plugins/session/preview-pane.tsx:messageCache",
          [
            "plugin-lru-cache",
            "per-message-key",
            "plugin-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/feature-plugins/sidebar/context.tsx:money",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/tui/src/keymap.tsx:modeStacks",
          [
            "module-mode-stacks",
            "per-mode-key",
            "process-lifetime",
            "mode-pop",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/plugin/command-shim.ts:warned",
          [
            "module-warned-set",
            "per-plugin-key",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/prompt/display.ts:graphemes",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/tui/src/routes/home.tsx:once",
          [
            "module-one-shot-flag",
            "tui-process",
            "process-lifetime",
            "first-fire",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/terminal-win32.ts:k32",
          [
            "module-lazy-singleton",
            "tui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-tui",
            "safe_scoped",
          ],
        ],
        [
          "packages/tui/src/terminal-win32.ts:unhook",
          [
            "module-singleton-callback",
            "tui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/theme/index.ts:customThemes",
          [
            "module-theme-map",
            "per-theme-name",
            "process-lifetime",
            "theme-remove",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/theme/index.ts:listeners",
          [
            "module-listener-set",
            "tui-process",
            "process-lifetime",
            "listener-unsubscribe",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/theme/index.ts:pluginThemes",
          [
            "module-theme-map",
            "per-theme-name",
            "process-lifetime",
            "theme-remove",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/theme/index.ts:systemTheme",
          [
            "module-singleton-state",
            "tui-process",
            "process-lifetime",
            "watch-update",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/util/layout.ts:previousByParent",
          [
            "module-layout-cache",
            "per-parent-key",
            "render-cycle",
            "render-replace",
            "ephemeral-runtime",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/util/session.ts:pendingForkIntents",
          [
            "module-pending-map",
            "per-intent-key",
            "intent-duration",
            "intent-settle",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        [
          "packages/tui/src/util/session.ts:pendingForkRequests",
          [
            "module-registry",
            "per-request-key",
            "request-duration",
            "request-settle",
            "coordination-only",
            "product-tui",
            "safe_bounded",
          ],
        ],
        // ---- ui/src: shared UI library caches (singletons bounded by product process) ----
        [
          "packages/ui/src/components/basic-tool.tsx:deferredFrame",
          [
            "module-frame-state",
            "ui-process",
            "frame-lifetime",
            "frame-commit",
            "ephemeral-ui",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/components/basic-tool.tsx:deferredMounts",
          [
            "module-mount-registry",
            "per-mount-key",
            "process-lifetime",
            "unmount-cleanup",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/components/icon.tsx:spriteInserted",
          [
            "module-one-shot-flag",
            "ui-process",
            "process-lifetime",
            "first-insert",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/v2/components/icon.tsx:spriteInserted",
          [
            "module-one-shot-flag",
            "ui-process",
            "process-lifetime",
            "first-insert",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/components/line-comment-styles.ts:installed",
          [
            "module-one-shot-flag",
            "ui-process",
            "process-lifetime",
            "first-install",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/components/markdown.tsx:cache",
          [
            "module-lru-cache",
            "per-content-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/components/message-part.tsx:PART_MAPPING",
          [
            "module-registration-map",
            "source-module",
            "registration-time-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/ui/src/components/message-part.tsx:state",
          [
            "module-singleton-state",
            "ui-process",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/components/session-diff.ts:patchFileDiffCache",
          [
            "module-lru-cache",
            "per-diff-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/components/timeline-playground.stories.tsx:seq",
          [
            "storybook-counter",
            "story-invocation",
            "story-lifetime",
            "story-return",
            "ephemeral-ui",
            "dev-only",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/pierre/file-find.ts:current",
          [
            "module-singleton-state",
            "ui-process",
            "widget-lifetime",
            "widget-close",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/pierre/file-find.ts:hosts",
          [
            "module-host-registry",
            "per-host-key",
            "process-lifetime",
            "host-unregister",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/pierre/file-find.ts:installed",
          [
            "module-one-shot-flag",
            "ui-process",
            "process-lifetime",
            "first-install",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/pierre/file-find.ts:target",
          [
            "module-singleton-state",
            "ui-process",
            "widget-lifetime",
            "widget-close",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/pierre/virtualizer.ts:cache",
          [
            "module-lru-cache",
            "per-element-key",
            "process-lifetime",
            "lru-eviction",
            "memoization-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/pierre/worker.ts:split",
          [
            "module-lazy-singleton",
            "ui-process",
            "worker-lifetime",
            "worker-terminate",
            "coordination-only",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/ui/src/pierre/worker.ts:unified",
          [
            "module-lazy-singleton",
            "ui-process",
            "worker-lifetime",
            "worker-terminate",
            "coordination-only",
            "product-ui",
            "safe_scoped",
          ],
        ],
        [
          "packages/ui/src/theme/context.tsx:files",
          [
            "module-theme-file-map",
            "per-theme-key",
            "process-lifetime",
            "theme-remove",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/theme/context.tsx:ids",
          [
            "module-id-map",
            "per-theme-key",
            "process-lifetime",
            "theme-remove",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/theme/context.tsx:known",
          [
            "module-known-set",
            "per-theme-key",
            "process-lifetime",
            "theme-remove",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        [
          "packages/ui/src/theme/loader.ts:activeTheme",
          [
            "module-singleton-state",
            "ui-process",
            "process-lifetime",
            "theme-change",
            "coordination-only",
            "product-ui",
            "safe_bounded",
          ],
        ],
        // ---- desktop/src: Electron main/preload/renderer singletons (W5 family) ----
        [
          "packages/desktop/src/main/windows.ts:relaunchHandler",
          [
            "electron-main-singleton",
            "main-process",
            "process-lifetime",
            "app-quit",
            "coordination-only",
            "desktop-main",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/main/windows.ts:titlebarThemes",
          [
            "electron-main-singleton",
            "main-process",
            "process-lifetime",
            "app-quit",
            "coordination-only",
            "desktop-main",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/preload/index.ts:updaterCallbacks",
          [
            "preload-singleton",
            "preload-lifetime",
            "window-lifetime",
            "window-close",
            "coordination-only",
            "desktop-preload",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/preload/index.ts:updaterState",
          [
            "preload-singleton",
            "preload-lifetime",
            "window-lifetime",
            "window-close",
            "coordination-only",
            "desktop-preload",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/preload/index.ts:updaterSubscription",
          [
            "preload-singleton",
            "preload-lifetime",
            "window-lifetime",
            "window-close",
            "coordination-only",
            "desktop-preload",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/renderer/i18n/index.ts:state",
          [
            "renderer-singleton",
            "renderer-process",
            "process-lifetime",
            "window-close",
            "coordination-only",
            "desktop-renderer",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/renderer/index.tsx:menuTrigger",
          [
            "renderer-singleton",
            "renderer-process",
            "process-lifetime",
            "window-close",
            "coordination-only",
            "desktop-renderer",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/renderer/index.tsx:rendererReadyLogged",
          [
            "renderer-one-shot-flag",
            "renderer-process",
            "process-lifetime",
            "first-fire",
            "coordination-only",
            "desktop-renderer",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/renderer/webview-zoom.ts:pinchZoomEnabled",
          [
            "renderer-singleton",
            "renderer-process",
            "process-lifetime",
            "window-close",
            "coordination-only",
            "desktop-renderer",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/renderer/webview-zoom.ts:requestedZoom",
          [
            "renderer-singleton",
            "renderer-process",
            "process-lifetime",
            "window-close",
            "coordination-only",
            "desktop-renderer",
            "safe_bounded",
          ],
        ],
        [
          "packages/desktop/src/renderer/webview-zoom.ts:wheelPinch",
          [
            "renderer-singleton",
            "renderer-process",
            "process-lifetime",
            "window-close",
            "coordination-only",
            "desktop-renderer",
            "safe_bounded",
          ],
        ],
        // ---- http-recorder / sdk / llm ----
        [
          "packages/http-recorder/src/cassette.ts:closure@148:149.stored",
          [
            "cassette-instance",
            "per-cassette",
            "cassette-lifetime",
            "cassette-flush",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/http-recorder/src/cassette.ts:closure@148:152.accumulatedFindings",
          [
            "cassette-instance",
            "per-cassette",
            "cassette-lifetime",
            "cassette-flush",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/http-recorder/src/cassette.ts:closure@148:153.appendLock",
          [
            "cassette-instance",
            "per-cassette",
            "append-duration",
            "release-on-append",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/http-recorder/src/cassette.ts:closure@77:80.recorded",
          [
            "recorder-instance",
            "per-recorder",
            "recorder-lifetime",
            "recorder-dispose",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/llm/src/route/executor.ts:secretValues@231:232.values",
          [
            "executor-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/sdk/js/src/client.ts:createDeepAgentCodeClient@58:85.client",
          [
            "factory-invocation",
            "single-call",
            "client-lifetime",
            "caller-close",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/sdk/js/src/index.ts:createDeepAgentCode@8:13.client",
          [
            "factory-invocation",
            "single-call",
            "client-lifetime",
            "caller-close",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/sdk/js/src/index.ts:createDeepAgentCode@8:9.server",
          [
            "factory-invocation",
            "single-call",
            "server-handle-lifetime",
            "caller-close",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // ===========================================================================
  // RI-94 ZERO WAVE deepagent-code/src (2026-09-11). Most keys are line-shifted re-numberings of
  // families already adjudicated in W1-W5 (the facts are re-asserted against current source);
  // the rest are per-cluster lifecycle facts verified below.
  // ===========================================================================
  ...Object.fromEntries(
    (
      [
        // SessionPrompt layer-instance worker registries (W-family re-pins after line shifts):
        // session-or-directory keyed, settle-cleanup, coordination-only.
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1181:1367.activeFederatedContexts",
          [
            "SessionPrompt.layer-instance",
            "per-session-or-directory",
            "active-sessions-and-directories",
            "settle-cleanup-or-layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1181:1371.steerAbsorbRounds",
          [
            "SessionPrompt.layer-instance",
            "per-session-or-directory",
            "active-sessions-and-directories",
            "settle-cleanup-or-layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1181:1372.activeReleasedKnowledge",
          [
            "SessionPrompt.layer-instance",
            "per-session-or-directory",
            "active-sessions-and-directories",
            "settle-cleanup-or-layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1181:7007.notificationWorkers",
          [
            "SessionPrompt.layer-instance",
            "per-session-or-directory",
            "active-sessions-and-directories",
            "settle-cleanup-or-layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1181:7070.durableWorkers",
          [
            "SessionPrompt.layer-instance",
            "per-session-or-directory",
            "active-sessions-and-directories",
            "settle-cleanup-or-layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1181:7071.durableLeases",
          [
            "SessionPrompt.layer-instance",
            "per-session-or-directory",
            "active-sessions-and-directories",
            "settle-cleanup-or-layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1431:1433.seen",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1468:1475.seen",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1606:1674.taskAbort",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@3492:3618.accumulatedChangeSurface",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:execRead@2493:2494.controller",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // snapshot/compaction/revert/session families: per-invocation maps and per-session keyed
        // mutexes released at settle.
        [
          "packages/deepagent-code/src/session/snapshot.ts:closure@136:149.messageMap",
          [
            "snapshot-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/snapshot.ts:closure@136:150.partMap",
          [
            "snapshot-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/snapshot.ts:closure@136:151.activityMap",
          [
            "snapshot-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/snapshot.ts:closure@136:186.progressByActivity",
          [
            "snapshot-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/snapshot/index.ts:closure@910:918.reasons",
          [
            "snapshot-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/compaction.ts:closure@498:516.activeCompactions",
          [
            "SessionCompaction.layer-instance",
            "per-session",
            "active-sessions",
            "settle-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/revert.ts:closure@55:106.files",
          [
            "revert-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/revert.ts:mutationLocks",
          [
            "module-keyed-mutex",
            "per-session-key",
            "lock-hold-duration",
            "release-on-settle",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/session/session.ts:closure@3165:3166.updated",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/session.ts:forkLocks",
          [
            "module-keyed-mutex",
            "per-session-key",
            "lock-hold-duration",
            "release-on-fork-delivery",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/session/session-completed-publisher.ts:closure@114:130.pending",
          [
            "publisher-layer-instance",
            "per-session",
            "active-sessions",
            "publish-or-fail-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/session/run-state.ts:closure@202:207.pending",
          [
            "RunState.layer-instance",
            "per-session",
            "active-sessions",
            "settle-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/session/run-state.ts:closure@202:208.cancelled",
          [
            "RunState.layer-instance",
            "per-session",
            "active-sessions",
            "settle-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/run-state.ts:closure@58:60.runners",
          [
            "RunState.layer-instance",
            "per-session",
            "active-sessions",
            "run-completion-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/message-v2.ts:hydrate@375:377.partByMessage",
          [
            "hydrate-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/message-v2.ts:hydrate@375:378.progressByMessage",
          [
            "hydrate-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/diff-artifact.ts:isBusySnapshot@165:166.seen",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/context-ledger.ts:closure@181:187.forkStore",
          [
            "context-ledger-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/agent-push.ts:closure@126:137.roots",
          [
            "agent-push-layer-instance",
            "per-root",
            "active-push-roots",
            "push-completion-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/multi-agent-runtime.ts:ancestorsOf@357:358.acc",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/multi-agent-runtime.ts:closure@187:206.tokenUsage",
          [
            "runtime-instance",
            "per-session",
            "active-sessions",
            "settle-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/processor.ts:DegenerationDetector.prevNgramSet@412",
          [
            "detector-instance",
            "per-session-detector",
            "detector-lifetime",
            "detector-owner",
            "coordination-only",
            "per-turn",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/session/deepagent-multiround.ts:StopHook",
          [
            "module-hook-object",
            "source-module",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/session/tools.ts:PlanHook",
          [
            "module-hook-object",
            "source-module",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/session/v2-plan-gate.ts:planHook",
          [
            "module-hook-object",
            "source-module",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        // provider discovery caches (W-family re-pins): process-bounded failure memoization and
        // discovered-provider registries refreshed per discovery pass.
        [
          "packages/deepagent-code/src/provider/provider.ts:closure@1301:1441.failedDiscoveryProviders",
          [
            "Provider-layer-instance",
            "per-discovery-pass",
            "runtime-lifetime",
            "layer-finalizer",
            "memoization-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/provider/provider.ts:closure@1301:1442.failedDiscoveryGroups",
          [
            "Provider-layer-instance",
            "per-discovery-pass",
            "runtime-lifetime",
            "layer-finalizer",
            "memoization-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/provider/provider.ts:closure@1301:1445.discoveryProviders",
          [
            "Provider-layer-instance",
            "per-discovery-pass",
            "runtime-lifetime",
            "layer-finalizer",
            "memoization-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/provider/provider.ts:closure@1301:1449.legacyDiscoveryProviders",
          [
            "Provider-layer-instance",
            "per-discovery-pass",
            "runtime-lifetime",
            "layer-finalizer",
            "memoization-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/provider/provider.ts:timeoutController@116:117.ctl",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "abort-on-completion",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // keyed locks across the tool/task/orchestration family: released at settle; overlays
        // bounded by fanout ceilings.
        [
          "packages/deepagent-code/src/agent/pr-collaboration.ts:mergeLocks",
          [
            "module-keyed-mutex",
            "per-session-key",
            "lock-hold-duration",
            "release-on-merge",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/agent/pr-collaboration.ts:sessionBranchLocks",
          [
            "module-keyed-mutex",
            "per-session-key",
            "lock-hold-duration",
            "release-on-merge",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/session/v4-pr-collaboration.ts:parentLocks",
          [
            "module-keyed-mutex",
            "per-session-key",
            "lock-hold-duration",
            "release-on-merge",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/apply_patch_chunk.ts:closure@39:42.transactions",
          [
            "ApplyPatchChunkTool.layer-instance",
            "per-session",
            "8-transactions-per-session-plus-30min-ttl-sweep",
            "commit-or-abort-delete-plus-ttl-sweep-on-call",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/apply_patch_chunk.ts:encoder",
          [
            "source-module",
            "source-symbol",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/code_intel.ts:closure@477:479.visited",
          [
            "invocation-scope",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/internal.ts:tools",
          [
            "module-registration-map",
            "source-module",
            "registration-time-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/provenance.ts:store",
          [
            "module-WeakMap",
            "per-tool-object",
            "tool-object-lifetime",
            "gc-with-tool-object",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/semantic-fingerprint.ts:resolvers",
          [
            "module-registry-map",
            "source-module",
            "registration-time-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/semantic-fingerprint.ts:resultResolvers",
          [
            "module-registry-map",
            "source-module",
            "registration-time-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/tool/shell.ts:parser",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        // process-level singletons and lazy bootstraps (RI-106 one-root discipline).
        [
          "packages/deepagent-code/src/effect/app-runtime.ts:rootDatabasePath",
          [
            "AppRuntime-root-build",
            "per-root-build",
            "root-lifetime",
            "root-dispose",
            "coordination-only",
            "process-singleton",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/effect/app-runtime.ts:rt",
          [
            "AppRuntime-root-build",
            "per-root-build",
            "root-lifetime",
            "root-dispose",
            "coordination-only",
            "process-singleton",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/effect/instance-registry.ts:stateDisposers",
          [
            "module-WeakMap",
            "per-instance-context",
            "instance-lifetime",
            "gc-with-context",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/bus/global.ts:GlobalBus",
          [
            "process-event-bus",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/id/id.ts:counter",
          [
            "module-counter",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/id/id.ts:lastTimestamp",
          [
            "module-counter",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/shell/shell.ts:defaultAcceptable",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/shell/shell.ts:defaultPreferred",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/server/shared/ui.ts:UI_UPSTREAM_HOST",
          [
            "env-derived-const",
            "source-module",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/server/shared/ui.ts:embeddedUIPromise",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/profile.ts:closure@79:81.runStore",
          [
            "profile-handler-layer-instance",
            "per-run",
            "active-runs",
            "run-terminal-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/server/routes/instance/httpapi/lifecycle.ts:disposeAfterResponse",
          [
            "module-flag",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/server/routes/instance/httpapi/websocket-tracker.ts:closure@21:22.sockets",
          [
            "tracker-layer-instance",
            "per-socket",
            "active-websockets",
            "socket-close-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        // permission/question pending queues: resolved or interrupted within session scope.
        [
          "packages/deepagent-code/src/permission/index.ts:closure@136:143.withPermissionOwner",
          [
            "Permission-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/permission/index.ts:closure@136:190.allPending",
          [
            "Permission-layer-instance",
            "per-ask",
            "active-asks",
            "resolve-or-interrupt-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/question/index.ts:closure@141:143.allPending",
          [
            "Question-layer-instance",
            "per-ask",
            "active-asks",
            "resolve-or-interrupt-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        // instance store / workspace / artifact-service / location-index: per-instance caches with
        // dispose-driven eviction (the instance registry owns the lifetime).
        [
          "packages/deepagent-code/src/project/instance-store.ts:closure@42:47.cache",
          [
            "InstanceStore-layer-instance",
            "per-directory-instance",
            "instance-lifetime",
            "registry-dispose-eviction",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/control-plane/workspace.ts:closure@207:215.connections",
          [
            "workspace-layer-instance",
            "per-connection",
            "active-connections",
            "connection-close-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/control-plane/workspace.ts:closure@926:927.names",
          [
            "workspace-layer-instance",
            "per-workspace",
            "workspace-lifetime",
            "workspace-dispose",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/context-federation/artifact-service.ts:closure@23:27.stores",
          [
            "artifact-service-instance",
            "per-store",
            "service-lifetime",
            "service-dispose",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/context-federation/artifact-service.ts:closure@23:28.storeBuild",
          [
            "artifact-service-instance",
            "per-store",
            "service-lifetime",
            "service-dispose",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/location-index/runtime.ts:closure@33:40.indexBuild",
          [
            "LocationIndexRuntime-instance",
            "per-instance",
            "instance-lifetime",
            "instance-dispose",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/location-index/watcher-consumer.ts:closure@19:21.scheduled",
          [
            "watcher-consumer-instance",
            "per-directory",
            "watch-lifetime",
            "watch-close",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // TS workspace adapter symbol index: per-indexWorkspace invocation.
        [
          "packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:indexWorkspace@17:29.byPath",
          [
            "indexWorkspace-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:indexWorkspace@17:30.records",
          [
            "indexWorkspace-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:indexWorkspace@17:61.externalEntities",
          [
            "indexWorkspace-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:collectSymbols@161:163.overloads",
          [
            "collectSymbols-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/code-intelligence/editor-buffer-snapshot.ts:layer@43:44.snapshots",
          [
            "editor-snapshot-layer-instance",
            "per-document",
            "layer-lifetime",
            "layer-finalizer",
            "memoization-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // debug client + rpc: per-connection pending maps, closed with the socket.
        [
          "packages/deepagent-code/src/debug/client.ts:create@52:90.pending",
          [
            "debug-client-connection",
            "per-connection",
            "connection-lifetime",
            "connection-close",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/debug/client.ts:create@52:91.eventHandlers",
          [
            "debug-client-connection",
            "per-connection",
            "connection-lifetime",
            "connection-close",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/util/rpc.ts:client@61:62.pending",
          [
            "rpc-client-connection",
            "per-connection",
            "configured-maxPending;default128;request-and-ready-default30000ms",
            "settle-or-timeout-deletes;close-rejects-clears-and-cancels-ready-timer",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/util/rpc.ts:client@61:70.listeners",
          [
            "rpc-client-connection",
            "per-connection",
            "configured-maxListeners;default128;one-ready-promise-per-client",
            "unsubscribe-deletes;close-clears/restores-original-handler;worker-error/exit-closes",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // config/runtime singletons: lazy one-shot bootstraps.
        [
          "packages/deepagent-code/src/config/config.ts:closure@643:648.consoleManagedProviders",
          [
            "Config-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/config/tui.ts:runPromise",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/installation/index.ts:runPromise",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/runtime/base.ts:closure@181:185.approvals",
          [
            "RuntimeBase-instance",
            "per-approval",
            "instance-lifetime",
            "approval-resolution-cleanup",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/deepagent/learning-runtime.ts:closure@34:35.factories",
          [
            "learning-runtime-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // CLI run-mode surfaces: per-command-invocation trees, TUI worker singleton, otel/heap
        // one-shot bootstraps, splash/scrollback render state.
        [
          "packages/deepagent-code/src/cli/cmd/run/noninteractive.ts:createBackgroundSessions@57:58.sessions",
          [
            "run-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/noninteractive.ts:createBackgroundSessions@57:59.settled",
          [
            "run-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/noninteractive.ts:createSessionTree@6:7.owned",
          [
            "run-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/otel.ts:ready",
          [
            "otel-bootstrap",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/otel.ts:runtime",
          [
            "otel-bootstrap",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/runtime.boot.ts:runtime",
          [
            "run-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/runtime.ts:closure@916:917.sdk",
          [
            "run-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/scrollback.surface.ts:RunScrollbackStream.pendingThemes@96",
          [
            "render-surface-instance",
            "per-render",
            "surface-lifetime",
            "surface-dispose",
            "coordination-only",
            "run-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/scrollback.surface.ts:nextId",
          [
            "module-counter",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/session-data.ts:money",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/splash.ts:id",
          [
            "module-counter",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@1208:1233.turn",
          [
            "transport-invocation",
            "per-turn",
            "turn-lifetime",
            "turn-completion",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@399:463.replayedParts",
          [
            "transport-invocation",
            "per-turn",
            "turn-lifetime",
            "turn-completion",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@399:464.recovering",
          [
            "transport-invocation",
            "per-turn",
            "turn-lifetime",
            "turn-completion",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:createSessionTransport@1482:1483.runtime",
          [
            "transport-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:createSessionTransport@1482:1486.activeTurns",
          [
            "transport-invocation",
            "per-session",
            "active-turns",
            "turn-completion-cleanup",
            "coordination-only",
            "run-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/trace.ts:state",
          [
            "trace-bootstrap",
            "process-global",
            "process-lifetime",
            "process-exit",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/variant.shared.ts:createVariantRuntime@200:201.runtime",
          [
            "run-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/run/variant.shared.ts:runtime",
          [
            "run-invocation",
            "per-run-invocation",
            "run-lifetime",
            "run-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/cmd/tui.ts:closure@114:141.worker",
          [
            "tui-command-invocation",
            "per-tui-invocation",
            "tui-lifetime",
            "tui-exit",
            "coordination-only",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/heap.ts:armed",
          [
            "one-shot-timer-guard",
            "process-global",
            "process-lifetime",
            "timer-fire",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/heap.ts:lock",
          [
            "one-shot-timer-guard",
            "process-global",
            "process-lifetime",
            "timer-fire",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/heap.ts:timer",
          [
            "one-shot-timer-guard",
            "process-global",
            "process-lifetime",
            "timer-fire",
            "coordination-only",
            "process-global",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/tui/worker.ts:server",
          [
            "tui-worker-singleton",
            "process-global",
            "worker-lifetime",
            "worker-exit",
            "coordination-only",
            "process-global",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/cli/ui.ts:blank",
          [
            "render-state",
            "per-render",
            "render-lifetime",
            "render-return",
            "ephemeral-runtime",
            "run-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/deepagent-code/src/control-plane/dev/debug-workspace-plugin.ts:PORT",
          [
            "env-derived-const",
            "source-module",
            "source-bounded",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/lsp/server.ts:roslynLanguageServerInstall",
          [
            "lazy-memoization",
            "source-module",
            "first-use-initialized",
            "not-applicable",
            "non-authority",
            "package-static",
            "safe_static",
          ],
        ],
        [
          "packages/deepagent-code/src/import/source/codex.ts:AssistantTurnBlocks.blocks@233",
          [
            "parser-instance",
            "per-parse",
            "parse-lifetime",
            "parse-return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/wiki/session-archive.ts:persistArchiveDoc@239:242.store",
          [
            "persistArchiveDoc-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // ===========================================================================
  // RI-94 ZERO WAVE core/src (2026-09-11): per-closure lifecycle facts verified in source.
  // All are per-layer/per-service-instance coordination state bounded by their owner's scope.
  // ===========================================================================
  ...Object.fromEntries(
    (
      [
        // The knowledge seed is constructed once per storage-runtime invocation.
        [
          "packages/core/src/agent-gateway.ts:createStorageRuntime@529:541.seed",
          [
            "original storage runtime",
            "captured canonical storage root",
            "one seeded flag and at most one active seed promise",
            "active promise finally clears; runtime owner exit releases closure",
            "coordination-only; durable seeded knowledge remains in original store",
            "original runtime or V1 compatibility storage owner",
            "safe_scoped",
          ],
        ],
        // cross-spawn-spawner: in-flight child process registries drained by wait semantics.
        [
          "packages/core/src/cross-spawn-spawner.ts:closure@168:180.ins",
          [
            "spawner-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/cross-spawn-spawner.ts:closure@168:181.outs",
          [
            "spawner-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // migration journal: completed-id set captured per migration run.
        [
          "packages/core/src/database/migration.ts:closure@181:189.completed",
          [
            "migration-run",
            "single-run",
            "run-lifetime",
            "run-return",
            "durable-journal-backed",
            "run-scoped",
            "safe_scoped",
          ],
        ],
        // event-bus consumer groups + db cache: per bus instance; groups refcounted on unsubscribe.
        [
          "packages/core/src/deepagent/deepagent-event-bus.ts:closure@269:291.groups",
          [
            "event-bus-instance",
            "per-bus",
            "bus-lifetime",
            "bus-dispose",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/deepagent/deepagent-event-bus.ts:closure@269:326.dbGroupsCache",
          [
            "event-bus-instance",
            "per-bus",
            "bus-lifetime",
            "bus-dispose",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/deepagent/domain-pack-registry.ts:discover@174:175.seen",
          [
            "discover-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/deepagent/event-registry.ts:createEventRegistry@116:117.map",
          [
            "createEventRegistry-invocation",
            "per-registry",
            "registry-lifetime",
            "registry-owner-dispose",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/deepagent/hooks.ts:HookPolicy.handlers@20",
          [
            "HookPolicy-instance",
            "per-policy",
            "policy-lifetime",
            "policy-owner",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/deepagent/rate-limiter.ts:Service.buckets@24",
          [
            "RateLimiter-instance",
            "per-limiter",
            "limiter-lifetime",
            "limiter-owner",
            "coordination-only",
            "bounded-max-live-buckets",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/deepagent/workspace-concurrency.ts:closure@53:57.inFlight",
          [
            "workspace-concurrency-instance",
            "per-instance",
            "instance-lifetime",
            "instance-owner",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/file-lock.ts:closure@44:46.locks",
          [
            "FileLock-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/file-lock.ts:closure@44:48.byId",
          [
            "FileLock-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/flag/runtime-features.ts:createRuntimeFeatureRegistry@110:114.features",
          [
            "createRuntimeFeatureRegistry-invocation",
            "per-registry",
            "registry-lifetime",
            "registry-owner",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/flag/runtime-features.ts:RuntimeFeatures",
          [
            "RuntimeFeatures-registry",
            "per-registry",
            "registry-lifetime",
            "registry-owner",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        // permission ask queue: pending asks resolved or interrupted within their session scope.
        [
          "packages/core/src/permission.ts:closure@197:205.withNoProgressOwner",
          [
            "PermissionV2-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/permission.ts:closure@197:206.pending",
          [
            "PermissionV2-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "session-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/pty.ts:closure@142:147.sessions",
          [
            "Pty-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/question.ts:closure@131:133.pending",
          [
            "QuestionV2-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "session-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/session/execution/local.ts:closure@18:26.ownedClaims",
          [
            "SessionExecutionLocal-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/session/run-coordinator.ts:closure@81:82.active",
          [
            "SessionRunCoordinator-instance",
            "per-coordinator",
            "scope-lifetime",
            "addFinalizer-clear",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/session/runner/publish-llm-event.ts:createLLMEventPublisher@73:74.tools",
          [
            "createLLMEventPublisher-invocation",
            "per-publisher",
            "publisher-lifetime",
            "publisher-owner",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/session/runner/publish-llm-event.ts:fragments@105:109.chunks",
          [
            "fragments-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/session/runner/recovery.ts:closure@1465:1466.store",
          [
            "recovery-module-instance",
            "per-instance",
            "instance-lifetime",
            "instance-owner",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/skill.ts:closure@90:142.cache",
          [
            "SkillV2-layer-instance",
            "per-layer",
            "layer-lifetime",
            "layer-finalizer",
            "memoization-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/state.ts:create@55:58.semaphore",
          [
            "create-invocation",
            "single-call",
            "owner-lifetime",
            "owner-release",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/system-context/capability-loader-memory.ts:receiptStore",
          [
            "capability-loader-memory-instance",
            "per-instance",
            "instance-lifetime",
            "instance-owner",
            "memoization-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/system-context/capability-loader-memory.ts:turnBudgets",
          [
            "capability-loader-memory-instance",
            "per-instance",
            "instance-lifetime",
            "instance-owner",
            "coordination-only",
            "per-turn",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/tool/application-tools.ts:closure@26:27.registered",
          [
            "ApplicationTools-layer-instance",
            "per-layer",
            "layer-lifetime",
            "scope-finalizer-tokens",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/tool/registry.ts:closure@163:164.registrations",
          [
            "ToolRegistry-layer-instance",
            "per-layer",
            "layer-lifetime",
            "scope-finalizer-tokens",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/tool/registry.ts:closure@63:67.local",
          [
            "ToolRegistry-layer-instance",
            "per-layer",
            "layer-lifetime",
            "scope-finalizer-tokens",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // ===========================================================================
  // RI-26 W3/W4 (2026-09-10): tool-factory and bridge adjudications.
  // ===========================================================================
  // Per-tool-object definition caches (one Map per frozen tool value, keyed by registration name,
  // 1-2 entries max, dies with the tool object): memoization only, never authority.
  "packages/core/src/tool/tool.ts:make@63:67.definitions": {
    owner: "Tool.make-invocation",
    keyScope: "per-tool-object",
    bound: "tool-object-lifetime",
    finalizer: "gc-with-tool-object",
    durability: "memoization-only",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
  "packages/core/src/tool/tool.ts:makeDynamic@136:138.definitions": {
    owner: "Tool.makeDynamic-invocation",
    keyScope: "per-tool-object",
    bound: "tool-object-lifetime",
    finalizer: "gc-with-tool-object",
    durability: "memoization-only",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
  // ===========================================================================
  // RI-26 W2 (2026-09-10): Core tool-port adjudications.
  // ===========================================================================
  // apply_patch_chunk transaction map: per-layer-instance, session-keyed, count-bounded (8 per
  // session), TTL-swept (30 min) on every call; commit/abort delete explicitly. Coordination-only
  // staging of not-yet-applied patch text — the durable authority stays in the apply pipeline.
  "packages/core/src/tool/apply-patch-chunk.ts:closure@56:65.transactions": {
    owner: "ApplyPatchChunkTool.layer-instance",
    keyScope: "per-session",
    bound: "8-transactions-per-session-plus-30min-ttl-sweep",
    finalizer: "commit-or-abort-delete-plus-ttl-sweep-on-call",
    durability: "coordination-only",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
  // Shared module TextEncoder: an immutable encoding utility (stateless per spec); never mutated.
  "packages/core/src/tool/apply-patch-chunk.ts:encoder": {
    owner: "source-module",
    keyScope: "source-symbol",
    bound: "source-bounded",
    finalizer: "not-applicable",
    durability: "non-authority",
    reachability: "package-static",
    verdict: "safe_static",
  },
  // ===========================================================================
  // RI-94 W3 (2026-09-10): per-family adjudications. Each entry names the real lifecycle owner
  // and finalizer verified in current source; none of these is durable authority.
  // ===========================================================================
  // ===========================================================================
  // RI-94 W4 (2026-09-10): per-family adjudications for the long tail.
  // ===========================================================================
  // Lazy OpenAPI /doc response (deepagent-code routes): computed once on first request, reused
  // read-only thereafter; process-static memoization, no authority.
  "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts:docResponse": {
    owner: "source-module",
    keyScope: "source-symbol",
    bound: "source-bounded",
    finalizer: "not-applicable",
    durability: "memoization-only",
    reachability: "package-static",
    verdict: "safe_static",
  },
  // zodMetadataRegistry traversal cycle-guard: a WeakSet scoped to one invocation's walk.
  "packages/deepagent-code/src/tool/registry.ts:zodMetadataRegistry@662:664.seen": {
    owner: "invocation-scope",
    keyScope: "single-call",
    bound: "call-stack",
    finalizer: "return",
    durability: "ephemeral-runtime",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
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
      "packages/deepagent-code/src/cli/cmd/run.ts:closure@279:1246.sdk",
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
      "packages/deepagent-code/src/acp/service.ts:make@80:90.registeredMcp",
      "packages/deepagent-code/src/acp/service.ts:make@80:91.sessionSnapshots",
      "packages/deepagent-code/src/acp/service.ts:make@80:92.forkIntents",
      "packages/deepagent-code/src/acp/service.ts:makeUsageService@612:613.limits",
      "packages/deepagent-code/src/acp/service.ts:registerMcpServers@934:944.pending",
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
      "packages/deepagent-code/src/server/server.ts:closure@193:209.scope",
      "packages/deepagent-code/src/server/server.ts:closure@193:235.maintenanceScope",
      "packages/deepagent-code/src/server/server.ts:serverLayer@431:432.server",
      "packages/deepagent-code/src/server/server.ts:serverLayer@431:434.upgradedSockets",
      "packages/deepagent-code/src/server/server.ts:serverLayer@431:435.activeSockets",
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
  "packages/core/src/auth.ts:closure@133:187.state": {
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
  // JuggleIM B1 kernel client (2026-10-05): liveInstances is the process-singleton guard counter for
  // the websdk live layer (the SDK's dedup watermark is bundle-global) — 0|1, incremented at layer
  // build and decremented by the layer finalizer (kernel/sdk.ts). The two FetchXHR entries are
  // per-request browser-shim state (kernel/shims.ts): upload is the SDK-visible progress stub on the
  // XHR instance; controller is the per-send AbortController, settled/aborted with the request.
  "packages/deepagent-code/src/im/kernel/sdk.ts:liveInstances": {
    owner: "KernelSdk.live-layer-guard",
    keyScope: "process",
    bound: "max-one-live-instance",
    finalizer: "layer-finalizer-decrement",
    durability: "singleton-guard-only",
    reachability: "im-kernel",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/im/kernel/shims.ts:FetchXHR.upload@64": {
    owner: "FetchXHR.instance",
    keyScope: "per-request",
    bound: "request-lifetime",
    finalizer: "request-settle-gc",
    durability: "browser-shim-only",
    reachability: "im-kernel",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/im/kernel/shims.ts:send@83:84.controller": {
    owner: "FetchXHR.send-invocation",
    keyScope: "single-call",
    bound: "request-duration",
    finalizer: "request-settle-or-abort",
    durability: "browser-shim-only",
    reachability: "im-kernel",
    verdict: "safe_scoped",
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
  "packages/deepagent-code/src/config/config.ts:attach@1038:1077.observed": {
    owner: "Config.watch-directory-subscription",
    keyScope: "watched-config-or-plugin-filename",
    bound: "config-names-plus-directory-plugin-file-count",
    finalizer: "watch-close-or-directory-rebind-gc",
    durability: "file-fingerprint-cache-only",
    reachability: "config-hot-refresh",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/config/config.ts:closure@1001:1024.watchers": {
    owner: "Config.watch-invocation",
    keyScope: "watched-target-directory",
    bound: "configured-target-directory-count",
    finalizer: "watch-stop-closes-and-clears-all",
    durability: "fs-watch-handles-only",
    reachability: "config-hot-refresh",
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
  "packages/deepagent-code/src/mcp/secret-store.ts:inMemoryBackend@108:109.map": {
    owner: "SecretStore.test-layer",
    keyScope: "secret-key",
    bound: "test-secret-count",
    finalizer: "process-exit",
    durability: "test-only-backend",
    reachability: "test-harness",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/session/llm.ts:closure@1079:1105.validatedCallIDs": {
    owner: "LLM.stream-call",
    keyScope: "provider-turn",
    bound: "turn-tool-call-count",
    finalizer: "call-return-gc",
    durability: "turn-validation-only",
    reachability: "v2-llm-stream",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/session/llm.ts:closure@1079:1147.aiSdkCallIDs": {
    owner: "LLM.stream-call",
    keyScope: "provider-turn",
    bound: "turn-tool-call-count",
    finalizer: "call-return-gc",
    durability: "turn-validation-only",
    reachability: "v2-llm-stream",
    verdict: "safe_scoped",
  },
  "packages/deepagent-code/src/session/llm.ts:closure@1079:1148.validatedCallIDs": {
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
  // ===========================================================================
  // RI-94 WAVE-3 J6 ADJUDICATION (2026-09-19). Two groups: (a) re-pins of families already
  // adjudicated in the 2026-09-11 zero waves whose keys shifted in the wave-3 root-graph merge
  // (facts re-asserted against current source); (b) first-time adjudications of the observability,
  // admission, and memoization families. Every row's owner/bound/finalizer was verified at the
  // cited lines; none of this state is durable authority.
  // ===========================================================================
  // mechanism-beacon (core): stderr-only ablation instrumentation. counts/details are keyed by the
  // fixed mechanism-id literals at the recordEngagement call sites (6 ids: event_admission,
  // learning, im_single_write, context_federation, v2_execution_owner, strict_plan_gate);
  // engagedLogged is hard-capped at MAX_ENGAGE_LOGS=5 (mechanism-beacon.ts:102,121-124). Read only
  // by emitSummaryBeacon (stderr JSON line) and a test accessor.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/deepagent/mechanism-beacon.ts:counts",
          [
            "MechanismBeacon.observability",
            "mechanism-id",
            "fixed-source-call-site-ids",
            "process-exit",
            "stderr-beacon-counter-only",
            "non-authority",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/deepagent/mechanism-beacon.ts:details",
          [
            "MechanismBeacon.observability",
            "mechanism-id",
            "one-detail-string-per-fixed-id",
            "process-exit",
            "stderr-beacon-summary-only",
            "non-authority",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/deepagent/mechanism-beacon.ts:engagedLogged",
          [
            "MechanismBeacon.observability",
            "process",
            "max-5-engage-logs",
            "cap-at-MAX_ENGAGE_LOGS",
            "stderr-emission-counter-only",
            "non-authority",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // turn-observability (core): JSON_LENGTH_CACHE is a WeakMap length memo (gc with the key object);
  // sessions is session-keyed and deleted at drain end — emitTurnSummary deletes on every exit
  // (turn-observability.ts:432,438) via the runner's Effect.ensuring drain finalizer
  // (session/runner/llm.ts:2035-2041). Counters feed stderr summaries and advisory repeat-guard
  // nudges only.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/deepagent/turn-observability.ts:JSON_LENGTH_CACHE",
          [
            "TurnObservability.estimator",
            "per-json-object",
            "weak-key-gc",
            "gc-with-key-object",
            "memoization-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/deepagent/turn-observability.ts:sessions",
          [
            "TurnObservability.per-drain-record",
            "per-session-key",
            "concurrent-sessions",
            "drain-exit-emitTurnSummary-delete",
            "observability-counters-only",
            "session-scoped",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // prompt-policy (core): per-session stage-render dedup marker. forgetSessionStageMarker deletes
  // the slot and is invoked on every drain exit by the same Effect.ensuring finalizer
  // (prompt-policy.ts:206-208, session/runner/llm.ts:2039). A stale marker only repeats or omits
  // advisory teaching prose in the volatile round context.
  "packages/core/src/deepagent/prompt-policy.ts:lastRenderedStageBySession": {
    owner: "PromptPolicy.stage-dedup",
    keyScope: "per-session-key",
    bound: "active-sessions",
    finalizer: "drain-exit-forgetSessionStageMarker",
    durability: "prompt-render-dedup-only",
    reachability: "session-scoped",
    verdict: "safe_bounded",
  },
  // EventV2 registries belong to one layer build. Subscriptions delete on release and their
  // pubsubs shut down in the layer finalizer; projector/codec registrations remain reachable
  // only through that layer and become collectible when its scope closes. Registration is capped
  // at 64 projectors per definition and one codec per codec@schemaVersion key.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/event.ts:closure@617:619.synchronized",
          [
            "EventV2.layer-instance",
            "per-aggregate-subscription",
            "active-aggregate-subscriptions",
            "acquireRelease-delete-plus-layer-finalizer",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/event.ts:closure@617:620.typed",
          [
            "EventV2.layer-instance",
            "per-definition-key",
            "source-definition-keyspace",
            "layer-finalizer-pubsub-shutdown",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/event.ts:closure@617:623.projectors",
          [
            "EventV2.layer-instance",
            "per-definition-key",
            "max-64-projectors-per-key",
            "layer-scope-close-gc",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/event.ts:closure@617:624.snapshotCodecs",
          [
            "EventV2.layer-instance",
            "per-codec-schemaVersion-key",
            "one-codec-per-key",
            "layer-scope-close-gc",
            "codec-registry-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // session/projector.ts wire-egress memos: WIRE_SESSION_MEMO_MAX=2000 (:334,339) and
  // WIRE_CURSOR_MEMO_MAX=10000 (:403,426) with clear-on-full; the cursor memo falls back to the
  // DURABLE session_wire_projection fingerprint row for unknown keys (:418-424), so the durable
  // cursor remains the dedup authority and a cleared memo costs one SELECT.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/session/projector.ts:wireSessionMemo",
          [
            "SessionProjector.wire-egress",
            "per-session-key",
            "max-2000-clear-on-full",
            "clear-on-full-eviction",
            "memoization-only",
            "v2-wire-projection",
            "safe_bounded",
          ],
        ],
        [
          "packages/core/src/session/projector.ts:wireCursorMemo",
          [
            "SessionProjector.wire-egress",
            "per-session-entity-id-key",
            "max-10000-clear-on-full",
            "clear-on-full-eviction",
            "durable-cursor-is-authority-memo-only",
            "v2-wire-projection",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // tool/task-policy.ts: taskSlots is the per-session subagent semaphore pool, refcounted and
  // deleted at zero users. Coordination ceiling only — the fan-out admission ledger became the
  // durable session_v2_task_call_admission table (C-P2-08) and durable task authority is
  // TaskRunAuthority.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/tool/task-policy.ts:taskSlots",
          [
            "TaskPolicy.concurrency-pool",
            "per-session-key",
            "active-sessions-refcount",
            "refcount-zero-delete",
            "mutex-only",
            "v2-task-admission",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // task-run-dispatcher: inFlight is the per-instance claimed-run set — tick only admits
  // (maxConcurrent − active) runs (:86-93) and every driveRun deletes its id via Effect.ensuring
  // (:82); the layer finalizer stops scanning (:64). Durable claim authority is the CAS lease.
  "packages/core/src/session/task-run-dispatcher.ts:closure@51:59.inFlight": {
    owner: "TaskRunDispatcher.instance",
    keyScope: "per-claimed-run-id",
    bound: "maxConcurrent-default-4",
    finalizer: "ensuring-delete-plus-scope-finalizer",
    durability: "coordination-only",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
  // session/runner/llm.ts (re-pin of closure@500 after shift): both bindings live inside the
  // runTurnAttempt invocation (starts :586) — withPublication is the turn's single-permit publish
  // mutex (:1039), planResultMetadata is a per-turn map bounded by the turn's plan tool calls
  // (:1145). Both die with the provider turn.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/session/runner/llm.ts:closure@792:1419.withPublication",
          [
            "SessionRunner.runTurnAttempt-invocation",
            "single-turn",
            "call-stack",
            "return",
            "coordination-only",
            "per-turn",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/session/runner/llm.ts:closure@792:1526.planResultMetadata",
          [
            "SessionRunner.runTurnAttempt-invocation",
            "single-turn",
            "turn-plan-tool-call-count",
            "return",
            "turn-validation-only",
            "per-turn",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // The legacy learning queue constructs a durable knowledge store when each job drains; the
  // worker drops out of the queue after completion. runtimeLayer builds one storage runtime per
  // layer and drains its learning queue on scope close.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/agent-gateway.ts:closure@1132:1140.durable",
          [
            "DeepAgent-learning-job-build",
            "per-queued-job",
            "job-run-lifetime",
            "queue-drain-job-settle-gc",
            "durable-store-backed",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/agent-gateway.ts:closure@3605:3607.storage",
          [
            "DeepAgent-runtime-instance",
            "per-runtime-layer",
            "layer-lifetime",
            "layer-scope-close-and-queue-drain",
            "durable-store-backed",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // sqlite backends: sqlCounts is the DEEPAGENT_CODE_PERF_DEBUG=1 statement histogram, keyed by the
  // 60-char SQL shape and only touched inside the perf-debug timed() guard (sqlite.bun.ts:60-82);
  // the worker backend owns one worker thread per client (terminate in the layer finalizer,
  // sqlite.worker.ts:136-138) whose pending waiters are deleted on reply (:126) and rejected+cleared
  // on worker error (:131-135).
  "packages/core/src/database/sqlite.bun.ts:closure@49:64.sqlCounts": {
    owner: "SqliteBun.client-instance",
    keyScope: "sql-shape-60char",
    bound: "distinct-statement-shapes",
    finalizer: "client-scope-close",
    durability: "perf-debug-histogram-only",
    reachability: "non-production-debug-env",
    verdict: "safe_bounded",
  },
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/database/sqlite.worker.ts:closure@112:120.worker",
          [
            "SqliteWorker.client-instance",
            "per-instance",
            "one-worker-thread",
            "layer-finalizer-terminate",
            "transport-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/core/src/database/sqlite.worker.ts:closure@112:122.pending",
          [
            "SqliteWorker.client-instance",
            "in-flight-message-id",
            "in-flight-statements",
            "reply-delete-plus-error-clear",
            "coordination-only",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // ---- deepagent-code ----
  // learning-runtime: activityStartGit holds the git state an activity started from for the
  // delivery-verdict metadata — MAX_ACTIVITY_START_GIT=64 FIFO ceiling (learning-runtime.ts:43,53-55)
  // plus per-activity delete once the receipt is produced (:389). The reviewer-registry factories
  // map is layer-scoped with per-register finalizer delete plus layer clear (:111-118).
  "packages/deepagent-code/src/deepagent/learning-runtime.ts:activityStartGit": {
    owner: "SessionFinalizer.git-start-state",
    keyScope: "per-activity-key",
    bound: "max-64-fifo-eviction",
    finalizer: "receipt-delete-plus-fifo-eviction",
    durability: "delivery-verdict-metadata-only",
    reachability: "v2-settle-path",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/deepagent/learning-runtime.ts:closure@113:114.factories": {
    owner: "ReviewerRegistry.layer-instance",
    keyScope: "per-symbol-token",
    bound: "registered-factory-count",
    finalizer: "register-finalizer-delete-plus-layer-clear",
    durability: "registry-only",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
  // One AbortController per reviewer execution; Effect.ensuring aborts it when the native stream
  // settles, so neither stream state nor signal survives the call.
  "packages/deepagent-code/src/deepagent/learning-reviewer-runner.ts:closure@88:100.abort": {
    owner: "ReviewerPort.execute-invocation",
    keyScope: "single-call",
    bound: "call-stack",
    finalizer: "ensuring-abort-on-exit",
    durability: "abort-signal-only",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
  // instance-store (re-pin of closure@42 after shift): per-directory instance entries evicted by
  // dispose/reload (instance-store.ts:83-88,118-124) and disposed wholesale by the layer finalizer
  // (:184-212).
  "packages/deepagent-code/src/project/instance-store.ts:closure@41:46.cache": {
    owner: "InstanceStore.layer-instance",
    keyScope: "per-directory-instance",
    bound: "live-instance-directories",
    finalizer: "dispose-eviction-plus-layer-finalizer-disposeAll",
    durability: "coordination-only",
    reachability: "instance-scoped",
    verdict: "safe_bounded",
  },
  // multi-agent-runtime (re-pins after shift): ancestorsOf's acc is a per-call DAG-walk set
  // (:377-391); tokenUsage is the layer's per-agent fallback budget buckets with 1h window-expiry
  // reset (:226-240) — production debits the durable SQLite token ledger instead (:223-225).
  ...Object.fromEntries(
    (
      [
        [
          "packages/deepagent-code/src/session/multi-agent-runtime.ts:ancestorsOf@403:404.acc",
          [
            "ancestorsOf-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/multi-agent-runtime.ts:closure@224:243.tokenUsage",
          [
            "MultiAgentRuntime.layer-instance",
            "per-agent-key",
            "distinct-agent-count",
            "window-expiry-reset",
            "test-fallback-budget-only-durable-ledger-is-authority",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // processor DegenerationDetector (re-pin of @412 after shift): one detector per reasoning stream
  // allocated at reasoning-start (processor.ts:1311) inside the per-create-invocation ctx (:671-699);
  // prevNgramSet holds 4-grams of the 4000-char sliding window (:421-422,450-451) — window-bounded.
  "packages/deepagent-code/src/session/processor.ts:DegenerationDetector.prevNgramSet@442": {
    owner: "DegenerationDetector.instance",
    keyScope: "per-reasoning-stream-detector",
    bound: "window-4000-chars-ngrams",
    finalizer: "stream-end-gc-with-processor-ctx",
    durability: "circuit-breaker-coordination-only",
    reachability: "per-turn",
    verdict: "safe_bounded",
  },
  // SessionPrompt layer maps (re-pins of closure@1180/1181 after shift): activeFederatedContexts
  // and activeReleasedKnowledge are deleted together by settleFederatedActivity, which the runLoop
  // wrapper invokes on EVERY terminal exit via Effect.onExit (prompt.ts:1242-1247,6000-6003,6026-
  // 6034) plus interrupted paths (:3305,6645); steerAbsorbRounds is deleted at the top of every
  // activity run (:3794). Bounded by sessions with an open activity.
  ...Object.fromEntries(
    (
      [
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1044:1228.activeFederatedContexts",
          [
            "SessionPrompt.layer-instance",
            "per-session-key",
            "active-sessions",
            "settle-cleanup-on-every-terminal-exit",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1044:1232.steerAbsorbRounds",
          [
            "SessionPrompt.layer-instance",
            "per-session-key",
            "active-sessions",
            "activity-run-start-delete",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1044:1233.activeReleasedKnowledge",
          [
            "SessionPrompt.layer-instance",
            "per-session-key",
            "active-sessions",
            "settle-cleanup-on-every-terminal-exit",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // SessionPrompt invocation-scope bindings (re-pins after shift): per-call dedup sets
  // (resolveReferenceParts :1282-1284, resolvePromptParts :1319-1326), the per-subtask abort
  // controller (handleSubtask :1457,1524-1530), the macro-round change-surface accumulator
  // (:3342,3465-3468), and execRead's per-read abort controller aborted on interrupt
  // (:2343-2356). All die with their owning call.
  ...Object.fromEntries(
    (
      [
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1282:1284.seen",
          [
            "resolveReferenceParts-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1319:1326.seen",
          [
            "resolvePromptParts-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@1457:1524.taskAbort",
          [
            "handleSubtask-invocation",
            "single-call",
            "call-stack",
            "return",
            "abort-signal-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:closure@3342:3468.accumulatedChangeSurface",
          [
            "deepagent-macro-round-invocation",
            "single-call",
            "files-touched-in-run",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/prompt.ts:execRead@2343:2344.controller",
          [
            "execRead-invocation",
            "single-call",
            "tool-call-duration",
            "abort-on-interrupt",
            "abort-signal-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // run-state (re-pins after shift): runners is the per-session runner-lane map — deleted on runner
  // idle (:82) and cleared by the InstanceState finalizer (:60-68); cancelBackgroundJobs' pending/
  // cancelled sets are per-invocation BFS frontier/dedup (:195-227).
  ...Object.fromEntries(
    (
      [
        [
          "packages/deepagent-code/src/session/run-state.ts:closure@57:59.runners",
          [
            "RunState.instance-state",
            "per-session-key",
            "active-runner-lanes",
            "onIdle-delete-plus-finalizer-clear",
            "coordination-only",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/run-state.ts:closure@195:200.pending",
          [
            "cancelBackgroundJobs-invocation",
            "single-call",
            "background-job-count",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/run-state.ts:closure@195:201.cancelled",
          [
            "cancelBackgroundJobs-invocation",
            "single-call",
            "background-job-count",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // session.ts (re-pins after shift): touch's timestamp is a per-call immutable value (:3168-3169);
  // partOwnershipVerified memoizes the immutable part-ownership check for streamed deltas with a
  // 10_000 clear-on-full ceiling (added in this wave; a cleared key costs one redundant SELECT —
  // the durable row remains the ownership authority).
  ...Object.fromEntries(
    (
      [
        [
          "packages/deepagent-code/src/session/session.ts:closure@3205:3206.updated",
          [
            "Session.touch-invocation",
            "single-call",
            "call-stack",
            "return",
            "ephemeral-runtime",
            "instance-scoped",
            "safe_scoped",
          ],
        ],
        [
          "packages/deepagent-code/src/session/session.ts:closure@882:1252.partOwnershipVerified",
          [
            "Session.layer-instance",
            "per-part-key",
            "max-10000-clear-on-full",
            "clear-on-full-eviction",
            "memoization-only-durable-ownership-is-authority",
            "instance-scoped",
            "safe_bounded",
          ],
        ],
      ] as const
    ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // v2-plugin-tools-bridge: the AbortController is created per plugin tool-call execute
  // (v2-plugin-tools-bridge.ts:63-70); the fiber signal's abort listener fires once and detaches
  // (:75-78,101,111). The instance-scoped registration batch is disposed via
  // InstanceRegistry.registerInstanceStateDisposer closing its Scope (:121-125).
  "packages/deepagent-code/src/session/v2-plugin-tools-bridge.ts:closure@64:70.controller": {
    owner: "PluginToolCall.execute-invocation",
    keyScope: "single-call",
    bound: "tool-call-duration",
    finalizer: "signal-abort-listener-detach",
    durability: "abort-signal-only",
    reachability: "instance-scoped",
    verdict: "safe_scoped",
  },
  // RI-94 2.0.2 follow-up: cache eviction is an optimization (a missed key only retries the
  // registry); the parser and Windows codec handles are singletons with process-lifetime bounds.
  ...Object.fromEntries(
    (
      [
        [
          "packages/core/src/npm.ts:notFound",
          "Npm.module",
          "per-directory-and-package",
          "max-1024",
          "oldest-key-eviction",
          "memoization-only",
          "process-local",
          "safe_bounded",
        ],
        [
          "packages/core/src/shell/scan.ts:parser",
          "ShellScan.module",
          "single-parser-pair",
          "one-lazy-initialization",
          "process-exit",
          "parse-resource-only",
          "process-local",
          "safe_bounded",
        ],
        [
          "packages/deepagent-code/src/mcp/dpapi.bun.ts:crypt32",
          "DPAPI-Bun-module",
          "one-native-library",
          "single-open",
          "process-exit",
          "native-codec-only",
          "process-local",
          "safe_bounded",
        ],
        [
          "packages/deepagent-code/src/mcp/dpapi.bun.ts:kernel32",
          "DPAPI-Bun-module",
          "one-native-library",
          "single-open",
          "process-exit",
          "native-codec-only",
          "process-local",
          "safe_bounded",
        ],
        [
          "packages/deepagent-code/src/mcp/dpapi.node.ts:probed",
          "DPAPI-Node-module",
          "one-probe-promise",
          "single-resolution",
          "process-exit",
          "availability-only",
          "process-local",
          "safe_bounded",
        ],
      ] as const
    ).map(([key, owner, keyScope, bound, finalizer, durability, reachability, verdict]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // MdExport.run's map is reconstructed from the on-disk manifest and dies when the export call
  // settles. PromptV2's dedup sets live inside one resolve call, never in the long-lived layer.
  ...Object.fromEntries(
    (
      [
        [
          "packages/deepagent-code/src/server/md-export.ts:closure@304:308.doneBySession",
          "MdExport.run-invocation",
          "per-export-session",
          "manifest-entry-count",
          "call-return",
          "manifest-is-authority",
          "single-call",
          "safe_scoped",
        ],
        [
          "packages/deepagent-code/src/session/prompt-v2.ts:closure@266:268.seen",
          "resolveReferenceParts-invocation",
          "per-reference-alias",
          "template-reference-count",
          "call-return",
          "dedup-only",
          "single-call",
          "safe_scoped",
        ],
        [
          "packages/deepagent-code/src/session/prompt-v2.ts:closure@303:310.seen",
          "resolvePromptParts-invocation",
          "per-file-reference",
          "template-reference-count",
          "call-return",
          "dedup-only",
          "single-call",
          "safe_scoped",
        ],
        [
          "packages/deepagent-code/src/tool/custom-tool-adapter.ts:closure@28:32.controller",
          "CustomTool.execute-invocation",
          "single-tool-call",
          "tool-call-duration",
          "callback-stop-and-listener-detach",
          "abort-signal-only",
          "single-call",
          "safe_scoped",
        ],
        [
          "packages/deepagent-code/src/tool/custom-tool-rejections.ts:rejected",
          "ApplicationTools-instance",
          "weak-instance-and-plugin-key",
          "live-plugin-instances",
          "instance-disposer-forget",
          "diagnostic-only",
          "instance-scoped",
          "safe_scoped",
        ],
      ] as const
    ).map(([key, owner, keyScope, bound, finalizer, durability, reachability, verdict]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
}

const fileOfKey = (key: string) => key.split(":")[0]!

// Only these 45 already reviewed owners tolerate line-only source movement. New owners remain
// unreviewed, and two candidates sharing a semantic owner reopen review instead of inheriting it.
const reviewedAnchors = new Map(
  [
    "packages/core/src/cross-spawn-spawner.ts:closure@168:180.ins",
    "packages/core/src/cross-spawn-spawner.ts:closure@168:181.outs",
    "packages/core/src/database/migration.ts:closure@181:189.completed",
    "packages/core/src/deepagent/deepagent-event-bus.ts:closure@269:291.groups",
    "packages/core/src/deepagent/deepagent-event-bus.ts:closure@269:326.dbGroupsCache",
    "packages/core/src/deepagent/document-store.ts:DocumentStore.docs@393",
    "packages/core/src/permission.ts:closure@197:205.withNoProgressOwner",
    "packages/core/src/permission.ts:closure@197:206.pending",
    "packages/core/src/session/execution/local.ts:closure@18:26.ownedClaims",
    "packages/core/src/session/run-coordinator.ts:closure@81:82.active",
    "packages/core/src/session/runner/llm.ts:closure@792:1419.withPublication",
    "packages/core/src/session/runner/llm.ts:closure@792:1526.planResultMetadata",
    "packages/core/src/state.ts:create@55:58.semaphore",
    "packages/core/src/tool/application-tools.ts:closure@26:27.registered",
    "packages/core/src/tool/registry.ts:closure@163:164.registrations",
    "packages/core/src/tool/registry.ts:closure@63:67.local",
    "packages/core/src/tool/tool.ts:make@63:67.definitions",
    "packages/core/src/tool/tool.ts:makeDynamic@136:138.definitions",
    "packages/deepagent-code/src/cli/cmd/run.ts:closure@279:1246.sdk",
    "packages/deepagent-code/src/cli/cmd/tui.ts:closure@114:141.worker",
    "packages/deepagent-code/src/config/config.ts:attach@1038:1077.observed",
    "packages/deepagent-code/src/config/config.ts:closure@1001:1024.watchers",
    "packages/deepagent-code/src/config/config.ts:closure@643:648.consoleManagedProviders",
    "packages/deepagent-code/src/import/source/codex.ts:AssistantTurnBlocks.blocks@233",
    "packages/deepagent-code/src/lsp/client.ts:create@125:151.pushDiagnostics",
    "packages/deepagent-code/src/lsp/client.ts:create@125:152.pullDiagnostics",
    "packages/deepagent-code/src/lsp/client.ts:create@125:153.published",
    "packages/deepagent-code/src/lsp/client.ts:create@125:154.diagnosticRegistrations",
    "packages/deepagent-code/src/lsp/client.ts:create@125:155.registrationListeners",
    "packages/deepagent-code/src/lsp/client.ts:create@125:156.diagnosticListeners",
    "packages/deepagent-code/src/lsp/client.ts:requestDiagnosticReport@313:325.byFile",
    "packages/deepagent-code/src/mcp/secret-store.ts:inMemoryBackend@108:109.map",
    "packages/deepagent-code/src/provider/provider.ts:closure@1301:1441.failedDiscoveryProviders",
    "packages/deepagent-code/src/provider/provider.ts:closure@1301:1442.failedDiscoveryGroups",
    "packages/deepagent-code/src/provider/provider.ts:closure@1301:1445.discoveryProviders",
    "packages/deepagent-code/src/provider/provider.ts:closure@1301:1449.legacyDiscoveryProviders",
    "packages/deepagent-code/src/provider/provider.ts:timeoutController@116:117.ctl",
    "packages/deepagent-code/src/server/server.ts:closure@193:209.scope",
    "packages/deepagent-code/src/server/server.ts:closure@193:235.maintenanceScope",
    "packages/deepagent-code/src/server/server.ts:serverLayer@431:434.upgradedSockets",
    "packages/deepagent-code/src/server/server.ts:serverLayer@431:435.activeSockets",
    "packages/deepagent-code/src/session/message-v2.ts:hydrate@375:377.partByMessage",
    "packages/deepagent-code/src/session/message-v2.ts:hydrate@375:378.progressByMessage",
    "packages/deepagent-code/src/session/session.ts:closure@882:1252.partOwnershipVerified",
    "packages/llm/src/route/executor.ts:secretValues@231:232.values",
  ].map((key) => [ownerAnchor(key), reviewed[key]!] as const),
)

function ownerAnchor(key: string) {
  return key.replace(/@\d+(?::\d+)?/g, "@owner")
}

const reviewedCoreWitnesses: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  (
    [
      [
        "packages/core/src/agent.ts:snapshots",
        [
          "Agent.Location-catalog",
          "original-snapshot-token",
          "weak-snapshots-per-live-catalog",
          "Location-finalizer-live=false-plus-generation-current;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "snapshotView-checks-current-generation",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/browser/file-authority.ts:leases",
        [
          "BrowserFileAuthority.native-tool-scope",
          "original-Lease",
          "one-lease-per-scoped-file-action",
          "acquireRelease-active=false-and-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "current-canonical-tool-frame-and-permission",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/browser/file-control.ts:leases",
        [
          "BrowserFileControl.native-control-scope",
          "original-control-Lease",
          "one-lease-per-scoped-control",
          "acquireRelease-active=false-and-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "SQL-control-hash-and-native-current",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/browser/file-exchange.ts:captures",
        [
          "BrowserFileExchange.original-preview",
          "original-Capture",
          "one-used-preview-per-live-token;bounded-file-schema",
          "used-on-approval-plus-weak-key-GC;Native-preview-owner-closes",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-preview-and-current-control;not-cold-JSON",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/event-investigation.ts:captures",
        [
          "EventInvestigation.original-grant",
          "original-GrantCapture",
          "one-used-approval-per-weak-capture",
          "used-on-mutation-and-weak-key-GC;native-scope-closes",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "actual-native-approvedGrant-and-operator-epoch",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/event-validation.ts:claims",
        [
          "EventValidation.original-native-run",
          "original-run-and-preparation-object",
          "one-finite-bounded-rule-and-run-per-weak-token",
          "used-original-claim-and-Native-retirement;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "native-object-membership-and-original-SQL-run-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/event-validation.ts:preparationClaims",
        [
          "EventValidation.original-native-run",
          "original-run-and-preparation-object",
          "one-finite-bounded-rule-and-run-per-weak-token",
          "used-original-claim-and-Native-retirement;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "native-object-membership-and-original-SQL-run-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/event-validation.ts:preparations",
        [
          "EventValidation.original-native-run",
          "original-run-and-preparation-object",
          "one-finite-bounded-rule-and-run-per-weak-token",
          "used-original-claim-and-Native-retirement;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "native-object-membership-and-original-SQL-run-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child-execution.ts:make@155:157.entries",
        [
          "GoalChildExecution.coordinator",
          "original-Receipt-and-execution-token",
          "one-private-witness-per-owned-receipt",
          "revoke-live=false-and-delete-both-weak-maps",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-execution-lineage-and-live-witness",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child-execution.ts:witnesses",
        [
          "GoalChildExecution.coordinator",
          "original-Receipt-and-execution-token",
          "one-private-witness-per-owned-receipt",
          "revoke-live=false-and-delete-both-weak-maps",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-execution-lineage-and-live-witness",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child-policy.ts:frames",
        [
          "GoalChildPolicy.original-frame",
          "original-Frame-and-Snapshot",
          "32-live-frames;256-bindings;67108864-binding-bytes",
          "revoke-frame-active=false;release-frame-deletes;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-frame-membership-and-current-policy",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child-policy.ts:snapshots",
        [
          "GoalChildPolicy.original-frame",
          "original-Frame-and-Snapshot",
          "32-live-frames;256-bindings;67108864-binding-bytes",
          "revoke-frame-active=false;release-frame-deletes;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-frame-membership-and-current-policy",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child-result.ts:proofs",
        [
          "GoalChildResult.inspection",
          "original-proof-object",
          "67108864-cumulative-inspection-bytes;RESULT_BYTES-contract",
          "inspection-owner-drop-and-weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-ledger-reinspection;historical-proof-not-dispatch",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child.ts:witnesses",
        [
          "GoalChild.operation",
          "original-operation-token",
          "one-token-per-withWitness-body",
          "ensuring-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-Current-operation-and-unit-stage",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/filesystem.ts:readObservations",
        [
          "Filesystem.original-read",
          "original-Content-or-TextPage",
          "one-observation-per-bounded-read-result",
          "result-owner-drop-and-weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "actual-open/read-stamp-observation;JSON-cannot-mint",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/kernel-delivery.ts:preparedResults",
        [
          "KernelDelivery.original-runtime-and-operation",
          "original-runtime-or-private-witness",
          "runtime-receipt-capacity-1..100000;one-witness-per-operation",
          "runtime-close-active=false;operation-ensuring-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-runtime/current-source-and-indexed-outbox-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/kernel-delivery.ts:runtimes",
        [
          "KernelDelivery.original-runtime-and-operation",
          "original-runtime-or-private-witness",
          "runtime-receipt-capacity-1..100000;one-witness-per-operation",
          "runtime-close-active=false;operation-ensuring-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-runtime/current-source-and-indexed-outbox-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/kernel-delivery.ts:senderRetirements",
        [
          "KernelDelivery.original-runtime-and-operation",
          "original-runtime-or-private-witness",
          "runtime-receipt-capacity-1..100000;one-witness-per-operation",
          "runtime-close-active=false;operation-ensuring-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-runtime/current-source-and-indexed-outbox-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/kernel-delivery.ts:verifications",
        [
          "KernelDelivery.original-runtime-and-operation",
          "original-runtime-or-private-witness",
          "runtime-receipt-capacity-1..100000;one-witness-per-operation",
          "runtime-close-active=false;operation-ensuring-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-runtime/current-source-and-indexed-outbox-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/kernel-delivery.ts:witnesses",
        [
          "KernelDelivery.original-runtime-and-operation",
          "original-runtime-or-private-witness",
          "runtime-receipt-capacity-1..100000;one-witness-per-operation",
          "runtime-close-active=false;operation-ensuring-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-runtime/current-source-and-indexed-outbox-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/kernel-reader.ts:engines",
        [
          "KernelReader.original-native-runtime",
          "original-Runtime-and-output-witness",
          "2-output-groups;32-live-handle-batch;SQL-record-and-byte-meters",
          "close-active=false;output-ensuring-active=false/delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-engine-current/scope/cut;history-never-live",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/kernel-reader.ts:outputs",
        [
          "KernelReader.original-native-runtime",
          "original-Runtime-and-output-witness",
          "2-output-groups;32-live-handle-batch;SQL-record-and-byte-meters",
          "close-active=false;output-ensuring-active=false/delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-engine-current/scope/cut;history-never-live",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/im/media-upload-checkpoint.ts:frames",
        [
          "MediaUploadCheckpoint.finalize-scope",
          "original-OriginFrame",
          "one-original-frame-per-finalize;record-and-byte-meters",
          "ensuring-active=false-and-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "same-runtime/current-group-and-original-upload-namespace",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/permission.ts:appActions",
        [
          "PermissionV2.original-Location",
          "original-ActionPermit/AppAction/FileActions",
          "weak-original-permits-per-Location;finite-ask-owner",
          "Location-finalizer-active=false;AppAction-acquireRelease-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "both-original-permits/Agent/Location-current",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/permission.ts:closure@261:271.actionPermits",
        [
          "PermissionV2.original-Location",
          "original-ActionPermit/AppAction/FileActions",
          "weak-original-permits-per-Location;finite-ask-owner",
          "Location-finalizer-active=false;AppAction-acquireRelease-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "both-original-permits/Agent/Location-current",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/permission.ts:fileActions",
        [
          "PermissionV2.original-Location",
          "original-ActionPermit/AppAction/FileActions",
          "weak-original-permits-per-Location;finite-ask-owner",
          "Location-finalizer-active=false;AppAction-acquireRelease-delete;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "both-original-permits/Agent/Location-current",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session.ts:taskResumers",
        [
          "SessionV2.original-resumer",
          "original-result-object",
          "one-resumer-per-scoped-SessionRoot-result",
          "Root-finalizer-active=false-and-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-db-and-SessionExecution;no-cold-resume-authority",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/run-coordinator.ts:closure@128:131.receipts",
        [
          "SessionRunCoordinator.scope",
          "original-OwnedReceipt",
          "one-original-receipt-per-active-entry",
          "scope-shutdown-active.clear;settle-deletes-entry;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "receipt-object-and-exact-active-entry;not-key-or-digest",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/runner/current-tool-execution.ts:fileFrames",
        [
          "CurrentToolExecution.original-admission",
          "original-handle-and-FileFrame",
          "one-handle-per-tool-body;one-frame-per-original-action",
          "acquireRelease-active=false/delete;weak-file-frame-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-provider-owner/admission/session/Location-current",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/runner/current-tool-execution.ts:permissionCancellations",
        [
          "CurrentToolExecution.original-builtin-Bash-settlement",
          "original-live-PermissionCancellation-and-exact-tool-context",
          "one-witness-per-admitted-builtin-Bash-body;weak-membership-not-capacity-authority",
          "acquireUseRelease-active=false-and-delete;permission-wait-ensuring-clears-marker",
          "ephemeral-pre-effect-cancellation-evidence;durable-effect-settlement-remains-separate",
          "registered-original-Bash/exact-session-call-message-agent;after-dispatch-unknown-kept",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/runner/current-tool-execution.ts:handles",
        [
          "CurrentToolExecution.original-admission",
          "original-handle-and-FileFrame",
          "one-handle-per-tool-body;one-frame-per-original-action",
          "acquireRelease-active=false/delete;weak-file-frame-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-provider-owner/admission/session/Location-current",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/runner/model.ts:configurationWitnesses",
        [
          "Model.Location-postPlugin-catalog",
          "original-resolved-model/config-witness",
          "weak-entries-per-resolved-catalog-object",
          "Location-finalizer-active=false;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-Config.service/entries/current-and-native-route-construction",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/runner/model.ts:configuredSources",
        [
          "Model.Location-postPlugin-catalog",
          "original-resolved-model/config-witness",
          "weak-entries-per-resolved-catalog-object",
          "Location-finalizer-active=false;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-Config.service/entries/current-and-native-route-construction",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/runner/model.ts:resolutions",
        [
          "Model.Location-postPlugin-catalog",
          "original-resolved-model/config-witness",
          "weak-entries-per-resolved-catalog-object",
          "Location-finalizer-active=false;weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-Config.service/entries/current-and-native-route-construction",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/task-continuation.ts:entries",
        [
          "TaskContinuation.runner-admission",
          "original-Current-handle",
          "one-witness-per-admitted-tool-body",
          "acquireUseRelease-active=false-and-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-provider-owner/toolCall/Session/admission",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/work-child-authority.ts:entries",
        [
          "WorkChildAuthority.original-tool-body",
          "original-admission-or-settlement-token",
          "one-entry/output-per-owned-admission",
          "admission-ensuring-active=false/delete;settlement-consume-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-WorkDerived/registeredTool/current-Entry/output-once",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/work-child-authority.ts:settlements",
        [
          "WorkChildAuthority.original-tool-body",
          "original-admission-or-settlement-token",
          "one-entry/output-per-owned-admission",
          "admission-ensuring-active=false/delete;settlement-consume-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-WorkDerived/registeredTool/current-Entry/output-once",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/work-known-recovery-v2.ts:continuations",
        [
          "WorkKnownRecoveryV2.original-resume-scope",
          "original-recovery-receipt",
          "one-entered-once-continuation-per-original-receipt",
          "Scope-finalizer-and-ensuring-active=false/delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-original-history/MAC/current-proof;unknown-no-replay",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/work-known-recovery.ts:continuations",
        [
          "WorkKnownRecovery.original-resume-scope",
          "original-recovery-receipt",
          "one-entered-once-continuation-per-original-receipt",
          "Scope-finalizer-and-ensuring-active=false/delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "exact-original-history/MAC/current-proof;unknown-no-replay",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/work-tool-policy.ts:entries",
        [
          "WorkToolPolicy.original-Work-admission",
          "original-Witness",
          "one-native-leaf-witness-per-canonical-tool-body",
          "acquireUseRelease-active=false-and-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "same-Current/admission/session/profile/native-leaf",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/bash.ts:builtins",
        [
          "BashTool.original-scoped-layer",
          "original-registered-Tool-object",
          "one-Bash-object-per-layer;Location-registry-names256-overlays32;weak-membership-not-capacity-proof",
          "layer-Scope-finalizer-deletes-original-object;weak-key-GC",
          "ephemeral-builtin-identity;not-permission-or-recovery-authority",
          "ToolRegistry.inspect-must-return-same-current-registered-object;copies-not-members",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/read.ts:nativeReads",
        [
          "NativeReadTool.Location-registry",
          "original-native-tool-object",
          "Location-tool-names256;overlays-per-name32",
          "Location-registry-owner-drop-and-weak-brand-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "actual-native-tool-construction;brand-alone-not-Work-permit",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/registry.ts:generations",
        [
          "ToolRegistry.original-Location",
          "original-materialization-and-registration",
          "256-local-names;32-overlays/name;512-materialized-names",
          "Location-owner-drop-and-weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "advertised-identity-equals-current-registration",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/registry.ts:materializations",
        [
          "ToolRegistry.original-Location",
          "original-materialization-and-registration",
          "256-local-names;32-overlays/name;512-materialized-names",
          "Location-owner-drop-and-weak-key-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "advertised-identity-equals-current-registration",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/task.ts:completedOutputs",
        [
          "TaskTool.original-Location-and-child-result",
          "original-native-tool-or-output-witness",
          "tool-names256;one-result-per-child-completion",
          "output-consume/ensuring-delete;Location-owner-drop-and-weak-brand-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-Tool/context/runID/inputHash/outcomeHash",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/task.ts:nativeTasks",
        [
          "TaskTool.original-Location-and-child-result",
          "original-native-tool-or-output-witness",
          "tool-names256;one-result-per-child-completion",
          "output-consume/ensuring-delete;Location-owner-drop-and-weak-brand-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "original-Tool/context/runID/inputHash/outcomeHash",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/tool.ts:appContexts",
        [
          "ToolAppContext.original-invocation",
          "original-AppContext",
          "one-frame-per-scoped-App-invocation",
          "acquireRelease-delete",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "current-before-and-after-check;non-JSON-membership",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/work-command.ts:nativeCommands",
        [
          "NativeWorkCommand.Location-registry",
          "original-native-tool-object",
          "Location-tool-names256;overlays-per-name32",
          "Location-registry-owner-drop-and-weak-brand-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "actual-native-tool-construction;original-command-authority",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/tool/write.ts:nativeWrites",
        [
          "NativeWriteTool.Location-registry",
          "original-native-tool-object",
          "Location-tool-names256;overlays-per-name32",
          "Location-registry-owner-drop-and-weak-brand-GC",
          "ephemeral-opaque-membership;durable-and-native-current-remain-separate",
          "actual-native-tool-construction;original-read/CAS-required",
          "safe_scoped",
        ],
      ],
    ] as const
  ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

const reviewedHostWitnesses: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  (
    [
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@149:153.previews",
        [
          "BrowserFileExchange.original-native-file-scope",
          "internally-minted-preview/approval/transfer/observation/released",
          "8-live-transfers;4-artifacts/action;64-preview-captures;bounded-grant-operations",
          "Root-scope-live=false;transfer-finalizer-closes-heldfiles/helpers;weak-original-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "current-Control/native-current-and-exact-SQL-grant/publication;unknown-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@149:155.approvals",
        [
          "BrowserFileExchange.original-native-file-scope",
          "internally-minted-preview/approval/transfer/observation/released",
          "8-live-transfers;4-artifacts/action;64-preview-captures;bounded-grant-operations",
          "Root-scope-live=false;transfer-finalizer-closes-heldfiles/helpers;weak-original-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "current-Control/native-current-and-exact-SQL-grant/publication;unknown-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@149:158.transfers",
        [
          "BrowserFileExchange.original-native-file-scope",
          "internally-minted-preview/approval/transfer/observation/released",
          "8-live-transfers;4-artifacts/action;64-preview-captures;bounded-grant-operations",
          "Root-scope-live=false;transfer-finalizer-closes-heldfiles/helpers;weak-original-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "current-Control/native-current-and-exact-SQL-grant/publication;unknown-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@149:159.observations",
        [
          "BrowserFileExchange.original-native-file-scope",
          "internally-minted-preview/approval/transfer/observation/released",
          "8-live-transfers;4-artifacts/action;64-preview-captures;bounded-grant-operations",
          "Root-scope-live=false;transfer-finalizer-closes-heldfiles/helpers;weak-original-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "current-Control/native-current-and-exact-SQL-grant/publication;unknown-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@149:160.released",
        [
          "BrowserFileExchange.original-native-file-scope",
          "internally-minted-preview/approval/transfer/observation/released",
          "8-live-transfers;4-artifacts/action;64-preview-captures;bounded-grant-operations",
          "Root-scope-live=false;transfer-finalizer-closes-heldfiles/helpers;weak-original-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "current-Control/native-current-and-exact-SQL-grant/publication;unknown-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/config/file-write.ts:nativeFiles",
        [
          "ConfigFileWrite.original-observation",
          "original-File-object",
          "one-original-private-snapshot-per-read;MAX_BYTES=16777216",
          "operation-active=false;original-native-lease-Scope-close;weak-read-object-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "current-sameRoot-private-optimistic-CAS;serialized-File-cannot-mint-nativeFiles",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/event-investigation.ts:closure@30:38.grants",
        [
          "EventInvestigation.NativeRuntime-scope",
          "original-Core-grant/failure-capture",
          "one-readiness/evidence-per-capture;native-runtime-handles32",
          "owner-finalizer-active=false;weak-original-capture-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "sameNativeRuntime/installed-manifest/provider/route/current-operator-epoch",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/event-investigation.ts:closure@30:46.failures",
        [
          "EventInvestigation.NativeRuntime-scope",
          "original-Core-grant/failure-capture",
          "one-readiness/evidence-per-capture;native-runtime-handles32",
          "owner-finalizer-active=false;weak-original-capture-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "sameNativeRuntime/installed-manifest/provider/route/current-operator-epoch",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/owned-validation.ts:handles",
        [
          "OwnedValidation.process-custody",
          "original-Handle-and-Receipt",
          "128-live-plus-strong-unknown-quarantine;stdout/stderr1048576B;command65536B",
          "known-original-result-releases-slot;unknown-original-Entry-strong-retained-to-process-exit",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-native-dispatch/one-used-handle;receipt-evidence-not-execution;unknown-no-replay",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/owned-validation.ts:receipts",
        [
          "OwnedValidation.process-custody",
          "original-Handle-and-Receipt",
          "128-live-plus-strong-unknown-quarantine;stdout/stderr1048576B;command65536B",
          "known-original-result-releases-slot;unknown-original-Entry-strong-retained-to-process-exit",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-native-dispatch/one-used-handle;receipt-evidence-not-execution;unknown-no-replay",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/client.ts:closure@129:134.liveHandles",
        [
          "KernelClient.original-SDK-event-scope",
          "original-SDK-live-event-object",
          "dropping-live-channel64;one-weak-membership-bit-per-original-event",
          "Root-finalizer-PubSub.shutdown;SDKsubscription-scope-closes;weak-event-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "ProtectedLiveOrigin.read-before-add/read;original-provider-current;never-history-upgrade",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/reader.ts:closure@63:75.livePrepared",
        [
          "KernelReader.original-runtime",
          "original-live-handle/native-reader-cut",
          "one-prepared-record-per-original-handle;1000ms-current-slot;32-live-pass-handles",
          "Root-revoke/invalidate;retirement-ensuring-delete;weak-original-handle-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-currentRuntime/native-link/generation/private-cut;old-history-refused",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/reader.ts:closure@63:89.retirementObserved",
        [
          "KernelReader.original-runtime",
          "original-live-handle/native-reader-cut",
          "one-prepared-record-per-original-handle;1000ms-current-slot;32-live-pass-handles",
          "Root-revoke/invalidate;retirement-ensuring-delete;weak-original-handle-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-currentRuntime/native-link/generation/private-cut;old-history-refused",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/sync.ts:closure@108:118.engines",
        [
          "KernelSync.original-reader-registry",
          "original-IMReaderRegistry.Entry",
          "one-engine-per-original-entry;send-queue128;4-attachments;bounded-continuations128",
          "Root-finalizer-clears/shuts-queue;entry.hold-controls-scope;weak-entry-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-entry.assertCurrent/reader-runtime/group-source;no-cold-engine-authority",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/protected-live-origin.ts:captures",
        [
          "ProtectedLiveOrigin.original-SDK-subscription",
          "internally-minted-live-object-from-private-SDK",
          "one-observation-per-weak-token;fixed-original-native-deadline",
          "unsubscribe-owner-active=false;SDK-native-current/deadline-invalidates;weak-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "provider.readProtectedLiveMessage/page-before-and-after;receivedAt-never-grants-authority",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-investigation-read.ts:wrap@14:24.roots",
        [
          "EventInvestigationRead.original-files-scope",
          "original-WorkFileCapability.Root",
          "one-role/read-owner-per-real-root;WorkFileHelper8-live-roots",
          "action-finalizer-roots.delete;original-file-helper-root-close",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-native-root/current-read-profile-and-byte-identity",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-validation-native.ts:closure@36:38.approvals",
        [
          "EventValidation.original-native-Scope",
          "original-approval/observation/preparation/handle",
          "8-active-native-entries;bounded-config/content/recipe-bytes;one-preparation-per-token",
          "Root-finalizer-active=false/closes-heldfiles;entry-finalizer-active.delete;weak-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-actual-native-preparation/workspace/current-config;unknown-dispatch-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-validation-native.ts:closure@36:39.observations",
        [
          "EventValidation.original-native-Scope",
          "original-approval/observation/preparation/handle",
          "8-active-native-entries;bounded-config/content/recipe-bytes;one-preparation-per-token",
          "Root-finalizer-active=false/closes-heldfiles;entry-finalizer-active.delete;weak-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-actual-native-preparation/workspace/current-config;unknown-dispatch-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-validation-native.ts:closure@36:40.handles",
        [
          "EventValidation.original-native-Scope",
          "original-approval/observation/preparation/handle",
          "8-active-native-entries;bounded-config/content/recipe-bytes;one-preparation-per-token",
          "Root-finalizer-active=false/closes-heldfiles;entry-finalizer-active.delete;weak-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-actual-native-preparation/workspace/current-config;unknown-dispatch-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-validation-native.ts:closure@36:41.preparations",
        [
          "EventValidation.original-native-Scope",
          "original-approval/observation/preparation/handle",
          "8-active-native-entries;bounded-config/content/recipe-bytes;one-preparation-per-token",
          "Root-finalizer-active=false/closes-heldfiles;entry-finalizer-active.delete;weak-token-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-actual-native-preparation/workspace/current-config;unknown-dispatch-not-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-work-placement.ts:closure@55:60.entries",
        [
          "EventWorkPlacement.original-child-scope",
          "original-Placement.Witness",
          "one-witness-per-current-child-placement;SQL/native-workspace-budget;finite-DAG32-nodes",
          "Scope-finalizer-active=false/entries.delete/byWork.delete/heldFD-close",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "exact-installed/base/Git/private-index/current-custody;historical-proof-not-dispatch",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/native-installation.ts:handles",
        [
          "NativeInstallation.original-installed-observation",
          "internally-minted-VerifiedInstalledComponents",
          "one-fixed-schema/components-Snapshot-per-weak-handle",
          "requireCurrent-failure-handles.delete;weak-handle-GC;Native-image-owner-close",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "exact-current-native-artifact/manifest/runtime-identity/signature/pin;no-route/Work-permission",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/native-runtime.ts:closure@228:231.purposes",
        [
          "NativeRuntime.original-Root-scope",
          "original-PurposeReadiness/ApprovedRuntime/Configuration/CredentialCapture",
          "32-live-runtime-handles;32-live-credential-captures;one-configuration-per-token",
          "Root-active=false/maps-delete/sets.clear;individual-finalizers-delete/decrement;secret-buffer-zeroize",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-originalModel/LLMClient/installedimage/route/current-capture;no-DTO-registration",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/native-runtime.ts:closure@228:232.handles",
        [
          "NativeRuntime.original-Root-scope",
          "original-PurposeReadiness/ApprovedRuntime/Configuration/CredentialCapture",
          "32-live-runtime-handles;32-live-credential-captures;one-configuration-per-token",
          "Root-active=false/maps-delete/sets.clear;individual-finalizers-delete/decrement;secret-buffer-zeroize",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-originalModel/LLMClient/installedimage/route/current-capture;no-DTO-registration",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/native-runtime.ts:closure@228:246.configurations",
        [
          "NativeRuntime.original-Root-scope",
          "original-PurposeReadiness/ApprovedRuntime/Configuration/CredentialCapture",
          "32-live-runtime-handles;32-live-credential-captures;one-configuration-per-token",
          "Root-active=false/maps-delete/sets.clear;individual-finalizers-delete/decrement;secret-buffer-zeroize",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-originalModel/LLMClient/installedimage/route/current-capture;no-DTO-registration",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/native-runtime.ts:closure@228:249.captures",
        [
          "NativeRuntime.original-Root-scope",
          "original-PurposeReadiness/ApprovedRuntime/Configuration/CredentialCapture",
          "32-live-runtime-handles;32-live-credential-captures;one-configuration-per-token",
          "Root-active=false/maps-delete/sets.clear;individual-finalizers-delete/decrement;secret-buffer-zeroize",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-originalModel/LLMClient/installedimage/route/current-capture;no-DTO-registration",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/provider-credential-binding.ts:closure@77:84.captures",
        [
          "ProviderCredentialBinding.original-Root-scope",
          "original-credential-capture",
          "32-live-captures;32-count-bindings;MAX_RECORD_BYTES-codec",
          "Root-finalizer-captures.delete/live.clear/countBindings.clear;individual-finalizer-delete",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "sameNativeRuntime/CredentialCapture/current-install/route/request-seal;cold-hash-not-authority",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-image-factory.ts:targets",
        [
          "NativeWindowsImageFactory.original-Root-scope",
          "internally-minted-TargetCapture",
          "one-frozen-TargetCapture-per-native-held-factory;bounded-fixedimages/libraries",
          "Scope-registered.close/native-heldFactory-close;active=false;weak-target-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "pure-original-target-lookup-plus-heldFactory-current;no-path/hash-DTO-factory",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-native-bootstrap.ts:originals",
        [
          "NativeWindowsBootstrap.original-preloaded-Root",
          "internally-minted-Capture",
          "one-host-Capture-per-original-installed/preloaded-native-capture",
          "Root-finalizer-active=false/originals.delete/native.close",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-originalNative-preloaded/current/env/heldimage-lease;copied-JSON-cannot-register",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command-runtime.ts:closure@36:44.commands",
        [
          "WindowsWorkCommandRuntime.original-Root-scope",
          "original-Workspace-object",
          "MAX_CUSTODY-active-workspace-leases;one-command-and-description-per-original-Workspace",
          "native-original-close;Root-finalizer-active=false;unknown-native-leases-retained;weak-workspace-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "opaque-originalFactory-workspace/current/FileID;no-POSIX-FileHandle-cast-or-path-DTO",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command-runtime.ts:closure@36:45.originals",
        [
          "WindowsWorkCommandRuntime.original-Root-scope",
          "original-Workspace-object",
          "MAX_CUSTODY-active-workspace-leases;one-command-and-description-per-original-Workspace",
          "native-original-close;Root-finalizer-active=false;unknown-native-leases-retained;weak-workspace-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "opaque-originalFactory-workspace/current/FileID;no-POSIX-FileHandle-cast-or-path-DTO",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command.ts:closure@60:66.receipts",
        [
          "WindowsWorkCommand.original-Root-scope",
          "original-CommandObservation-object",
          "MAX_CUSTODY-admissions;one-terminal-receipt-per-original-Observation",
          "lifetime-finalizer-active=false;known-release-owned.delete;weak-observation-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "Ready->SQL-dispatch->Continue->original-Stop/Job/dualEOF/security/MAC;unknown-retained",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-factory.ts:closure@249:251.active",
        [
          "NativeWindowsWorkFactory.original-capture-scope",
          "original-native-workspace-or-image-registry-object",
          "bounded-originalNative-factory/workspace/child-capacities;one-membership-per-token",
          "workspace.close-deletes-membership;registry.close-active.delete;Root-scope-retirement-current=false",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-nativeCapture/Factory/Workspace External registry;no-caller-command-path/hash/env",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-factory.ts:closure@39:173.workspaces",
        [
          "NativeWindowsWorkFactory.original-capture-scope",
          "original-native-workspace-or-image-registry-object",
          "bounded-originalNative-factory/workspace/child-capacities;one-membership-per-token",
          "workspace.close-deletes-membership;registry.close-active.delete;Root-scope-retirement-current=false",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-nativeCapture/Factory/Workspace External registry;no-caller-command-path/hash/env",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-factory.ts:closure@39:129.eventRuntimes",
        [
          "NativeWindowsWorkFactory.original-capture-scope",
          "original-Native-Event-Git-runtime-lease",
          "one-weak-membership-per-Native-lease;Native-runtime-cap64-including-pending;original-capture-and-caller-Scope",
          "close-runtime-deletes-exact-membership;Root-scoped=false-fences-new-use;failed-Native-close-retains-original-capture",
          "weak-membership-only;original-Native-current-and-SQL-Work-remain-required",
          "WindowsEventGit.capture-acquireRelease-and-original-current-port",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-factory.ts:closure@39:130.eventRepositories",
        [
          "NativeWindowsWorkFactory.original-capture-scope",
          "original-Native-Event-Git-repository-lease",
          "one-weak-membership-per-Native-lease;Native-repository-cap64-including-pending;original-capture-and-caller-Scope",
          "close-repository-deletes-exact-membership;Root-scoped=false-fences-new-use;failed-Native-close-retains-original-capture",
          "weak-membership-only;original-Native-current-and-SQL-Work-remain-required",
          "WindowsEventGit.pinRepository-acquireRelease-and-original-current-port",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-factory.ts:closure@39:131.eventDirectories",
        [
          "NativeWindowsWorkFactory.original-capture-scope",
          "original-Native-Event-directory-lease",
          "one-weak-membership-per-Native-lease;Native-directory-cap128-including-pending;Event-placement-workspaces64",
          "Placement-original-Scope-closes-directory-and-deletes-membership;Root-scoped=false-fences-new-use",
          "weak-membership-only;held-name/FileID/DACL-and-Native-current-remain-required",
          "WindowsEventGit.retain-through-original-Placement.retainDirectory-owner",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-factory.ts:closure@39:151.collectors",
        [
          "NativeWindowsWorkFactory.original-capture-scope",
          "original-Native-known-command-cleanup-lease",
          "one-weak-membership-per-Native-lease;Native-cold-collector-cap8;SQL-cleanup-MAX_ACTIVE40;request1048576B",
          "Host-cleanup-Scope-finalizer-closes-exact-lease-and-deletes-membership-on-success;Root-scoped=false-fences-new-collect;unknown-not-replayed",
          "weak-membership-only;original-known-terminal/MAC/held-Native-custody-remain-required",
          "original-WorkStorageCleanup-known-command-consumer",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/event-work-git.ts:capturedWindows",
        [
          "original-EventWorkGit.capture-Scope",
          "original-Windows-runtime-object",
          "one-weak-current-callback-per-captured-runtime;no-strong-global-key",
          "capture-Scope-finalizer-deletes-original-runtime;WindowsEventGit-finalizer-invalidates-native-token",
          "pure-live-membership-fence;copied-DTO-or-historical-hash-cannot-authorize-Git",
          "original-WindowsEventGit.capture-and-current-port",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/windows-event-git.ts:originals",
        [
          "original-WindowsEventGit-runtime-or-repository-Scope",
          "internally-minted-opaque-token-and-original-Native-lease",
          "one-weak-entry-per-runtime-or-repository-token;fixed-Git-images256-and-bytes536870912",
          "Scope-finalizer-active=false/scoped=false/delete;acquireRelease-closes-exact-Native-runtime-or-repository",
          "ephemeral-original-token-membership;factory.current-and-original-Native-metadata-still-required",
          "capture/pinRepository-only;no-caller-path-or-serialized-DTO-token-producer",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-file-helper.ts:assets",
        [
          "WindowsWorkFileHelper.original-factory-child-scope",
          "internally-minted-verified-asset",
          "8-child-plus-opening-slots;bounded-original-native-queue/pages",
          "actual-native-Job/dualEOF/writer-join-only-deletes-child;asset-weak-key-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "sameRoot-Installed/Factory/current/launchHelper;unknown-child-retained-no-Node-spawn-fallback",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-write.ts:closure@72:78.owned",
        [
          "WindowsWorkWrite.original-root/stage-scope",
          "original-Root-or-WriteObservation",
          "one-attempt-originalStage-per-bound-root;8-helper-roots;MAX_CONTENT_BYTES",
          "Root-finalizer-active=false;ownedRoot helper-close;weak-original-root/observation-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-originalStage/FileID/DACL/grant/SQL-stage/MAC;known-only-cold-GC;unknown-no-replay",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-write.ts:closure@72:79.observations",
        [
          "WindowsWorkWrite.original-root/stage-scope",
          "original-Root-or-WriteObservation",
          "one-attempt-originalStage-per-bound-root;8-helper-roots;MAX_CONTENT_BYTES",
          "Root-finalizer-active=false;ownedRoot helper-close;weak-original-root/observation-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-originalStage/FileID/DACL/grant/SQL-stage/MAC;known-only-cold-GC;unknown-no-replay",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-execution-profile.ts:closure@93:123.turns",
        [
          "WorkExecutionProfile.original-provider-turn-scope",
          "original-Runtime-object",
          "32-active-turns;one-installed/native/root tuple-per-original-Runtime",
          "Root-finalizer-turns.delete/active.clear;turn-finalizer-turns.delete/active.delete",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-admittedWork/session/route/NativeRuntime/currentRoot/source;fixed-runtime-not-reconstructed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-file-helper.ts:closure@92:97.roots",
        [
          "WorkFileHelper.original-root-helper-scope",
          "original-Root-or-CommandObservation",
          "8-live/opening-helpers;bounded-frame65536/payload51200/queue16;MAX_CUSTODY-command-stages",
          "Root-scope-retire;only-stopped-helper active.delete;unknown-original-helper-retained",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-native-binding/currentRoot/grant/SQL-effect/heldFS-current;receipt-not-JSON-authority",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-file-helper.ts:closure@92:99.commandReceipts",
        [
          "WorkFileHelper.original-root-helper-scope",
          "original-Root-or-CommandObservation",
          "8-live/opening-helpers;bounded-frame65536/payload51200/queue16;MAX_CUSTODY-command-stages",
          "Root-scope-retire;only-stopped-helper active.delete;unknown-original-helper-retained",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-native-binding/currentRoot/grant/SQL-effect/heldFS-current;receipt-not-JSON-authority",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-known-recovery-v2.ts:closure@39:49.entries",
        [
          "WorkKnownRecoveryV2.original-resume-scope",
          "original-Prepared-recovery",
          "1-live-preparation;128-known-effects;MAX_RECORD_BYTES/MAX_RESUME_RECORD_BYTES",
          "Root-finalizer-active=false/entries.delete/live.clear/secret-zeroize;individual-finalizer-delete",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-v2-knownMAC/history/source/custody/provider-owner-idle;unknown-never-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-known-recovery.ts:closure@37:47.entries",
        [
          "WorkKnownRecovery.original-resume-scope",
          "original-Prepared-recovery",
          "1-live-preparation;128-known-effects;MAX_RECORD_BYTES",
          "Root-finalizer-active=false/entries.delete/live.clear/secret-zeroize;individual-finalizer-delete",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-knownMAC/history/source/custody/provider-owner-idle;unknown-never-replayed",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-leaf-proof.ts:closure@57:79.recoveries",
        [
          "WorkLeafProof.original-installed-root",
          "original-VerifiedRecovery-object",
          "32-original-recoveries;128-verified-effects;MAX_PROOF_BYTES16384",
          "consume-deletes-recoveries/recoveryLive;Root-finalizer-active=false/cache-clear/secret-zeroize",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-knownNative/MAC/currentSQL;history-does-not-construct-dispatch",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-process-supervisor.ts:closure@320:377.stops",
        [
          "WorkProcessSupervisor.original-held-child-scope",
          "original-Ready-or-StopProof",
          "one-ready/stop per original managed child;bounded-workspace/factory-capacities",
          "ready-finally-delete;Scope-lifetime.active=false;originalNative-close retains unknown",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "Ready-original-child->durable-SQL->Continue;Stop-originalJob/dualEOF/security/manifest;no-DTO-stop",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-process-supervisor.ts:closure@607:616.stops",
        [
          "WorkProcessSupervisor.original-held-child-scope",
          "original-Ready-or-StopProof",
          "one-ready/stop per original managed child;bounded-workspace/factory-capacities",
          "ready-finally-delete;Scope-lifetime.active=false;originalNative-close retains unknown",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "Ready-original-child->durable-SQL->Continue;Stop-originalJob/dualEOF/security/manifest;no-DTO-stop",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-process-supervisor.ts:readyHandles",
        [
          "WorkProcessSupervisor.original-held-child-scope",
          "original-Ready-or-StopProof",
          "one-ready/stop per original managed child;bounded-workspace/factory-capacities",
          "ready-finally-delete;Scope-lifetime.active=false;originalNative-close retains unknown",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "Ready-original-child->durable-SQL->Continue;Stop-originalJob/dualEOF/security/manifest;no-DTO-stop",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-process-supervisor.ts:windowsStops",
        [
          "WorkProcessSupervisor.original-held-child-scope",
          "original-Ready-or-StopProof",
          "one-ready/stop per original managed child;bounded-workspace/factory-capacities",
          "ready-finally-delete;Scope-lifetime.active=false;originalNative-close retains unknown",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "Ready-original-child->durable-SQL->Continue;Stop-originalJob/dualEOF/security/manifest;no-DTO-stop",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-storage-cleanup.ts:closure@93:107.entries",
        [
          "WorkStorageCleanup.original-installed-scope",
          "original-Prepared-cleanup",
          "one-original-plan/MAC-envelope-per-operation;bounded-native-inventory/retained-byte-meters",
          "operation-finalizer-entries.delete;Root-finalizer-active=false/secret-zeroize",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "exact-original/native-current inventory/known-terminal/manifest;unknown-cannot-collect",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/lsp/client.ts:observations",
        [
          "LSPClient.original-document-generation",
          "internally-minted-CheckedObservation",
          "checked-text1048576B;diagnostics1024/262144B;view2048B;timeout10000ms",
          "client.closed/source-generation-or-signal-invalidates;weak-receipt-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "actual-versioned-push/document-pull/current-text/generation;diagnosticHash-does-not-authorize-exec",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/index.ts:closure@486:504.localTransports",
        [
          "MCP.original-InstanceState/client-scope",
          "original-Transport-or-State",
          "one-owner-check-per-realtransport;one-appResource-per-realState;bounded-app-resource-protocol",
          "connect-failure/original-client.close;Instance-finalizer-disposed/appResource.dispose;weak-key-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "actual-localtransport-current/handedOff/original-client-version/selectedState;no-JSON-transport",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/index.ts:closure@486:823.appResourcesByState",
        [
          "MCP.original-InstanceState/client-scope",
          "original-Transport-or-State",
          "one-owner-check-per-realtransport;one-appResource-per-realState;bounded-app-resource-protocol",
          "connect-failure/original-client.close;Instance-finalizer-disposed/appResource.dispose;weak-key-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "actual-localtransport-current/handedOff/original-client-version/selectedState;no-JSON-transport",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/local-operator.ts:accesses",
        [
          "McpLocalOperator.original-authenticated-ticket",
          "internally-minted-Access",
          "8-requests/8-original-tickets;one-current-check-per-Access",
          "ticket-close-active=false;request-finally-abort/delete;weak-access-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-native-ticket/directory/config/account/current-server-policy;no-caller-auth-DTO",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/secret-ref-scope.ts:captures",
        [
          "McpSecretRefScope.original-auth/config-scope",
          "original-Capture/Permit/RepairCapture",
          "one-bounded-ConfigFile observation+template-per-weak-token;MAX_BYTES16777216",
          "Scope-owner.live=false;repair-consume-delete;weak-capture/permit-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-account/location/currentraw-config/install-MAC/source-slot;Redacted/JSON-never-mints-permit",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/secret-ref-scope.ts:closure@88:175.repairs",
        [
          "McpSecretRefScope.original-auth/config-scope",
          "original-Capture/Permit/RepairCapture",
          "one-bounded-ConfigFile observation+template-per-weak-token;MAX_BYTES16777216",
          "Scope-owner.live=false;repair-consume-delete;weak-capture/permit-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-account/location/currentraw-config/install-MAC/source-slot;Redacted/JSON-never-mints-permit",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/secret-ref-scope.ts:permits",
        [
          "McpSecretRefScope.original-auth/config-scope",
          "original-Capture/Permit/RepairCapture",
          "one-bounded-ConfigFile observation+template-per-weak-token;MAX_BYTES16777216",
          "Scope-owner.live=false;repair-consume-delete;weak-capture/permit-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-account/location/currentraw-config/install-MAC/source-slot;Redacted/JSON-never-mints-permit",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/project/instance-store.ts:closure@42:48.retiring",
        [
          "InstanceStore.original-InstanceScope",
          "original-InstanceContext",
          "one-retiring-membership-bit-per-real-instance",
          "registry.dispose-ensuring-disposeInstanceState;Root-disposeAll;weak-context-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-context identity prevents admission while retirement-in-flight;no-recreated-cold-context",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/server/server.ts:serverLayer@446:459.tlsRequests",
        [
          "Server.original-TLS-request-owner",
          "original-server-request-object",
          "one-TLS-membership-bit-per-realrequest;server-socket-limit2048",
          "server-scope-ready=false/close;weak-original-request-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "actual-TLS-server-request-event membership;forwarded/header strings cannot mint-TLS",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-owned-loop.ts:decisions",
        [
          "GoalOwnedLoop.original-tick-controller",
          "original-GoalChildPolicy.Frame-witness",
          "bounded-original-tick/role specification;one-decision-per-original-witness",
          "skipRoles-ensuring-decisions.delete;frame-revoke-invalidate",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "same-policy-frameCurrent/permit/journalHash/roles;history-only-projection-no-execution",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-plan-rebase-access.ts:accesses",
        [
          "GoalPlanRebase.original-HTTP-or-worker-request",
          "internally-minted-Access",
          "one-current-auth-check-per-request;bounded-worker-request-lane",
          "worker-finally-abort/requests.delete;close-state.active=false;weak-request-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-authenticated-HTTP/socket-origin or opaque-worker-current;exact-session/goal/directory",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-plan-rebase-access.ts:localAccesses",
        [
          "GoalPlanRebase.original-HTTP-or-worker-request",
          "internally-minted-Access",
          "one-current-auth-check-per-request;bounded-worker-request-lane",
          "worker-finally-abort/requests.delete;close-state.active=false;weak-request-GC",
          "ephemeral-original-object-membership;durable/Native-authority-current-remains-separate",
          "original-authenticated-HTTP/socket-origin or opaque-worker-current;exact-session/goal/directory",
          "safe_scoped",
        ],
      ],
    ] as const
  ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

const reviewedUiLifetimes: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  (
    [
      [
        "packages/app/src/components/browser-file-exchange.tsx:drafts",
        [
          "original SDK-client file-exchange draft owner",
          "client + scope/directory/controlID",
          "64 retained drafts per original client, gate before new entry",
          "alive/activeOwner/generation fence; abort request on cleanup; explicit unknown reconciliation; no eviction",
          "ephemeral exact request drafts; backend/Native proof authoritative",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/deepagent/goal-start-button.tsx:pendingStarts",
        [
          "renderer module GoalClient pending custody",
          "captured original server/scope/directory/session; control also original goalID; retry selects Map original, not Solid store proxy",
          "32 original Descriptor slots per module; admission before GoalClient.send; full-capacity exact original ID retry allowed",
          "known original control receipt deletes same descriptor; first definitive refusal deletes; previously unknown remains counted after later 4xx; unmount does not evict unknown",
          "ephemeral exact original Descriptor; no auto retry",
          "production Goal Start/Status UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/deepagent/goal-status-bar.tsx:pendingControls",
        [
          "renderer module GoalClient pending custody",
          "captured original server/scope/directory/session; control also original goalID; retry selects Map original, not Solid store proxy",
          "32 original Descriptor slots per module; admission before GoalClient.send; full-capacity exact original ID retry allowed",
          "known original control receipt deletes same descriptor; first definitive refusal deletes; previously unknown remains counted after later 4xx; unmount does not evict unknown",
          "ephemeral exact original Descriptor; no auto retry",
          "production Goal Start/Status UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/dialog-attention.tsx:bookmarks",
        [
          "original SDK-client attention dialog",
          "actual client + captured scope/url/transport identity",
          "one value per client per WeakMap; no historical entry array",
          "cleanup invalidates epoch and aborts reads/timers; known command receipt deletes; bookmark only current cleanup",
          "ephemeral pending original command or read-only bookmark; no extra grant",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/dialog-attention.tsx:pendingCommands",
        [
          "original SDK-client attention dialog",
          "actual client + captured scope/url/transport identity",
          "one value per client per WeakMap; no historical entry array",
          "cleanup invalidates epoch and aborts reads/timers; known command receipt deletes; bookmark only current cleanup",
          "ephemeral pending original command or read-only bookmark; no extra grant",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/dialog-browser-control.tsx:controls",
        [
          "original SDK-client browser-control owner",
          "client + scope/directory/sessionID",
          "64 retained controls per original client, gate before entry",
          "cleanup invalidates alive/generation and aborts timer; unknown original command retained",
          "ephemeral original request only; Native current required",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/dialog-event-validation.tsx:requests",
        [
          "original SDK-client EventValidation request owner",
          "client + scope/directory/sourceSessionID",
          "32 retained entries per original client; checked before mutation POST",
          "disposed/read-generation fence and current owner invalidation; known exact receipt deletes; unknown retained; HTTP mutation has no explicit local abort timer",
          "ephemeral original request; no automatic replay",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/dialog-event-work.tsx:requests",
        [
          "original SDK-client EventWork UI request owner",
          "client + scope/directory/workspace/sourceSessionID",
          "32 entries per original client, checked before mutation POST",
          "10s request abort and owner cleanup; known exact receipt deletes; first definitive failure may delete; prior unknown retained",
          "ephemeral structured original request; explicit retries only",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/components/dialog-mcp-secrets.tsx:pending",
        [
          "original SDK client migration-request custody",
          "client identity + directory/name; TUI also workspace",
          "32 unresolved migration IDs per actual SDK client; gate before commit POST; different existing original ID cannot replace unknown",
          "UI cleanup aborts request/generation; unknown remains counted across remount; only exact original committed receipt deletes entry; independent client has independent bound",
          "ephemeral original ID only; original backend remains credential authority",
          "production MCP credentials dialog",
          "safe_scoped",
        ],
      ],
      [
        "packages/app/src/utils/im-client.ts:httpObservations",
        [
          "IM UI original HTTP-message provenance",
          "actual IMMessage object identity",
          "membership marker only, no strong payload/OS resource retained",
          "weak original message GC with UI projection lifecycle",
          "ephemeral stale-HTTP replacement marker; no permission",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/browser-view.ts:views",
        [
          "Electron Main human-browser physical view",
          "actual BrowserWindow and original WebContentsView incarnation",
          "32 actual physical views TOTAL per Main module, including active/closing/unknown; one original incarnation per host; gate before WebContentsView construction",
          "one close issued; 5s timeout keeps original strong custody, WeakMap slot and permanent destroyed listener; all same-host replacement/navigation refused while closing; actual destroyed event retires only original entry",
          "physical resource custody to actual destruction; no implicit retry after unknown, no agent browser authority",
          "production navigation-only browser IPC",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/managed-browser-clipboard-confirmation.ts:facts",
        [
          "dedicated Electron QA process managed-browser-clipboard-confirmation",
          "fixture invocation/original App or UtilityProcess",
          "4 fixed confirmation scenarios, original lease released/window destroyed",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/managed-browser-clipboard-physical.ts:state",
        [
          "dedicated Electron QA process managed-browser-clipboard-physical",
          "fixture invocation/original App or UtilityProcess",
          "fixed read/write/restore-CAS scenarios; external clipboard change prevents restoration",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/managed-browser-input-ime.ts:windows",
        [
          "dedicated Electron QA process managed-browser-input-ime",
          "fixture invocation/original App or UtilityProcess",
          "fixed original IME/window scenario list; Native lease disposed and all windows destroyed",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/managed-browser-input-main.ts:checkpoint",
        [
          "dedicated Electron QA process managed-browser-input-main",
          "fixture invocation/original App or UtilityProcess",
          "fixed controlled browser command sequence and scalar checkpoint",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/managed-browser-input-observer.ts:facts",
        [
          "dedicated Electron QA process managed-browser-input-observer",
          "fixture invocation/original App or UtilityProcess",
          "fixed three observer windows and scripted input/churn facts",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/managed-browser-input-observer.ts:windows",
        [
          "dedicated Electron QA process managed-browser-input-observer",
          "fixture invocation/original App or UtilityProcess",
          "fixed three observer windows and scripted input/churn facts",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/shutdown-bootstrap.ts:facts",
        [
          "dedicated Electron QA process shutdown-bootstrap",
          "fixture invocation/original App or UtilityProcess",
          "one UtilityProcess target, fixed shutdown facts and 10s kill/exit deadline",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/shutdown-bootstrap.ts:target",
        [
          "dedicated Electron QA process shutdown-bootstrap",
          "fixture invocation/original App or UtilityProcess",
          "one UtilityProcess target, fixed shutdown facts and 10s kill/exit deadline",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/shutdown-utility.ts:facts",
        [
          "dedicated Electron QA process shutdown-utility",
          "fixture invocation/original App or UtilityProcess",
          "one utility process, fixed stop facts and normal/refusal script",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/sidecar-shutdown-server.ts:facts",
        [
          "dedicated Electron QA process sidecar-shutdown-server",
          "fixture invocation/original App or UtilityProcess",
          "one fixture server and fixed HTTP/ws/mdns/force shutdown stages",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/sidecar-stop-main.ts:facts",
        [
          "dedicated Electron QA process sidecar-stop-main",
          "fixture invocation/original App or UtilityProcess",
          "one child, fixed stop facts, 12s kill/exit deadline",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/sidecar-stop-utility.ts:facts",
        [
          "dedicated Electron QA process sidecar-stop-utility",
          "fixture invocation/original App or UtilityProcess",
          "one utility process and fixed normal/refusal stop scenario",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/startup.ts:facts",
        [
          "dedicated Electron QA process startup",
          "fixture invocation/original App or UtilityProcess",
          "one startup App and void pathsReady Deferred, fixed startup booleans/5s deadline",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/fixture/startup.ts:pathsReady",
        [
          "dedicated Electron QA process startup",
          "fixture invocation/original App or UtilityProcess",
          "one startup App and void pathsReady Deferred, fixed startup booleans/5s deadline",
          "fixture original cleanup/stop joins; explicit app/process exit and watchdog; not product admission policy",
          "ephemeral fixture facts/scalars; no external authority",
          "dedicated QA entry only; normal Main index import closure excludes fixture",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/index.ts:pathsReady",
        [
          "Main bootstrap path initialization",
          "one void Deferred per Main process",
          "one success/failure gate, no queue entries",
          "Bootstrap onExit fails gate or success completes before normal startup",
          "ephemeral initialization synchronization",
          "production Main bootstrap",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/managed-browser-clipboard.ts:lease",
        [
          "Main clipboard confirmation lease",
          "one actual active clipboard operation",
          "capacity1 checked before confirmation; deadline/byte contract",
          "idempotent release clears deadline/window listener and active flag; confirmation failure releases; physical caller finally releases",
          "ephemeral original native lease; Native current/readback remain authoritative",
          "production managed-browser clipboard producer",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/sidecar.ts:serverURL",
        [
          "Main fixed installed module URL",
          "one module-local URL/process, pathname set once for unpacking",
          "single fixed installed import/require locator",
          "process lifetime; URL has no independent OS resource",
          "ephemeral module locator; signed/captured assets checked elsewhere",
          "production Main sidecar bootstrap",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/startup.ts:initialized",
        [
          "original Electron App startup owner",
          "actual App object identity",
          "one initialized startup value per App",
          "App process lifetime; no additional live I/O retained by map",
          "ephemeral paths/startup facts",
          "production Electron startup",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/windows-native-sidecar.ts:addonURL",
        [
          "Main fixed installed module URL",
          "one module-local URL/process, pathname set once for unpacking",
          "single fixed installed import/require locator",
          "process lifetime; URL has no independent OS resource",
          "ephemeral module locator; signed/captured assets checked elsewhere",
          "production Main sidecar bootstrap",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/windows-native-sidecar.ts:retained",
        [
          "Main original Native sidecar close custody",
          "original captured Native sidecar lease/NAPI environment",
          "Native napi.prepare_sidecar sidecars.len<4 BEFORE prepare; JS retained closures correspond to original live leases",
          "confirmed close removes closure; unconfirmed close retains original closure/Native handles until env teardown; no silent eviction",
          "ephemeral opaque lease with original signed installation/current",
          "production Windows Native sidecar",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/auth.ts:authConstructions",
        [
          "LLM original credential/auth constructor",
          "actual Credential or Auth object identity",
          "one description/load/apply identity per constructed object; not a global numerical cap",
          "weak original object lifetime; no extra I/O handle; original Redacted credential owner retains secret",
          "ephemeral construction identity; serialized description not a credential permission",
          "production LLM auth construction",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/auth.ts:credentialConstructions",
        [
          "LLM original credential/auth constructor",
          "actual Credential or Auth object identity",
          "one description/load/apply identity per constructed object; not a global numerical cap",
          "weak original object lifetime; no extra I/O handle; original Redacted credential owner retains secret",
          "ephemeral construction identity; serialized description not a credential permission",
          "production LLM auth construction",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/builtin-node.ts:create@101:106.pending",
        [
          "original BuiltinNode.create transport Scope",
          "one transport http/https Agent and original request/response objects",
          "production client.nativeManagedLayer binds max32 live Native requests per client; one original transport/Scope; no independent global cap claimed",
          "request/response close removes original Set membership; abort/cancel destroys resources; Scope close destroys all+agents and joins close; 1s unconfirmed close raises refusal, does not refresh/replay",
          "ephemeral real network resource custody, not a weak provenance marker",
          "production sole builtinNodeLayer consumer is nativeManagedLayer; fixture create calls separate",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/builtin-node.ts:create@101:107.responses",
        [
          "original BuiltinNode.create transport Scope",
          "one transport http/https Agent and original request/response objects",
          "production client.nativeManagedLayer binds max32 live Native requests per client; one original transport/Scope; no independent global cap claimed",
          "request/response close removes original Set membership; abort/cancel destroys resources; Scope close destroys all+agents and joins close; 1s unconfirmed close raises refusal, does not refresh/replay",
          "ephemeral real network resource custody, not a weak provenance marker",
          "production sole builtinNodeLayer consumer is nativeManagedLayer; fixture create calls separate",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/builtin-node.ts:state",
        [
          "Node Native bootstrap capture",
          "one module process state",
          "singleton installed/active state",
          "process lifecycle and original startup current checks",
          "ephemeral native environment/fetch identity; no extra resource",
          "production Native Node transport",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/client.ts:nativeClients",
        [
          "original LLM Native client Layer Scope",
          "actual client identity + original single-use request witness",
          "32 live requests/client before binding; per-request canonical byte limit",
          "request finalizer marks inactive/body undefined and decrements; Layer finalizer invalidates client and closes original executor Scope",
          "ephemeral original opaque request construction; count/current verifier separate",
          "production Native managed LLM client",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/client.ts:routeIntegrity",
        [
          "original LLM built Route constructor",
          "actual Route object identity + exact original function/member integrity",
          "one callback per original route; no OS resource or extra copied payload",
          "weak original Route lifetime; integrity checked at binding",
          "ephemeral construction integrity; not route approval",
          "production LLM routes",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/executor.ts:builtinExecutors",
        [
          "original builtin executor Layer Scope",
          "actual original executor object and captured boundary",
          "one captured boundary per original executor; request admission max32/client downstream",
          "Scope finalizer boundary.active=false and deletes original entry; underlying transport close finalizer",
          "ephemeral construction/current provenance",
          "production original builtin LLM executors",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/executor.ts:builtinObservations",
        [
          "original native request observation producer",
          "actual original RequestSealInput; builtin map also same original boundary/request",
          "one marker/fact per original observation; body/count limits checked by original consumers",
          "weak original observation lifetime; counted marker enforces consume-once; no extra Native lease in registry",
          "ephemeral provenance, not cloned observation/permission",
          "production Native LLM request/count consumers",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/executor.ts:closure@755:756.abort",
        [
          "single original countBuiltinResponses invocation",
          "original request/boundary and AbortSignal",
          "one AbortController/count; deadline <=10s; response <=16384 bytes",
          "finally clears timeout/removes external abort listener/cancels body; reader finally cancels; no retry",
          "ephemeral bounded input-token-count I/O",
          "production native input count",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/executor.ts:countedObservations",
        [
          "original native request observation producer",
          "actual original RequestSealInput; builtin map also same original boundary/request",
          "one marker/fact per original observation; body/count limits checked by original consumers",
          "weak original observation lifetime; counted marker enforces consume-once; no extra Native lease in registry",
          "ephemeral provenance, not cloned observation/permission",
          "production Native LLM request/count consumers",
          "safe_scoped",
        ],
      ],
      [
        "packages/llm/src/route/executor.ts:nativeObservations",
        [
          "original native request observation producer",
          "actual original RequestSealInput; builtin map also same original boundary/request",
          "one marker/fact per original observation; body/count limits checked by original consumers",
          "weak original observation lifetime; counted marker enforces consume-once; no extra Native lease in registry",
          "ephemeral provenance, not cloned observation/permission",
          "production Native LLM request/count consumers",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/dialog-attention.tsx:pendingCommands",
        [
          "original SDK-client attention dialog",
          "actual client + captured scope/url/transport identity",
          "one value per client per WeakMap; no historical entry array",
          "cleanup invalidates epoch and aborts reads/timers; known command receipt deletes; bookmark only current cleanup",
          "ephemeral pending original command or read-only bookmark; no extra grant",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/dialog-browser-control.tsx:controls",
        [
          "original SDK-client browser-control owner",
          "client + scope/directory/sessionID",
          "64 retained controls per original client, gate before entry",
          "cleanup invalidates alive/generation and aborts timer; unknown original command retained",
          "ephemeral original request only; Native current required",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/dialog-browser-files.tsx:drafts",
        [
          "original SDK-client file-exchange draft owner",
          "client + scope/directory/controlID",
          "64 retained drafts per original client, gate before new entry",
          "alive/activeOwner/generation fence; abort request on cleanup; explicit unknown reconciliation; no eviction",
          "ephemeral exact request drafts; backend/Native proof authoritative",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/dialog-event-validation.tsx:requests",
        [
          "original SDK-client EventValidation request owner",
          "client + scope/directory/sourceSessionID",
          "32 retained entries per original client; checked before mutation POST",
          "disposed/read-generation fence and current owner invalidation; known exact receipt deletes; unknown retained; HTTP mutation has no explicit local abort timer",
          "ephemeral original request; no automatic replay",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/dialog-event-work.tsx:requests",
        [
          "original SDK-client EventWork UI request owner",
          "client + scope/directory/workspace/sourceSessionID",
          "32 entries per original client, checked before mutation POST",
          "10s request abort and owner cleanup; known exact receipt deletes; first definitive failure may delete; prior unknown retained",
          "ephemeral structured original request; explicit retries only",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/dialog-mcp-secrets.tsx:pending",
        [
          "original SDK client migration-request custody",
          "client identity + directory/name; TUI also workspace",
          "32 unresolved migration IDs per actual SDK client; gate before commit POST; different existing original ID cannot replace unknown",
          "UI cleanup aborts request/generation; unknown remains counted across remount; only exact original committed receipt deletes entry; independent client has independent bound",
          "ephemeral original ID only; original backend remains credential authority",
          "production MCP credentials dialog",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/im-client.ts:httpObservations",
        [
          "IM UI original HTTP-message provenance",
          "actual IMMessage object identity",
          "membership marker only, no strong payload/OS resource retained",
          "weak original message GC with UI projection lifecycle",
          "ephemeral stale-HTTP replacement marker; no permission",
          "production UI",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/im-media-preview.ts:current",
        [
          "TUI media-preview process owner",
          "one current authenticated preview plus scalar generation",
          "one active preview; maxConnections2, requests8, resources4; byte/MIME contract and 60s expiry",
          "replacement closes old; abort/error/expiry closes server/connections and timer/listener; generation mismatch closes late setup",
          "ephemeral local preview ticket; no bearer in URL",
          "production TUI media preview",
          "safe_scoped",
        ],
      ],
      [
        "packages/tui/src/component/im-media-preview.ts:generation",
        [
          "TUI media-preview process owner",
          "one current authenticated preview plus scalar generation",
          "one active preview; maxConnections2, requests8, resources4; byte/MIME contract and 60s expiry",
          "replacement closes old; abort/error/expiry closes server/connections and timer/listener; generation mismatch closes late setup",
          "ephemeral local preview ticket; no bearer in URL",
          "production TUI media preview",
          "safe_scoped",
        ],
      ],
      [
        "packages/desktop/src/main/browser-view.ts:custody",
        [
          "Electron Main original physical browser custody",
          "original Entry captures original actual BrowserWindow/WebContentsView",
          "MAX_BROWSER_VIEWS=32 checked before create, all active/closing/unknown entries included",
          "only original actual destroyed event removes entry; close timeout retains original and consumes capacity; one close only",
          "ephemeral actual physical resource custody; unknown not evicted/replayed",
          "production navigation-only human browser IPC",
          "safe_scoped",
        ],
      ],
    ] as const
  ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

const reviewedFiniteLifetimes: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  (
    [
      [
        "packages/core/src/cross-spawn-spawner.ts:processCustody",
        [
          "original generic process custody",
          "one original ChildProcess and reserved slot",
          "128 live plus strong unknown custody; reserve before spawn",
          "known original root/stdio lifecycle releases slot; unknown scope-close/close/unref retains exact process and consumes slot",
          "ephemeral process custody, no Native whole-tree proof; unknown never automatically replayed",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/cross-spawn-spawner.ts:processSlots",
        [
          "original generic process custody",
          "one original ChildProcess and reserved slot",
          "128 live plus strong unknown custody; reserve before spawn",
          "known original root/stdio lifecycle releases slot; unknown scope-close/close/unref retains exact process and consumes slot",
          "ephemeral process custody, no Native whole-tree proof; unknown never automatically replayed",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/cross-spawn-spawner.ts:closure@122:386.unknownStops",
        [
          "original generic process custody",
          "one original ChildProcess and reserved slot",
          "128 live plus strong unknown custody; reserve before spawn",
          "known original root/stdio lifecycle releases slot; unknown scope-close/close/unref retains exact process and consumes slot",
          "ephemeral process custody, no Native whole-tree proof; unknown never automatically replayed",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/event-validation-consumer.ts:closure@11:16.timers",
        [
          "original EventValidation consumer Scope",
          "original configured ruleID/projectKey",
          "MAX_RULES256 per instance, one timer per rule and one running per project; no historical independent keys",
          "cancel removes and interrupts original timer; known run deletes running/backoff; scope joins forkIn fibers and invalidates active owner",
          "SQL rule/run facts remain authority; maps are advisory scheduling only",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/event-validation-consumer.ts:closure@11:17.running",
        [
          "original EventValidation consumer Scope",
          "original configured ruleID/projectKey",
          "MAX_RULES256 per instance, one timer per rule and one running per project; no historical independent keys",
          "cancel removes and interrupts original timer; known run deletes running/backoff; scope joins forkIn fibers and invalidates active owner",
          "SQL rule/run facts remain authority; maps are advisory scheduling only",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/event-validation-consumer.ts:closure@11:18.backoff",
        [
          "original EventValidation consumer Scope",
          "original configured ruleID/projectKey",
          "MAX_RULES256 per instance, one timer per rule and one running per project; no historical independent keys",
          "cancel removes and interrupts original timer; known run deletes running/backoff; scope joins forkIn fibers and invalidates active owner",
          "SQL rule/run facts remain authority; maps are advisory scheduling only",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child-policy.ts:bindings",
        [
          "original GoalTick frame and ChildPolicy permit",
          "original current permitID/frame plus binding hash",
          "MAX_FRAMES32; MAX_BINDINGS256 and 67108864 bytes per frame",
          "releaseRole verifies original terminal role then deletes binding; frame revoke/release deletes owned bindings and frame",
          "original permit/current and SQL lineage remain authority; no cold reconstruction",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/deepagent/goal-child-policy.ts:liveFrames",
        [
          "original GoalTick frame and ChildPolicy permit",
          "original current permitID/frame plus binding hash",
          "MAX_FRAMES32; MAX_BINDINGS256 and 67108864 bytes per frame",
          "releaseRole verifies original terminal role then deletes binding; frame revoke/release deletes owned bindings and frame",
          "original permit/current and SQL lineage remain authority; no cold reconstruction",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/mcp-app-invocation.ts:hosts",
        [
          "original registered MCP host Scope",
          "exact Location key and original registration entry",
          "64 locations; 32 stacked registrations per location",
          "Scope deactivates exact entry, filters stack, deletes empty key",
          "runtime registration only; durable invocation authority separate",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/mcp-app-invocation.ts:live",
        [
          "original MCP invocation preparation/dispatch custody",
          "original invocationID and current host/context",
          "pendingGlobal64 including preparing, pending and unknown; synchronous pre-capture reservation",
          "failed no-effect preparation removes placeholder; known SQL settle/cancel removes original Live; unknown and failed receipt reads retain",
          "original SQL invocation receipt remains authoritative; unknown never retried/refunded automatically",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/projector.ts:closure@678:683.liveWireParts",
        [
          "SessionProjector original Event subscription Scope",
          "original Session/message/fragment identity",
          "2048 live fragments; full refuses new advisory fragment",
          "terminal/delete removes exact fragments; unsubscribe finalizer clears map",
          "advisory wire fragment identity only; original durable Event/Session rows retained",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/task-human-control.ts:closure@51:69.interruptions",
        [
          "one original Task human-control transaction call",
          "distinct existing descendant Session IDs collected in that call",
          "finite original SQL task subtree for one call, not a process cache or admission ledger",
          "post-commit original SessionExecution.interrupt then invocation returns; no retained reference",
          "durable Task control CAS/current are authority; invocation Set only deduplicates interruptions",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/task-run.ts:closure@948:952.interruptions",
        [
          "one original Task human-control transaction call",
          "distinct existing descendant Session IDs collected in that call",
          "finite original SQL task subtree for one call, not a process cache or admission ledger",
          "post-commit original SessionExecution.interrupt then invocation returns; no retained reference",
          "durable Task control CAS/current are authority; invocation Set only deduplicates interruptions",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/owned-validation.ts:quarantine",
        [
          "original OwnedValidation process custody",
          "original unknown Entry with handles/receipt",
          "128 active plus unknown custody slots reserved before prepare",
          "only original confirmed known release refunds; unknown remains strong across Scope close and no second kill/replay",
          "ephemeral original handles; root exit alone is not containment or Native tree retirement",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/auth-password-worker-client.node.ts:derive@23:35.worker",
        [
          "one original password derivation call",
          "one exact Worker created by derive",
          "one worker per call; resourceLimits heap64MiB/young16MiB/stack4MiB",
          "finally original worker.terminate and listeners/timer removal; password buffers scrubbed",
          "no password result cache or execution permission",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/auth-runtime.ts:waiting",
        [
          "original auth derivation process pool",
          "original queued derivation request",
          "waiting queue32 and concurrent2; original5s timeout",
          "completion/error/timeout dequeues, closes worker and scrubs original buffers",
          "transient derivation only; no credential authority from queue",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-work-placement.ts:closure@55:61.byWork",
        [
          "original Event DAG placement Scope",
          "exact admitted graph Work/configuration/retirement identity",
          "original graph admission32 nodes, one current configuration/readiness per owned Work",
          "per-Work/config retirement removes entries; Root finalizer deactivates entries and clears all three maps",
          "SQL DAG/Work and original Native current remain authority; cached readiness cannot authorize old execution",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-work-placement.ts:closure@55:62.configurations",
        [
          "original Event DAG placement Scope",
          "exact admitted graph Work/configuration/retirement identity",
          "original graph admission32 nodes, one current configuration/readiness per owned Work",
          "per-Work/config retirement removes entries; Root finalizer deactivates entries and clears all three maps",
          "SQL DAG/Work and original Native current remain authority; cached readiness cannot authorize old execution",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-work-placement.ts:closure@55:66.readiness",
        [
          "original Event DAG placement Scope",
          "exact admitted graph Work/configuration/retirement identity",
          "original graph admission32 nodes, one current configuration/readiness per owned Work",
          "per-Work/config retirement removes entries; Root finalizer deactivates entries and clears all three maps",
          "SQL DAG/Work and original Native current remain authority; cached readiness cannot authorize old execution",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/native-runtime.ts:closure@228:248.active",
        [
          "original NativeRuntime Root and tool Scope",
          "exact original Native handle/capture object",
          "original runtime handles/capture admission32; SQL Work/turn owners govern calls",
          "individual Scope removes exact capture/handle; Root deactivates, deletes all memberships, clears sets and zeroizes key",
          "opaque original source membership only; Native/current checks remain required",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/native-runtime.ts:closure@228:261.activeCaptures",
        [
          "original NativeRuntime Root and tool Scope",
          "exact original Native handle/capture object",
          "original runtime handles/capture admission32; SQL Work/turn owners govern calls",
          "individual Scope removes exact capture/handle; Root deactivates, deletes all memberships, clears sets and zeroizes key",
          "opaque original source membership only; Native/current checks remain required",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/provider-credential-binding.ts:closure@77:88.live",
        [
          "original ProviderCredentialBinding Root/turn Scope",
          "original native credential capture and binding hash",
          "32 live captures and 32 count bindings; schema record byte limits",
          "individual finalizer deletes only matching capture/binding; Root clears all maps and zeroizes secret",
          "ephemeral original membership; durable count receipt and Native current remain authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/provider-credential-binding.ts:closure@77:89.countBindings",
        [
          "original ProviderCredentialBinding Root/turn Scope",
          "original native credential capture and binding hash",
          "32 live captures and 32 count bindings; schema record byte limits",
          "individual finalizer deletes only matching capture/binding; Root clears all maps and zeroizes secret",
          "ephemeral original membership; durable count receipt and Native current remain authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-native-bootstrap.ts:installed",
        [
          "original Windows preloaded entry bootstrap",
          "one installed original FirstLoad port per entry",
          "one install; fixed purpose/EXE/module/preload/native current gates",
          "Root original capture and environment finalizer retire entry; changed/foreign receipt cannot reconstruct registration",
          "one private Native registration, no cold DTO registration or Work grant",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-private-storage.ts:originals",
        [
          "original Windows private installation leaf pin",
          "original Root capture/local_operator fixed installation.json lease",
          "Native at most8 live leases, 32 operations, 30s lifetime; leaf<=1024 bytes",
          "Scope closes original pinned leaf; unknown Native close retains custody; Buffer zeroized each API",
          "original held parent/name/FileID/User/protectedDACL/stamp plus actual hash checked; no time cache/path DTO",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command-custody.ts:closure@26:33.preparations",
        [
          "original Windows Command Custody/Scope",
          "exact original preparation object/Root/DB/Factory/command Scope",
          "one preparation for each original bounded Command scope; Native private pin8 admission",
          "capture consumes once; Scope deactivates/removes WeakMap and closes original leaf pin",
          "last held.current and currentBinding before pure SQL/MAC; instanceID observation never authorizes",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command-custody.ts:closure@26:36.retained",
        [
          "original Windows Command Custody finalizer",
          "original failed cleanup closure with held native lease",
          "bounded by same Native8 original private lease admission; no detached new key namespace",
          "only actual successful close removes cleanup; unknown strongly retains original, no replay",
          "original opaque lease retained; historical SQL/MAC untouched",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command-runtime.ts:closure@36:43.leases",
        [
          "original Windows command workspace Root Scope",
          "original native Workspace External/cleanup closure",
          "MAX_CUSTODY8; native workspace admission8 includes unknown",
          "only native.close successful return sets inactive and deletes; failed close retains exact active original plus cleanup closure",
          "no path DTO can construct workspace; unknown close never represented as known retirement",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command-runtime.ts:retained",
        [
          "original Windows command workspace Root Scope",
          "original native Workspace External/cleanup closure",
          "MAX_CUSTODY8; native workspace admission8 includes unknown",
          "only native.close successful return sets inactive and deletes; failed close retains exact active original plus cleanup closure",
          "no path DTO can construct workspace; unknown close never represented as known retirement",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-command.ts:closure@60:65.owned",
        [
          "original Windows command execution Scope",
          "exact command admission/opaque workspace/supervisor receipt",
          "MAX_CUSTODY8 and original Native command factory admission",
          "known SQL/MAC release retires owned entry; unknown retains original state and cannot repeat dispatch",
          "original Ready->durable Continue->Stop proof plus Windows custody authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-factory.ts:retained",
        [
          "original Windows WorkFactory Root",
          "original failed Native close closure",
          "same Native bridge8/env and original Factory image128 admission; no external path-created owner",
          "only actual original close joins child/command/workspace and removes retained cleanup; unknown retains",
          "same capture/factory lifetime and fixed Installed image facts; no extra execution owner",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/windows-work-file-helper.ts:children",
        [
          "original Windows helper native process adapter",
          "original Factory plus exact Child External",
          "8 including opening and unknown; queue16/frame byte limits",
          "delete only actual native close with Job empty/root join/dual EOF/writer join; unknown strong retention",
          "original native process custody only; no Node spawn or inferred tree retirement",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-command-runtime.ts:cleanupPreparedWorkspace@157:162.ancestors",
        [
          "one original command workspace cleanup invocation",
          "exact held workspace traversal/manifest in that call",
          "finite original bounded workspace/output inventory, no module cache",
          "call returns after exact held checks and cleanup; unknown retained by SQL/workspace owner",
          "temporary cleanup plan, not execution permission; no release from path DTO",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-command-runtime.ts:cleanupWorkspace@99:103.directories",
        [
          "one original command workspace cleanup invocation",
          "exact held workspace traversal/manifest in that call",
          "finite original bounded workspace/output inventory, no module cache",
          "call returns after exact held checks and cleanup; unknown retained by SQL/workspace owner",
          "temporary cleanup plan, not execution permission; no release from path DTO",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-command-runtime.ts:cleanupWorkspace@99:104.files",
        [
          "one original command workspace cleanup invocation",
          "exact held workspace traversal/manifest in that call",
          "finite original bounded workspace/output inventory, no module cache",
          "call returns after exact held checks and cleanup; unknown retained by SQL/workspace owner",
          "temporary cleanup plan, not execution permission; no release from path DTO",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-execution-profile.ts:closure@93:133.active",
        [
          "original WorkExecutionProfile Root/turn",
          "actual native provider profile/turn token",
          "32 active profiles under original serialized Session/provider turn admission",
          "individual Scope deletes exact token; Root invalidates, clears map, zeroizes secret",
          "original Work/source/runtime observation only; current and receipt gates remain separate",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-file-helper.ts:closure@92:98.active",
        [
          "original WorkFileHelper Scope",
          "exact original helper Entry",
          "8 including synchronous opening reservations and unknown; frame65536/payload51200",
          "only actual helper stopped lifecycle removes active; Scope close timeout retains unknown and cannot mint stopped receipt",
          "original helper/held root membership; unknown effect cannot replay",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-file-helper.ts:closure@92:100.commandWorkspaces",
        [
          "original WorkFileHelper command custody",
          "exact admissionID and original helper-held snapshot",
          "MAX_CUSTODY8",
          "known command SQL/security/manifest permits original file.close then deletes entry; Root closes owned originals",
          "opaque Workspace and original custody remain authority; historical JSON never reconstructs held root",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-known-recovery.ts:closure@37:55.live",
        [
          "original known-history inspection Scope",
          "exact recovery witness",
          "one active witness per Root scope",
          "individual finalizer deletes original witness; Root invalidates, clears, zeroizes secret",
          "historical known MAC inspection only; never reauthorizes dispatch/unknown replay",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-known-recovery-v2.ts:closure@39:57.live",
        [
          "original known-history inspection Scope",
          "exact recovery witness",
          "one active witness per Root scope",
          "individual finalizer deletes original witness; Root invalidates, clears, zeroizes secret",
          "historical known MAC inspection only; never reauthorizes dispatch/unknown replay",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-leaf-proof.ts:closure@57:80.recoveryLive",
        [
          "original LeafProof recovery Scope",
          "original minted recovery token",
          "32 original recovery tokens",
          "consume deletes exact token and WeakMap entry; Root deactivates/clears/zeroizes all keys",
          "historical known proof only; replay/current dispatch separate",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-leaf-proof.ts:closure@57:81.verified",
        [
          "original LeafProof historical consumer Scope",
          "exact effectID verification facts",
          "128 verified terminal effects per scope",
          "Root finalizer clears and zeroizes; original current/known MAC checks on consumer",
          "historical verification cache never dispatch authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-storage-cleanup.ts:jobs",
        [
          "original bounded durable storage cleanup operation",
          "exact cleanupID and original pending Promise",
          "SQL MAX_ACTIVE40; original instance retained record/bytes quotas, operation bounded33.5s",
          "ensuring awaits original operation before jobs.delete; Native unknown storage remains durable custody",
          "SQL terminal/custody and Native held manifest are authority; no automatic unknown replay",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/work-storage-cleanup.ts:closure@853:938.controller",
        [
          "one original Native cleanup subprocess operation",
          "one AbortController per original cleanupID",
          "same SQL MAX_ACTIVE40 and original operation deadline",
          "Effect cancellation aborts original controller; ensuring joins original pending operation before jobs.delete;operation-local signal/controller then unreachable",
          "cancellation signal only, never fabricated cleanup proof",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/lsp/client.ts:create@148:178.generations",
        [
          "original live LSP client/document protocol",
          "exact opened path and monotonic client generation",
          "4096 current documents synchronously reserved; same path update retained; unopened diagnostic never enters authority map",
          "didClose/connection close/shutdown remove exact generation/push; reopen receives new generation permanently invalidating old proof",
          "original LSP/Filesystem generation current checks; ordinary unopened SDK project diagnostics preserved",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/lsp/client.ts:create@148:179.checkedPushes",
        [
          "original live LSP client/document protocol",
          "exact opened path and monotonic client generation",
          "4096 current documents synchronously reserved; same path update retained; unopened diagnostic never enters authority map",
          "didClose/connection close/shutdown remove exact generation/push; reopen receives new generation permanently invalidating old proof",
          "original LSP/Filesystem generation current checks; ordinary unopened SDK project diagnostics preserved",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/app-resource.ts:make@134:135.snapshots",
        [
          "original MCP app-resource Instance",
          "current observed configured server bindings",
          "one current config snapshot map rebuilt by observe; source ConfigFileWrite bytes<=16777216",
          "observe clears previous map; instance dispose clears snapshots/views",
          "observation only, exact config/native/credential current checks remain authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/app-resource.ts:make@134:136.views",
        [
          "original MCP app-resource view owner",
          "original viewID/server/resource current binding",
          "LIMITS.views64 plus original byte/MIME/request lifetime",
          "close/expiry/reconcile removes view; dispose aborts pending and clears",
          "ephemeral resource view; original server/native invocation permission remains separate",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/auth-scope.ts:closure@81:90.runtime",
        [
          "original opaque MCP Instance auth scope",
          "exact InstanceRef/name/config digest/incarnation",
          "names<=journal256, name<=512; synchronous check/add after snapshot",
          "exact durable config retires corresponding transient; InstanceStateDisposer clears/deletes after closing flows/client",
          "64hex digest/incarnation only, no cloned secret; original journal remains authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/index.ts:closure@1328:1330.collisions",
        [
          "one current MCP tools enumeration invocation",
          "canonical names for current configured connected servers",
          "finite current configured client/tool inventory, not historical cache",
          "invocation return discards set",
          "dedup/collision detection only, no authorization state",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/local-operator.ts:installed",
        [
          "actual TUI worker parentPort MCP bootstrap",
          "one installation/current bridge",
          "one installed bridge; no arbitrary Access mint",
          "bridge close marks inactive, aborts original requests, releases tickets, waits settled, closes port",
          "private actual native operator bridge; config/account/current checks remain separate",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/local-operator.ts:closeBridge",
        [
          "actual TUI worker parentPort MCP bootstrap",
          "one installation/current bridge",
          "one installed bridge; no arbitrary Access mint",
          "bridge close marks inactive, aborts original requests, releases tickets, waits settled, closes port",
          "private actual native operator bridge; config/account/current checks remain separate",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/local-operator.ts:nativeOperations",
        [
          "actual TUI MCP mutation owner",
          "original canonical directory with live mutation count",
          "requests<=8 per one actual worker bridge; mutation is serialized original owner",
          "finally decrements/removes original directory count after mutation settles; startup blocked while pending",
          "startup exclusion only, not execution authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/local-operator.ts:closure@101:117.requests",
        [
          "actual TUI worker MCP request owner",
          "original monotonic request ID",
          "8 live requests reserved before request work; deadline<=McpOperatorClient.LIMIT_MS",
          "finally clears timer, aborts original controller, removes request and signals settled; close waits original requests",
          "transient private request, original current guard rejects revoked bridge",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/local-operator.ts:closure@166:203.controller",
        [
          "actual TUI worker MCP request owner",
          "original monotonic request ID",
          "8 live requests reserved before request work; deadline<=McpOperatorClient.LIMIT_MS",
          "finally clears timer, aborts original controller, removes request and signals settled; close waits original requests",
          "transient private request, original current guard rejects revoked bridge",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/local-operator.ts:closure@101:118.tickets",
        [
          "actual TUI worker MCP interaction owner",
          "original random Access ticket/current config/account fingerprint",
          "admission tickets8 before observe and at most8 in-flight requests; overlapping preparations retain fewer than16 tickets",
          "release marks inactive, clears timer, awaits original cancel, deletes only finally; bridge close releases all",
          "ephemeral exact original Access; TTL/config/account/server-current checks required, no cold reconstruction",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/oauth-callback.ts:owners",
        [
          "original OAuth callback lease",
          "exact owner lease and requested state",
          "MAX_PENDING_AUTHS64; one pending waiter per original lease",
          "timeout/cancel/close deletes waiter and owner; actual listener ownership closes when empty",
          "callback/state matching only; original OAuth/credential journal still authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/oauth-callback.ts:pending",
        [
          "original OAuth callback lease",
          "exact owner lease and requested state",
          "MAX_PENDING_AUTHS64; one pending waiter per original lease",
          "timeout/cancel/close deletes waiter and owner; actual listener ownership closes when empty",
          "callback/state matching only; original OAuth/credential journal still authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/oauth-callback.ts:listeners",
        [
          "original OAuth callback socket owner",
          "exact host/port listener with original live owners",
          "128 actual listeners, bounded64 lease owners",
          "last owner retirement closes exact socket and removes listener; shutdown closes originals",
          "ephemeral callback server lifecycle; no arbitrary callback authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/oauth-callback.ts:closure@94:128.server",
        [
          "original OAuth callback socket owner",
          "exact host/port listener with original live owners",
          "128 actual listeners, bounded64 lease owners",
          "last owner retirement closes exact socket and removes listener; shutdown closes originals",
          "ephemeral callback server lifecycle; no arbitrary callback authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/oauth-callback.ts:compatibility",
        [
          "original compatibility OAuth lease",
          "one process compatibility owner plus name/state association",
          "one compatibility owner under original64 owner cap",
          "resolve/fail/stop removes original name/state; shutdown clears and closes owned callback lease",
          "compatibility observation only, original OAuth state checks required",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/oauth-provider.ts:McpOAuthProvider.writes@41",
        [
          "one original OAuth provider/flow object",
          "exact Promise from original async journal save",
          "only pending awaited writes for that live flow; settled promises removed rather than historic accumulation",
          "each original promise.finally deletes exact write; flow revoked before transport/callback close; pending promise owns provider until it settles",
          "pending completion bookkeeping only; journal and owner scope remain secret authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/secret-migration.ts:closure@91:98.previews",
        [
          "original secret-migration Instance preview Scope",
          "random original previewID with exact source/current fingerprint",
          "8 previews and 8 binding previews; original source byte limits",
          "expired sweep removes, exact commit consumes; instance scope deactivates owner",
          "preview observation only; exact current/source/journal/Work-unsettled guards required",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/mcp/secret-migration.ts:closure@91:102.bindingPreviews",
        [
          "original secret-migration Instance preview Scope",
          "random original previewID with exact source/current fingerprint",
          "8 previews and 8 binding previews; original source byte limits",
          "expired sweep removes, exact commit consumes; instance scope deactivates owner",
          "preview observation only; exact current/source/journal/Work-unsettled guards required",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/runtime/native-bootstrap.ts:state",
        [
          "original process Native bootstrap",
          "one immutable startup installation/verifier state",
          "one initialized state per process; fixed purpose/install/current fingerprint",
          "original entry/environment lifecycle; replacement/changed startup evidence rejected",
          "fixed startup binding, not a historical cache or cold dispatch grant",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/event-investigation.ts:closure@22:27.captures",
        [
          "original investigation HTTP/Native approval Scope",
          "original approval captureID and in-flight reservation",
          "32 including preparing; synchronous reservation before Native capture",
          "consume deletes exact approval; 60s expiry sweep; Root finalizer clears",
          "private current approval provenance, no query/body DTO mints permission",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/im-media.ts:uploads",
        [
          "original protected media upload admission",
          "same Root Semaphore permit",
          "2 active uploads with withPermitsIfAvailable typed full refusal",
          "Effect permit release on original complete/interruption",
          "admission semaphore only, original reader/media permission current checks remain",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/server/server.ts:goalListeners",
        [
          "original Node Server listener/bootstrap Scope",
          "actual Server object or original in-progress binding token",
          "one entry per actual owned listener/bootstrap transition; no historical request cache",
          "socket close/error/unbound failure removes exact authority; pending always removed in original finally; Scope unpublishes before replacement",
          "ephemeral actual listener provenance; no numeric stress claim or Native tree proof",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/server/server.ts:pendingGoalListeners",
        [
          "original Node Server listener/bootstrap Scope",
          "actual Server object or original in-progress binding token",
          "one entry per actual owned listener/bootstrap transition; no historical request cache",
          "socket close/error/unbound failure removes exact authority; pending always removed in original finally; Scope unpublishes before replacement",
          "ephemeral actual listener provenance; no numeric stress claim or Native tree proof",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/multi-agent-runtime.ts:closure@234:253.tokenUsage",
        [
          "policy-test MultiAgentRuntime fallback",
          "current agentID in one explicitly test-configured runtime",
          "production always uses original durable AgentExecution token ledger, not this fallback",
          "dies with test layer/runtime; current window resets scalar values",
          "QA fallback only; never production quota or execution authority",
          "policy tests without AgentExecution only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/multi-agent-runtime.ts:ancestorsOf@415:416.acc",
        [
          "one admitted graph ancestor traversal invocation",
          "current graph taskIDs",
          "approved production Event DAG32 nodes; QA custom partition not production dispatch authority",
          "call return discards Set",
          "DAG traversal dedup only, original admission/lineage is authority",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/runtime-status-events.ts:closure@42:47.pending",
        [
          "original advisory runtime-status SSE subscription",
          "exact Session ID including in-flight observer",
          "64 pending plus dropping Queue64; full fails SSE explicitly",
          "unsubscribe/Queue shutdown clears; each observer ensuring deletes original Session key",
          "advisory projection only, original terminal Event and Session runtime remain facts",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/core/src/session/input.ts:selections",
        [
          "original SessionInput selection owner",
          "original selection token/Session/request cutoff",
          "metadata only: exact Session/promotion/cutoff/count and original queue/steer sequence metadata, no retained full rows; promotion queries original rows in bounded128 steer pages plus at most one FIFO queue row",
          "current ordinal/location/delivery checks reject invalid selection; weak original selection object GC; original durable input not truncated",
          "original admitted FIFO/steer/current and projected history remain authority; rows re-read from SQL at promotion",
          "production original caller",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/import/job.ts:closure@31:36.active",
        [
          "original ImportJobs Root owner",
          "original new request admission/preflight/driver",
          "8 per original owner, reserved synchronously before any new target effect/new durable row; durable exact retry does not take new slot",
          "original uninterruptible fenced driver finally releases; unknown recovery remains original durable receipt and no auto re-import",
          "SQL import request digest/receipt authority; explicit existing unavailable IMPORT_JOB_CAPACITY only",
          "production original caller",
          "safe_scoped",
        ],
      ],
    ] as const
  ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

const reviewedHostOriginalLifetimes: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  (
    [
      [
        "packages/deepagent-code/src/attention/task-tui-private.ts:closeBridge",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/attention/task-tui-private.ts:closure@39:58.requests",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/attention/task-tui-private.ts:closure@82:121.controller",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/attention/task-tui-private.ts:installed",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/native-host.ts:closure@203:224.completed",
        [
          "one original BrowserNativeHost.execute scoped file transfer",
          "original action/transfer/approved artifactID",
          "files<=4; set only one actual observed leaf per approved artifact",
          "execute Scope lifetime; leaf busy synchronous before current/IO; no reused artifact; original cleanup receipt after all matching Native publications",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/native-host.ts:connect@56:63.controls",
        [
          "actual Electron utility original parentPort host incarnation",
          "controlID plus exact frozen descriptor/host/resource/credential generation",
          "MAX_CONTROLS256 before controls.set/create RPC; retained for entire original host",
          "port.close active=false and controls.clear; physical Main owns actual view destruction separately; credential generation revokes only",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/native-host.ts:connect@56:64.pending",
        [
          "actual original utility-parent RPC channel",
          "unique original requestID/action + Native current/file callback",
          "noncancel MAX_WAITING+MAX_ACTIVE_CONTROLS+4 before publish; cancel one cached RPC per original control (<=256)",
          "response clears exact timer/entry; timeout/interruption removes waiter only and exposes unknown; port.close invalidates host and clears waiters; physical Main custody independent",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/native-host.ts:installed",
        [
          "original Electron utility module bootstrap",
          "single real process.parentPort/electron utility incarnation",
          "one prepared Promise/installed host/credential observation callback per utility process; bootstrap30s",
          "port.close invalidates installed host; mismatch credential capture irreversibly revokes; no caller port/DTO registration factory",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/native-host.ts:observeConfiguration",
        [
          "original Electron utility module bootstrap",
          "single real process.parentPort/electron utility incarnation",
          "one prepared Promise/installed host/credential observation callback per utility process; bootstrap30s",
          "port.close invalidates installed host; mismatch credential capture irreversibly revokes; no caller port/DTO registration factory",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/native-host.ts:prepared",
        [
          "original Electron utility module bootstrap",
          "single real process.parentPort/electron utility incarnation",
          "one prepared Promise/installed host/credential observation callback per utility process; bootstrap30s",
          "port.close invalidates installed host; mismatch credential capture irreversibly revokes; no caller port/DTO registration factory",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/cli/tui/goal-plan-bridge.ts:createGoalPlanBridge@7:18.pending",
        [
          "actual TUI worker parent private MessageChannel transport",
          "one original worker/directory bridge and request sequence",
          "8 pending per original bridge BEFORE post; deadline30s; handshake5s/ready10s; exact worker settlement required",
          "timeout/abort rejects visible Promise but retains owned slot; finish only worker finally settled or actual worker close; reconnect refuses pending; closes old port and joins original scope",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/cli/tui/mcp-operator-bridge.ts:createMcpOperatorBridge@7:18.pending",
        [
          "actual TUI worker parent private MessageChannel transport",
          "one original worker/directory bridge and request sequence",
          "8 pending per original bridge BEFORE post; deadline30s; handshake5s/ready10s; exact worker settlement required",
          "timeout/abort rejects visible Promise but retains owned slot; finish only worker finally settled or actual worker close; reconnect refuses pending; closes old port and joins original scope",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/cli/tui/task-control-bridge.ts:createTaskControlBridge@10:21.pending",
        [
          "actual TUI worker parent private MessageChannel transport",
          "one original worker/directory bridge and request sequence",
          "8 pending per original bridge BEFORE post; deadline30s; handshake5s/ready10s; exact worker settlement required",
          "timeout/abort rejects visible Promise but retains owned slot; finish only worker finally settled or actual worker close; reconnect refuses pending; closes old port and joins original scope",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/reader-registry.ts:closure@29:39.entries",
        [
          "original IMKernelReader Registry Root Scope",
          "workspaceID/userID + exact InstanceRegistry incarnation",
          "construction Semaphore1; owned<=64 admission AFTER known idle retirement; native2/background1/queue64; retired pending native entries remain owned",
          "revoke reader/authority and unregister before retire; original retireReads joins SDK reads+child Scope.close before owned.delete; scope finalizer revokes/joins all; retain release idempotent",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/reader-registry.ts:closure@29:40.owned",
        [
          "original IMKernelReader Registry Root Scope",
          "workspaceID/userID + exact InstanceRegistry incarnation",
          "construction Semaphore1; owned<=64 admission AFTER known idle retirement; native2/background1/queue64; retired pending native entries remain owned",
          "revoke reader/authority and unregister before retire; original retireReads joins SDK reads+child Scope.close before owned.delete; scope finalizer revokes/joins all; retain release idempotent",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/reader.ts:closure@63:78.liveCuts",
        [
          "original KernelReader connection/receiver incarnation",
          "projectionKey original opaque live-cut object",
          "64 actual entries checked immediately after capture and before set; current-cut generation required; no retained byte payload",
          "original reader/entry Scope lifecycle; revoke closes runtime and Native reader request owner; original native handle current() gates reuse",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/reader.ts:closure@63:163.watchedGroups",
        [
          "original authenticated WebSocket output owner",
          "groupID with reference count of accepted original sockets",
          "original Broadcaster.register before watchGroup; MAX_CONNECTIONS1024/MAX_GROUP128; only accepted socket can add",
          "exact WebSocket Effect finalizer calls idempotent release, removes zero ref group; revoked reader broadcasts invalidation; historical groups do not enter watch map",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/reader.ts:closure@63:165.maintenance",
        [
          "original KernelReader sender maintenance logger",
          "typed SenderCleanupError.code literals",
          "finite exact two codes sender_binding_mismatch/sender_body_mismatch",
          "reader Scope metadata only; suppresses repeated same-code warning, never delivery permissions; original current fails propagate",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/task-source.ts:closure@26:32.slots",
        [
          "original shared KernelTaskSource Root resolver",
          "messageID and exact facade/engine/reader/Native handle; no persisted native claim",
          "slots+preparing<=128; synchronous reserve preparing before fork; fresh joins original preparation and refuses owner mismatch; originaldeadline1s",
          "expired only observations pruned; prepare onExit clears exact preparing/failed installed slot; Root clears both and conflicts facade; SQL verifier consume-only current no remote IO",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/task-source.ts:closure@26:34.preparing",
        [
          "original shared KernelTaskSource Root resolver",
          "messageID and exact facade/engine/reader/Native handle; no persisted native claim",
          "slots+preparing<=128; synchronous reserve preparing before fork; fresh joins original preparation and refuses owner mismatch; originaldeadline1s",
          "expired only observations pruned; prepare onExit clears exact preparing/failed installed slot; Root clears both and conflicts facade; SQL verifier consume-only current no remote IO",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/installation/event-validation-native.ts:closure@36:42.active",
        [
          "original EventValidationNative Root/consumer Scope",
          "original opaque prepared handle/held workspace/signed asset/current rule",
          "Core event-validation claim same SQL TX enforces aggregate MAX_CUSTODY8 with work-command meter BEFORE native.prepare; prepare local check8 is secondary, not itself reservation proof",
          "original workspace file acquireRelease; entry scope finalizer active=false/delete; Root lifetime inactive then closes original held files; unknown physical workspace remains durable/quota-held and never deleted/replayed",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-plan-rebase-access.ts:closeWorkerBridge",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-plan-rebase-access.ts:closure@130:146.requests",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-plan-rebase-access.ts:closure@168:202.controller",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-plan-rebase-access.ts:workerInstalled",
        [
          "actual TUI worker parentPort private bootstrap",
          "one worker bootstrap/current original directory/OS principal; controller per original accepted request",
          "one install/close callback per worker; requests8 BEFORE launch; originaldeadline<=30s",
          "close revokes active first, aborts all original controllers, keeps port until requests finally; finally clearTimeout/abort/delete/settled; original Access current checks active+deadline/ordinarySession",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/session/goal-tick-execution.ts:closure@48:51.entries",
        [
          "original GoalTickExecution Root Layer Scope",
          "original opaque Frame/current durable tick permit",
          "entries32 before original frame admission; original permit IDs cannot duplicate; per-frame Session coordinator receipts",
          "revoke original child-policy frame, signal/interrupt/await original execution receipts; releaseFrame durable then delete exact entry; Root finalizer stops and joins all",
          "ephemeral original runtime state; durable SQL and Native current remain authority",
          "original installed Host/Root product consumer, not fixture-injected service",
          "safe_scoped",
        ],
      ],
    ] as const
  ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

const reviewedHostClosureLifetimes: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  (
    [
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:163.previews",
        [
          "same Root browser file factory; non-owning original Preview handles",
          "original opaque preview handle, immutable control/request/native manifest/asset; no wire object keys",
          "producer API captures+previewing <=64; independent native opening+active <=8; WeakMap is non-owning metadata, NOT a capacity proof",
          "Root invalidation/currentPreview rechecks original Native asset/control/manifest; capture consumption drops strong preview holder; physical helper retired by observing/active owners",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:165.approvals",
        [
          "same Root browser file factory; immutable original confirmation handles",
          "opaque affirmative NativeHost confirmation handle bound same preview+command; JSON cannot recreate it",
          "native confirmations64/control and controls256; operations16384; metadata only, no child/FD ownership",
          "confirmed handles weak-owned by original captures/approved flow; acceptGrant checks original object identity/current manifest; Root live=false invalidates",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:167.grants",
        [
          "same Root browser file factory; original admitted grant hash cache",
          "grantID -> hash of exact original durable grant only",
          "Core64 grant/control *256 controls and original durable capacity; strings only",
          "same Root only; acceptGrant requires original preview+approval; grantHash current SQL controls verification; no cached authority survives Root close",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:168.transfers",
        [
          "same Root browser file factory; non-owning opaque transfer lookup",
          "opaque transfer handle -> original active strong Transfer, <=4 Leaf exact artifacts",
          "physical ownership is active+opening<=8, not WeakMap; each <=4 helper/FD leaves",
          "scope finalizer calls original singleton closeTransfer; lookup/current rejects inactive; strong active owner retained until all original helpers stopped and FileHandles closed",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:169.observations",
        [
          "same Root browser file factory; immutable publication facts",
          "opaque publication object -> original <=4 artifact manifests",
          "one publication per original Leaf; <=4 per original transfer; object has no held native process/FD; no weak-cap claim",
          "original transfer/current/publication identity and Core receipt/SQL recordObservation verify; Root close rejects new operations, metadata follows opaque key lifetime",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:170.released",
        [
          "same Root browser file factory; known physical-release observation",
          "opaque released object -> original artifact IDs; no close/dispatch permit",
          "<=4 IDs each; produced only after original physical cleanup confirms; cleanupReceipts bounded4096",
          "strong cleanupReceipts owns known pending DB settlement, finish original SQL then deletes; no unknown physically released token is minted",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:171.active",
        [
          "same Root browser file factory; strong original Transfer custody",
          "original Transfer with its real Native children/FileHandles/control/action",
          "opening+active <=8 reserved before capture/current/first async; <=4 Leaf each",
          "closeTransfer is one cached promise; Root/scope finalizers mark inactive and attempt original closes once; allSettled alone cannot delete; exact original stopped+fileClosed needed; late original close may release; unknown retains slot",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:172.cleanupReceipts",
        [
          "same Root browser file factory; known cleanup -> durable settlement bridge",
          "original actionID -> <=4 actual artifacts plus opaque physical release confirmation",
          "Core global browser actions4096, at most one receipt/action; artifacts4",
          "created only after known physical cleanup; finish SQL then exact receipt delete; unknown has no receipt; Root closure metadata lifetime does not authorize replay",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:490.captures",
        [
          "same Root browser file service; original pending preview descriptors",
          "random previewID -> actual Core/native Capture",
          "captures+previewing <=64 synchronously reserved BEFORE preview Effect/Native capture; active native separate8",
          "onExit releases previewing; known approval consumes exact capture; Root live/current fences reject late publication; unknown child separately stays observing/active; no silent unknown close eviction",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:491.operations",
        [
          "same Root browser file service; exact approval request coordination",
          "controlID+requestID bound exact scope+commandHash, original completion Deferred",
          "<=MAX_CONTROLS256*MAX_GRANTS_PER_CONTROL64=16384; publish pending Deferred synchronously before effect/body allocation",
          "exact same body joins original completion; different body conflict; onExit completes once including failure/interruption; bounded immutable terminal metadata retained for original retry, not authority; no repeat native confirmation",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/event-validation.ts:closure@36:45.parents",
        [
          "original Host EventValidation scope; exact path watcher owner",
          "canonical parent path -> exact dev/inode/FSWatcher + subscribers",
          "ownedParents plus new reserved pending <=256; existing path pending exactjoins original before lstat await",
          "desired path refresh retains original watcher; no await overwrite; original actual close callback exact-removes name; closing path refuses replacement, unknown stays physically owned",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/event-validation.ts:closure@36:49.hints",
        [
          "original Host EventValidation scope; coalesced untrusted FS callback work",
          "ruleID -> at most one fiber and one coalesced next hint",
          "Core MAX_RULES256; max1 hint/fiber each, EffectBridge256 additionally bounds forks",
          "original revision/configHash/durable enabled state checked before consumer; original fiber finally exact deletes; Root active=false ignores late callbacks and interrupts original hint fibers, then clears observation metadata",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/event-validation.ts:closure@36:50.captures",
        [
          "original Host EventValidation preview owner",
          "captureID -> original configuration + operatorRevision and expiry",
          "captures+capturing<=32 counter BEFORE Native approve async; expiry<=60s and bounded original rule config/watch256",
          "expires prior descriptors before admission; onExit counter release; Root active/operatorRevision/config current before publication; Root clears readonly captures after invalidation",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/im/kernel/sync.ts:closure@178:213.continuations",
        [
          "actual IM fixedEngine captured in one original ReaderRegistry Entry",
          "messageID bound raw requestHash + original sourceHash and original pending/ready/unknown completion",
          "<=128 before plan/claim/remote async; exact request/source joins; only fully known ready observation can expire, no TTL extension",
          "known read-only/pre-dispatch/typed refusal failure releases exact slot; raw begin/put/finalize ambiguity retains original unknown entry and denies retry; late original completion finishes actual pending; known ready createMessage consumes only after actual repository success; custody checkpoint stays durable and unchanged",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/browser/file-exchange.ts:closure@159:173.observing",
        [
          "same Root browser file factory; strong original preview helper custody",
          "one original control/request/asset + spawned child if any",
          "opening+active <=8; reservation BEFORE currentControl/browserAsset/filesystem/native await",
          "no spawned child/confirmed original stopped -> release; close() cached once; unknown retains original entry/slot and Root attempts no reclose; original exited callback exact-removes only its reservation",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/event-validation.ts:closure@36:46.ownedParents",
        [
          "original Host EventValidation scope; strong real FSWatcher custody",
          "actual original FSWatcher object, named dev/inode/immutable parent",
          "<=256 actual+reserved; owned in same synchronous watch constructor boundary",
          "detach/root close set closing before one watcher.close; no all-clear; only actual original close removes owned entry; unknown occupies slot and blocks same path; late close releases",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
      [
        "packages/deepagent-code/src/deepagent/event-validation.ts:closure@36:47.pendingParents",
        [
          "original Host EventValidation scope; path construction reservation",
          "canonical exact path -> one original Deferred and new-slot reservation",
          "before filesystem await, new owned+reserved <=256; original path exactjoins, no new watcher",
          "onExit exact deletes pending and settles same actual Exit; async continuation checks Root active/current original name/inode before publication; cancellation cannot split constructor from custody ownership",
          "ephemeral same original owner; original SQL/MAC/Native current/permissions remain authority; no new durable table or execution permit",
          "original installed Root/Host production service and existing HTTP or IM product consumer; QA observation hooks are test-only",
          "safe_scoped",
        ],
      ],
    ] as const
  ).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

// v2.0.5 source review: these are the actual new owners, separate from line-only reanchors.
// Scope/weak-key cleanup and native current checks remain independent of durable authority.
const reviewedRelease205: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  ([
    ["packages/app/src/components/im/navigation-state.ts:communications",
      "renderer window communications drafts", "exact UI scope/account/connection including credential identity",
      "window-lifetime drafts including retained unknown commands; no hard capacity cap",
      "window exit GC; publish and retire check original owner", "UI drafts only; no socket or durable command ledger",
      "renderer communications UI", "safe_scoped"],
    ["packages/app/src/components/settings-keybinds.tsx:SettingsPage",
      "Solid module component loader", "one lazy SettingsPage export", "one loader per module",
      "framework render owner and module exit", "component code only; no mutable business authority",
      "settings UI", "safe_bounded"],
    ["packages/app/src/components/shared-browser-create.tsx:requests",
      "original SharedBrowserPlatform bridge", "weak bridge identity and original scope/directory/session",
      "at most 64 request entries per bridge", "bridge GC; component cleanup invalidates async publication",
      "original retry UI bytes only; current checked after every await", "renderer shared-browser create UI", "safe_bounded"],
    ["packages/app/src/context/global-sync/event-reducer.ts:questionWritesByStore",
      "original Solid global-sync store", "weak Store identity and Session/request revision", "store-lifetime revision observations; no hard per-store cap",
      "weak store GC", "revision snapshot reconciles UI; durable question facts remain authority",
      "global-sync event reducer", "safe_scoped"],
    ["packages/app/src/pages/session/task-progress.tsx:taskSummaries",
      "retained task-summary UI source", "weak client identity plus scope/directory/Session",
      "live retained UI sources; request deadline 10 seconds", "last release aborts lifetime, clears interval, removes listener and deletes source",
      "query projection only; Task durable receipts remain authority", "Session task-progress UI", "safe_scoped"],
    ["packages/core/src/config/plugin/provider.ts:closure@21:22.disabledVariants",
      "ConfigProviderPlugin catalog transform", "provider/model in one captured config", "finite config entries and model variants",
      "synchronous transform returns", "derived configuration only", "production Catalog transform", "safe_scoped"],
    ["packages/core/src/im/reply-reconciliation.ts:run@43:51.rangeCounts",
      "one ReplyReconciliation.run effect", "original final-message body digest", "one paged reconcile request and its original collector checks",
      "effect settlement releases closure", "SQL delivery/outbox receipts remain authoritative", "original IM reconciliation request", "safe_scoped"],
    ["packages/deepagent-code/src/im/device-transport.ts:diagnostics",
      "IMDeviceTransport error object", "weak original failure identity", "one diagnostic per live error",
      "weak-key GC", "redacted transport diagnostics only", "IM device HTTP failure", "safe_bounded"],
    ["packages/deepagent-code/src/im/device-transport.ts:make@138:143.cached",
      "one IMDeviceTransport instance", "realm/requestHash/device JKT", "at most 4 challenges; expiry and supported clock skew checked",
      "capacity clear and transport-owner GC", "challenge cache; every request still signs its own proof", "current device transport", "safe_bounded"],
    ["packages/deepagent-code/src/im/device-transport.ts:make@138:144.pending",
      "one IMDeviceTransport instance", "identical concurrent kernel-http challenge", "actual in-flight challenge calls in this transport",
      "actual promise finally deletes original key", "single-flight only; no reusable request proof", "current device transport", "safe_scoped"],
    ["packages/deepagent-code/src/im/facade.ts:closure@290:381.inspections",
      "one bound IM credential engine Scope", "realm/user/conversation inspection", "pending inspections in this engine; completed results never retained",
      "worker ensuring deletes; forkIn engine Scope interrupts on close", "conversation query only; generation current checked around result", "current credential engine", "safe_scoped"],
    ["packages/deepagent-code/src/im/kernel/exchange.ts:rateLimits",
      "original device transport", "weak device identity and current realm", "one wait timestamp per live device; capped to MAX_SAFE_INTEGER",
      "wait expiry ceases blocking; weak-key GC", "retry scheduling only; no nonce or authority result", "communication HTTP calls", "safe_bounded"],
    ["packages/deepagent-code/src/im/kernel/reader.ts:closure@63:109.cuts",
      "one IM reader Scope", "exact version/scope/projection/revision", "in-flight cuts through original request gate; no completed proof reuse",
      "worker ensuring deletes before completion; engine Scope closes worker", "single-flight only; native current and durable reader remain authority", "current original reader", "safe_scoped"],
    ["packages/deepagent-code/src/installation/local-authority.ts:installationReads",
      "one scoped Windows installation read", "weak opaque original read token", "active original installation scopes",
      "Effect.ensuring deletes token; original native hold is scoped", "membership only; original.current revalidates installation", "original Windows installation read", "safe_scoped"],
    ["packages/deepagent-code/src/installation/native-installation.ts:componentInventory",
      "package component manifest", "one immutable embedded components document", "one frozen decoded value",
      "process exit", "static package bytes; live installation handles still checked separately", "NativeInstallation manifest reader", "safe_bounded"],
    ["packages/deepagent-code/src/installation/windows-native-bootstrap.ts:owners",
      "original preloaded native Port", "weak original Port identity", "one reference count and retirement flag per live Port",
      "scope release decrements; last release closes and permanently retires Port; weak-key GC",
      "coordination only; verified native installation and current capture remain authority", "original scoped Windows bootstrap", "safe_scoped"],
    ["packages/deepagent-code/src/config/config.ts:globalConfigGenerations",
      "process global-config CAS domain coordinator", "canonical Global.Path.config realpath; Windows case normalized",
      "process-lifetime canonical domains; symlink retarget retains historical epochs; no hard capacity cap",
      "process exit; per-layer eviction would permit generation ABA", "coordination epoch only; original file observation/CAS remains authority",
      "original Config.layer builds; never Session/provider request keys", "safe_scoped"],
    ["packages/deepagent-code/src/location-index/typescript-index.ts:capacity",
      "process semantic-index scheduler", "all original Location compiler jobs", "one semaphore permit including termination",
      "withPermits releases after scoped worker finalizer", "resource admission only; no code graph authority", "TypeScriptIndex.build", "safe_bounded"],
    ["packages/deepagent-code/src/location-index/typescript-index.ts:live",
      "process semantic-index scheduler", "original Worker identity", "at most one Worker under capacity permit",
      "worker exit deletes; acquireRelease terminates and awaits actual exit", "diagnostic active count only", "TypeScriptIndex.build", "safe_bounded"],
    ["packages/deepagent-code/src/location-index/typescript-index.ts:start@62:64.worker",
      "one TypeScriptIndex.build scope", "original random request ID and worker", "one worker per held process permit",
      "acquireRelease terminate plus await exited; error path terminates", "isolated compiler result; response identity checked", "original scoped index job", "safe_scoped"],
    ["packages/deepagent-code/src/mcp/windows-storage.ts:closure@34:39.journals",
      "original Windows MCP storage root Scope", "original native journal lease close callback", "native bridge admits at most 64 journals",
      "journal close deletes; root finalizer closes every retained journal", "retained native journal custody; original current checked for access", "original Windows MCP storage root", "safe_scoped"],
    ["packages/deepagent-code/src/session/goal-tick-execution.ts:closure@48:52.quiescent",
      "one GoalTickExecution control call", "weak opaque original quiescence witness", "currently joined original pause transactions",
      "acquireUseRelease deletes witness after settlePause", "SQL pause boundary and original owner joins remain authority", "post-commit original Goal control", "safe_scoped"],
    ["packages/deepagent-code/src/session/message-v2.ts:hydrate@367:371.canonicalByMessage",
      "one message hydrate effect", "original requested message IDs", "finite rows passed to this hydration request",
      "effect settlement releases closure", "derived SQL canonical sequence projection only", "original Session message reader", "safe_scoped"],
  ] as const).map(([key, owner, keyScope, bound, finalizer, durability, reachability, verdict]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

// Browser/Desktop owners reviewed against the exact v2.0.5 production and fixture import graph.
// Test-only rows stay in the denominator and never inherit a production-safe verdict.
const reviewedBrowser205: Readonly<Record<string, RuntimeStateAudit>> = Object.fromEntries(
  ([
    // packages/core/src/browser/shared-file-exchange.ts:30-33, packages/core/src/browser/shared-file-exchange.ts:48-71, packages/core/src/browser/shared-file-exchange.ts:132-176, packages/deepagent-code/src/browser/file-exchange.ts:752-760
    ["packages/core/src/browser/shared-file-exchange.ts:captures",
      "original shared file preview Capture owner", "weak opaque Capture bound to actual db/native preview/resource/lease/request",
      "weak keys; product BrowserFiles strong preview custody additionally capped64 shared+legacy", "capture key GC after caller retires it; used flag prevents re-consumption; every effect rechecks native/current lease",
      "ephemeral original custody only; grant/artifact SQL is durable and cannot reconstruct native handle", "production SharedBrowserFileExchange.preview/confirm/approve via installed BrowserFileCapability",
      "safe_scoped"],
    // packages/core/src/browser/shared-user-input.ts:28, packages/core/src/browser/shared-user-input.ts:40-65, packages/core/src/browser/shared-user-input.ts:74-96
    ["packages/core/src/browser/shared-user-input.ts:origins",
      "original SharedBrowserUserInput.withOrigin acquireUseRelease", "opaque handle bound to cloned original input stamp and actual Main incarnation",
      "weak keys; exactly one witness per concurrently executing original withOrigin body", "acquireUseRelease release deletes original handle on success/failure/interruption",
      "ephemeral provenance guard; admitted origin/selection/receipt facts remain durable SQL and are separately validated", "original installed browser host -> Session admission commit; no serialized object can mint weak key",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:330-350, packages/deepagent-code/src/browser/file-exchange.ts:577-603
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:225.previews",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "opaque original native Preview -> version1 control or version2 resource/lease binding",
      "weak keys; original preview custody64; active helper/transfer admission8; per-transfer files<=4; no enumeration or DTO reconstruction", "weak key GC; layer finalizer sets live=false and joins original active transfers/observations; original physical custody is retained when stop is unknown",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:330-350, packages/deepagent-code/src/browser/file-exchange.ts:577-603
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:229.approvals",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "opaque Approval -> exact original Preview and commandHash/confirmation",
      "weak keys; original preview custody64; active helper/transfer admission8; per-transfer files<=4; no enumeration or DTO reconstruction", "weak key GC; layer finalizer sets live=false and joins original active transfers/observations; original physical custody is retained when stop is unknown",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:425-430, packages/deepagent-code/src/browser/file-exchange.ts:688-692, packages/core/src/browser/file-exchange.ts:130-150, packages/core/src/browser/file-exchange.ts:365-395, packages/core/src/browser/shared-capacity.ts:37-49
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:231.grants",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "grantID -> exact original accepted grant digest",
      "only after original preview approval and durable grant admission; per-control grants64 and original shared/legacy DB reservation ceilings; no TTL/eviction authority", "scope exit invalidates live guard; layer closure GC; grant records never recreate original weak approvals",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:330-350, packages/deepagent-code/src/browser/file-exchange.ts:577-603
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:232.transfers",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "opaque original Transfer -> native processes/leaves/current guard",
      "weak keys; original preview custody64; active helper/transfer admission8; per-transfer files<=4; no enumeration or DTO reconstruction", "weak key GC; layer finalizer sets live=false and joins original active transfers/observations; original physical custody is retained when stop is unknown",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:330-350, packages/deepagent-code/src/browser/file-exchange.ts:577-603
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:233.observations",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "opaque original Observation -> exact native publication",
      "weak keys; original preview custody64; active helper/transfer admission8; per-transfer files<=4; no enumeration or DTO reconstruction", "weak key GC; layer finalizer sets live=false and joins original active transfers/observations; original physical custody is retained when stop is unknown",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:330-350, packages/deepagent-code/src/browser/file-exchange.ts:577-603
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:234.released",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "opaque original Released -> original cleaned artifact IDs",
      "weak keys; original preview custody64; active helper/transfer admission8; per-transfer files<=4; no enumeration or DTO reconstruction", "weak key GC; layer finalizer sets live=false and joins original active transfers/observations; original physical custody is retained when stop is unknown",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:270-300, packages/deepagent-code/src/browser/file-exchange.ts:330-350
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:235.active",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "strong original helper/FD custody; active",
      "opening+active<8 before any observation/transfer allocation; leaves<=4; unknown actual exits retain capacity", "observe finally closes original process; exits release observation reservation; transfer closes FD/helpers; retire only known stopped/fileClosed; layer finalizer joins both",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:579-600, packages/deepagent-code/src/browser/file-exchange.ts:624-629, packages/deepagent-code/src/browser/file-exchange.ts:708-715, packages/core/src/browser/file-exchange.ts:365-395
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:236.cleanupReceipts",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "version+original actionID -> original cleaned artifacts and Released confirmation",
      "actual cleanup receipts only; bounded by original durable artifact/metadata reservation capacity; no fabricated release for unknown", "finishAction persists exact original released proof then deletes receipt; layer closure GC; original unknown stages keep reservations",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:270-300, packages/deepagent-code/src/browser/file-exchange.ts:330-350
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:237.observing",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "strong original helper/FD custody; observing",
      "opening+active<8 before any observation/transfer allocation; leaves<=4; unknown actual exits retain capacity", "observe finally closes original process; exits release observation reservation; transfer closes FD/helpers; retire only known stopped/fileClosed; layer finalizer joins both",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:752-760, packages/deepagent-code/src/browser/file-exchange.ts:782-810, packages/deepagent-code/src/browser/file-exchange.ts:833-839, packages/deepagent-code/src/browser/file-exchange.ts:860-864
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:724.captures",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "random previewID -> original version1/version2 Capture",
      "captures+sharedCaptures+previewing<64 before await; rejected on capacity, not evicted", "successful approval/cancellation deletes exact capture; layer live=false on close and closure GC; unknown no grant reconstruction",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:752-760, packages/deepagent-code/src/browser/file-exchange.ts:782-810, packages/deepagent-code/src/browser/file-exchange.ts:833-839, packages/deepagent-code/src/browser/file-exchange.ts:860-864
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:725.sharedCaptures",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "random previewID -> original version1/version2 Capture",
      "captures+sharedCaptures+previewing<64 before await; rejected on capacity, not evicted", "successful approval/cancellation deletes exact capture; layer live=false on close and closure GC; unknown no grant reconstruction",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:766-799, packages/deepagent-code/src/browser/file-exchange.ts:847-870
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:726.operations",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "version+control/resourceID+requestID with exact scopeHash/commandHash -> original Deferred outcome",
      "combined operations+sharedOperations<MAX_CONTROLS256*MAX_GRANTS_PER_CONTROL64 before original slot publication", "original onExit completes Deferred; retained exact retries die with layer closure; no replacement after ambiguous original operation",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/file-exchange.ts:217-255, packages/deepagent-code/src/browser/file-exchange.ts:719-729, packages/deepagent-code/src/session/v2-runner-frame.ts:304-312, packages/deepagent-code/src/browser/file-exchange.ts:766-799, packages/deepagent-code/src/browser/file-exchange.ts:847-870
    ["packages/deepagent-code/src/browser/file-exchange.ts:closure@217:727.sharedOperations",
      "original Database/BrowserHost BrowserFiles Effect layer scope", "version+control/resourceID+requestID with exact scopeHash/commandHash -> original Deferred outcome",
      "combined operations+sharedOperations<MAX_CONTROLS256*MAX_GRANTS_PER_CONTROL64 before original slot publication", "original onExit completes Deferred; retained exact retries die with layer closure; no replacement after ambiguous original operation",
      "RAM original capability/custody only; real native current guards and durable grant/artifact records remain separate", "same production BrowserFiles layer object shared by HTTP API and Location tools; installed assets and consent stay lazy",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/file-leaf-bridge.ts:21-32, packages/deepagent-code/src/browser/file-leaf-bridge.ts:62-86, packages/deepagent-code/src/browser/native-host.ts:480-497
    ["packages/deepagent-code/src/browser/file-leaf-bridge.ts:make@21:24.completed",
      "one original BrowserFileLeafBridge.make action/transfer invocation", "artifactID -> original opaque native Observation",
      "only artifactIDs in input.files; original transfer files<=4; busy gate serializes before async current check", "returned leaf/complete closure GC at original action/RPC completion; complete joins native cleanup; unknown keeps physical custody in owning layer",
      "RAM publication cross-check only; canonical ToolEffect settles durable action before refund", "original native-host private leaf protocol with installed FileCapability, not caller-supplied JSON observer",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/native-host.ts:63-73, packages/deepagent-code/src/browser/native-host.ts:187-190, packages/deepagent-code/src/browser/native-host.ts:446, packages/deepagent-code/src/browser/native-host.ts:530-539
    ["packages/deepagent-code/src/browser/native-host.ts:connect@63:69.credentialRevocations",
      "actual utility-process original Main MessagePort and bootstrap incarnation", "private current-credential generation revocation callback",
      "single connectShared->connectTui retire callback; no public registration API", "credential mismatch invokes retire; port closure invalidates host; callback closure GC with original connection",
      "ephemeral exact private channel state; SQL/HTTP descriptors do not reinstall authority; native Main retains actual physical cleanup", "private utility bootstrap/connect/connectShared/connectTui production path only",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/native-host.ts:74, packages/deepagent-code/src/browser/native-host.ts:94-100, packages/deepagent-code/src/browser/native-host.ts:143-147, packages/deepagent-code/src/browser/native-host.ts:194-201
    ["packages/deepagent-code/src/browser/native-host.ts:connect@63:74.controls",
      "actual utility-process original Main MessagePort and bootstrap incarnation", "controlID -> immutable descriptor/resource/credential binding and original cancel cache",
      "MAX_CONTROLS256 before set/create; entries retained for original host lifetime", "port.close marks inactive and clears controls; actual Main view cleanup remains independent",
      "ephemeral exact private channel state; SQL/HTTP descriptors do not reinstall authority; native Main retains actual physical cleanup", "private utility bootstrap/connect/connectShared/connectTui production path only",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/native-host.ts:75-77, packages/deepagent-code/src/browser/native-host.ts:143-173, packages/deepagent-code/src/browser/native-host.ts:175-183
    ["packages/deepagent-code/src/browser/native-host.ts:connect@63:75.pending",
      "actual utility-process original Main MessagePort and bootstrap incarnation", "original RPC id/action/current/file callback",
      "noncancel cap MAX_WAITING16+MAX_ACTIVE_CONTROLS4+4 before publication; cached cancel <=one per admitted control256", "response clears exact timer+entry; timeout/interruption removes waiter and exposes unknown; port close resolves/clears all",
      "ephemeral exact private channel state; SQL/HTTP descriptors do not reinstall authority; native Main retains actual physical cleanup", "private utility bootstrap/connect/connectShared/connectTui production path only",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/native-host.ts:265-270, packages/deepagent-code/src/browser/native-host.ts:325-365
    // No fixed aggregate bound is claimed for reducing RPC concurrency. This is a scoped waiter lifetime classification, not performance/capacity qualification.
    ["packages/deepagent-code/src/browser/native-host.ts:connectShared@265:268.pending",
      "actual utility-process original Main MessagePort and bootstrap incarnation", "original shared RPC id/resource/lease/action and private callbacks",
      "nonreducing cap20 before publication; reducing cleanup/status RPCs deliberately bypass aggregate cap but each owns original10s/deadline timer and Effect finalizer", "exact response/timeout/interruption deletes entry; port.close resolves/clears waiters; Main custody never released solely by timeout",
      "ephemeral exact private channel state; SQL/HTTP descriptors do not reinstall authority; native Main retains actual physical cleanup", "private utility bootstrap/connect/connectShared/connectTui production path only",
      "safe_scoped"],
    // packages/deepagent-code/src/browser/native-host.ts:513-539, packages/deepagent-code/src/browser/native-host.ts:586-632
    ["packages/deepagent-code/src/browser/native-host.ts:connectTui@505:513.streams",
      "actual utility-process original Main MessagePort and bootstrap incarnation", "attachID -> exact generation/streamID and one callback queue",
      "MAX_PENDING16+MAX_ACTIVE8 before set; Stream callback buffer1 sliding", "Effect.addFinalizer deletes exact original stream and disconnects; port.close/credential revoke retires all; takeUntil retired",
      "ephemeral exact private channel state; SQL/HTTP descriptors do not reinstall authority; native Main retains actual physical cleanup", "private utility bootstrap/connect/connectShared/connectTui production path only",
      "safe_bounded"],
    // packages/deepagent-code/src/browser/native-host.ts:521, packages/deepagent-code/src/browser/native-host.ts:556-573
    ["packages/deepagent-code/src/browser/native-host.ts:connectTui@505:521.waiting",
      "actual utility-process original Main MessagePort and bootstrap incarnation", "original source/attachID -> live RPC count",
      "MAX_PER_SOURCE4 plus MAX_WAITING32 total before increment", "Effect.ensuring decrements and deletes source at0 on success/failure/interruption",
      "ephemeral exact private channel state; SQL/HTTP descriptors do not reinstall authority; native Main retains actual physical cleanup", "private utility bootstrap/connect/connectShared/connectTui production path only",
      "safe_bounded"],
    // packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:10-36, packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:120-141, packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:228-252, packages/deepagent-code/src/cli/cmd/attach.ts:82-102
    ["packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:createBrowserOwnerBridge@10:25.client",
      "one actual interactive TUI attach BrowserOwnerBridge", "one SDK client bound to validated credential-free loopback URL",
      "one per attach bridge", "attach finally calls close; active/retained streams aborted and secrets cleared",
      "RAM secret/immutable sealed-retry witness only; original Desktop approval and Main port still required", "production attach.ts creates only for interactive stdin TTY and closes in finally",
      "safe_scoped"],
    // packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:10-36, packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:120-141, packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:228-252, packages/deepagent-code/src/cli/cmd/attach.ts:82-102
    ["packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:createBrowserOwnerBridge@10:34.retained",
      "one actual interactive TUI attach BrowserOwnerBridge", "attachID -> exact original pair secret/view/stream",
      "MAX_ACTIVE8 before new pair entry; only original sealed retries retained", "close aborts every stream, clears each secret, clears retained map and active entry",
      "RAM secret/immutable sealed-retry witness only; original Desktop approval and Main port still required", "production attach.ts creates only for interactive stdin TTY and closes in finally",
      "safe_scoped"],
    // packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:10-36, packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:120-141, packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:228-252, packages/deepagent-code/src/cli/cmd/attach.ts:82-102
    ["packages/deepagent-code/src/cli/tui/browser-owner-bridge.ts:createBrowserOwnerBridge@10:36.listeners",
      "one actual interactive TUI attach BrowserOwnerBridge", "original local view observer callbacks",
      "32 listeners maximum", "returned unsubscribe deletes callback; bridge close clears set",
      "RAM secret/immutable sealed-retry witness only; original Desktop approval and Main port still required", "production attach.ts creates only for interactive stdin TTY and closes in finally",
      "safe_scoped"],
    // packages/desktop/src/main/fixture/managed-browser-files-main.ts:23, packages/desktop/src/main/fixture/managed-browser-files-main.ts:186-204, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/managed-browser-files-main.ts:contextEvents",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; contextEvents",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/managed-browser-files-main.ts:14, packages/desktop/src/main/fixture/managed-browser-files-main.ts:186-204, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/managed-browser-files-main.ts:driverStages",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; driverStages",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/managed-browser-input-windows-qualification.ts:54, packages/desktop/src/main/fixture/managed-browser-input-windows-qualification.ts:243-272, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/managed-browser-input-windows-qualification.ts:result",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; result",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/managed-browser-input-windows-qualification.ts:48, packages/desktop/src/main/fixture/managed-browser-input-windows-qualification.ts:243-272, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/managed-browser-input-windows-qualification.ts:state",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; state",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/managed-browser-program.ts:9, packages/desktop/src/main/fixture/managed-browser-program.ts:131-170, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/managed-browser-program.ts:stages",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; stages",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-manager.ts:26, packages/desktop/src/main/fixture/shared-browser-file-manager.ts:316-331, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-manager.ts:facts",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; facts",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-manager.ts:25, packages/desktop/src/main/fixture/shared-browser-file-manager.ts:316-331, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-manager.ts:trace",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; trace",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-observer.ts:3, packages/desktop/src/main/fixture/shared-browser-file-observer.ts:3-6, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-observer.ts:fileStages",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; fileStages",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-transport.ts:41, packages/desktop/src/main/fixture/shared-browser-file-transport.ts:421-434, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-transport.ts:commandErrors",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; commandErrors",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-transport.ts:33, packages/desktop/src/main/fixture/shared-browser-file-transport.ts:421-434, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-transport.ts:facts",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; facts",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-transport.ts:44, packages/desktop/src/main/fixture/shared-browser-file-transport.ts:421-434, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-transport.ts:gates",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; gates",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-transport.ts:42, packages/desktop/src/main/fixture/shared-browser-file-transport.ts:421-434, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-transport.ts:requests",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; requests",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-transport.ts:30, packages/desktop/src/main/fixture/shared-browser-file-transport.ts:421-434, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-transport.ts:state",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; state",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-transport.ts:43, packages/desktop/src/main/fixture/shared-browser-file-transport.ts:421-434, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-transport.ts:trace",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; trace",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-file-transport.ts:40, packages/desktop/src/main/fixture/shared-browser-file-transport.ts:421-434, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-file-transport.ts:uploadParts",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; uploadParts",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser-ipc.ts:26, packages/desktop/src/main/fixture/shared-browser-ipc.ts:431-444, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser-ipc.ts:stage",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; stage",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser.ts:37, packages/desktop/src/main/fixture/shared-browser.ts:2013-2043, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser.ts:frameEvidence",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; frameEvidence",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser.ts:35, packages/desktop/src/main/fixture/shared-browser.ts:2013-2043, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser.ts:stage",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; stage",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/fixture/shared-browser.ts:36, packages/desktop/src/main/fixture/shared-browser.ts:2013-2043, packages/desktop/electron.vite.config.ts:61-66, packages/desktop/tsconfig.json:21-22
    ["packages/desktop/src/main/fixture/shared-browser.ts:trace",
      "explicit isolated Electron test/qualification child", "one fixture process and its owned test root; trace",
      "finite scripted test/qualification run; diagnostic arrays live only in child (some have explicit256/1024 caps); no production admission claim", "fixture finally/child exit destroys owned windows and closes owned servers; process exit releases diagnostic RAM",
      "test evidence only; never product Native/Work authority", "test_only: fixed production Rollup entry bootstrap.ts/sidecar.ts has no fixture import; Desktop tsconfig excludes src/main/fixture; imports/build paths occur only in tests or fixture graph",
      "test_only"],
    // packages/desktop/src/main/shared-browser-compute.ts:7, packages/desktop/src/main/shared-browser-compute.ts:31-42, packages/desktop/src/main/shared-browser-compute.ts:57-88, packages/desktop/src/main/shared-browser-compute.ts:94
    ["packages/desktop/src/main/shared-browser-compute.ts:active",
      "actual Main approved source computation per resource", "resourceKey -> original worker started observation",
      "map<=4 before reservation; projection<=1MiB; isolated worker V8/WASM/result and original deadline bounds", "result Promise finally clears timer/deletes exact slot after worker exit; cancellation terminates original worker",
      "diagnostic ephemeral worker entry only, never grants script permission", "production shared browser manager approved evaluate/program current guards",
      "safe_bounded"],
    // packages/desktop/src/main/shared-browser-tui.ts:31-58, packages/desktop/src/main/shared-browser-tui.ts:99-123, packages/desktop/src/main/shared-browser-tui.ts:162-164, packages/desktop/src/main/shared-browser-tui.ts:230-244, packages/desktop/src/main/managed-browser.ts:200-216, packages/desktop/src/main/managed-browser.ts:1576
    ["packages/desktop/src/main/shared-browser-tui.ts:registry",
      "single actual Electron Main SharedBrowserTuiRegistry", "one singleton -> original hosts, source entries, listeners, stream generations",
      "one registry/process; entries<=MAX_ACTIONS4096; pending16 active8; waiting32/per-source4; listener64; hosts only live original utility incarnations", "hostLost deletes host and retires its sources; entry retirement clears pending timer and unsealed stamps; dispose unsubscribes/retire/clears; process exit ends singleton",
      "ephemeral original Main owner-source/stamps; no raw secret/text stored in retained sealed retry; cold reopen cannot recreate source", "original Main shared-browser-ipc and managed-browser utility installers",
      "safe_scoped"],
    // packages/desktop/src/main/shared-browser.ts:112-132, packages/desktop/src/main/shared-browser.ts:511-626, packages/desktop/src/main/shared-browser.ts:847, packages/desktop/src/main/shared-browser.ts:950, packages/desktop/src/main/shared-browser.ts:1247, packages/desktop/src/main/shared-browser.ts:1532-1535, packages/desktop/src/main/managed-browser.ts:200-207
    ["packages/desktop/src/main/shared-browser.ts:manager",
      "single actual Electron Main SharedBrowserManager", "one manager/Main incarnation containing original pages/leases/hosts/source stamps",
      "one singleton/process; controls256 activephysical4; tabs bounded; seen/stamps<=4096; waiting16; hosts keyed live actual utility incarnation", "resource close fences lease/action/compute/files and joins original physical cleanup; hostLost revokes leases but intentionally preserves user pages; process exit releases singleton",
      "ephemeral actual Main page custody/source stamps; serialized SQL metadata alone cannot restore authority", "original Main IPC/utility transport singleton; separate from test-created managers",
      "safe_scoped"],
    // packages/desktop/src/main/windows.ts:138-141, packages/desktop/src/main/windows.ts:174-176
    ["packages/desktop/src/main/windows.ts:mainWindows",
      "actual Main-created BrowserWindow lifetime", "weak original BrowserWindow membership",
      "WeakSet only; one entry per real createMainWindow result, no enumerable retained IDs", "GC releases destroyed windows; isMainWindow also requires !isDestroyed immediately",
      "RAM window identity guard only; caller DTOs do not mint real windows", "actual production Main createMainWindow / shared browser IPC sender guards",
      "safe_scoped"],
    // packages/tui/src/component/dialog-shared-browser.tsx:25-62, packages/tui/src/component/dialog-shared-browser.tsx:64-81
    ["packages/tui/src/component/dialog-shared-browser.tsx:controls",
      "TUI SDK client lifetime and exact directory/workspace/session dialog state", "weak SDK client -> state map keyed directory/workspace/session",
      "max64 cached state entries/client; underlying resource list follows server capacity; no new cache entry beyond64", "component cleanup marks disposed and unregisters terminal observer; retained exact retry UI state dies with weak SDK client GC",
      "UI request/retry projection only; every response current() checks owner/client/directory/workspace/session; never authority", "production TUI DialogSharedBrowser",
      "safe_bounded"],
  ] as const).map(([key, owner, keyScope, bound, finalizer, durability, reachability, verdict]) => [
    key,
    { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
  ]),
)

function audit(key: string, classification: RuntimeStateClassification): RuntimeStateAudit {
  const review =
    reviewedBrowser205[key] ??
    reviewedRelease205[key] ??
    reviewed[key] ??
    reviewedCoreWitnesses[key] ??
    reviewedHostWitnesses[key] ??
    reviewedUiLifetimes[key] ??
    reviewedFiniteLifetimes[key] ??
    reviewedHostOriginalLifetimes[key] ??
    reviewedHostClosureLifetimes[key]
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

  // DateTime.makeUnsafe constructs a time value; the generic makeUnsafe rule below is for
  // runtime resources such as Semaphore and KeyedMutex, not pure value constructors.
  if (/^DateTime\.makeUnsafe\s*\(/.test(source)) return "immutable"

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
