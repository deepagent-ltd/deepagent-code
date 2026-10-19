import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { sharedBrowserManager, SharedBrowserMainError } from "./shared-browser"

type Ready = { url: string; username: string | null; password: string | null }
type Host = {
  credentialBinding: string
  verifyReady: (server: Ready) => boolean
  onState: (state: SharedBrowserTuiSchema.State) => void
}
type Entry = {
  input: SharedBrowserTuiSchema.Pair
  transport: SharedBrowserTuiSchema.Transport
  view: SharedBrowserTuiSchema.View
  stream?: SharedBrowserTuiSchema.StreamBinding
  approver?: string
  source?: string
  timer?: ReturnType<typeof setTimeout>
  waiting: number
  inputs: Map<string, { stamp: SharedBrowserSchema.InputStamp; promptHash?: string }>
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const digest = (value: unknown) => hash(CanonicalJson.stringify(value))
function fail(code: BrowserSchema.Error["code"]): never { throw new SharedBrowserMainError(code) }

/** Pending HTTP requests carry no owner authority. Only the original DAC window
 * may approve one live stream, whose issuer remains this actual Main registry. */
export function createSharedBrowserTuiRegistry(manager: ReturnType<typeof sharedBrowserManager>) {
  const hosts = new Map<string, Host>()
  const entries = new Map<string, Entry>()
  const listeners = new Set<(view: SharedBrowserTuiSchema.View) => void>()
  let waiting = 0
  const frontier = (sessionID: string) => Math.max(0, ...manager.list(sessionID).map((value) => value.barrierOrder))
  const view = (entry: Entry): SharedBrowserTuiSchema.View => ({ ...entry.view,
    barrierOrder: frontier(entry.input.rootSessionID), streamLive: entry.stream !== undefined })
  const publish = (entry: Entry) => {
    const value = view(entry)
    if (entry.stream) {
      try { hosts.get(entry.transport.hostIncarnation)?.onState({ type: "shared.tui.state", ...entry.stream, view: value }) }
      catch { /* A lost observer cannot mint or retain a source. The port close retires it. */ }
    }
    for (const listener of listeners) {
      try { listener(value) }
      catch { /* Only control metadata is best effort; the registry owns the state. */ }
    }
  }
  const retire = (entry: Entry) => {
    if (entry.view.state === "retired") return
    clearTimeout(entry.timer)
    entry.view = { ...entry.view, state: "retired" }
    if (entry.source) manager.retireSource(entry.source)
    // Keep sealed exact retries, never the raw text, prompt, or connection secret.
    for (const [id, value] of entry.inputs) if (value.promptHash === undefined) entry.inputs.delete(id)
    publish(entry)
  }
  const current = (hostIncarnation: string, input: SharedBrowserTuiSchema.Connect) => {
    const entry = entries.get(input.attachID)
    if (!entry || entry.transport.hostIncarnation !== hostIncarnation || entry.view.generation !== input.generation ||
      !timingSafeEqual(createHash("sha256").update(Buffer.from(input.secret, "hex")).digest(), Buffer.from(entry.input.challengeHash, "hex")))
      fail("BROWSER_AUTHORITY_REQUIRED")
    return entry
  }
  const transportFor = (hostIncarnation: string, transport: SharedBrowserTuiSchema.Transport) => {
    const host = hosts.get(hostIncarnation)
    const url = URL.canParse(transport.serverURL) ? new URL(transport.serverURL) : undefined
    if (!host || transport.hostIncarnation !== hostIncarnation || host.credentialBinding !== transport.credentialBinding ||
      !url || url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      fail("BROWSER_HOST_UNAVAILABLE")
    return host
  }
  const exact = (entry: Entry, input: SharedBrowserTuiSchema.Approve) => {
    if (input.attachID !== entry.view.attachID || input.expectedGeneration !== entry.view.generation ||
      digest(entry.input) !== digest({ requestID: input.requestID, challengeHash: input.challengeHash,
        rootSessionID: input.rootSessionID, directory: input.directory })) fail("BROWSER_CONFLICT")
  }
  const active = (entry: Entry) => {
    if (entry.view.state === "pending" && entry.view.pendingUntil <= Date.now()) retire(entry)
    if (entry.view.state !== "active" || !entry.stream || !entry.source || !hosts.has(entry.transport.hostIncarnation))
      fail("BROWSER_AUTHORITY_REQUIRED")
  }
  const use = <Value>(entry: Entry, operation: () => Value) => {
    if (entry.waiting >= SharedBrowserTuiSchema.MAX_PER_SOURCE || waiting >= SharedBrowserTuiSchema.MAX_WAITING)
      fail("BROWSER_CAPACITY")
    entry.waiting++; waiting++
    try { return operation() }
    finally { entry.waiting--; waiting-- }
  }
  const unsubscribe = manager.subscribe((resource) => {
    for (const entry of entries.values()) if (entry.view.state !== "retired" && entry.input.rootSessionID === resource.rootSessionID)
      publish(entry)
  })
  return {
    registerHost(hostIncarnation: string, host: Host) {
      if (hosts.has(hostIncarnation)) fail("BROWSER_CONFLICT")
      hosts.set(hostIncarnation, host)
    },
    hostLost(hostIncarnation: string) {
      for (const entry of entries.values()) if (entry.transport.hostIncarnation === hostIncarnation) retire(entry)
      hosts.delete(hostIncarnation)
    },
    pair(hostIncarnation: string, transport: SharedBrowserTuiSchema.Transport, input: SharedBrowserTuiSchema.Pair) {
      transportFor(hostIncarnation, transport)
      if (input.directory.includes("\0") || !path.isAbsolute(input.directory) || path.normalize(input.directory) !== input.directory)
        fail("BROWSER_SCOPE_DENIED")
      const prior = [...entries.values()].find((entry) => entry.transport.hostIncarnation === hostIncarnation && entry.input.requestID === input.requestID)
      if (prior) {
        if (digest(prior.input) !== digest(input) || digest(prior.transport) !== digest(transport)) fail("BROWSER_CONFLICT")
        if (prior.view.state === "pending" && prior.view.pendingUntil <= Date.now()) retire(prior)
        return view(prior)
      }
      for (const entry of entries.values()) if (entry.view.state === "pending" && entry.view.pendingUntil <= Date.now()) retire(entry)
      if (entries.size >= BrowserSchema.MAX_ACTIONS || [...entries.values()].filter((entry) => entry.view.state === "pending").length >= SharedBrowserTuiSchema.MAX_PENDING)
        fail("BROWSER_CAPACITY")
      const entry: Entry = { input, transport, waiting: 0, inputs: new Map(), view: { ...input,
        attachID: randomUUID(), generation: randomUUID(), pendingUntil: Date.now() + SharedBrowserTuiSchema.PENDING_MS,
        state: "pending", streamLive: false, barrierOrder: frontier(input.rootSessionID) } }
      entries.set(entry.view.attachID, entry)
      entry.timer = setTimeout(() => { if (entry.view.state === "pending") retire(entry) }, SharedBrowserTuiSchema.PENDING_MS)
      entry.timer.unref()
      publish(entry)
      return view(entry)
    },
    open(hostIncarnation: string, transport: SharedBrowserTuiSchema.Transport, input: SharedBrowserTuiSchema.Connect,
      binding: SharedBrowserTuiSchema.StreamBinding) {
      transportFor(hostIncarnation, transport)
      const entry = current(hostIncarnation, input)
      if (digest(entry.transport) !== digest(transport) || binding.attachID !== input.attachID || binding.generation !== input.generation ||
        entry.stream && digest(entry.stream) !== digest(binding)) fail("BROWSER_CONFLICT")
      if (entry.view.state === "pending" && entry.view.pendingUntil <= Date.now()) retire(entry)
      if (entry.view.state === "retired") fail("BROWSER_AUTHORITY_REQUIRED")
      entry.stream = binding
      publish(entry)
      return view(entry)
    },
    disconnect(hostIncarnation: string, binding: SharedBrowserTuiSchema.StreamBinding) {
      const entry = entries.get(binding.attachID)
      if (!entry || entry.transport.hostIncarnation !== hostIncarnation || !entry.stream || digest(entry.stream) !== digest(binding))
        return
      retire(entry)
      entry.stream = undefined
      publish(entry)
    },
    pending(rootSessionID: string) {
      for (const entry of entries.values()) if (entry.view.state === "pending" && entry.view.pendingUntil <= Date.now()) retire(entry)
      return [...entries.values()].filter((entry) => entry.input.rootSessionID === rootSessionID && entry.view.state !== "retired").map(view)
    },
    approve(input: SharedBrowserTuiSchema.Approve, approver: string, server: Ready) {
      const entry = entries.get(input.attachID) ?? fail("BROWSER_NOT_FOUND")
      exact(entry, input)
      const host = transportFor(entry.transport.hostIncarnation, entry.transport)
      if (new URL(server.url).href !== new URL(entry.transport.serverURL).href || !host.verifyReady(server))
        fail("BROWSER_HOST_UNAVAILABLE")
      if (entry.view.state === "active") {
        if (entry.approver !== approver) fail("BROWSER_AUTHORITY_REQUIRED")
        return view(entry)
      }
      if (entry.view.pendingUntil <= Date.now()) retire(entry)
      if (entry.view.state !== "pending" || !entry.stream) fail("BROWSER_AUTHORITY_REQUIRED")
      if ([...entries.values()].filter((value) => value.view.state === "active").length >= SharedBrowserTuiSchema.MAX_ACTIVE)
        fail("BROWSER_CAPACITY")
      entry.approver = approver
      entry.source = digest({ mainIncarnation: manager.mainIncarnation, ...entry.transport, ...entry.stream,
        rootSessionID: entry.input.rootSessionID, directory: entry.input.directory })
      entry.view = { ...entry.view, state: "active" }
      clearTimeout(entry.timer)
      publish(entry)
      return view(entry)
    },
    revoke(input: SharedBrowserTuiSchema.Approve) {
      const entry = entries.get(input.attachID) ?? fail("BROWSER_NOT_FOUND")
      exact(entry, input)
      retire(entry)
      return view(entry)
    },
    retireApprover(approver: string) {
      for (const entry of entries.values()) if (entry.approver === approver) retire(entry)
    },
    reserve(hostIncarnation: string, input: SharedBrowserTuiSchema.Reserve) {
      const entry = current(hostIncarnation, input)
      active(entry)
      return use(entry, () => {
        if (input.expectedBarrierOrder !== frontier(entry.input.rootSessionID)) fail("BROWSER_CONFLICT")
        const resources = manager.list(entry.input.rootSessionID).filter((resource) => !["closed", "resource_lost"].includes(resource.state))
        if (!resources.length) return undefined
        if (resources.some((resource) => resource.scope.directory !== entry.input.directory)) fail("BROWSER_SCOPE_DENIED")
        if (Buffer.byteLength(input.rawInput) > SharedBrowserTuiSchema.MAX_INPUT_BYTES) fail("BROWSER_CAPACITY")
        const prior = entry.inputs.get(input.inputID)
        if (prior && (prior.stamp.originalSubmissionID !== input.originalSubmissionID || prior.stamp.rawInputHash !== hash(input.rawInput)))
          fail("BROWSER_CONFLICT")
        const stamp = manager.stamp({ rootSessionID: entry.input.rootSessionID, inputID: input.inputID,
          originalSubmissionID: input.originalSubmissionID, rawInputHash: hash(input.rawInput), sourceKind: "tui_owner",
          sourceBindingHash: entry.source! })
        if (prior && digest({ ...prior.stamp, promptHash: undefined }) !== digest({ ...stamp, promptHash: undefined }))
          fail("BROWSER_CONFLICT")
        entry.inputs.set(input.inputID, prior ?? { stamp })
        return stamp
      })
    },
    seal(hostIncarnation: string, input: SharedBrowserTuiSchema.Seal) {
      const entry = current(hostIncarnation, input)
      return use(entry, () => {
        const prior = entry.inputs.get(input.stamp.inputID)
        if (!prior || digest(prior.stamp) !== digest({ ...input.stamp, promptHash: undefined }) ||
          input.stamp.sourceKind !== "tui_owner" || input.stamp.sourceBindingHash !== entry.source)
          fail("BROWSER_AUTHORITY_REQUIRED")
        const prompt = CanonicalJson.stringify(input.prompt)
        if (Buffer.byteLength(prompt) > 8_388_608) fail("BROWSER_CAPACITY")
        const promptHash = hash(prompt)
        if (input.stamp.promptHash !== undefined && input.stamp.promptHash !== promptHash) fail("BROWSER_CONFLICT")
        if (prior.promptHash !== undefined) {
          if (prior.promptHash !== promptHash) fail("BROWSER_CONFLICT")
          return manager.seal(prior.stamp, promptHash)
        }
        active(entry)
        const stamp = manager.seal(prior.stamp, promptHash)
        entry.inputs.set(input.stamp.inputID, { stamp: prior.stamp, promptHash })
        return stamp
      })
    },
    detach(hostIncarnation: string, input: SharedBrowserTuiSchema.Detach) {
      const entry = current(hostIncarnation, input)
      retire(entry)
      return view(entry)
    },
    subscribe(listener: (view: SharedBrowserTuiSchema.View) => void) {
      if (listeners.size >= 64 && !listeners.has(listener)) fail("BROWSER_CAPACITY")
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      unsubscribe()
      for (const entry of entries.values()) retire(entry)
      hosts.clear(); listeners.clear()
    },
  }
}

let registry: ReturnType<typeof createSharedBrowserTuiRegistry> | undefined
export function sharedBrowserTuiRegistry() { return registry ??= createSharedBrowserTuiRegistry(sharedBrowserManager()) }
