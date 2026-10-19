import type { WebContents } from "electron"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { createManagedBrowserActions } from "./managed-browser-actions"
import { compileManagedBrowserProgramPlan } from "./managed-browser-program"
import type { SharedBrowserScriptPage } from "./shared-browser-compute"

type FrameTree = { frame: { id: string; parentId?: string }; childFrames?: FrameTree[] }

/** One resource owns this budget; opening another tab or frame cannot mint capacity. */
export function createSharedBrowserWitnessBudget() {
  let bytes = 0
  return {
    get bytes() { return bytes },
    open() {
      const values = new Map<string, string>()
      let reserved = 0
      return {
        get: (ref: string) => values.get(ref),
        set(ref: string, value: string) {
          const size = Buffer.byteLength(value)
          const previous = values.get(ref)
          const delta = size - (previous === undefined ? 0 : Buffer.byteLength(previous))
          if (size > SharedBrowserSchema.MAX_WITNESS_BYTES ||
            bytes + delta > SharedBrowserSchema.MAX_RESOURCE_WITNESS_BYTES) return false
          values.set(ref, value)
          bytes += delta
          reserved += delta
          return true
        },
        clear() {
          bytes -= reserved
          reserved = 0
          values.clear()
        },
      }
    },
  }
}

// Child-session routing follows OpenCode cdp.ts/chromium.ts at
// d099d2cb2a0869d07d2f533c66348e4868325a78. MIT notice is retained in
// shared-browser-proxy.ts; this adapter never auto-attaches after lease loss.
export function createSharedBrowserDriver(input: {
  contents: WebContents
  generation: () => number
  current: () => Promise<void>
  currentNow: () => void
  setupCurrentNow: () => void
  approvedOrigins: readonly string[]
  witnessBudget: ReturnType<typeof createSharedBrowserWitnessBudget>
  dispatched: () => void
  invalidated?: () => void
  fail: (code: BrowserSchema.Error["code"]) => never
}) {
  const sessions = new Map<string, string>()
  const parents = new Map<string, string>()
  const frameSessions = new Map<string, string>()
  const frameContext = new AsyncLocalStorage<string>()
  const backends = new Map<number, string>()
  const objects = new Map<string, string>()
  const contexts = new Map<number, string>()
  const witnesses = input.witnessBudget.open()
  let detached = false
  let lastSnapshot: SharedBrowserScriptPage | undefined
  const raw = (method: string, params?: Record<string, unknown>, sessionID?: string, setup = false) => {
    if (setup) input.setupCurrentNow()
    else input.currentNow()
    if (detached || !input.contents.debugger.isAttached()) return input.fail("BROWSER_DRIVER_UNAVAILABLE")
    return input.contents.debugger.sendCommand(method, params, sessionID)
  }
  const send = async (method: string, params?: Record<string, unknown>) => {
    await input.current()
    const requestedFrame = typeof params?.frameId === "string" ? params.frameId : frameContext.getStore()
    const sessionID = method === "Page.getFrameTree" ? undefined
      : requestedFrame !== undefined ? frameSessions.get(requestedFrame) ?? sessions.get(requestedFrame)
      : typeof params?.backendNodeId === "number" ? backends.get(params.backendNodeId)
      : typeof params?.objectId === "string" ? objects.get(params.objectId)
      : typeof params?.contextId === "number" ? contexts.get(params.contextId)
      : typeof params?.executionContextId === "number" ? contexts.get(params.executionContextId) : undefined
    const result: unknown = await raw(method, params, sessionID)
    input.currentNow()
    if (method === "Page.getFrameTree") {
      const tree = result as { frameTree?: FrameTree }
      if (!tree.frameTree?.frame.id) return input.fail("BROWSER_STALE_TARGET")
      const indexed = new Map<string, FrameTree>()
      frameSessions.clear()
      const visit = (node: FrameTree, owner?: string, depth = 0) => {
        if (depth > 16 || indexed.size >= BrowserSchema.MAX_FRAMES || !node.frame.id) return input.fail("BROWSER_OUTPUT_LIMIT")
        indexed.set(node.frame.id, node)
        if (owner) frameSessions.set(node.frame.id, owner)
        node.childFrames?.forEach((child) => visit(child, owner, depth + 1))
      }
      visit(tree.frameTree)
      // Page.getFrameTree omits out-of-process subtrees. Reuse the upstream
      // root + attached-child-session walk, retaining real parent identities.
      const children: Array<{ id: string; sessionID: string; tree: FrameTree }> = []
      for (const [id, childSession] of sessions) {
        await input.current()
        const child = await raw("Page.getFrameTree", {}, childSession) as { frameTree?: FrameTree }
        input.currentNow()
        if (sessions.get(id) !== childSession || child.frameTree?.frame.id !== id) return input.fail("BROWSER_STALE_TARGET")
        children.push({ id, sessionID: childSession, tree: child.frameTree })
      }
      while (children.length) {
        const before = children.length
        for (const child of [...children]) {
          const parentID = child.tree.frame.parentId ?? parents.get(child.id)
          const parent = parentID ? indexed.get(parentID) : undefined
          if (!parent) continue
          const prior = indexed.get(child.id)
          if (prior) { prior.frame = child.tree.frame; prior.childFrames = child.tree.childFrames; visit(prior, child.sessionID) }
          else { parent.childFrames ??= []; parent.childFrames.push(child.tree); visit(child.tree, child.sessionID) }
          children.splice(children.indexOf(child), 1)
        }
        if (children.length === before) return input.fail("BROWSER_STALE_TARGET")
      }
      return tree
    }
    if (sessionID && result && typeof result === "object") {
      if ("nodes" in result && Array.isArray(result.nodes)) result.nodes.forEach((node: { backendDOMNodeId?: number }) => {
        if (node.backendDOMNodeId) backends.set(node.backendDOMNodeId, sessionID)
      })
      if ("object" in result && result.object && typeof result.object === "object" &&
        "objectId" in result.object && typeof result.object.objectId === "string") objects.set(result.object.objectId, sessionID)
      if ("executionContextId" in result && typeof result.executionContextId === "number") contexts.set(result.executionContextId, sessionID)
    }
    return result
  }
  const actions = createManagedBrowserActions({
    send,
    current: input.current,
    generation: input.generation,
    approvedOrigins: input.approvedOrigins,
    sharedDocument: true,
    watchContext: (contextID) => {
      const frameID = frameContext.getStore()
      const sessionID = frameID ? (frameSessions.get(frameID) ?? sessions.get(frameID)) : undefined
      const state = { retired: false }
      const observe = (
        _event: Electron.Event,
        method: string,
        params: Record<string, unknown>,
        sourceSession?: string,
      ) => {
        // Electron reports the root session as an empty string; sendCommand
        // selects that same root session with an omitted session argument.
        if ((sourceSession ?? "") !== (sessionID ?? "")) return
        if (
          method === "Runtime.executionContextsCleared" ||
          (method === "Runtime.executionContextDestroyed" && params.executionContextId === contextID)
        )
          state.retired = true
      }
      input.contents.debugger.on("message", observe)
      return {
        retired: () => state.retired,
        dispose: () => {
          input.contents.debugger.off("message", observe)
        },
      }
    },
    cleanupSend: (method, params) => {
      if (
        input.contents.isDestroyed() ||
        !input.contents.debugger.isAttached() ||
        ![
          "DOM.setFileInputFiles",
          "Page.createIsolatedWorld",
          "DOM.resolveNode",
          "Runtime.callFunctionOn",
          "Runtime.releaseObject",
        ].includes(method) ||
        (method === "DOM.setFileInputFiles" && (!Array.isArray(params?.files) || params.files.length !== 0))
      )
        return Promise.reject(new Error("BROWSER_CANCELLED"))
      const sessionID = frameContext.getStore() ? frameSessions.get(frameContext.getStore()!) : undefined
      return input.contents.debugger.sendCommand(method, params, sessionID)
    },
    dispatched: input.dispatched,
    fail: input.fail,
  })
  const receive = (_event: Electron.Event, method: string, params: Record<string, unknown>, sessionID?: string) => {
    if (detached || sessionID && ![...sessions.values()].includes(sessionID)) return
    if (method === "Target.attachedToTarget") {
      const event = params as { sessionId: string; targetInfo: { type: string; targetId: string; parentFrameId?: string } }
      if (event.targetInfo.type !== "iframe" || sessions.size >= BrowserSchema.MAX_FRAMES) return
      const parent = event.targetInfo.parentFrameId ?? [...sessions].find(([, id]) => id === sessionID)?.[0]
      if (parent) parents.set(event.targetInfo.targetId, parent)
      sessions.set(event.targetInfo.targetId, event.sessionId)
      void (async () => {
        for (const name of ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"]) await raw(name, {}, event.sessionId, true)
        await raw("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
          filter: [{ type: "iframe", exclude: false }, { exclude: true }] }, event.sessionId, true)
      })().catch(() => {})
    }
    if (method === "Target.detachedFromTarget") {
      for (const [frameID, id] of sessions) if (id === params.sessionId) { sessions.delete(frameID); parents.delete(frameID) }
      frameSessions.clear()
      actions.invalidate()
      witnesses.clear()
      lastSnapshot = undefined
      input.invalidated?.()
    }
    if (["DOM.documentUpdated", "Page.frameNavigated", "Page.frameDetached", "Page.navigatedWithinDocument"].includes(method)) {
      actions.invalidate()
      witnesses.clear()
      lastSnapshot = undefined
      input.invalidated?.()
    }
  }
  const witness = async (command: Pick<Extract<BrowserSchema.Command, { ref: string }>, "ref" | "frameID" | "generation" | "observationRevision">) => {
    const value = await actions.targetWitness(command)
    input.currentNow()
    if (!value || typeof value !== "object" || !("value" in value) || typeof value.value !== "string" ||
      Buffer.byteLength(value.value) > 65536) return input.fail("BROWSER_OUTPUT_LIMIT")
    const state = value as { tag: string; type: string; disabled: boolean; readOnly: boolean; value: string; checked: boolean; selected: string[] }
    const digest = (text: unknown) => createHash("sha256").update(CanonicalJson.stringify(text)).digest("hex")
    const encoded = CanonicalJson.stringify({ tag: state.tag, type: state.type, disabled: state.disabled,
      readOnly: state.readOnly, value: digest(state.value), checked: state.checked, selected: digest([...state.selected].sort()) })
    if (Buffer.byteLength(encoded) > SharedBrowserSchema.MAX_WITNESS_BYTES) return input.fail("BROWSER_OUTPUT_LIMIT")
    return encoded
  }
  return {
    async attach() {
      input.currentNow()
      if (input.contents.debugger.isAttached()) return input.fail("BROWSER_CONFLICT")
      input.contents.debugger.attach("1.3")
      input.contents.debugger.on("message", receive)
      for (const method of ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"])
        await raw(method, undefined, undefined, true)
      await raw(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }, { exclude: true }],
        },
        undefined,
        true,
      )
      input.currentNow()
    },
    invalidate() {
      actions.invalidate()
      witnesses.clear()
      lastSnapshot = undefined
      input.invalidated?.()
    },
    frames: () => frameContext.run("", actions.frames),
    async snapshot(command: Extract<BrowserSchema.Command, { type: "snapshot" }>) {
      return frameContext.run(command.frameID ?? "", async () => {
        witnesses.clear()
        lastSnapshot = undefined
        // Synchronize the DOM domain after native loadURL's separate completion
        // channel, before capturing the snapshot invalidation token.
        await send("DOM.getDocument", { depth: 0, pierce: false })
        const result = await actions.snapshot(command)
        const removed = new Set<string>()
        for (const ref of result.refs) {
          const target = {
            ...command,
            frameID: ref.frameID,
            ref: ref.ref,
            observationRevision: result.observationRevision,
          }
          try {
            if (!witnesses.set(ref.ref, await witness(target))) input.fail("BROWSER_OUTPUT_LIMIT")
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "BROWSER_OUTPUT_LIMIT") throw error
            actions.retireRef(ref.ref)
            removed.add(ref.ref)
          }
        }
        input.currentNow()
        const snapshot = {
          ...result,
          truncated: result.truncated || removed.size > 0,
          refs: result.refs.filter((ref) => !removed.has(ref.ref)),
          text: [...removed].reduce((text, ref) => text.replace("[" + ref + "] ", ""), result.text),
        }
        lastSnapshot = { ...snapshot, generation: command.generation }
        return snapshot
      })
    },
    async scriptPage(command: Extract<BrowserSchema.Command, { type: "evaluate" | "program" }>) {
      const prior = lastSnapshot
      if (
        !prior ||
        prior.generation !== command.generation ||
        prior.frameID !== command.frameID ||
        prior.observationRevision !== command.observationRevision
      )
        return input.fail("BROWSER_STALE_TARGET")
      await frameContext.run(command.frameID, () => actions.requireObservation(command))
      input.currentNow()
      if (lastSnapshot !== prior) return input.fail("BROWSER_STALE_TARGET")
      return prior
    },
    async execute(command: Extract<BrowserSchema.Command, { ref: string }>) {
      return frameContext.run(command.frameID, async () => {
        const refs = command.type === "drag" ? [command.ref, command.targetRef] : [command.ref]
        for (const ref of refs)
          if (witnesses.get(ref) !== (await witness({ ...command, ref }))) return input.fail("BROWSER_STALE_TARGET")
        await actions.execute(command)
        input.currentNow()
        if (command.type === "select") {
          const selected = (await actions.targetWitness(command)) as { selected?: string[] } | undefined
          if (
            !selected?.selected ||
            CanonicalJson.stringify([...selected.selected].sort()) !==
              CanonicalJson.stringify([...command.values].sort())
          )
            return input.fail("BROWSER_UNKNOWN")
        }
        actions.invalidate()
        witnesses.clear()
        lastSnapshot = undefined
        input.invalidated?.()
      })
    },
    async program(
      command: Extract<BrowserSchema.Command, { type: "program" }>,
      grants: typeof BrowserSchema.ProgramGrants.Type | undefined,
      json: string,
      deadline: number,
    ) {
      return frameContext.run(command.frameID, async () => {
        const compiled = compileManagedBrowserProgramPlan(grants, command, json, input.fail)
        const prior = lastSnapshot
        const cursor = new Map(command.targets.map((target) => [target.ref, witnesses.get(target.ref)]))
        const check = async () => {
          if (!prior || lastSnapshot !== prior) return input.fail("BROWSER_STALE_TARGET")
          await actions.requireObservation(command)
          for (const target of command.targets) {
            const expected = cursor.get(target.ref)
            if (!expected || expected !== (await witness({ ...command, ref: target.ref })))
              return input.fail("BROWSER_STALE_TARGET")
          }
          await input.current()
          if (lastSnapshot !== prior) return input.fail("BROWSER_STALE_TARGET")
        }
        try {
          // Validate every target and every leaf before the first mutation. Only
          // this serialized action owns the cursor; public execute always retires refs.
          await check()
          for (const step of compiled.inputs) await actions.preflight(step)
          const steps: Array<{ ordinal: number; operation: (typeof compiled.inputs)[number]["type"] }> = []
          for (const [ordinal, step] of compiled.inputs.entries()) {
            await check()
            const navigation = (step.type === "click" || step.type === "press") && step.waitForNavigation
            if (navigation) {
              const loaded = Promise.withResolvers<void>()
              const finish = () => loaded.resolve()
              const failure = (_event: Electron.Event, _code: number, _text: string, _url: string, main: boolean) => {
                if (main) loaded.reject(new Error("BROWSER_UNKNOWN"))
              }
              const timer = setTimeout(
                () => loaded.reject(new Error("BROWSER_UNKNOWN")),
                Math.max(1, deadline - Date.now()),
              )
              input.contents.on("did-finish-load", finish)
              input.contents.on("did-fail-load", failure)
              try {
                await Promise.all([actions.execute(step), loaded.promise])
              } finally {
                clearTimeout(timer)
                input.contents.off("did-finish-load", finish)
                input.contents.off("did-fail-load", failure)
              }
            } else {
              await actions.execute(step)
              // Adopt exactly the approved fill/select outcome. Unrelated values,
              // checked state, semantics or documents must retain their baseline.
              if (step.type === "fill" || step.type === "select") {
                const baseline = JSON.parse(cursor.get(step.ref)!) as Record<string, unknown>
                cursor.set(
                  step.ref,
                  CanonicalJson.stringify({
                    ...baseline,
                    ...(step.type === "fill"
                      ? { value: createHash("sha256").update(CanonicalJson.stringify(step.text)).digest("hex") }
                      : {
                          selected: createHash("sha256")
                            .update(CanonicalJson.stringify([...step.values].sort()))
                            .digest("hex"),
                        }),
                  }),
                )
              }
              await check()
            }
            await input.current()
            steps.push({ ordinal, operation: step.type })
          }
          return {
            version: 1 as const,
            planHash: compiled.planHash,
            totalSteps: compiled.inputs.length,
            completedSteps: steps.length,
            steps,
          }
        } finally {
          actions.invalidate()
          witnesses.clear()
          lastSnapshot = undefined
          input.invalidated?.()
        }
      })
    },
    fileTarget(command: Extract<BrowserSchema.Command, { type: "file.upload" | "file.download" }>) {
      return frameContext.run(command.frameID, async () => {
        if (witnesses.get(command.ref) !== (await witness(command))) return input.fail("BROWSER_STALE_TARGET")
        return actions.fileTarget(command)
      })
    },
    selectFiles(
      command: Extract<BrowserSchema.Command, { type: "file.upload" }>,
      files: Parameters<typeof actions.selectFiles>[1],
    ) {
      return frameContext.run(command.frameID, () => actions.selectFiles(command, files))
    },
    submitFiles(
      command: Extract<BrowserSchema.Command, { type: "file.upload" }>,
      targetPath: string,
      targetURL?: string,
      onSelectionCleared?: () => void,
    ) {
      return frameContext.run(command.frameID, () =>
        actions.submitFiles(command, targetPath, targetURL, onSelectionCleared),
      )
    },
    clearFiles(command: Extract<BrowserSchema.Command, { type: "file.upload" }>) {
      if (input.contents.isDestroyed()) return Promise.resolve(true)
      return frameContext.run(command.frameID, () => actions.clearFiles(command))
    },
    async cleanup() {
      detached = true
      witnesses.clear()
      lastSnapshot = undefined
      input.contents.debugger.off("message", receive)
      const released = await actions.releaseConfirmed((method, params) => {
        if (input.contents.isDestroyed() || !input.contents.debugger.isAttached())
          return Promise.reject(new Error("BROWSER_UNKNOWN"))
        if (
          (method !== "Input.dispatchKeyEvent" && method !== "Input.dispatchMouseEvent") ||
          (params?.type !== "keyUp" && params?.type !== "mouseReleased")
        )
          return Promise.reject(new Error("BROWSER_SCOPE_DENIED"))
        return input.contents.debugger.sendCommand(method, params)
      })
      actions.invalidate()
      witnesses.clear()
      lastSnapshot = undefined
      input.invalidated?.()
      sessions.clear()
      parents.clear()
      frameSessions.clear()
      backends.clear()
      objects.clear()
      contexts.clear()
      // Keep the fenced debugger and its held-input ledger available for a
      // cleanup retry; detach cannot prove an unacknowledged key-up occurred.
      if (!released.confirmed) return { heldReleased: false, transportStopped: false }
      const transportStopped = (() => {
        try {
          if (input.contents.debugger.isAttached()) input.contents.debugger.detach()
        } catch {
          return false
        }
        return !input.contents.debugger.isAttached()
      })()
      return { heldReleased: released.confirmed, transportStopped }
    },
  }
}
