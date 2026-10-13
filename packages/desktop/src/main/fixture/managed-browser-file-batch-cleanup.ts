import type { Server } from "node:http"
import type { Socket } from "node:net"

export async function closeBrowserFileBatchServers(servers: ReadonlyArray<Server>, sockets: ReadonlySet<Socket>) {
  // server.close can finish before Socket's close event removes the last held
  // connection from the QA inventory. Capture those events before destroying it.
  const disconnected = Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => {
    socket.once("close", () => resolve())
  })))
  const stopped = Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
  servers.forEach((server) => server.closeAllConnections())
  await stopped
  await disconnected
}
