export * as RemoteCompactionBinding from "./remote-compaction-binding"

import type { Model } from "@deepagent-code/llm"
import type { RemoteCompactionWindow } from "./remote-compaction-window"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"

export function identity(model: Model) {
  return {
    providerID: String(model.provider),
    modelID: String(model.id),
    routeID: model.route.id,
    protocol: String(model.route.protocol),
    endpointHash: Hash.sha256(
      CanonicalJson.stringify({
        baseURL: model.route.endpoint.baseURL ?? null,
        path: typeof model.route.endpoint.path === "string" ? model.route.endpoint.path : null,
        query: model.route.endpoint.query ?? null,
      }),
    ),
  }
}

export function matches(state: RemoteCompactionWindow.State, model: Model) {
  const binding = identity(model)
  return Object.entries(binding).every(([key, value]) => state[key as keyof typeof binding] === value)
}
