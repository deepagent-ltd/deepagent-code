export * as BrowserHost from "./host"

import { Context, Effect } from "effect"
import type { BrowserSchema } from "./schema"
import type { BrowserFileSchema } from "./file-exchange.schema"
import type { SharedBrowserHost } from "./shared-host"

export interface Interface {
  readonly hostID: string
  readonly hostIncarnation: string
  readonly principal: string
  readonly credentialBinding: string
  readonly matchesCredentials: (username: string, password: string) => boolean
  readonly alive: () => boolean
  readonly shared?: SharedBrowserHost.Interface
  /** Normal observation requires the actual create ACK. A reducing cancellation may still
   * target its original descriptor after a lost ACK; neither path accepts a SQL hash as proof. */
  readonly verify: (control: BrowserSchema.Control, destroyOnly?: boolean) => { matched: boolean; stopped: boolean }
  readonly create: (control: BrowserSchema.Control) => Effect.Effect<void, BrowserSchema.Error>
  readonly cancel: (control: BrowserSchema.Control) => Effect.Effect<boolean, BrowserSchema.Error>
  /** Real Main-owned user interaction. Bare HTTP credentials cannot produce its affirmative receipt. */
  readonly confirmFiles?: (control: BrowserSchema.Control, preview: BrowserFileSchema.Preview,
    command: BrowserFileSchema.Approve, current: Effect.Effect<void, BrowserFileSchema.Error>) =>
    Effect.Effect<BrowserFileSchema.Confirmation, BrowserFileSchema.Error>
  readonly execute: (control: BrowserSchema.Control, action: BrowserSchema.Action,
    current: Effect.Effect<void, BrowserSchema.Error>) => Effect.Effect<{
      result: BrowserSchema.Result
      png?: string
    }, BrowserSchema.Error>
}

// Only the real native sidecar bootstrap installs a value, before the actual Root is built.
// A bare CLI/HTTP server has no Browser host and cannot upgrade a serialized descriptor.
export const Current = Context.Reference<Interface | undefined>("@deepagent-code/BrowserHost", { defaultValue: () => undefined })
