export * as GlobalRuntimeFixture from "./global-runtime"

import { Layer } from "effect"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { EventV2Bridge } from "@/event-v2-bridge"

// Small global-route tests exercise upgrade/import/control only. Unexpected observer use
// throws instead of constructing an independent Session runtime or inventing a recovery state.
export const layer = Layer.mergeAll(
  Layer.mock(EventV2Bridge.Service)({}),
  Layer.mock(SessionExecution.Service)({}),
  Layer.mock(SessionRuntimeStatus.Service)({}),
)
