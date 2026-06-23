export * from "./client.js"
export * from "./server.js"

import { createDeepAgentCodeClient } from "./client.js"
import { createDeepAgentCodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createDeepAgentCode(options?: ServerOptions) {
  const server = await createDeepAgentCodeServer({
    ...options,
  })

  const client = createDeepAgentCodeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

export const createOpencode = createDeepAgentCode
