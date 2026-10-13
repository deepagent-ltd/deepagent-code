import { BrowserWindow } from "electron"
import type { WebContents, Event } from "electron"

/** Clipboard authority belongs to Main's explicit native confirmation, never the page. */
export async function installManagedBrowserClipboardPolicy(contents: WebContents, onUnavailable?: () => void) {
  const debuggerOwner = contents.debugger
  const state = { closed: false, children: new Set<string>() }
  const unavailable = () => {
    if (state.closed) return
    release()
    if (onUnavailable) { onUnavailable(); return }
    BrowserWindow.fromWebContents(contents)?.destroy()
  }
  const attach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: "iframe", exclude: false }, { exclude: true }] }
  const listener = (_event: Event, method: string, params: { sessionId?: unknown; targetInfo?: { type?: unknown } }, parent: string) => {
    if (state.closed || parent && !state.children.has(parent)) return
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") state.children.delete(params.sessionId)
      return
    }
    if (method !== "Target.attachedToTarget") return
    if (params.targetInfo?.type !== "iframe" || typeof params.sessionId !== "string" ||
      !params.sessionId.length || params.sessionId.length > 256 || state.children.size >= 64) { unavailable(); return }
    const child = params.sessionId
    if (state.children.has(child)) return
    state.children.add(child)
    const timer = setTimeout(() => { if (state.children.has(child)) unavailable() }, 2000)
    const install = async () => {
      await debuggerOwner.sendCommand("Runtime.enable", {}, child)
      await debuggerOwner.sendCommand("Page.enable", {}, child)
      await installScripts(debuggerOwner, child)
      await debuggerOwner.sendCommand("Target.setAutoAttach", attach, child)
      if (state.closed || !state.children.has(child)) return
      // OOPIF documents stay paused until both policies and descendant attachment exist.
      await debuggerOwner.sendCommand("Runtime.runIfWaitingForDebugger", {}, child)
    }
    void install().catch(() => { if (state.children.has(child)) unavailable() }).finally(() => clearTimeout(timer))
  }
  debuggerOwner.on("message", listener)
  const detached = () => {
    if (state.closed) return
    release()
    // Detachment also occurs inside native window destruction; do not reenter destroy.
    onUnavailable?.()
  }
  debuggerOwner.once("detach", detached)
  const release = () => {
    state.closed = true
    state.children.clear()
    debuggerOwner.removeListener("message", listener)
    debuggerOwner.removeListener("detach", detached)
    contents.removeListener("destroyed", release)
  }
  contents.once("destroyed", release)
  await installScripts(debuggerOwner)
  await debuggerOwner.sendCommand("Target.setAutoAttach", attach)
  return release
}

async function installScripts(debuggerOwner: WebContents["debugger"], sessionID?: string) {
  const source = `(() => {
    const prevent = Event.prototype.preventDefault;
    const stop = Event.prototype.stopImmediatePropagation;
    const block = (event) => { prevent.call(event); stop.call(event); };
    for (const type of ['copy', 'cut', 'paste']) window.addEventListener(type, block, true);
  })();`
  // Runs before document scripts in frames covered by this debugger target.
  // A page cannot remove this listener or replace its captured Event intrinsics.
  const result = await debuggerOwner.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source, worldName: "dac-managed-clipboard-policy-v1", runImmediately: !sessionID,
  }, sessionID) as { identifier?: unknown }
  if (typeof result.identifier !== "string" || !result.identifier.length || result.identifier.length > 256)
    throw new Error("Managed browser clipboard policy unavailable")
  const page = await debuggerOwner.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    runImmediately: !sessionID,
    source: `(() => {
      const define = Object.defineProperty;
      const apply = Reflect.apply;
      const convert = String;
      const lower = String.prototype.toLowerCase;
      const trim = String.prototype.trim;
      const starts = String.prototype.startsWith;
      const prototype = Document.prototype;
      const view = Object.getOwnPropertyDescriptor(prototype, 'defaultView').get;
      const own = Object.getOwnPropertyDescriptor;
      const marker = Symbol.for('dac-managed-clipboard-policy-v1');
      if (Object.prototype.hasOwnProperty.call(prototype, marker)) { prototype[marker](); return; }
      const execute = prototype.execCommand;
      const add = EventTarget.prototype.addEventListener;
      const prevent = Event.prototype.preventDefault;
      const stop = Event.prototype.stopImmediatePropagation;
      const block = (event) => { apply(prevent, event, []); apply(stop, event, []); };
      const install = () => {
        for (const type of ['copy', 'cut', 'paste']) apply(add, window, [type, block, true]);
        if (!own(document, marker)) define(document, marker, { configurable: false, writable: false, value: install });
      };
      define(prototype, marker, { configurable: false, writable: false, value: install });
      define(prototype, 'execCommand', { configurable: false, writable: false, value: function(command, ...args) {
        const value = convert(command);
        const name = apply(lower, apply(trim, value, []), []);
        if (apply(starts, name, ['copy']) || apply(starts, name, ['cut']) || apply(starts, name, ['paste'])) return false;
        return apply(execute, this, [value, ...args]);
      } });
      // document.open/write can clear window listeners without creating a new realm.
      // A borrowed wrapper may remove its own frame. Its callbacks then become inert;
      // the immutable receiver installer supplies callbacks from the surviving realm.
      for (const name of ['open', 'write', 'writeln']) {
        const original = prototype[name];
        define(prototype, name, { configurable: false, writable: false, value: function(...args) {
          try { return apply(original, this, args); } finally {
            const receiver = own(this, marker);
            if (receiver && typeof receiver.value === 'function') apply(receiver.value, undefined, []);
            else if (apply(view, this, [])) throw new Error('Managed clipboard receiver policy unavailable');
          }
        } });
      }
      install();
    })();`,
  }, sessionID) as { identifier?: unknown }
  if (typeof page.identifier !== "string" || !page.identifier.length || page.identifier.length > 256)
    throw new Error("Managed browser clipboard command policy unavailable")
}
