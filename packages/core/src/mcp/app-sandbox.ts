export * as McpAppSandbox from "./app-sandbox"

export const path = "/ui/mcp-app-sandbox"

/** No server-declared domain or browser permission is granted by the first DAC view profile. */
export const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export const permissions = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'"

/**
 * This fixed HTTP document is sandboxed without allow-same-origin. Resource HTML runs
 * in a second srcdoc frame with a different opaque origin; neither can access host DOM.
 * The proxy's frame-src policy also applies to navigations of the inner frame. Its fixed
 * markup never interpolates resource HTML, URLs, credentials, or connection identifiers.
 */
export function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{overflow:hidden}</style></head><body><script>
(() => {
  const host = parent;
  let frame;
  let loaded = false;
  const notify = (method) => host.postMessage({jsonrpc:"2.0",method}, "*");
  addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    if (event.source === host) {
      if (message.method === "ui/notifications/sandbox-resource-ready") {
        if (loaded || typeof message.params?.html !== "string" || new TextEncoder().encode(message.params.html).length > 262144) return;
        loaded = true;
        frame = document.createElement("iframe");
        frame.name = "dac-mcp-app-view";
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("allow", ${JSON.stringify(permissions)});
        frame.setAttribute("referrerpolicy", "no-referrer");
        let loads = 0;
        frame.addEventListener("load", () => {
          if (++loads < 2) return;
          frame?.remove();
          frame = undefined;
          notify("ui/notifications/sandbox-resource-invalidated");
        });
        frame.srcdoc = ${JSON.stringify(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`)} + message.params.html;
        document.body.append(frame);
        return;
      }
      if (message.method === "ui/notifications/sandbox-close") {
        frame?.remove();
        frame = undefined;
        loaded = true;
        return;
      }
      if (typeof message.method === "string" && message.method.startsWith("ui/notifications/sandbox-")) return;
      frame?.contentWindow?.postMessage(message, "*");
      return;
    }
    if (event.source !== frame?.contentWindow) return;
    if (typeof message.method === "string" && message.method.startsWith("ui/notifications/sandbox-")) return;
    host.postMessage(message, "*");
  });
  notify("ui/notifications/sandbox-proxy-ready");
})();
</script></body></html>`
}

