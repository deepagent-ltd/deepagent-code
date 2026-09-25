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
  // RI-94 ZERO WAVE app/tui/ui/desktop/recorder/sdk/llm (2026-09-11). UI/TUI state is
  // process-bounded render/coordination state (W1/W2 rules re-asserted per key); desktop is the
  // Electron main-process/preload/renderer singleton family (W5); recorder/sdk/llm are per-media
  // coordination maps and client factories.
  // ===========================================================================
  ...Object.fromEntries(
    (
      [
        // ---- app/src: UI process state (ui_process_state), render-tree bounded ----
        ["packages/app/src/app.tsx:Session", ["ui-route-component", "ui-process", "route-lifetime", "unmount-gc", "ephemeral-ui", "product-ui", "safe_scoped"]],
        ["packages/app/src/app.tsx:HomeRoute", ["ui-route-component", "ui-process", "route-lifetime", "unmount-gc", "ephemeral-ui", "product-ui", "safe_scoped"]],
        ["packages/app/src/app.tsx:ReviewRoute", ["ui-route-component", "ui-process", "route-lifetime", "unmount-gc", "ephemeral-ui", "product-ui", "safe_scoped"]],
        ["packages/app/src/app.tsx:AgentSystemRoute", ["ui-route-component", "ui-process", "route-lifetime", "unmount-gc", "ephemeral-ui", "product-ui", "safe_scoped"]],
        ["packages/app/src/components/code-editor.tsx:BREAKPOINT_MARKER", ["ui-marker-const", "source-module", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/code-editor.tsx:PAUSED_MARKER", ["ui-marker-const", "source-module", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/dialog-custom-provider-form.ts:row", ["form-component-state", "ui-owner-invocation", "owner-lifecycle", "owner-exit-gc", "ephemeral-ui", "product-ui", "safe_scoped"]],
        ["packages/app/src/components/prompt-input/scenario-override.ts:listeners", ["module-listener-set", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/components/prompt-input/scenario-override.ts:scenarioOverride", ["module-singleton-state", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/components/prompt-input/submit.ts:pending", ["module-pending-map", "per-followup-id", "active-followups", "resolve-on-response-or-abort", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/components/settings-keybinds.tsx:ButtonV2", ["ui-lazy-component", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/settings-keybinds.tsx:IconButtonV2", ["ui-lazy-component", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/settings-keybinds.tsx:IconV2", ["ui-lazy-component", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/settings-keybinds.tsx:SettingsListV2", ["ui-lazy-component", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/settings-keybinds.tsx:TextInputV2", ["ui-lazy-component", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/settings-v2/general.tsx:demoSoundState", ["ui-demo-toggle", "ui-process", "toggle-lifetime", "toggle-flip", "ephemeral-ui", "product-ui", "safe_bounded"]],
        ["packages/app/src/components/status-popover.tsx:ServerBody", ["ui-lazy-component", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/app/src/components/terminal.tsx:shared", ["module-lazy-singleton", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_scoped"]],
        ["packages/app/src/context/file/content-cache.ts:lru", ["module-lru-cache", "per-file-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/file/content-cache.ts:total", ["module-lru-counter", "per-file-key", "process-lifetime", "lru-eviction", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/global-sync/bootstrap.ts:providerRev", ["module-revision-counter", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/global-sync/session-prefetch.ts:cache", ["module-lru-cache", "per-session-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/global-sync/session-prefetch.ts:inflight", ["module-inflight-map", "per-session-key", "request-duration", "response-settle", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/global-sync/session-prefetch.ts:nextRevision", ["module-revision-counter", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/global-sync/session-prefetch.ts:rev", ["module-revision-counter", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/language.tsx:dicts", ["module-dictionary-cache", "per-locale", "process-lifetime", "locale-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/local.tsx:handoff", ["module-singleton-state", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/terminal.tsx:lruClock", ["module-lru-counter", "per-session-key", "process-lifetime", "lru-eviction", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/terminal.tsx:sessionTerminalCache", ["module-lru-cache", "per-session-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/terminal.tsx:sessions", ["module-session-map", "per-session-key", "process-lifetime", "session-close-cleanup", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/context/terminal.tsx:workspaceDiscardFn", ["module-singleton-callback", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/pages/session/composer/session-question-dock.tsx:cache", ["component-lru-cache", "per-question-key", "dock-lifetime", "unmount-gc", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/pages/session/message-timeline.tsx:timelineCache", ["module-lru-cache", "per-session-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/id.ts:counter", ["module-counter", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/app/src/utils/id.ts:lastTimestamp", ["module-counter", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/app/src/utils/notification-click.ts:nav", ["module-singleton-callback", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/persist.ts:cache", ["module-lru-cache", "per-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/persist.ts:cacheTotal", ["module-lru-counter", "per-key", "process-lifetime", "lru-eviction", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/persist.ts:fallback", ["module-fallback-store", "per-key", "process-lifetime", "storage-flush", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/server-health.ts:healthCache", ["module-memoization", "per-server-key", "ttl-expiry", "eviction-on-refresh", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/sound.ts:cache", ["module-memoization", "per-sound-key", "process-lifetime", "process-exit", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/sound.ts:files", ["module-lazy-load-map", "per-sound-key", "process-lifetime", "process-exit", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/sound.ts:loads", ["module-inflight-map", "per-sound-key", "load-duration", "load-settle", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/app/src/utils/toast.tsx:v2", ["module-lazy-singleton", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_scoped"]],
        ["packages/app/src/utils/worktree.ts:state", ["module-singleton-state", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_scoped"]],
        ["packages/app/src/utils/worktree.ts:waiters", ["module-waiter-set", "per-request", "request-duration", "resolve-on-state", "coordination-only", "product-ui", "safe_bounded"]],
        // ---- tui/src: terminal-UI process state ----
        ["packages/tui/src/audio.ts:audio", ["module-lazy-singleton", "tui-process", "process-lifetime", "process-exit", "coordination-only", "product-tui", "safe_scoped"]],
        ["packages/tui/src/audio.ts:sounds", ["module-lazy-load-map", "per-sound-key", "process-lifetime", "process-exit", "memoization-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/clipboard.ts:copyMethod", ["module-singleton-state", "tui-process", "process-lifetime", "process-exit", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/component/prompt/index.tsx:money", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/tui/src/component/prompt/index.tsx:stashed", ["component-state", "ui-owner-invocation", "owner-lifecycle", "owner-exit-gc", "ephemeral-ui", "product-tui", "safe_scoped"]],
        ["packages/tui/src/context/theme.tsx:setStore", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/tui/src/context/theme.tsx:store", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/tui/src/context/v2-session-journal.ts:pollMsOverride", ["module-singleton-state", "tui-process", "process-lifetime", "process-exit", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/editor-zed.ts:utf8", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/tui/src/feature-plugins/session/preview-pane.tsx:messageCache", ["plugin-lru-cache", "per-message-key", "plugin-lifetime", "lru-eviction", "memoization-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/feature-plugins/sidebar/context.tsx:money", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/tui/src/keymap.tsx:modeStacks", ["module-mode-stacks", "per-mode-key", "process-lifetime", "mode-pop", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/plugin/command-shim.ts:warned", ["module-warned-set", "per-plugin-key", "process-lifetime", "process-exit", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/prompt/display.ts:graphemes", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/tui/src/routes/home.tsx:once", ["module-one-shot-flag", "tui-process", "process-lifetime", "first-fire", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/terminal-win32.ts:k32", ["module-lazy-singleton", "tui-process", "process-lifetime", "process-exit", "coordination-only", "product-tui", "safe_scoped"]],
        ["packages/tui/src/terminal-win32.ts:unhook", ["module-singleton-callback", "tui-process", "process-lifetime", "process-exit", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/theme/index.ts:customThemes", ["module-theme-map", "per-theme-name", "process-lifetime", "theme-remove", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/theme/index.ts:listeners", ["module-listener-set", "tui-process", "process-lifetime", "listener-unsubscribe", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/theme/index.ts:pluginThemes", ["module-theme-map", "per-theme-name", "process-lifetime", "theme-remove", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/theme/index.ts:systemTheme", ["module-singleton-state", "tui-process", "process-lifetime", "watch-update", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/util/layout.ts:previousByParent", ["module-layout-cache", "per-parent-key", "render-cycle", "render-replace", "ephemeral-runtime", "product-tui", "safe_bounded"]],
        ["packages/tui/src/util/session.ts:pendingForkIntents", ["module-pending-map", "per-intent-key", "intent-duration", "intent-settle", "coordination-only", "product-tui", "safe_bounded"]],
        ["packages/tui/src/util/session.ts:pendingForkRequests", ["module-registry", "per-request-key", "request-duration", "request-settle", "coordination-only", "product-tui", "safe_bounded"]],
        // ---- ui/src: shared UI library caches (singletons bounded by product process) ----
        ["packages/ui/src/components/basic-tool.tsx:deferredFrame", ["module-frame-state", "ui-process", "frame-lifetime", "frame-commit", "ephemeral-ui", "product-ui", "safe_bounded"]],
        ["packages/ui/src/components/basic-tool.tsx:deferredMounts", ["module-mount-registry", "per-mount-key", "process-lifetime", "unmount-cleanup", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/components/icon.tsx:spriteInserted", ["module-one-shot-flag", "ui-process", "process-lifetime", "first-insert", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/v2/components/icon.tsx:spriteInserted", ["module-one-shot-flag", "ui-process", "process-lifetime", "first-insert", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/components/line-comment-styles.ts:installed", ["module-one-shot-flag", "ui-process", "process-lifetime", "first-install", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/components/markdown.tsx:cache", ["module-lru-cache", "per-content-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/components/message-part.tsx:PART_MAPPING", ["module-registration-map", "source-module", "registration-time-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/ui/src/components/message-part.tsx:state", ["module-singleton-state", "ui-process", "process-lifetime", "process-exit", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/components/session-diff.ts:patchFileDiffCache", ["module-lru-cache", "per-diff-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/components/timeline-playground.stories.tsx:seq", ["storybook-counter", "story-invocation", "story-lifetime", "story-return", "ephemeral-ui", "dev-only", "safe_bounded"]],
        ["packages/ui/src/pierre/file-find.ts:current", ["module-singleton-state", "ui-process", "widget-lifetime", "widget-close", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/pierre/file-find.ts:hosts", ["module-host-registry", "per-host-key", "process-lifetime", "host-unregister", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/pierre/file-find.ts:installed", ["module-one-shot-flag", "ui-process", "process-lifetime", "first-install", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/pierre/file-find.ts:target", ["module-singleton-state", "ui-process", "widget-lifetime", "widget-close", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/pierre/virtualizer.ts:cache", ["module-lru-cache", "per-element-key", "process-lifetime", "lru-eviction", "memoization-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/pierre/worker.ts:split", ["module-lazy-singleton", "ui-process", "worker-lifetime", "worker-terminate", "coordination-only", "product-ui", "safe_scoped"]],
        ["packages/ui/src/pierre/worker.ts:unified", ["module-lazy-singleton", "ui-process", "worker-lifetime", "worker-terminate", "coordination-only", "product-ui", "safe_scoped"]],
        ["packages/ui/src/theme/context.tsx:files", ["module-theme-file-map", "per-theme-key", "process-lifetime", "theme-remove", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/theme/context.tsx:ids", ["module-id-map", "per-theme-key", "process-lifetime", "theme-remove", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/theme/context.tsx:known", ["module-known-set", "per-theme-key", "process-lifetime", "theme-remove", "coordination-only", "product-ui", "safe_bounded"]],
        ["packages/ui/src/theme/loader.ts:activeTheme", ["module-singleton-state", "ui-process", "process-lifetime", "theme-change", "coordination-only", "product-ui", "safe_bounded"]],
        // ---- desktop/src: Electron main/preload/renderer singletons (W5 family) ----
        ["packages/desktop/src/main/windows.ts:relaunchHandler", ["electron-main-singleton", "main-process", "process-lifetime", "app-quit", "coordination-only", "desktop-main", "safe_bounded"]],
        ["packages/desktop/src/main/windows.ts:titlebarThemes", ["electron-main-singleton", "main-process", "process-lifetime", "app-quit", "coordination-only", "desktop-main", "safe_bounded"]],
        ["packages/desktop/src/preload/index.ts:updaterCallbacks", ["preload-singleton", "preload-lifetime", "window-lifetime", "window-close", "coordination-only", "desktop-preload", "safe_bounded"]],
        ["packages/desktop/src/preload/index.ts:updaterState", ["preload-singleton", "preload-lifetime", "window-lifetime", "window-close", "coordination-only", "desktop-preload", "safe_bounded"]],
        ["packages/desktop/src/preload/index.ts:updaterSubscription", ["preload-singleton", "preload-lifetime", "window-lifetime", "window-close", "coordination-only", "desktop-preload", "safe_bounded"]],
        ["packages/desktop/src/renderer/i18n/index.ts:state", ["renderer-singleton", "renderer-process", "process-lifetime", "window-close", "coordination-only", "desktop-renderer", "safe_bounded"]],
        ["packages/desktop/src/renderer/index.tsx:menuTrigger", ["renderer-singleton", "renderer-process", "process-lifetime", "window-close", "coordination-only", "desktop-renderer", "safe_bounded"]],
        ["packages/desktop/src/renderer/index.tsx:rendererReadyLogged", ["renderer-one-shot-flag", "renderer-process", "process-lifetime", "first-fire", "coordination-only", "desktop-renderer", "safe_bounded"]],
        ["packages/desktop/src/renderer/webview-zoom.ts:pinchZoomEnabled", ["renderer-singleton", "renderer-process", "process-lifetime", "window-close", "coordination-only", "desktop-renderer", "safe_bounded"]],
        ["packages/desktop/src/renderer/webview-zoom.ts:requestedZoom", ["renderer-singleton", "renderer-process", "process-lifetime", "window-close", "coordination-only", "desktop-renderer", "safe_bounded"]],
        ["packages/desktop/src/renderer/webview-zoom.ts:wheelPinch", ["renderer-singleton", "renderer-process", "process-lifetime", "window-close", "coordination-only", "desktop-renderer", "safe_bounded"]],
        // ---- http-recorder / sdk / llm ----
        ["packages/http-recorder/src/cassette.ts:closure@148:149.stored", ["cassette-instance", "per-cassette", "cassette-lifetime", "cassette-flush", "memoization-only", "instance-scoped", "safe_scoped"]],
        ["packages/http-recorder/src/cassette.ts:closure@148:152.accumulatedFindings", ["cassette-instance", "per-cassette", "cassette-lifetime", "cassette-flush", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/http-recorder/src/cassette.ts:closure@148:153.appendLock", ["cassette-instance", "per-cassette", "append-duration", "release-on-append", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/http-recorder/src/cassette.ts:closure@77:80.recorded", ["recorder-instance", "per-recorder", "recorder-lifetime", "recorder-dispose", "memoization-only", "instance-scoped", "safe_scoped"]],
        ["packages/llm/src/route/executor.ts:secretValues@231:232.values", ["executor-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/sdk/js/src/client.ts:createDeepAgentCodeClient@58:85.client", ["factory-invocation", "single-call", "client-lifetime", "caller-close", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/sdk/js/src/index.ts:createDeepAgentCode@8:13.client", ["factory-invocation", "single-call", "client-lifetime", "caller-close", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/sdk/js/src/index.ts:createDeepAgentCode@8:9.server", ["factory-invocation", "single-call", "server-handle-lifetime", "caller-close", "coordination-only", "instance-scoped", "safe_scoped"]],
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
        ["packages/deepagent-code/src/session/prompt.ts:closure@1181:1367.activeFederatedContexts", ["SessionPrompt.layer-instance", "per-session-or-directory", "active-sessions-and-directories", "settle-cleanup-or-layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1181:1371.steerAbsorbRounds", ["SessionPrompt.layer-instance", "per-session-or-directory", "active-sessions-and-directories", "settle-cleanup-or-layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1181:1372.activeReleasedKnowledge", ["SessionPrompt.layer-instance", "per-session-or-directory", "active-sessions-and-directories", "settle-cleanup-or-layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1181:7007.notificationWorkers", ["SessionPrompt.layer-instance", "per-session-or-directory", "active-sessions-and-directories", "settle-cleanup-or-layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1181:7070.durableWorkers", ["SessionPrompt.layer-instance", "per-session-or-directory", "active-sessions-and-directories", "settle-cleanup-or-layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1181:7071.durableLeases", ["SessionPrompt.layer-instance", "per-session-or-directory", "active-sessions-and-directories", "settle-cleanup-or-layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1431:1433.seen", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1468:1475.seen", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@1606:1674.taskAbort", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:closure@3492:3618.accumulatedChangeSurface", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/prompt.ts:execRead@2493:2494.controller", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        // snapshot/compaction/revert/session families: per-invocation maps and per-session keyed
        // mutexes released at settle.
        ["packages/deepagent-code/src/session/snapshot.ts:closure@136:149.messageMap", ["snapshot-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/snapshot.ts:closure@136:150.partMap", ["snapshot-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/snapshot.ts:closure@136:151.activityMap", ["snapshot-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/snapshot.ts:closure@136:186.progressByActivity", ["snapshot-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/snapshot/index.ts:closure@910:918.reasons", ["snapshot-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/compaction.ts:closure@498:516.activeCompactions", ["SessionCompaction.layer-instance", "per-session", "active-sessions", "settle-cleanup", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/revert.ts:closure@52:75.files", ["revert-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/revert.ts:mutationLocks", ["module-keyed-mutex", "per-session-key", "lock-hold-duration", "release-on-settle", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/session/session.ts:closure@3165:3166.updated", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/session.ts:forkLocks", ["module-keyed-mutex", "per-session-key", "lock-hold-duration", "release-on-fork-delivery", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/session/session-completed-publisher.ts:closure@114:130.pending", ["publisher-layer-instance", "per-session", "active-sessions", "publish-or-fail-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/session/run-state.ts:closure@202:207.pending", ["RunState.layer-instance", "per-session", "active-sessions", "settle-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/session/run-state.ts:closure@202:208.cancelled", ["RunState.layer-instance", "per-session", "active-sessions", "settle-cleanup", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/run-state.ts:closure@58:60.runners", ["RunState.layer-instance", "per-session", "active-sessions", "run-completion-cleanup", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/message-v2.ts:hydrate@375:377.partByMessage", ["hydrate-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/message-v2.ts:hydrate@375:378.progressByMessage", ["hydrate-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/diff-artifact.ts:isBusySnapshot@165:166.seen", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/context-ledger.ts:closure@181:187.forkStore", ["context-ledger-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "memoization-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/agent-push.ts:closure@126:137.roots", ["agent-push-layer-instance", "per-root", "active-push-roots", "push-completion-cleanup", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/multi-agent-runtime.ts:ancestorsOf@357:358.acc", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/multi-agent-runtime.ts:closure@187:206.tokenUsage", ["runtime-instance", "per-session", "active-sessions", "settle-cleanup", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/session/processor.ts:DegenerationDetector.prevNgramSet@412", ["detector-instance", "per-session-detector", "detector-lifetime", "detector-owner", "coordination-only", "per-turn", "safe_bounded"]],
        ["packages/deepagent-code/src/session/deepagent-multiround.ts:StopHook", ["module-hook-object", "source-module", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/session/tools.ts:PlanHook", ["module-hook-object", "source-module", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/session/v2-plan-gate.ts:planHook", ["module-hook-object", "source-module", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        // provider discovery caches (W-family re-pins): process-bounded failure memoization and
        // discovered-provider registries refreshed per discovery pass.
        ["packages/deepagent-code/src/provider/provider.ts:closure@1301:1438.failedDiscoveryProviders", ["Provider-layer-instance", "per-discovery-pass", "runtime-lifetime", "layer-finalizer", "memoization-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/provider/provider.ts:closure@1301:1439.failedDiscoveryGroups", ["Provider-layer-instance", "per-discovery-pass", "runtime-lifetime", "layer-finalizer", "memoization-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/provider/provider.ts:closure@1301:1442.discoveryProviders", ["Provider-layer-instance", "per-discovery-pass", "runtime-lifetime", "layer-finalizer", "memoization-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/provider/provider.ts:closure@1301:1446.legacyDiscoveryProviders", ["Provider-layer-instance", "per-discovery-pass", "runtime-lifetime", "layer-finalizer", "memoization-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/provider/provider.ts:timeoutController@116:117.ctl", ["invocation-scope", "single-call", "call-stack", "abort-on-completion", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        // keyed locks across the tool/task/orchestration family: released at settle; overlays
        // bounded by fanout ceilings.
        ["packages/deepagent-code/src/agent/pr-collaboration.ts:mergeLocks", ["module-keyed-mutex", "per-session-key", "lock-hold-duration", "release-on-merge", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/agent/pr-collaboration.ts:sessionBranchLocks", ["module-keyed-mutex", "per-session-key", "lock-hold-duration", "release-on-merge", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/session/v4-pr-collaboration.ts:parentLocks", ["module-keyed-mutex", "per-session-key", "lock-hold-duration", "release-on-merge", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/tool/apply_patch_chunk.ts:closure@39:42.transactions", ["ApplyPatchChunkTool.layer-instance", "per-session", "8-transactions-per-session-plus-30min-ttl-sweep", "commit-or-abort-delete-plus-ttl-sweep-on-call", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/tool/apply_patch_chunk.ts:encoder", ["source-module", "source-symbol", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/tool/code_intel.ts:closure@477:479.visited", ["invocation-scope", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/tool/internal.ts:tools", ["module-registration-map", "source-module", "registration-time-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/tool/provenance.ts:store", ["module-WeakMap", "per-tool-object", "tool-object-lifetime", "gc-with-tool-object", "memoization-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/tool/semantic-fingerprint.ts:resolvers", ["module-registry-map", "source-module", "registration-time-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/tool/semantic-fingerprint.ts:resultResolvers", ["module-registry-map", "source-module", "registration-time-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/tool/shell.ts:parser", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        // process-level singletons and lazy bootstraps (RI-106 one-root discipline).
        ["packages/deepagent-code/src/effect/app-runtime.ts:rootDatabasePath", ["AppRuntime-root-build", "per-root-build", "root-lifetime", "root-dispose", "coordination-only", "process-singleton", "safe_scoped"]],
        ["packages/deepagent-code/src/effect/app-runtime.ts:rt", ["AppRuntime-root-build", "per-root-build", "root-lifetime", "root-dispose", "coordination-only", "process-singleton", "safe_scoped"]],
        ["packages/deepagent-code/src/effect/instance-registry.ts:stateDisposers", ["module-WeakMap", "per-instance-context", "instance-lifetime", "gc-with-context", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/bus/global.ts:GlobalBus", ["process-event-bus", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/id/id.ts:counter", ["module-counter", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/id/id.ts:lastTimestamp", ["module-counter", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/shell/shell.ts:defaultAcceptable", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/shell/shell.ts:defaultPreferred", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/server/shared/ui.ts:UI_UPSTREAM_HOST", ["env-derived-const", "source-module", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/server/shared/ui.ts:embeddedUIPromise", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/server/routes/instance/httpapi/handlers/profile.ts:closure@79:81.runStore", ["profile-handler-layer-instance", "per-run", "active-runs", "run-terminal-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/server/routes/instance/httpapi/lifecycle.ts:disposeAfterResponse", ["module-flag", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/server/routes/instance/httpapi/websocket-tracker.ts:closure@21:22.sockets", ["tracker-layer-instance", "per-socket", "active-websockets", "socket-close-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        // permission/question pending queues: resolved or interrupted within session scope.
        ["packages/deepagent-code/src/permission/index.ts:closure@136:143.withPermissionOwner", ["Permission-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/permission/index.ts:closure@136:190.allPending", ["Permission-layer-instance", "per-ask", "active-asks", "resolve-or-interrupt-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/question/index.ts:closure@141:143.allPending", ["Question-layer-instance", "per-ask", "active-asks", "resolve-or-interrupt-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        // instance store / workspace / artifact-service / location-index: per-instance caches with
        // dispose-driven eviction (the instance registry owns the lifetime).
        ["packages/deepagent-code/src/project/instance-store.ts:closure@42:47.cache", ["InstanceStore-layer-instance", "per-directory-instance", "instance-lifetime", "registry-dispose-eviction", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/control-plane/workspace.ts:closure@207:215.connections", ["workspace-layer-instance", "per-connection", "active-connections", "connection-close-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/control-plane/workspace.ts:closure@926:927.names", ["workspace-layer-instance", "per-workspace", "workspace-lifetime", "workspace-dispose", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/context-federation/artifact-service.ts:closure@23:27.stores", ["artifact-service-instance", "per-store", "service-lifetime", "service-dispose", "memoization-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/context-federation/artifact-service.ts:closure@23:28.storeBuild", ["artifact-service-instance", "per-store", "service-lifetime", "service-dispose", "memoization-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/location-index/runtime.ts:closure@33:40.indexBuild", ["LocationIndexRuntime-instance", "per-instance", "instance-lifetime", "instance-dispose", "memoization-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/location-index/watcher-consumer.ts:closure@19:21.scheduled", ["watcher-consumer-instance", "per-directory", "watch-lifetime", "watch-close", "coordination-only", "instance-scoped", "safe_scoped"]],
        // TS workspace adapter symbol index: per-indexWorkspace invocation.
        ["packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:indexWorkspace@17:29.byPath", ["indexWorkspace-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:indexWorkspace@17:30.records", ["indexWorkspace-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:indexWorkspace@17:61.externalEntities", ["indexWorkspace-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/code-intelligence/typescript-workspace-adapter.ts:collectSymbols@161:163.overloads", ["collectSymbols-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/code-intelligence/editor-buffer-snapshot.ts:layer@43:44.snapshots", ["editor-snapshot-layer-instance", "per-document", "layer-lifetime", "layer-finalizer", "memoization-only", "instance-scoped", "safe_scoped"]],
        // debug client + rpc: per-connection pending maps, closed with the socket.
        ["packages/deepagent-code/src/debug/client.ts:create@52:90.pending", ["debug-client-connection", "per-connection", "connection-lifetime", "connection-close", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/debug/client.ts:create@52:91.eventHandlers", ["debug-client-connection", "per-connection", "connection-lifetime", "connection-close", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/util/rpc.ts:client@59:60.pending", ["rpc-client-connection", "per-connection", "connection-lifetime", "connection-close", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/util/rpc.ts:client@59:68.listeners", ["rpc-client-connection", "per-connection", "connection-lifetime", "connection-close", "coordination-only", "instance-scoped", "safe_scoped"]],
        // config/runtime singletons: lazy one-shot bootstraps.
        ["packages/deepagent-code/src/config/config.ts:closure@635:640.consoleManagedProviders", ["Config-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/config/tui.ts:runPromise", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/installation/index.ts:runPromise", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/runtime/base.ts:closure@181:185.approvals", ["RuntimeBase-instance", "per-approval", "instance-lifetime", "approval-resolution-cleanup", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/deepagent/learning-runtime.ts:closure@34:35.factories", ["learning-runtime-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        // CLI run-mode surfaces: per-command-invocation trees, TUI worker singleton, otel/heap
        // one-shot bootstraps, splash/scrollback render state.
        ["packages/deepagent-code/src/cli/cmd/run/noninteractive.ts:createBackgroundSessions@57:58.sessions", ["run-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/noninteractive.ts:createBackgroundSessions@57:59.settled", ["run-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/noninteractive.ts:createSessionTree@6:7.owned", ["run-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/otel.ts:ready", ["otel-bootstrap", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/cmd/run/otel.ts:runtime", ["otel-bootstrap", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/cmd/run/runtime.boot.ts:runtime", ["run-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/runtime.ts:closure@916:917.sdk", ["run-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/scrollback.surface.ts:RunScrollbackStream.pendingThemes@96", ["render-surface-instance", "per-render", "surface-lifetime", "surface-dispose", "coordination-only", "run-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/cmd/run/scrollback.surface.ts:nextId", ["module-counter", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/cmd/run/session-data.ts:money", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/cli/cmd/run/splash.ts:id", ["module-counter", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@1208:1233.turn", ["transport-invocation", "per-turn", "turn-lifetime", "turn-completion", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@399:463.replayedParts", ["transport-invocation", "per-turn", "turn-lifetime", "turn-completion", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:closure@399:464.recovering", ["transport-invocation", "per-turn", "turn-lifetime", "turn-completion", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:createSessionTransport@1482:1483.runtime", ["transport-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/stream.transport.ts:createSessionTransport@1482:1486.activeTurns", ["transport-invocation", "per-session", "active-turns", "turn-completion-cleanup", "coordination-only", "run-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/cmd/run/trace.ts:state", ["trace-bootstrap", "process-global", "process-lifetime", "process-exit", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/cmd/run/variant.shared.ts:createVariantRuntime@200:201.runtime", ["run-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/run/variant.shared.ts:runtime", ["run-invocation", "per-run-invocation", "run-lifetime", "run-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/cmd/tui.ts:closure@114:141.worker", ["tui-command-invocation", "per-tui-invocation", "tui-lifetime", "tui-exit", "coordination-only", "run-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/heap.ts:armed", ["one-shot-timer-guard", "process-global", "process-lifetime", "timer-fire", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/heap.ts:lock", ["one-shot-timer-guard", "process-global", "process-lifetime", "timer-fire", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/heap.ts:timer", ["one-shot-timer-guard", "process-global", "process-lifetime", "timer-fire", "coordination-only", "process-global", "safe_bounded"]],
        ["packages/deepagent-code/src/cli/tui/worker.ts:server", ["tui-worker-singleton", "process-global", "worker-lifetime", "worker-exit", "coordination-only", "process-global", "safe_scoped"]],
        ["packages/deepagent-code/src/cli/ui.ts:blank", ["render-state", "per-render", "render-lifetime", "render-return", "ephemeral-runtime", "run-scoped", "safe_bounded"]],
        ["packages/deepagent-code/src/control-plane/dev/debug-workspace-plugin.ts:PORT", ["env-derived-const", "source-module", "source-bounded", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/lsp/server.ts:roslynLanguageServerInstall", ["lazy-memoization", "source-module", "first-use-initialized", "not-applicable", "non-authority", "package-static", "safe_static"]],
        ["packages/deepagent-code/src/import/source/codex.ts:AssistantTurnBlocks.blocks@233", ["parser-instance", "per-parse", "parse-lifetime", "parse-return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/deepagent-code/src/wiki/session-archive.ts:persistArchiveDoc@239:242.store", ["persistArchiveDoc-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
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
        ["packages/core/src/agent-gateway.ts:createStorageRuntime@528:540.seed", ["createStorageRuntime-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        // cross-spawn-spawner: in-flight child process registries drained by wait semantics.
        ["packages/core/src/cross-spawn-spawner.ts:closure@168:180.ins", ["spawner-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/cross-spawn-spawner.ts:closure@168:181.outs", ["spawner-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        // migration journal: completed-id set captured per migration run.
        ["packages/core/src/database/migration.ts:closure@181:189.completed", ["migration-run", "single-run", "run-lifetime", "run-return", "durable-journal-backed", "run-scoped", "safe_scoped"]],
        // event-bus consumer groups + db cache: per bus instance; groups refcounted on unsubscribe.
        ["packages/core/src/deepagent/deepagent-event-bus.ts:closure@269:291.groups", ["event-bus-instance", "per-bus", "bus-lifetime", "bus-dispose", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/deepagent/deepagent-event-bus.ts:closure@269:326.dbGroupsCache", ["event-bus-instance", "per-bus", "bus-lifetime", "bus-dispose", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/core/src/deepagent/domain-pack-registry.ts:discover@174:175.seen", ["discover-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/deepagent/event-registry.ts:createEventRegistry@116:117.map", ["createEventRegistry-invocation", "per-registry", "registry-lifetime", "registry-owner-dispose", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/deepagent/hooks.ts:HookPolicy.handlers@20", ["HookPolicy-instance", "per-policy", "policy-lifetime", "policy-owner", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/deepagent/rate-limiter.ts:Service.buckets@24", ["RateLimiter-instance", "per-limiter", "limiter-lifetime", "limiter-owner", "coordination-only", "bounded-max-live-buckets", "safe_bounded"]],
        ["packages/core/src/deepagent/workspace-concurrency.ts:closure@53:57.inFlight", ["workspace-concurrency-instance", "per-instance", "instance-lifetime", "instance-owner", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/file-lock.ts:closure@44:46.locks", ["FileLock-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/file-lock.ts:closure@44:48.byId", ["FileLock-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/flag/runtime-features.ts:createRuntimeFeatureRegistry@112:116.features", ["createRuntimeFeatureRegistry-invocation", "per-registry", "registry-lifetime", "registry-owner", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/flag/runtime-features.ts:RuntimeFeatures", ["RuntimeFeatures-registry", "per-registry", "registry-lifetime", "registry-owner", "coordination-only", "instance-scoped", "safe_scoped"]],
        // permission ask queue: pending asks resolved or interrupted within their session scope.
        ["packages/core/src/permission.ts:closure@197:205.withNoProgressOwner", ["PermissionV2-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/permission.ts:closure@197:206.pending", ["PermissionV2-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "session-scoped", "safe_scoped"]],
        ["packages/core/src/pty.ts:closure@142:147.sessions", ["Pty-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/question.ts:closure@131:133.pending", ["QuestionV2-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "session-scoped", "safe_scoped"]],
        ["packages/core/src/session/execution/local.ts:closure@18:26.ownedClaims", ["SessionExecutionLocal-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/session/run-coordinator.ts:closure@81:82.active", ["SessionRunCoordinator-instance", "per-coordinator", "scope-lifetime", "addFinalizer-clear", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/session/runner/publish-llm-event.ts:createLLMEventPublisher@73:74.tools", ["createLLMEventPublisher-invocation", "per-publisher", "publisher-lifetime", "publisher-owner", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/session/runner/publish-llm-event.ts:fragments@105:109.chunks", ["fragments-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/session/runner/recovery.ts:closure@1465:1466.store", ["recovery-module-instance", "per-instance", "instance-lifetime", "instance-owner", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/skill.ts:closure@90:142.cache", ["SkillV2-layer-instance", "per-layer", "layer-lifetime", "layer-finalizer", "memoization-only", "instance-scoped", "safe_bounded"]],
        ["packages/core/src/state.ts:create@55:58.semaphore", ["create-invocation", "single-call", "owner-lifetime", "owner-release", "coordination-only", "instance-scoped", "safe_scoped"]],
        ["packages/core/src/system-context/capability-loader-memory.ts:receiptStore", ["capability-loader-memory-instance", "per-instance", "instance-lifetime", "instance-owner", "memoization-only", "instance-scoped", "safe_bounded"]],
        ["packages/core/src/system-context/capability-loader-memory.ts:turnBudgets", ["capability-loader-memory-instance", "per-instance", "instance-lifetime", "instance-owner", "coordination-only", "per-turn", "safe_bounded"]],
        ["packages/core/src/tool/application-tools.ts:closure@26:27.registered", ["ApplicationTools-layer-instance", "per-layer", "layer-lifetime", "scope-finalizer-tokens", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/core/src/tool/registry.ts:closure@163:164.registrations", ["ToolRegistry-layer-instance", "per-layer", "layer-lifetime", "scope-finalizer-tokens", "coordination-only", "instance-scoped", "safe_bounded"]],
        ["packages/core/src/tool/registry.ts:closure@63:67.local", ["ToolRegistry-layer-instance", "per-layer", "layer-lifetime", "scope-finalizer-tokens", "coordination-only", "instance-scoped", "safe_bounded"]],
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
  "packages/core/src/util/effect-flock.ts:closure@99:104.ensuredDirs": {
    owner: "EffectFlock.process",
    keyScope: "lock-root-constant",
    bound: "source-constant-keyspace",
    finalizer: "process-exit",
    durability: "mkdir-memo-only",
    reachability: "storage-locking",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/config/config.ts:attach@1030:1069.observed": {
    owner: "Config.watch-directory-subscription",
    keyScope: "watched-config-or-plugin-filename",
    bound: "config-names-plus-directory-plugin-file-count",
    finalizer: "watch-close-or-directory-rebind-gc",
    durability: "file-fingerprint-cache-only",
    reachability: "config-hot-refresh",
    verdict: "safe_bounded",
  },
  "packages/deepagent-code/src/config/config.ts:closure@993:1016.watchers": {
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
    ([
      ["packages/core/src/deepagent/mechanism-beacon.ts:counts", ["MechanismBeacon.observability", "mechanism-id", "fixed-source-call-site-ids", "process-exit", "stderr-beacon-counter-only", "non-authority", "safe_bounded"]],
      ["packages/core/src/deepagent/mechanism-beacon.ts:details", ["MechanismBeacon.observability", "mechanism-id", "one-detail-string-per-fixed-id", "process-exit", "stderr-beacon-summary-only", "non-authority", "safe_bounded"]],
      ["packages/core/src/deepagent/mechanism-beacon.ts:engagedLogged", ["MechanismBeacon.observability", "process", "max-5-engage-logs", "cap-at-MAX_ENGAGE_LOGS", "stderr-emission-counter-only", "non-authority", "safe_bounded"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/core/src/deepagent/turn-observability.ts:JSON_LENGTH_CACHE", ["TurnObservability.estimator", "per-json-object", "weak-key-gc", "gc-with-key-object", "memoization-only", "instance-scoped", "safe_bounded"]],
      ["packages/core/src/deepagent/turn-observability.ts:sessions", ["TurnObservability.per-drain-record", "per-session-key", "concurrent-sessions", "drain-exit-emitTurnSummary-delete", "observability-counters-only", "session-scoped", "safe_bounded"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/core/src/event.ts:closure@617:619.synchronized", ["EventV2.layer-instance", "per-aggregate-subscription", "active-aggregate-subscriptions", "acquireRelease-delete-plus-layer-finalizer", "coordination-only", "instance-scoped", "safe_scoped"]],
      ["packages/core/src/event.ts:closure@617:620.typed", ["EventV2.layer-instance", "per-definition-key", "source-definition-keyspace", "layer-finalizer-pubsub-shutdown", "coordination-only", "instance-scoped", "safe_scoped"]],
      ["packages/core/src/event.ts:closure@617:623.projectors", ["EventV2.layer-instance", "per-definition-key", "max-64-projectors-per-key", "layer-scope-close-gc", "coordination-only", "instance-scoped", "safe_scoped"]],
      ["packages/core/src/event.ts:closure@617:624.snapshotCodecs", ["EventV2.layer-instance", "per-codec-schemaVersion-key", "one-codec-per-key", "layer-scope-close-gc", "codec-registry-only", "instance-scoped", "safe_scoped"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // session/projector.ts wire-egress memos: WIRE_SESSION_MEMO_MAX=2000 (:334,339) and
  // WIRE_CURSOR_MEMO_MAX=10000 (:403,426) with clear-on-full; the cursor memo falls back to the
  // DURABLE session_wire_projection fingerprint row for unknown keys (:418-424), so the durable
  // cursor remains the dedup authority and a cleared memo costs one SELECT.
  ...Object.fromEntries(
    ([
      ["packages/core/src/session/projector.ts:wireSessionMemo", ["SessionProjector.wire-egress", "per-session-key", "max-2000-clear-on-full", "clear-on-full-eviction", "memoization-only", "v2-wire-projection", "safe_bounded"]],
      ["packages/core/src/session/projector.ts:wireCursorMemo", ["SessionProjector.wire-egress", "per-session-entity-id-key", "max-10000-clear-on-full", "clear-on-full-eviction", "durable-cursor-is-authority-memo-only", "v2-wire-projection", "safe_bounded"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // tool/task-policy.ts: taskSlots is the per-session subagent semaphore pool, refcounted and
  // deleted at zero users. Coordination ceiling only — the fan-out admission ledger became the
  // durable session_v2_task_call_admission table (C-P2-08) and durable task authority is
  // TaskRunAuthority.
  ...Object.fromEntries(
    ([
      ["packages/core/src/tool/task-policy.ts:taskSlots", ["TaskPolicy.concurrency-pool", "per-session-key", "active-sessions-refcount", "refcount-zero-delete", "mutex-only", "v2-task-admission", "safe_bounded"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/core/src/session/runner/llm.ts:closure@792:1394.withPublication", ["SessionRunner.runTurnAttempt-invocation", "single-turn", "call-stack", "return", "coordination-only", "per-turn", "safe_scoped"]],
      ["packages/core/src/session/runner/llm.ts:closure@792:1501.planResultMetadata", ["SessionRunner.runTurnAttempt-invocation", "single-turn", "turn-plan-tool-call-count", "return", "turn-validation-only", "per-turn", "safe_scoped"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // The legacy learning queue constructs a durable knowledge store when each job drains; the
  // worker drops out of the queue after completion. runtimeLayer builds one storage runtime per
  // layer and drains its learning queue on scope close.
  ...Object.fromEntries(
    ([
      ["packages/core/src/agent-gateway.ts:closure@1124:1132.durable", ["DeepAgent-learning-job-build", "per-queued-job", "job-run-lifetime", "queue-drain-job-settle-gc", "durable-store-backed", "instance-scoped", "safe_scoped"]],
      ["packages/core/src/agent-gateway.ts:closure@3580:3582.storage", ["DeepAgent-runtime-instance", "per-runtime-layer", "layer-lifetime", "layer-scope-close-and-queue-drain", "durable-store-backed", "instance-scoped", "safe_scoped"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/core/src/database/sqlite.worker.ts:closure@112:120.worker", ["SqliteWorker.client-instance", "per-instance", "one-worker-thread", "layer-finalizer-terminate", "transport-only", "instance-scoped", "safe_scoped"]],
      ["packages/core/src/database/sqlite.worker.ts:closure@112:122.pending", ["SqliteWorker.client-instance", "in-flight-message-id", "in-flight-statements", "reply-delete-plus-error-clear", "coordination-only", "instance-scoped", "safe_bounded"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/deepagent-code/src/session/multi-agent-runtime.ts:ancestorsOf@403:404.acc", ["ancestorsOf-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/multi-agent-runtime.ts:closure@224:243.tokenUsage", ["MultiAgentRuntime.layer-instance", "per-agent-key", "distinct-agent-count", "window-expiry-reset", "test-fallback-budget-only-durable-ledger-is-authority", "instance-scoped", "safe_bounded"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/deepagent-code/src/session/prompt.ts:closure@1044:1228.activeFederatedContexts", ["SessionPrompt.layer-instance", "per-session-key", "active-sessions", "settle-cleanup-on-every-terminal-exit", "coordination-only", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/prompt.ts:closure@1044:1232.steerAbsorbRounds", ["SessionPrompt.layer-instance", "per-session-key", "active-sessions", "activity-run-start-delete", "coordination-only", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/prompt.ts:closure@1044:1233.activeReleasedKnowledge", ["SessionPrompt.layer-instance", "per-session-key", "active-sessions", "settle-cleanup-on-every-terminal-exit", "coordination-only", "instance-scoped", "safe_scoped"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/deepagent-code/src/session/prompt.ts:closure@1282:1284.seen", ["resolveReferenceParts-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/prompt.ts:closure@1319:1326.seen", ["resolvePromptParts-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/prompt.ts:closure@1457:1524.taskAbort", ["handleSubtask-invocation", "single-call", "call-stack", "return", "abort-signal-only", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/prompt.ts:closure@3342:3468.accumulatedChangeSurface", ["deepagent-macro-round-invocation", "single-call", "files-touched-in-run", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/prompt.ts:execRead@2343:2344.controller", ["execRead-invocation", "single-call", "tool-call-duration", "abort-on-interrupt", "abort-signal-only", "instance-scoped", "safe_scoped"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // run-state (re-pins after shift): runners is the per-session runner-lane map — deleted on runner
  // idle (:82) and cleared by the InstanceState finalizer (:60-68); cancelBackgroundJobs' pending/
  // cancelled sets are per-invocation BFS frontier/dedup (:195-227).
  ...Object.fromEntries(
    ([
      ["packages/deepagent-code/src/session/run-state.ts:closure@57:59.runners", ["RunState.instance-state", "per-session-key", "active-runner-lanes", "onIdle-delete-plus-finalizer-clear", "coordination-only", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/run-state.ts:closure@195:200.pending", ["cancelBackgroundJobs-invocation", "single-call", "background-job-count", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/run-state.ts:closure@195:201.cancelled", ["cancelBackgroundJobs-invocation", "single-call", "background-job-count", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // session.ts (re-pins after shift): touch's timestamp is a per-call immutable value (:3168-3169);
  // partOwnershipVerified memoizes the immutable part-ownership check for streamed deltas with a
  // 10_000 clear-on-full ceiling (added in this wave; a cleared key costs one redundant SELECT —
  // the durable row remains the ownership authority).
  ...Object.fromEntries(
    ([
      ["packages/deepagent-code/src/session/session.ts:closure@3205:3206.updated", ["Session.touch-invocation", "single-call", "call-stack", "return", "ephemeral-runtime", "instance-scoped", "safe_scoped"]],
      ["packages/deepagent-code/src/session/session.ts:closure@882:1252.partOwnershipVerified", ["Session.layer-instance", "per-part-key", "max-10000-clear-on-full", "clear-on-full-eviction", "memoization-only-durable-ownership-is-authority", "instance-scoped", "safe_bounded"]],
    ] as const).map(([key, [owner, keyScope, bound, finalizer, durability, reachability, verdict]]) => [
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
    ([
      ["packages/core/src/npm.ts:notFound", "Npm.module", "per-directory-and-package", "max-1024", "oldest-key-eviction", "memoization-only", "process-local", "safe_bounded"],
      ["packages/core/src/shell/scan.ts:parser", "ShellScan.module", "single-parser-pair", "one-lazy-initialization", "process-exit", "parse-resource-only", "process-local", "safe_bounded"],
      ["packages/deepagent-code/src/mcp/dpapi.bun.ts:crypt32", "DPAPI-Bun-module", "one-native-library", "single-open", "process-exit", "native-codec-only", "process-local", "safe_bounded"],
      ["packages/deepagent-code/src/mcp/dpapi.bun.ts:kernel32", "DPAPI-Bun-module", "one-native-library", "single-open", "process-exit", "native-codec-only", "process-local", "safe_bounded"],
      ["packages/deepagent-code/src/mcp/dpapi.node.ts:probed", "DPAPI-Node-module", "one-probe-promise", "single-resolution", "process-exit", "availability-only", "process-local", "safe_bounded"],
    ] as const).map(([key, owner, keyScope, bound, finalizer, durability, reachability, verdict]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
  // MdExport.run's map is reconstructed from the on-disk manifest and dies when the export call
  // settles. PromptV2's dedup sets live inside one resolve call, never in the long-lived layer.
  ...Object.fromEntries(
    ([
      ["packages/deepagent-code/src/server/md-export.ts:closure@304:308.doneBySession", "MdExport.run-invocation", "per-export-session", "manifest-entry-count", "call-return", "manifest-is-authority", "single-call", "safe_scoped"],
      ["packages/deepagent-code/src/session/prompt-v2.ts:closure@266:268.seen", "resolveReferenceParts-invocation", "per-reference-alias", "template-reference-count", "call-return", "dedup-only", "single-call", "safe_scoped"],
      ["packages/deepagent-code/src/session/prompt-v2.ts:closure@303:310.seen", "resolvePromptParts-invocation", "per-file-reference", "template-reference-count", "call-return", "dedup-only", "single-call", "safe_scoped"],
      ["packages/deepagent-code/src/tool/custom-tool-adapter.ts:closure@28:32.controller", "CustomTool.execute-invocation", "single-tool-call", "tool-call-duration", "callback-stop-and-listener-detach", "abort-signal-only", "single-call", "safe_scoped"],
      ["packages/deepagent-code/src/tool/custom-tool-rejections.ts:rejected", "ApplicationTools-instance", "weak-instance-and-plugin-key", "live-plugin-instances", "instance-disposer-forget", "diagnostic-only", "instance-scoped", "safe_scoped"],
    ] as const).map(([key, owner, keyScope, bound, finalizer, durability, reachability, verdict]) => [
      key,
      { owner, keyScope, bound, finalizer, durability, reachability, verdict } satisfies RuntimeStateAudit,
    ]),
  ),
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
