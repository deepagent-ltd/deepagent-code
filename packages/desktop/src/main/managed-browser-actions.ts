import { randomUUID } from "node:crypto"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { compileManagedBrowserProgram } from "./managed-browser-program"
import type { ProgramInput } from "./managed-browser-program"

/* CDP input primitives adapted from OpenCode chromium.ts at
 * 6bffe7932efa9adc36b74e389598daecb4b17ac1. The surrounding authority and
 * observation binding are DAC-owned; selectors/backend IDs are never public authority.
 *
 * MIT License — Copyright (c) 2025 opencode
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
type AXNode = {
  backendDOMNodeId?: number
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  properties?: Array<{ name: string; value: { value?: unknown } }>
}
type FrameTree = {
  frame?: { id?: string; loaderId?: string; url?: string; securityOrigin?: string }
  childFrames?: FrameTree[]
}
type Target = {
  backendID: number
  frameID: string
  loaderID: string
  documentPath: string
  generation: number
  observation: number
  role: string
  name: string
  semantic: string
}
type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type Input = Extract<BrowserSchema.Command, { ref: string }>

export function createManagedBrowserActions(input: {
  send: Send
  cleanupSend?: Send
  watchContext?: (contextID: number) => { retired: () => boolean; dispose: () => void }
  current: () => Promise<void>
  generation: () => number
  inputSource?: () => void
  sharedDocument?: boolean
  origin?: string
  approvedOrigins?: readonly string[]
  fail: (code: BrowserSchema.Error["code"]) => never
  dispatched: () => void
}) {
  const refs = new Map<string, Target>()
  const held = new Map<string, { method: string; params: Record<string, unknown> }>()
  let observation = 0
  let invalidation = 0
  let scriptWorlds = 0
  let observed: { generation: number; revision: number; frameID: string; documentPath: string } | undefined
  const invalidate = () => {
    invalidation++
    refs.clear()
    observed = undefined
  }
  const send: Send = async (method, params) => {
    await input.current()
    return input.send(method, params)
  }
  const frames = async () => {
    const result = (await send("Page.getFrameTree")) as { frameTree?: FrameTree }
    const root = result.frameTree?.frame
    if (!root?.id || !root.loaderId) return input.fail("BROWSER_STALE_TARGET")
    const origin = input.origin ?? (root.url && URL.canParse(root.url) ? new URL(root.url).origin : undefined)
    const allowed = (value: string) =>
      URL.canParse(value) && input.approvedOrigins?.includes(new URL(value).origin) === true
    if (input.approvedOrigins && root.url !== "about:blank" && (!root.url || !allowed(root.url)))
      return input.fail("BROWSER_SCOPE_DENIED")
    const found: Array<{ id: string; loaderID: string; parentID: string | null; url: string; documentPath: string }> =
      []
    let visited = 0
    const visit = (tree: FrameTree, parents: Array<{ id: string; loaderID: string; url: string }>) => {
      if (parents.length > 16 || ++visited > BrowserSchema.MAX_FRAMES) return input.fail("BROWSER_OUTPUT_LIMIT")
      const value = tree.frame
      if (!value?.id || !value.loaderId || !value.url || Buffer.byteLength(value.url) > 2048)
        return input.fail("BROWSER_STALE_TARGET")
      if (
        input.approvedOrigins &&
        parents.length &&
        (!value.securityOrigin ||
          !input.approvedOrigins.includes(value.securityOrigin) ||
          (!["about:blank", "about:srcdoc"].includes(value.url) && !allowed(value.url)))
      )
        return
      if (
        !input.approvedOrigins &&
        parents.length &&
        (!origin ||
          value.securityOrigin !== origin ||
          (!["about:blank", "about:srcdoc"].includes(value.url) &&
            (!URL.canParse(value.url) || new URL(value.url).origin !== origin)))
      )
        return
      const path = [...parents, { id: value.id, loaderID: value.loaderId, url: value.url }]
      found.push({
        id: value.id,
        loaderID: value.loaderId,
        parentID: parents.at(-1)?.id ?? null,
        url: value.url,
        documentPath: CanonicalJson.stringify(path),
      })
      for (const child of tree.childFrames ?? []) visit(child, path)
    }
    visit(result.frameTree!, [])
    if (
      Buffer.byteLength(
        CanonicalJson.stringify(
          found.map((value) => ({
            frameID: value.id,
            parentFrameID: value.parentID,
            url: value.url,
          })),
        ),
      ) > BrowserSchema.MAX_AX_BYTES
    )
      return input.fail("BROWSER_OUTPUT_LIMIT")
    return found
  }
  const frame = async (id?: string) => {
    const found = await frames()
    const value = id ? found.find((value) => value.id === id) : found[0]
    if (!value) return input.fail("BROWSER_STALE_TARGET")
    return value
  }
  const semantics = async (backendID: number) => {
    const result = (await send("DOM.describeNode", { backendNodeId: backendID, depth: 0 })) as {
      node?: { backendNodeId?: number; nodeType?: number; nodeName?: string; attributes?: string[] }
    }
    if (result.node?.backendNodeId !== backendID || result.node.nodeType !== 1)
      return input.fail("BROWSER_STALE_TARGET")
    const attributes = result.node.attributes ?? []
    if (
      attributes.length > 1024 ||
      attributes.some((value) => typeof value !== "string" || Buffer.byteLength(value) > 16384)
    )
      return input.fail("BROWSER_OUTPUT_LIMIT")
    // Value changes are the intended outcome of fill/select; identity and control semantics
    // (including form action, disabled/type/contenteditable) remain part of the reference.
    return CanonicalJson.stringify({
      tag: result.node.nodeName,
      attributes: attributes.flatMap((value, index) =>
        index % 2 === 0 && value !== "value" ? [[value, attributes[index + 1]]] : [],
      ),
    })
  }
  const currentTarget = (command: Pick<Input, "ref" | "frameID" | "generation" | "observationRevision">, target: Target) => {
    input.inputSource?.()
    if (
      refs.get(command.ref) !== target ||
      command.observationRevision !== observation ||
      target.observation !== observation ||
      command.frameID !== target.frameID ||
      command.generation !== target.generation ||
      target.generation !== input.generation()
    )
      return input.fail("BROWSER_STALE_TARGET")
  }
  const assertObservation = (command: { generation: number; frameID: string; observationRevision: number }) => {
    input.inputSource?.()
    if (!observed || observed.generation !== command.generation || observed.generation !== input.generation() ||
      observed.revision !== command.observationRevision || observed.frameID !== command.frameID)
      return input.fail("BROWSER_STALE_TARGET")
  }
  const requireTarget = async (command: Pick<Input, "ref" | "frameID" | "generation" | "observationRevision">) => {
    const target = refs.get(command.ref)
    if (!target) return input.fail("BROWSER_STALE_TARGET")
    currentTarget(command, target)
    const document = await frame(target.frameID)
    if (document.loaderID !== target.loaderID || document.documentPath !== target.documentPath)
      return input.fail("BROWSER_STALE_TARGET")
    const ax = (await send("Accessibility.getPartialAXTree", {
      backendNodeId: target.backendID,
      fetchRelatives: false,
    })) as { nodes?: AXNode[] }
    const node = ax.nodes?.find((value) => value.backendDOMNodeId === target.backendID)
    if (
      !node ||
      node.ignored ||
      String(node.role?.value ?? "") !== target.role ||
      String(node.name?.value ?? "") !== target.name ||
      (await semantics(target.backendID)) !== target.semantic
    )
      return input.fail("BROWSER_STALE_TARGET")
    await input.current()
    currentTarget(command, target)
    return target
  }
  const dispatchTarget = async (
    command: Input,
    target: Target,
    method: string,
    params: Record<string, unknown>,
    mutate: boolean,
  ) => {
    await input.current()
    // The authority check may yield. Nothing may yield between the final reference
    // check and raw dispatch, or an intervening input/navigation can use an old ref.
    currentTarget(command, target)
    if (mutate) input.dispatched()
    return input.send(method, params)
  }
  const call = async (
    command: Input,
    declaration: string,
    args: unknown[] = [],
    mutate = false,
    hitBackendID?: number,
    awaitPromise = false,
    onResult?: (value: unknown) => void,
  ) => {
    const target = await requireTarget(command)
    // Driver scripts run in a named isolated world; page replacements of DOM prototypes
    // cannot turn the fixed editor/selection operations into arbitrary page code.
    const world = (await send("Page.createIsolatedWorld", {
      frameId: target.frameID,
      worldName: "dac-managed-input-v1",
      grantUniveralAccess: false,
    })) as { executionContextId?: number }
    if (!Number.isSafeInteger(world.executionContextId)) return input.fail("BROWSER_STALE_TARGET")
    const lifetime = onResult ? input.watchContext?.(world.executionContextId!) : undefined
    const objects: string[] = []
    try {
      const resolved = (await send("DOM.resolveNode", {
        backendNodeId: target.backendID,
        executionContextId: world.executionContextId,
      })) as { object?: { objectId?: string } }
      if (!resolved.object?.objectId) return input.fail("BROWSER_STALE_TARGET")
      objects.push(resolved.object.objectId)
      const hit =
        hitBackendID === undefined
          ? undefined
          : ((await send("DOM.resolveNode", {
              backendNodeId: hitBackendID,
              executionContextId: world.executionContextId,
            })) as { object?: { objectId?: string } })
      if (hitBackendID !== undefined && !hit?.object?.objectId) return input.fail("BROWSER_STALE_TARGET")
      if (hit?.object?.objectId) objects.push(hit.object.objectId)
      await requireTarget(command)
      const result = (await dispatchTarget(
        command,
        target,
        "Runtime.callFunctionOn",
        {
          objectId: resolved.object.objectId,
          functionDeclaration: declaration,
          arguments: [
            ...args.map((value) => ({ value })),
            ...(hit?.object?.objectId ? [{ objectId: hit.object.objectId }] : []),
          ],
          returnByValue: true,
          awaitPromise,
          userGesture: mutate,
        },
        mutate,
      )) as {
        exceptionDetails?: unknown
        result?: { value?: unknown }
      }
      if (result.exceptionDetails) return input.fail("BROWSER_STALE_TARGET")
      onResult?.(result.result?.value)
      return result.result?.value
    } finally {
      // Releasing this captured remote object cannot mutate the page or authorize new input.
      try {
        const released = await Promise.allSettled(
          objects.map((objectId) => input.send("Runtime.releaseObject", { objectId })),
        )
        if (onResult && released.some((result) => result.status === "rejected") && !lifetime?.retired())
          return input.fail("BROWSER_UNKNOWN")
      } finally {
        lifetime?.dispose()
      }
    }
  }
  const leaf = async (command: Input, method: string, params: Record<string, unknown>) => {
    const target = await requireTarget(command)
    return dispatchTarget(command, target, method, params, true)
  }
  const editable =
    "function() { return this.isConnected && !this.disabled && !this.readOnly && (this instanceof HTMLTextAreaElement || this.isContentEditable || (this instanceof HTMLInputElement && ['text','search','email','url','tel','number'].includes(this.type))); }"
  const enabled =
    "function() { return this.isConnected && !this.disabled && !(this instanceof HTMLInputElement && ['password','file'].includes(this.type)); }"
  // Both read-only plan preflight and the actual select leaf use this exact rule.
  // Validation never changes option selection, focus or dispatches page events.
  const selection =
    "function(values, mutate) { if (!this.isConnected || !(this instanceof HTMLSelectElement) || this.disabled || (!this.multiple && values.length !== 1)) throw new Error('Unavailable select'); for (const value of values) if (!Array.from(this.options).some(option => option.value === value && !option.disabled)) throw new Error('Unavailable option'); if (!mutate) return true; for (const option of this.options) option.selected = values.includes(option.value); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return true; }"
  const preflight = async (command: Input) => {
    await requireTarget(command)
    if (command.type === "file.upload" || command.type === "file.download") return input.fail("BROWSER_SCOPE_DENIED")
    const valid =
      command.type === "select"
        ? await call(command, selection, [command.values, false])
        : await call(command, command.type === "fill" ? editable : enabled)
    if (valid !== true) return input.fail("BROWSER_STALE_TARGET")
    if (command.type === "drag" && (await call({ ...command, ref: command.targetRef }, enabled)) !== true)
      return input.fail("BROWSER_STALE_TARGET")
    await requireTarget(command)
  }
  const hitTarget = async (command: Input, point: { x: number; y: number }) => {
    const target = await requireTarget(command)
    const found = (await send("DOM.getNodeForLocation", {
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    })) as { backendNodeId?: number; frameId?: string }
    if (
      !Number.isSafeInteger(found.backendNodeId) ||
      found.frameId !== target.frameID ||
      (await call(
        command,
        "function(hit) { return this.isConnected && (hit === this || this.contains(hit)); }",
        [],
        false,
        found.backendNodeId,
      )) !== true
    )
      return input.fail("BROWSER_STALE_TARGET")
  }
  const point = async (command: Input) => {
    await leaf(command, "DOM.scrollIntoViewIfNeeded", { backendNodeId: (await requireTarget(command)).backendID })
    // CDP quads include the complete frame transform in top-viewport coordinates.
    const geometry = (await send("DOM.getContentQuads", {
      backendNodeId: (await requireTarget(command)).backendID,
    })) as { quads?: number[][] }
    const quad = geometry.quads?.[0]
    if (!quad || quad.length !== 8 || !quad.every(Number.isFinite)) return input.fail("BROWSER_STALE_TARGET")
    const result = {
      x: quad.filter((_value, index) => index % 2 === 0).reduce((total, value) => total + value, 0) / 4,
      y: quad.filter((_value, index) => index % 2 === 1).reduce((total, value) => total + value, 0) / 4,
    }
    await hitTarget(command, result)
    return result
  }
  const key = async (command: Input, value: typeof BrowserSchema.InputKey.Type) => {
    const keys = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      PageUp: 33,
      PageDown: 34,
      Home: 36,
      End: 35,
      Space: 32,
    }
    const name = value === "Shift+Tab" ? "Tab" : value === "SelectAll" ? "a" : value
    const modifiers = value === "Shift+Tab" ? 8 : value === "SelectAll" ? (process.platform === "darwin" ? 4 : 2) : 0
    const text = name === "Enter" ? "\r" : name === "Space" ? " " : undefined
    const params = {
      key: name === "Space" ? " " : name,
      windowsVirtualKeyCode: name === "a" ? 65 : keys[name],
      modifiers,
      ...(text === undefined ? {} : { text }),
    }
    const release = { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...params } }
    if (
      (await call(
        command,
        "function() { return this.isConnected && document.activeElement === this && !(this instanceof HTMLInputElement && ['password','file'].includes(this.type)); }",
      )) !== true
    )
      return input.fail("BROWSER_STALE_TARGET")
    held.set(name, release)
    await leaf(command, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...params,
      ...(value === "SelectAll" ? { commands: ["selectAll"] } : {}),
    })
    // A navigation caused by Enter must not prevent release of the exact held key.
    await input.send(release.method, release.params)
    held.delete(name)
  }
  return {
    invalidate,
    async frames() {
      return (await frames()).map((value) => ({ frameID: value.id, parentFrameID: value.parentID, url: value.url }))
    },
    async release() {
      const releases = [...held.values()]
      held.clear()
      await Promise.allSettled(releases.map((value) => input.send(value.method, value.params)))
    },
    async releaseConfirmed(cleanup: Send) {
      const results = await Promise.all(
        [...held].map(async ([key, value]) => {
          const confirmed = await cleanup(value.method, value.params).then(
            () => true,
            () => false,
          )
          if (confirmed && held.get(key) === value) held.delete(key)
          return { key, confirmed }
        }),
      )
      return { confirmed: results.every((value) => value.confirmed) && held.size === 0, results }
    },
    retireRef(ref: string) {
      refs.delete(ref)
    },
    preflight,
    async targetWitness(command: Pick<Input, "ref" | "frameID" | "generation" | "observationRevision">) {
      return call(
        command as Input,
        "function() { if (!this.isConnected) return null; const editable = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement; return {tag:this.tagName,type:this.type || '',disabled:!!this.disabled,readOnly:!!this.readOnly,value:editable ? this.value : this.isContentEditable ? this.textContent : '',checked:!!this.checked,selected:this instanceof HTMLSelectElement ? Array.from(this.selectedOptions, o=>o.value) : [],active:document.activeElement === this,start:editable ? this.selectionStart : null,end:editable ? this.selectionEnd : null}; }",
      )
    },
    async fileTarget(command: Extract<Input, { type: "file.upload" | "file.download" }>) {
      if (command.type === "file.download") {
        const url = await call(
          command,
          "function() { return this.isConnected && this instanceof HTMLAnchorElement && !this.hasAttribute('disabled') ? this.href : null; }",
        )
        if (
          typeof url !== "string" ||
          Buffer.byteLength(url) > 2048 ||
          !URL.canParse(url) ||
          (input.sharedDocument
            ? !input.approvedOrigins?.includes(new URL(url).origin)
            : new URL(url).origin !== input.origin)
        )
          return input.fail("BROWSER_STALE_TARGET")
        return { direction: "download" as const, url }
      }
      const value = await call(
        command,
        "function() { if (!this.isConnected || !(this instanceof HTMLInputElement) || this.type !== 'file' || this.disabled || !this.form || this.form.method.toUpperCase() !== 'POST' || this.form.enctype !== 'multipart/form-data') return null; const url = new URL(this.form.action); return {path:url.pathname,url:url.href,origin:url.origin,search:url.search,multiple:this.multiple,field:this.name}; }",
      )
      if (
        !value ||
        typeof value !== "object" ||
        !("path" in value) ||
        typeof value.path !== "string" ||
        !("origin" in value) ||
        (input.sharedDocument
          ? !input.approvedOrigins?.includes(String(value.origin))
          : value.origin !== input.origin) ||
        !("search" in value) ||
        (!input.sharedDocument && value.search !== "") ||
        !("field" in value) ||
        typeof value.field !== "string" ||
        !value.field ||
        Buffer.byteLength(value.field) > 512 ||
        !("multiple" in value) ||
        typeof value.multiple !== "boolean"
      )
        return input.fail("BROWSER_STALE_TARGET")
      return {
        direction: "upload" as const,
        targetPath: value.path,
        multiple: value.multiple,
        field: value.field,
        ...(input.sharedDocument && "url" in value && typeof value.url === "string" ? { targetURL: value.url } : {}),
      }
    },
    async selectFiles(
      command: Extract<Input, { type: "file.upload" }>,
      files: readonly { path: string; name: string; bytes: number; sha256: string }[],
    ) {
      const target = await requireTarget(command)
      await leaf(command, "DOM.setFileInputFiles", {
        backendNodeId: target.backendID,
        files: files.map((file) => file.path),
      })
      const verified = await call(
        command,
        "async function(expected) { if (!this.isConnected || !(this instanceof HTMLInputElement) || this.type !== 'file' || this.disabled || this.files.length !== expected.length) return false; for (let i=0;i<expected.length;i++) { const file=this.files[i], value=expected[i]; if (file.name !== value.name || file.size !== value.bytes) return false; const bytes=await file.arrayBuffer(); const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join(''); if (digest !== value.sha256) return false; } return true; }",
        [files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))],
        false,
        undefined,
        true,
      )
      if (verified !== true) return input.fail("BROWSER_UNKNOWN")
    },
    async submitFiles(
      command: Extract<Input, { type: "file.upload" }>,
      targetPath: string,
      targetURL?: string,
      onSelectionCleared?: () => void,
    ) {
      if (input.sharedDocument) {
        // HTML constructs the File entry list before firing formdata. Reduce the
        // original selection in that synchronous call, before navigation can
        // suspend later CDP cleanup behind its held network request.
        const cleared = await call(
          command,
          "function(path,href) { if (!this.isConnected || !(this instanceof HTMLInputElement) || this.type !== 'file' || !this.form || this.disabled || this.form.method.toUpperCase() !== 'POST' || this.form.enctype !== 'multipart/form-data' || new URL(this.form.action).pathname !== path || !href || new URL(this.form.action).href !== href) return false; const file=this, form=this.form; let observed=false, empty=false; const clear=function(event) { if (!event.isTrusted || event.target !== form || !(event instanceof FormDataEvent)) return; observed=true; file.value=''; empty=file.files.length === 0; }; EventTarget.prototype.addEventListener.call(form,'formdata',clear,{capture:true}); try { HTMLFormElement.prototype.requestSubmit.call(form); return observed && empty && file.files.length === 0; } finally { EventTarget.prototype.removeEventListener.call(form,'formdata',clear,true); } }",
          [targetPath, targetURL],
          true,
          undefined,
          false,
          (value) => {
            if (value === true) onSelectionCleared?.()
          },
        )
        if (cleared !== true) return input.fail("BROWSER_UNKNOWN")
        return true
      }
      const submitted = await call(
        command,
        "function(path,href) { if (!this.isConnected || !(this instanceof HTMLInputElement) || this.type !== 'file' || !this.form || this.disabled || this.form.method.toUpperCase() !== 'POST' || this.form.enctype !== 'multipart/form-data' || new URL(this.form.action).pathname !== path || href && new URL(this.form.action).href !== href) return false; this.form.requestSubmit(); return true; }",
        [targetPath, targetURL],
        true,
      )
      if (submitted !== true) return input.fail("BROWSER_UNKNOWN")
    },
    async clearFiles(command: Extract<Input, { type: "file.upload" }>) {
      const target = refs.get(command.ref)
      if (!target) return false
      // Reducing cleanup uses only the originally observed backend node, even after navigation.
      // It grants no new input and never follows an arbitrary selector supplied by a caller.
      try {
        await (input.cleanupSend ?? input.send)("DOM.setFileInputFiles", { backendNodeId: target.backendID, files: [] })
        const world = (await (input.cleanupSend ?? input.send)("Page.createIsolatedWorld", {
          frameId: target.frameID,
          worldName: "dac-managed-file-cleanup-v1",
          grantUniveralAccess: false,
        })) as { executionContextId?: number }
        if (!Number.isSafeInteger(world.executionContextId)) return false
        const resolved = (await (input.cleanupSend ?? input.send)("DOM.resolveNode", {
          backendNodeId: target.backendID,
          executionContextId: world.executionContextId,
        })) as { object?: { objectId?: string } }
        if (!resolved.object?.objectId) return false
        try {
          const result = (await (input.cleanupSend ?? input.send)("Runtime.callFunctionOn", {
            objectId: resolved.object.objectId,
            functionDeclaration:
              "function() { return this instanceof HTMLInputElement && this.type === 'file' && this.files.length === 0; }",
            returnByValue: true,
            throwOnSideEffect: true,
            awaitPromise: false,
          })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
          return !result.exceptionDetails && result.result?.value === true
        } finally {
          await (input.cleanupSend ?? input.send)("Runtime.releaseObject", { objectId: resolved.object.objectId })
        }
      } catch {
        return false
      }
    },
    async snapshot(command: Extract<BrowserSchema.Command, { type: "snapshot" }>) {
      input.inputSource?.()
      refs.clear()
      observed = undefined
      const epoch = invalidation
      const targets = new Map<string, Target>()
      const revision = ++observation
      const generation = input.generation()
      const document = await frame(command.frameID)
      const tree = (await send("Accessibility.getFullAXTree", {
        depth: command.depth ?? 16,
        frameId: document.id,
      })) as { nodes?: AXNode[] }
      if (!Array.isArray(tree.nodes)) return input.fail("BROWSER_DRIVER_UNAVAILABLE")
      const metadata: Array<{ ref: string; frameID: string; role: string; name: string }> = []
      const lines: string[] = []
      let bytes = 0
      let referenceBytes = 0
      let truncated = tree.nodes.length > (command.limit ?? BrowserSchema.MAX_SNAPSHOT_TARGETS)
      for (const node of tree.nodes.slice(0, command.limit ?? BrowserSchema.MAX_SNAPSHOT_TARGETS)) {
        if (node.ignored) continue
        const role = String(node.role?.value ?? "")
        const name = String(node.name?.value ?? "")
        const protectedValue = node.properties?.some(
          (value) => value.name === "protected" && value.value.value === true,
        )
        const interactive = [
          "textbox",
          "combobox",
          "button",
          "link",
          "checkbox",
          "radio",
          "listbox",
          "spinbutton",
          "searchbox",
          "slider",
          "scrollbar",
          "region",
        ].includes(role)
        const referenceSize = Buffer.byteLength(
          CanonicalJson.stringify({ ref: "0".repeat(36), frameID: document.id, role, name }),
        )
        const ref =
          interactive &&
          node.backendDOMNodeId &&
          !protectedValue &&
          role.length <= 256 &&
          name.length <= 512 &&
          referenceSize <= 16_384 - referenceBytes
            ? randomUUID()
            : undefined
        const line = `${ref ? `[${ref}] ` : ""}${role.slice(0, 256)}: ${name} ${protectedValue ? "[protected]" : String(node.value?.value ?? "")}\n`
        const size = Buffer.byteLength(line)
        if (bytes + size > BrowserSchema.MAX_AX_BYTES) {
          truncated = true
          break
        }
        if (ref && node.backendDOMNodeId) {
          targets.set(ref, {
            backendID: node.backendDOMNodeId,
            frameID: document.id,
            loaderID: document.loaderID,
            documentPath: document.documentPath,
            generation,
            observation: revision,
            role,
            name,
            semantic: await semantics(node.backendDOMNodeId),
          })
          metadata.push({ ref, frameID: document.id, role, name })
          referenceBytes += referenceSize
        }
        lines.push(line)
        bytes += size
      }
      await input.current()
      if (
        generation !== input.generation() ||
        revision !== observation ||
        (await frame(document.id)).documentPath !== document.documentPath
      )
        return input.fail("BROWSER_STALE_TARGET")
      await input.current()
      input.inputSource?.()
      if (epoch !== invalidation || generation !== input.generation() || revision !== observation)
        return input.fail("BROWSER_STALE_TARGET")
      for (const [ref, target] of targets) refs.set(ref, target)
      observed = { generation, revision, frameID: document.id, documentPath: document.documentPath }
      return { text: lines.join(""), truncated, observationRevision: revision, frameID: document.id, refs: metadata }
    },
    assertObservation,
    async requireObservation(command: { generation: number; frameID: string; observationRevision: number }) {
      input.inputSource?.()
      const prior = observed
      if (
        !prior ||
        prior.generation !== command.generation ||
        prior.generation !== input.generation() ||
        prior.revision !== command.observationRevision ||
        prior.frameID !== command.frameID ||
        (await frame(command.frameID)).documentPath !== prior.documentPath
      )
        return input.fail("BROWSER_STALE_TARGET")
      await input.current()
      input.inputSource?.()
      if (observed !== prior || input.generation() !== prior.generation) return input.fail("BROWSER_STALE_TARGET")
      assertObservation(command)
    },
    async evaluate(command: Extract<BrowserSchema.Command, { type: "evaluate" }>, deadline: number) {
      input.inputSource?.()
      const prior = observed
      if (
        !prior ||
        prior.generation !== command.generation ||
        prior.generation !== input.generation() ||
        prior.revision !== command.observationRevision ||
        prior.frameID !== command.frameID ||
        (await frame(command.frameID)).documentPath !== prior.documentPath
      )
        return input.fail("BROWSER_STALE_TARGET")
      // Isolated worlds live until their document dies. Never allocate an unbounded number
      // in a long-lived tab, or silently reuse a world whose globals approved code changed.
      if (scriptWorlds >= BrowserSchema.MAX_SCRIPT_WORLDS) return input.fail("BROWSER_CAPACITY")
      scriptWorlds++
      const world = (await send("Page.createIsolatedWorld", {
        frameId: command.frameID,
        worldName: `dac-managed-script-${randomUUID()}`,
        grantUniveralAccess: false,
      })) as { executionContextId?: number }
      if (!Number.isSafeInteger(world.executionContextId)) return input.fail("BROWSER_DRIVER_UNAVAILABLE")
      if (
        observed !== prior ||
        input.generation() !== prior.generation ||
        (await frame(command.frameID)).documentPath !== prior.documentPath
      )
        return input.fail("BROWSER_STALE_TARGET")
      const timeout = Math.min(BrowserSchema.MAX_SCRIPT_MS, deadline - Date.now())
      if (timeout <= 0) return input.fail("BROWSER_CANCELLED")
      await input.current()
      input.inputSource?.()
      if (observed !== prior || input.generation() !== prior.generation) return input.fail("BROWSER_STALE_TARGET")
      invalidate()
      input.dispatched()
      // A fresh isolated world has no preload, Node or host bindings. Capture the serializer
      // before running approved page code; expose only bounded JSON, never remote objects.
      const result = (await input.send("Runtime.evaluate", {
        contextId: world.executionContextId,
        timeout,
        returnByValue: true,
        awaitPromise: false,
        throwOnSideEffect: true,
        userGesture: false,
        allowUnsafeEvalBlockedByCSP: false,
        expression: `(() => { const encode = JSON.stringify.bind(JSON); const P = Promise; const value = (function(args) {\n${command.source}\n})(JSON.parse(${JSON.stringify(command.argsJSON)})); if (value instanceof P) throw new Error("Asynchronous script result is unavailable"); const text = encode(value === undefined ? null : value); if (typeof text !== "string" || text.length > ${BrowserSchema.MAX_SCRIPT_RESULT_BYTES}) throw new Error("Script result exceeds its limit"); return text; })()`,
      })) as { exceptionDetails?: unknown; result?: { value?: unknown } }
      if (
        result.exceptionDetails ||
        typeof result.result?.value !== "string" ||
        Buffer.byteLength(result.result.value, "utf8") > BrowserSchema.MAX_SCRIPT_RESULT_BYTES
      )
        return input.fail("BROWSER_UNKNOWN")
      await input.current()
      if (input.generation() !== prior.generation || (await frame(command.frameID)).documentPath !== prior.documentPath)
        return input.fail("BROWSER_UNKNOWN")
      return result.result.value
    },
    async program(
      control: BrowserSchema.Control,
      command: Extract<BrowserSchema.Command, { type: "program" }>,
      deadline: number,
      runStep: (step: ProgramInput, ordinal: number) => Promise<void>,
    ) {
      const prior = observed
      const currentDocument = async () => {
        input.inputSource?.()
        if (
          !prior ||
          observed !== prior ||
          prior.generation !== command.generation ||
          prior.generation !== input.generation() ||
          prior.revision !== command.observationRevision ||
          prior.frameID !== command.frameID ||
          (await frame(command.frameID)).documentPath !== prior.documentPath
        )
          return input.fail("BROWSER_STALE_TARGET")
        await input.current()
        input.inputSource?.()
        if (observed !== prior || input.generation() !== prior.generation) return input.fail("BROWSER_STALE_TARGET")
      }
      try {
        if (!BrowserSchema.allowsProgram(control, command)) return input.fail("BROWSER_SCOPE_DENIED")
        await currentDocument()
        if (scriptWorlds >= BrowserSchema.MAX_SCRIPT_WORLDS) return input.fail("BROWSER_CAPACITY")
        scriptWorlds++
        const world = (await send("Page.createIsolatedWorld", {
          frameId: command.frameID,
          worldName: `dac-managed-program-${randomUUID()}`,
          grantUniveralAccess: false,
        })) as { executionContextId?: number }
        if (!Number.isSafeInteger(world.executionContextId)) return input.fail("BROWSER_DRIVER_UNAVAILABLE")
        await currentDocument()
        const timeout = Math.min(BrowserSchema.MAX_SCRIPT_MS, deadline - Date.now())
        if (timeout <= 0) return input.fail("BROWSER_CANCELLED")
        input.dispatched()
        // Approved code only plans: it cannot mutate DOM or schedule effects. References
        // remain private to this serialized action until its fixed native leaves finish.
        const result = (await input.send("Runtime.evaluate", {
          contextId: world.executionContextId,
          timeout,
          returnByValue: true,
          awaitPromise: false,
          throwOnSideEffect: true,
          userGesture: false,
          allowUnsafeEvalBlockedByCSP: false,
          expression: `(() => { const encode = JSON.stringify.bind(JSON); const P = Promise; const value = (function(args) {\n${command.source}\n})(JSON.parse(${JSON.stringify(command.argsJSON)})); if (value instanceof P) throw new Error("Asynchronous program is unavailable"); const text = encode(value); if (typeof text !== "string" || text.length > ${BrowserSchema.MAX_SCRIPT_RESULT_BYTES}) throw new Error("Program exceeds its limit"); return text; })()`,
        })) as { exceptionDetails?: unknown; result?: { value?: unknown } }
        if (result.exceptionDetails || typeof result.result?.value !== "string") return input.fail("BROWSER_UNKNOWN")
        await currentDocument()
        const compiled = compileManagedBrowserProgram(control, command, result.result.value, input.fail)
        // Verify the complete command-bound target set before the first native mutation.
        // Every original leaf repeats this check; a valid first target grants no fallback.
        for (const target of command.targets) await requireTarget({ ...command, ref: target.ref })
        for (const step of compiled.inputs) {
          await preflight(step)
        }
        const steps: Array<{ ordinal: number; operation: ProgramInput["type"] }> = []
        for (const [ordinal, step] of compiled.inputs.entries()) {
          await currentDocument()
          await requireTarget(step)
          await runStep(step, ordinal)
          if (!((step.type === "click" || step.type === "press") && step.waitForNavigation)) await currentDocument()
          steps.push({ ordinal, operation: step.type })
        }
        await input.current()
        return {
          version: 1 as const,
          planHash: compiled.planHash,
          totalSteps: steps.length,
          completedSteps: steps.length,
          steps,
        }
      } finally {
        invalidate()
      }
    },
    async execute(command: Input) {
      if (command.type === "file.upload" || command.type === "file.download") return input.fail("BROWSER_SCOPE_DENIED")
      await preflight(command)
      if (command.type === "fill") {
        const read = () =>
          call(
            command,
            "function() { return {value:this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement ? this.value : this.textContent,active:document.activeElement === this,start:this.selectionStart === undefined ? null : this.selectionStart,end:this.selectionEnd === undefined ? null : this.selectionEnd}; }",
          ) as Promise<{ value: string; active: boolean; start: number | null; end: number | null }>
        const before = input.sharedDocument ? await read() : undefined
        await leaf(command, "DOM.focus", { backendNodeId: (await requireTarget(command)).backendID })
        await key(command, "SelectAll")
        if (before) {
          const selected = await read()
          if (
            !selected.active ||
            selected.value !== before.value ||
            (selected.start !== null && (selected.start !== 0 || selected.end !== before.value.length))
          )
            return input.fail("BROWSER_UNKNOWN")
        }
        await key(command, "Backspace")
        if (before) {
          const erased = await read()
          if (!erased.active || erased.value !== "") return input.fail("BROWSER_UNKNOWN")
        }
        if (
          (await call(
            command,
            "function() { return this.isConnected && document.activeElement === this && !this.disabled && !this.readOnly && !(this instanceof HTMLInputElement && ['password','file'].includes(this.type)); }",
          )) !== true
        )
          return input.fail("BROWSER_STALE_TARGET")
        await leaf(command, "Input.insertText", { text: command.text })
        await input.current()
        if (before) {
          const result = await read()
          if (!result.active || result.value !== command.text) return input.fail("BROWSER_UNKNOWN")
        }
        return
      }
      if (command.type === "select") {
        await call(command, selection, [command.values, true], true)
        await input.current()
        return
      }
      if (command.type === "press") {
        await leaf(command, "DOM.focus", { backendNodeId: (await requireTarget(command)).backendID })
        await key(command, command.key)
        return
      }
      const start = await point(command)
      if (command.type === "scroll") {
        await leaf(command, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: start.x,
          y: start.y,
          deltaX: command.deltaX,
          deltaY: command.deltaY,
        })
        await input.current()
        return
      }
      if (command.type === "drag") {
        const destination = { ...command, ref: command.targetRef }
        const end = await point(destination)
        await hitTarget(command, start)
        await hitTarget(destination, end)
        await leaf(command, "Input.dispatchMouseEvent", { type: "mouseMoved", ...start })
        const release = {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseReleased", ...end, button: "left", clickCount: 1 },
        }
        held.set("mouse", release)
        await leaf(command, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...start,
          button: "left",
          clickCount: 1,
        })
        const steps = command.steps ?? 8
        for (let index = 1; index <= steps; index++) {
          await requireTarget(destination)
          await leaf(command, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: start.x + ((end.x - start.x) * index) / steps,
            y: start.y + ((end.y - start.y) * index) / steps,
            button: "left",
            buttons: 1,
          })
        }
        await hitTarget(destination, end)
        await leaf(destination, release.method, release.params)
        held.delete("mouse")
        await input.current()
        return
      }
      await leaf(command, "Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y })
      for (let count = 1; count <= (command.count ?? 1); count++) {
        // Hover handlers can move an ancestor or cover the target without changing its
        // own DOM/AX semantics. Recheck the captured point before each pressed input.
        await hitTarget(command, start)
        const params = { x: start.x, y: start.y, button: "left", clickCount: count }
        held.set("mouse", { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...params } })
        await leaf(command, "Input.dispatchMouseEvent", { type: "mousePressed", ...params })
        await leaf(command, "Input.dispatchMouseEvent", { type: "mouseReleased", ...params })
        held.delete("mouse")
      }
      await input.current()
    },
  }
}
