export * as LiveContextQueryAuthorization from "./query-authorization"

import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"

// Migration compatibility for V1 consumers. Core owns the process-local store so
// V2 admission and host facades cannot accidentally resolve different maps.
export const layer = ContextQueryAuthorization.layer
export const defaultLayer = ContextQueryAuthorization.defaultLayer
