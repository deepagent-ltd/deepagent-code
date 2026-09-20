export * as Delegation from "./delegation"

import { Context, Effect, Layer } from "effect"
import type { SessionV2 } from "../session"

/**
 * Delegation slot (RI-24 RootIdentitySlot pattern): the V2 session service lives in the process
 * root, and Location-scoped runner fibers structurally cannot see root services — a plain
 * serviceOption read inside a settled tool returned None even with the service present at the
 * root. The root composition captures the service into this per-root holder after SessionV2
 * builds; the execution coordinator provides the holder into every drain fiber, and the Core
 * `task` tool reads through it. Kept in a leaf module (type-only session import) so wiring it
 * from session/execution adds no runtime import cycle.
 */
export interface DelegationSlotService {
  service?: SessionV2.Interface
}

export class DelegationSlot extends Context.Service<DelegationSlot, DelegationSlotService>()(
  "@deepagent-code/v2/TaskDelegationSlot",
) {}

export const delegationSlotLayer = Layer.effect(DelegationSlot, Effect.sync(() => ({})))
