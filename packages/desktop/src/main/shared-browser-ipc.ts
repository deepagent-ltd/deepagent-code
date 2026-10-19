import { createHash, randomUUID } from "node:crypto"
import { BrowserWindow, ipcMain } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron"
import { Option, Schema } from "effect"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import type { ServerReadyData } from "../preload/types"
import { SharedBrowserMainError, sharedBrowserManager } from "./shared-browser"
import { sharedBrowserTuiRegistry } from "./shared-browser-tui"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const Input = Schema.Struct({
  sessionID: Schema.String,
  inputID: Schema.String,
  originalSubmissionID: Schema.String,
  rawInput: Schema.String,
})
const Preview = Schema.Struct({ sessionID: Schema.String, resourceID: Schema.String, manualEpoch: Schema.Number })
const Envelope = Schema.Struct({ generation: Schema.String, value: Schema.Unknown })
type Viewer = { generation: string; frame: string; sessions: Set<string>; sources: Set<string> }
type Sender = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">

function rendererURL(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol === "oc:" && url.host === "renderer") return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return !!dev && URL.canParse(dev) && url.origin === new URL(dev).origin
}

/** Only the DAC top-level renderer owns these channels. Managed pages have no
 * preload, and neither a website frame nor an HTTP client can mint an input. */
