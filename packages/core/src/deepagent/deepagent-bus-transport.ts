export * as DeepAgentBusTransport from "./deepagent-bus-transport"

import type { DeepAgentEvent } from "./deepagent-event"

// K40-1 (v4.0.4): pluggable transport seam for the DeepAgent Event Bus.
//
// DESIGN PRINCIPLE: the Event Bus Interface (deepagent-event-bus.ts) defines the BEHAVIOUR contract
// (publish/subscribe/ack/nack/replay/…). The Transport defines the STORAGE contract — the minimal
// primitives that any backend must implement for the bus to work. By keeping these separate:
//   - The local SQLite backend (current production) and a future distributed backend (Redis Streams /
//     Kafka) implement the same Transport interface.
//   - Contract tests (deepagent-bus-transport.contract.test.ts) run against ANY Transport to verify
//     invariants: persist idempotency, group-registry persistence, delivery ordering.
//   - The bus layer composes Transport + in-memory fan-out; Transport never knows about live subscribers.
//
// This is a seam, not a full abstraction: the SQLite bus implementation still uses Drizzle directly
// for complex queries (retry scans, retention sweeps, DLQ views). Those can migrate to Transport
// methods incrementally once the seam proves stable.

export interface ConsumerGroupRecord {
  readonly groupId: string
  readonly typeFilter: string | null
  readonly registeredAt: number
  readonly lastSeenAt: number
}

/**
 * Transport — the minimal storage abstraction the Event Bus runs on.
 *
 * A compliant implementation MUST satisfy:
 *   T1 Idempotency:   persistEvent with the same idempotencyKey is a no-op (returns existing).
 *   T2 Ordering:      findEventsSince returns events in ascending createdAt/id order.
 *   T3 Group-persist: registerGroup/unregisterGroup survive process restarts.
 *   T4 Delivery:      writeDelivery is upsert-safe (concurrent writes for the same key don't corrupt).
 */
export interface Transport {
  /**
   * T1/T2: Durably persist an event. Idempotent on idempotencyKey. Returns the persisted event
   * (the existing one when idempotency fires; the new one when this write wins).
   */
  readonly persistEvent: (event: DeepAgentEvent.Event) => Promise<DeepAgentEvent.Event>

  /** T2: Read events of a given type (or all when type is null) with createdAt >= fromMs. */
  readonly findEventsSince: (input: {
    readonly type: string | null
    readonly workspaceID?: string
    readonly fromMs: number
    readonly toMs?: number
  }) => Promise<ReadonlyArray<DeepAgentEvent.Event>>

  /** T3: Register a consumer group durably. Idempotent. */
  readonly registerGroup: (groupId: string, typeFilter: string | null, now: number) => Promise<void>

  /** T3: Unregister a consumer group (remove from durable registry). */
  readonly unregisterGroup: (groupId: string) => Promise<void>

  /** T3: List all durably registered groups whose typeFilter matches the event type (or null wildcard). */
  readonly groupsForType: (eventType: string) => Promise<ReadonlyArray<ConsumerGroupRecord>>

  /**
   * T4: Upsert a delivery record for (eventId, subscriptionGroup).
   * status, attempts, lastError, nextAttemptAt — overwrites existing on conflict.
   */
  readonly writeDelivery: (input: {
    readonly eventId: DeepAgentEvent.ID
    readonly subscriptionGroup: string
    readonly status: "pending" | "delivered" | "dead"
    readonly attempts: number
    readonly lastError: string | null
    readonly nextAttemptAt: number | null
    readonly now: number
  }) => Promise<void>

  /** Read the delivery record for (eventId, subscriptionGroup), or undefined if not found. */
  readonly readDelivery: (
    eventId: DeepAgentEvent.ID,
    subscriptionGroup: string,
  ) => Promise<{
    status: "pending" | "delivered" | "dead"
    attempts: number
    lastError: string | null
    nextAttemptAt: number | null
  } | undefined>
}
