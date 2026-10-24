export * as SharedBrowserHost from "./shared-host"

import type { Effect, Stream } from "effect"
import type { BrowserSchema } from "./schema"
import type { SharedBrowserSchema } from "./shared-schema"
import type { SharedBrowserTuiSchema } from "./shared-tui-schema"
import type { SharedBrowserFileSchema } from "./shared-file-schema"
import type { BrowserFileSchema } from "./file-exchange.schema"

export interface Files {
  /** Actual Main implementation/qualification, not the existence of this interface. */
  readonly ready?: (resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease) => Effect.Effect<boolean, BrowserFileSchema.Error>
  /** Nonreducing, authenticated Main check; a status projection cannot grant file access. */
  readonly current: (resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease) => Effect.Effect<void, BrowserFileSchema.Error>
  readonly confirm: (resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease,
    preview: SharedBrowserFileSchema.Preview, command: SharedBrowserFileSchema.Approve,
    checks: {
      readonly previewCurrent: Effect.Effect<void, BrowserFileSchema.Error>
      /** Fresh scope/lease authority only; the bounded Main callback must not reopen file captures. */
      readonly authorityCurrent: Effect.Effect<void, BrowserFileSchema.Error>
    }) => Effect.Effect<BrowserFileSchema.Confirmation | SharedBrowserFileSchema.Cancellation, BrowserFileSchema.Error>
  /** Reads only the original settled negative decision; never opens a dialog or grants a lease. */
  readonly cancellation?: (resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease,
    preview: SharedBrowserFileSchema.Preview, command: SharedBrowserFileSchema.Approve) =>
    Effect.Effect<SharedBrowserFileSchema.Cancellation | undefined, BrowserFileSchema.Error>
}

export interface Tui {
  readonly pair: (
    input: SharedBrowserTuiSchema.Pair,
    serverURL: string,
  ) => Effect.Effect<SharedBrowserTuiSchema.View, BrowserSchema.Error>
  /** The actual original HTTP stream owns this source. Finalization always retires that
   * exact private stream binding; a reconnect cannot inherit its UI approval. */
  readonly owner: (
    input: SharedBrowserTuiSchema.Connect,
    serverURL: string,
  ) => Stream.Stream<SharedBrowserTuiSchema.View, BrowserSchema.Error>
  readonly reserve: (
    input: SharedBrowserTuiSchema.Reserve,
  ) => Effect.Effect<SharedBrowserSchema.InputStamp | undefined, BrowserSchema.Error>
  readonly seal: (
    input: SharedBrowserTuiSchema.Seal,
  ) => Effect.Effect<SharedBrowserSchema.InputStamp, BrowserSchema.Error>
  readonly detach: (
    input: SharedBrowserTuiSchema.Detach,
  ) => Effect.Effect<SharedBrowserTuiSchema.View, BrowserSchema.Error>
}

/** Installed only by the actual Main/utility private port bootstrap. SQL records and wire
 * shapes are not proof of a living resource; every operation still verifies the Main registry. */
export interface Interface {
  readonly mainIncarnation: string
  readonly tui?: Tui
  readonly files?: Files
  readonly policy?: {
    readonly claim: (resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin) => Effect.Effect<string, BrowserSchema.Error>
    readonly check: (resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin, claim: string) => Effect.Effect<void, BrowserSchema.Error>
    readonly abort: (resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin, claim: string) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
    readonly commit: (resource: SharedBrowserSchema.Resource, command: SharedBrowserSchema.ApproveOrigin) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
  }
  readonly validateInput: (stamp: SharedBrowserSchema.InputStamp) => Effect.Effect<boolean, BrowserSchema.Error>
  readonly create: (
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
  ) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
  readonly status: (resourceID: string) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
  /** Monotone projection metadata only; SQL can never restore Main ownership or a lease. */
  readonly syncProjection: (
    resource: SharedBrowserSchema.Resource,
  ) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
  /** Returns immediately after synchronous Main fencing, before any Core transaction. */
  readonly takeover: (
    resource: SharedBrowserSchema.Resource,
    request: SharedBrowserSchema.Takeover,
  ) => Effect.Effect<SharedBrowserSchema.BarrierTicket, BrowserSchema.Error>
  /** Core has committed this exact frontier; waits only for the bounded reducing cleanup. */
  readonly confirmBarrier: (
    resource: SharedBrowserSchema.Resource,
    ticket: SharedBrowserSchema.BarrierTicket,
  ) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
  readonly acquire: (
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
    witness: SharedBrowserSchema.UserWitness,
  ) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
  readonly execute: (
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
    action: SharedBrowserSchema.Action,
    current: Effect.Effect<void, BrowserSchema.Error>,
  ) => Effect.Effect<{ result: BrowserSchema.Result; png?: string }, BrowserSchema.Error>
  readonly close: (
    resource: SharedBrowserSchema.Resource,
    request: SharedBrowserSchema.Close,
  ) => Effect.Effect<SharedBrowserSchema.Observation, BrowserSchema.Error>
}
