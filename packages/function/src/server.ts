import { serve } from "@hono/node-server"
import { WebSocketServer } from "ws"
import app, { store, subscribers } from "./api.ts"

/**
 * Node entrypoint for the share/GitHub/Feishu backend.
 *
 * Serves the hono app over plain HTTP and handles the `/share_poll` WebSocket
 * upgrade with the `ws` server — on connect it replays the share's existing
 * `session/*` entries, then registers the socket for live fan-out.
 */
const port = Number(process.env.PORT ?? 3099)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`share backend listening on http://localhost:${info.port}`)
})

const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname !== "/share_poll") {
    socket.destroy()
    return
  }
  const id = url.searchParams.get("id")
  if (!id) {
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, async (ws) => {
    subscribers.add(id, ws)
    // Replay current state to the freshly-connected viewer.
    try {
      const entries = await store.getData(id)
      for (const entry of entries) ws.send(JSON.stringify(entry))
    } catch (err) {
      console.error("share_poll replay failed", err)
    }
  })
})

export { server }
