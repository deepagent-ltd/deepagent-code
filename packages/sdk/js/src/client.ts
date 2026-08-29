export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { DeepAgentCodeClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error-interceptor.js"
export { type Config as DeepAgentCodeClientConfig, DeepAgentCodeClient }
export type OpencodeClientConfig = Config
export { DeepAgentCodeClient as OpencodeClient }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

/**
 * Route the directory/workspace identity into the request surface the httpapi
 * understands (query params; `location[...]` on /api/ paths), then strip the
 * hop headers. Port of the historical compat rewrite (LIC4c: the compat entry is
 * deleted; its rewrite behavior is production behavior, not a compat quirk).
 */
function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-deepagent-code-directory", "directory"],
    ["x-deepagent-code-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-deepagent-code-directory")
  next.headers.delete("x-deepagent-code-workspace")
  return next
}

export function createDeepAgentCodeClient(config?: Config & { directory?: string; workspace?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-deepagent-code-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.workspace) {
    config.headers = {
      ...config.headers,
      "x-deepagent-code-workspace": config.workspace,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) => rewrite(request, { directory: config?.directory, workspace: config?.workspace }))
  client.interceptors.error.use(wrapClientError)
  return new DeepAgentCodeClient({ client })
}

export const createOpencodeClient = createDeepAgentCodeClient