export function registerSharedBrowserIpc(
  ready: () => Promise<ServerReadyData>,
  owns: (window: BrowserWindow) => boolean,
) {
  const manager = sharedBrowserManager()
  const tui = sharedBrowserTuiRegistry()
  const viewers = new Map<WebContents, Viewer>()
  const hooks = new Map<WebContents, () => void>()
  const trusted = (event: Sender) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const url = event.senderFrame?.url
    if (
      !window ||
      !owns(window) ||
      window.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      !url ||
      !rendererURL(url)
    )
      throw new Error("Shared browser requires the local DAC window")
    return `${event.senderFrame.processId}:${event.senderFrame.routingId}`
  }
  const retire = (contents: WebContents, generation?: string) => {
    const viewer = viewers.get(contents)
    if (!viewer || (generation !== undefined && viewer.generation !== generation)) return
    tui.retireApprover(String(contents.id))
    viewers.delete(contents)
    for (const source of viewer.sources) manager.retireSource(source)
  }
  const installHooks = (contents: WebContents) => {
    if (hooks.has(contents)) return
    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) retire(contents)
    }
    const gone = () => retire(contents)
    const destroyed = () => {
      retire(contents)
      hooks.get(contents)?.()
      hooks.delete(contents)
    }
    contents.on("did-start-navigation", navigation)
    contents.on("render-process-gone", gone)
    contents.once("destroyed", destroyed)
    hooks.set(contents, () => {
      contents.removeListener("did-start-navigation", navigation)
      contents.removeListener("render-process-gone", gone)
      contents.removeListener("destroyed", destroyed)
    })
  }
  const register = (event: IpcMainEvent) => {
    try {
      const frame = trusted(event)
      retire(event.sender)
      installHooks(event.sender)
      const generation = randomUUID()
      viewers.set(event.sender, { generation, frame, sessions: new Set(), sources: new Set() })
      event.returnValue = { generation }
    } catch {
      event.returnValue = { error: "The local shared browser bridge could not be registered" }
    }
  }
  ipcMain.on("shared-browser-register", register)
  const watch = (viewer: Viewer, sessionID: string) => {
    if (viewer.sessions.size >= 64 && !viewer.sessions.has(sessionID))
      throw new Error("Shared browser window subscription limit reached")
    viewer.sessions.add(sessionID)
  }
  const request = async (path: string, body?: unknown) => {
    const server = await ready()
    const base = new URL(server.url)
    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) ||
      !server.username ||
      !server.password
    )
      throw new Error("Shared browser requires the local DAC service")
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Shared browser request failed (${response.status}); retry the original request`)
    return response.json() as Promise<unknown>
  }
  const parse = <A>(schema: Schema.Decoder<A>, value: unknown) => {
    const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
    if (Option.isNone(decoded)) throw new Error("Invalid shared browser response")
    return decoded.value
  }
  const connection = (event: Sender, value: unknown) => {
    const frame = trusted(event)
    const input = parse(Envelope, value)
    const viewer = viewers.get(event.sender)
    if (!viewer || viewer.generation !== input.generation || viewer.frame !== frame)
      throw new Error("The original shared browser UI connection was retired")
    return { viewer, value: input.value }
  }
  const reply = <Value>(event: Sender, viewer: Viewer, value: Value) => {
    if (trusted(event) !== viewer.frame || viewers.get(event.sender) !== viewer)
      throw new Error("The original shared browser UI connection was retired")
    return { generation: viewer.generation, value }
  }
  const stopFileOwner = manager.registerFileConfirmationOwner((resource) => {
    const candidates = [...viewers].flatMap(([contents, viewer]) => {
      if (contents.isDestroyed()) return []
      const window = BrowserWindow.fromWebContents(contents)
      if (!window) return []
      const current = () => !contents.isDestroyed() && !window.isDestroyed() && owns(window) &&
        window.webContents === contents && viewers.get(contents) === viewer &&
        viewer.sessions.has(resource.rootSessionID) && rendererURL(contents.mainFrame.url) &&
        `${contents.mainFrame.processId}:${contents.mainFrame.routingId}` === viewer.frame
      if (!current() || !window.isVisible() || window.isMinimized() || !window.isFocusable()) return []
      return [{ window, current }]
    })
    return candidates.length === 1 ? candidates[0] : undefined
  })
  const source = (event: Sender, viewer: Viewer, sessionID: string) =>
    hash(
      CanonicalJson.stringify({
        sender: event.sender.id,
        frame: viewer.frame,
        generation: viewer.generation,
        sessionID,
      }),
    )
  const view = (resource: SharedBrowserSchema.Resource) => {
    if (resource.state === "closed") return { resource }
    if (resource.mainIncarnation !== manager.mainIncarnation)
      return {
        resource: {
          ...resource,
          state: "resource_lost" as const,
          resourceAlive: false,
          agentAccessFenced: true,
          manualEnabled: false,
          liveLeaseID: null,
        },
      }
    return manager.getView(resource.resourceID)
  }
  const single = async (path: string, body?: unknown) =>
    parse(Schema.Struct({ resource: SharedBrowserSchema.Resource }), await request(path, body)).resource
  const base = "/api/v1/browser/shared/resources"
  const stop = manager.subscribe((resource) => {
    for (const [contents, viewer] of viewers) {
      if (contents.isDestroyed()) {
        retire(contents)
        continue
      }
      const window = BrowserWindow.fromWebContents(contents)
      if (!window || !owns(window) || !rendererURL(contents.mainFrame.url)) continue
      if (
        `${contents.mainFrame.processId}:${contents.mainFrame.routingId}` !== viewer.frame ||
        !viewer.sessions.has(resource.rootSessionID)
      )
        continue
      contents.send("shared-browser-state", {
        generation: viewer.generation,
        value: manager.getView(resource.resourceID),
      })
    }
  })
  const stopTui = tui.subscribe((value) => {
    for (const [contents, viewer] of viewers) {
      if (contents.isDestroyed()) continue
      const window = BrowserWindow.fromWebContents(contents)
      if (!window || !owns(window) || !rendererURL(contents.mainFrame.url) ||
        `${contents.mainFrame.processId}:${contents.mainFrame.routingId}` !== viewer.frame ||
        !viewer.sessions.has(value.rootSessionID)) continue
      contents.send("shared-browser-tui-state", { generation: viewer.generation, value })
    }
  })
  ipcMain.handle("shared-browser-tui-pending", (event, value: unknown) => {
    const connected = connection(event, value)
    if (typeof connected.value !== "string" || connected.value.length > 256) throw new Error("Invalid Session")
    watch(connected.viewer, connected.value)
    return reply(event, connected.viewer, tui.pending(connected.value))
  })
  ipcMain.handle("shared-browser-tui-approve", async (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(SharedBrowserTuiSchema.Approve, connected.value)
    const server = await ready()
    // A slow server-ready lookup must not approve after this original app frame retired.
    if (connection(event, value).viewer !== connected.viewer) throw new Error("The original shared browser UI connection was retired")
    watch(connected.viewer, input.rootSessionID)
    return reply(event, connected.viewer, tui.approve(input, String(event.sender.id), server))
  })
  ipcMain.handle("shared-browser-tui-detach", (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(SharedBrowserTuiSchema.Approve, connected.value)
    return reply(event, connected.viewer, tui.revoke(input))
  })
  ipcMain.handle("shared-browser-detach", (event, generation: unknown) => {
    trusted(event)
    if (typeof generation !== "string" || generation.length > 256)
      throw new Error("Invalid shared browser UI connection")
    retire(event.sender, generation)
  })
  ipcMain.handle("shared-browser-list", async (event, value: unknown) => {
    const connected = connection(event, value)
    const sessionID = connected.value
    if (typeof sessionID !== "string" || sessionID.length > 256) throw new Error("Invalid Session")
    watch(connected.viewer, sessionID)
    const response = parse(
      Schema.Struct({ resources: Schema.Array(SharedBrowserSchema.Resource) }),
      await request(`${base}?sessionID=${encodeURIComponent(sessionID)}`),
    )
    return reply(event, connected.viewer, response.resources.map(view))
  })
  ipcMain.handle("shared-browser-create", async (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(SharedBrowserSchema.Create, connected.value)
    watch(connected.viewer, input.sessionID)
    return reply(event, connected.viewer, view(await single(base, input)))
  })
  ipcMain.handle("shared-browser-takeover", async (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(SharedBrowserSchema.Takeover, connected.value)
    const current = manager.getView(input.resourceID)
    // Fence synchronously before waiting for HTTP or the Core transaction.
    manager.beginTakeover(current.resource, input)
    return reply(
      event,
      connected.viewer,
      view(await single(`${base}/${encodeURIComponent(input.resourceID)}/takeover`, input)),
    )
  })
  ipcMain.handle("shared-browser-close", async (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(SharedBrowserSchema.Close, connected.value)
    const current = manager.getView(input.resourceID)
    // close() fences before its first await; a failed ACK keeps this exact request.
    void manager.close(current.resource, input).catch(() => undefined)
    return reply(
      event,
      connected.viewer,
      view(await single(`${base}/${encodeURIComponent(input.resourceID)}/close`, input)),
    )
  })
  ipcMain.handle("shared-browser-approve-origin", async (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(SharedBrowserSchema.ApproveOrigin, connected.value)
    const current = manager.getView(input.resourceID)
    watch(connected.viewer, current.resource.rootSessionID)
    manager.prepareOrigin(current.resource, input, `${event.sender.id}/${connected.viewer.generation}`,
      () => {
        try { return connection(event, value).viewer === connected.viewer }
        catch { return false }
      })
    return reply(event, connected.viewer,
      view(await single(`${base}/${encodeURIComponent(input.resourceID)}/origins`, input)))
  })
  ipcMain.handle("shared-browser-cancel-origin", (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(SharedBrowserSchema.ApproveOrigin, connected.value)
    const cancelled = manager.cancelOrigin(input.resourceID, input, `${event.sender.id}/${connected.viewer.generation}`)
    return reply(event, connected.viewer, { view: manager.getView(input.resourceID), cancelled })
  })
  ipcMain.handle("shared-browser-preview", (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(Preview, connected.value)
    const current = manager.getView(input.resourceID)
    if (current.resource.rootSessionID !== input.sessionID) throw new Error("Shared browser Session mismatch")
    watch(connected.viewer, input.sessionID)
    const preview = manager.preview(input.resourceID, input.sessionID, input.manualEpoch)
    return reply(event, connected.viewer, { manualEpoch: input.manualEpoch, ...(preview ?? {}) })
  })
  ipcMain.handle("shared-browser-input", (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(Input, connected.value)
    if (
      input.rawInput.length > 4_194_304 ||
      !manager.list(input.sessionID).some((resource) => !["closed", "resource_lost"].includes(resource.state))
    )
      return reply(event, connected.viewer, undefined)
    try {
      const binding = source(event, connected.viewer, input.sessionID)
      const stamp = manager.stamp({
        rootSessionID: input.sessionID,
        inputID: input.inputID,
        originalSubmissionID: input.originalSubmissionID,
        rawInputHash: hash(input.rawInput),
        sourceKind: "gui_composer",
        sourceBindingHash: binding,
      })
      connected.viewer.sources.add(binding)
      return reply(event, connected.viewer, stamp)
    } catch (error) {
      // Exhausted browser metadata or an uncommitted barrier cannot turn ordinary
      // chat into a global failure, and an unstamped input gains no browser rights.
      if (error instanceof SharedBrowserMainError && ["BROWSER_CAPACITY", "BROWSER_CONFLICT"].includes(error.code))
        return reply(event, connected.viewer, undefined)
      throw error
    }
  })
  ipcMain.handle("shared-browser-input-seal", (event, value: unknown) => {
    const connected = connection(event, value)
    const input = parse(
      Schema.Struct({ stamp: SharedBrowserSchema.InputStamp, prompt: Schema.Unknown }),
      connected.value,
    )
    const binding = source(event, connected.viewer, input.stamp.rootSessionID)
    if (input.stamp.sourceKind !== "gui_composer" || input.stamp.sourceBindingHash !== binding)
      throw new Error("Shared browser input belongs to another window")
    const prompt = CanonicalJson.stringify(input.prompt)
    if (Buffer.byteLength(prompt) > 8_388_608) throw new Error("Shared browser prompt exceeds the admission budget")
    return reply(event, connected.viewer, manager.seal(input.stamp, hash(prompt)))
  })
  return () => {
    stopFileOwner()
    stop()
    stopTui()
    for (const contents of viewers.keys()) retire(contents)
    for (const cleanup of hooks.values()) cleanup()
    hooks.clear()
    ipcMain.removeListener("shared-browser-register", register)
    for (const name of ["detach", "list", "create", "takeover", "close", "approve-origin", "cancel-origin", "preview", "input", "input-seal", "tui-pending", "tui-approve", "tui-detach"])
      ipcMain.removeHandler(`shared-browser-${name}`)
  }
}
