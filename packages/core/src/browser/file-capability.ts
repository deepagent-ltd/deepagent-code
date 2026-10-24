export * as BrowserFileCapability from "./file-capability"

import { Context, Effect, Scope } from "effect"
import type { BrowserProtocol } from "./protocol"
import type { BrowserSchema } from "./schema"
import type { BrowserFileSchema } from "./file-exchange.schema"
import type { SharedBrowserSchema } from "./shared-schema"
import type { SharedBrowserFileSchema } from "./shared-file-schema"

declare const preview: unique symbol
declare const transfer: unique symbol
declare const observation: unique symbol
declare const released: unique symbol
declare const approval: unique symbol
export interface Preview { readonly [preview]: true }
export interface Approval { readonly [approval]: true }
export interface Transfer { readonly [transfer]: true }
export interface Observation { readonly [observation]: true }
export interface Released { readonly [released]: true }

/** Private installed browser-purpose factory. A Work binding is neither required nor fabricated.
 * The canonical tool and each native leaf independently recheck their current source permission. */
export interface Interface {
  readonly shared?: Shared
  readonly preview: (input: { control: BrowserSchema.Control; request: BrowserFileSchema.PreviewRequest }) =>
    Effect.Effect<Preview, BrowserFileSchema.Error>
  readonly describePreview: (handle: Preview, input: { control: BrowserSchema.Control; request: BrowserFileSchema.PreviewRequest }) =>
    BrowserFileSchema.Preview | undefined
  readonly currentPreview: (handle: Preview) => Effect.Effect<void, BrowserFileSchema.Error>
  /** Main-owned native confirmation, never a caller JSON boolean or bare Basic credential. */
  readonly confirm: (handle: Preview, command: BrowserFileSchema.Approve) => Effect.Effect<Approval, BrowserFileSchema.Error>
  readonly approved: (handle: Approval, preview: Preview, command: BrowserFileSchema.Approve) => boolean
  readonly describeApproval: (handle: Approval) => BrowserFileSchema.Confirmation | undefined
  readonly acceptGrant: (handle: Preview, approval: Approval, grant: BrowserFileSchema.Grant) => boolean
  readonly prepare: (input: { control: BrowserSchema.Control; action: BrowserSchema.Action;
    grants: readonly BrowserFileSchema.Grant[]; artifacts: readonly BrowserFileSchema.Artifact[];
    current: Effect.Effect<void, BrowserFileSchema.Error> }) => Effect.Effect<Transfer, BrowserFileSchema.Error, Scope.Scope>
  readonly current: (handle: Transfer) => Effect.Effect<void, BrowserFileSchema.Error>
  readonly readUpload: (handle: Transfer, input: { artifactID: string; offset: number; bytes: number }) =>
    Effect.Effect<Uint8Array, BrowserFileSchema.Error>
  readonly writeDownload: (handle: Transfer, input: { artifactID: string; offset: number; bytes: Uint8Array }) =>
    Effect.Effect<void, BrowserFileSchema.Error>
  readonly sealUpload: (handle: Transfer, input: { artifactID: string; bytes: number; sha256: string }) =>
    Effect.Effect<void, BrowserFileSchema.Error>
  /** Exact original sealed Windows stage, private leaf use only; never a public grant or path selector. */
  readonly uploadStage?: (handle: Transfer, artifactID: string) => Effect.Effect<BrowserProtocol.UploadStage | undefined, BrowserFileSchema.Error>
  readonly observeUpload: (handle: Transfer, input: { artifactID: string; bytes: number; sha256: string }) =>
    Effect.Effect<Observation, BrowserFileSchema.Error>
  readonly publishDownload: (handle: Transfer, input: { artifactID: string; bytes: number; sha256: string }) =>
    Effect.Effect<Observation, BrowserFileSchema.Error>
  readonly describe: (handle: Observation) => BrowserFileSchema.Publication | undefined
  /** A real close/removal confirmation only. SQL terminal state cannot mint this object. */
  readonly cleanup: (handle: Transfer) => Effect.Effect<Released, BrowserFileSchema.Error>
  readonly describeReleased: (handle: Released) => readonly string[] | undefined
  /** Same captured Root DB. Location execution receives this exact capability, not a new factory. */
  readonly executionFiles?: (input: { control: BrowserSchema.Control; action: BrowserSchema.Action;
    current: Effect.Effect<void, BrowserFileSchema.Error> }) => Effect.Effect<{
      files: readonly { grant: BrowserFileSchema.Grant; artifact: BrowserFileSchema.Artifact }[]; transfer: Transfer
    }, BrowserFileSchema.Error, Scope.Scope>
  readonly recordObservation?: (handle: Transfer, artifactID: string, observation: Observation) => Effect.Effect<void, BrowserFileSchema.Error>
  readonly unknownAction?: (handle: Transfer) => Effect.Effect<void, BrowserFileSchema.Error>
  readonly finishAction?: (actionID: string) => Effect.Effect<void, BrowserFileSchema.Error>
  readonly listFiles?: (input: { controlID: string; scope: BrowserSchema.Scope; cursor?: string; limit?: number }) =>
    Effect.Effect<{ files: (typeof BrowserFileSchema.Summary.Type)[]; grants: BrowserFileSchema.GrantSummary[]; nextCursor: string | null }, BrowserFileSchema.Error>
}
/** Versioned owner adapter of the same installed factory and opaque handles. */
export interface Shared {
  readonly preview: (input: { resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease;
    request: SharedBrowserFileSchema.PreviewRequest }) => Effect.Effect<Preview, BrowserFileSchema.Error>
  readonly describePreview: (handle: Preview, input: { resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease;
    request: SharedBrowserFileSchema.PreviewRequest }) => SharedBrowserFileSchema.Preview | undefined
  readonly currentPreview: (handle: Preview) => Effect.Effect<void, BrowserFileSchema.Error>
  readonly confirm: (handle: Preview, command: SharedBrowserFileSchema.Approve) => Effect.Effect<Approval | SharedBrowserFileSchema.Cancellation, BrowserFileSchema.Error>
  readonly cancellation?: (handle: Preview, command: SharedBrowserFileSchema.Approve) =>
    Effect.Effect<SharedBrowserFileSchema.Cancellation | undefined, BrowserFileSchema.Error>
  readonly approved: (handle: Approval, preview: Preview, command: SharedBrowserFileSchema.Approve) => boolean
  readonly describeApproval: (handle: Approval) => BrowserFileSchema.Confirmation | undefined
  readonly acceptGrant: (handle: Preview, approval: Approval, grant: SharedBrowserFileSchema.Grant) => boolean
  readonly prepare: (input: { resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease;
    action: SharedBrowserSchema.Action; grants: readonly SharedBrowserFileSchema.Grant[];
    artifacts: readonly SharedBrowserFileSchema.Artifact[]; current: Effect.Effect<void, BrowserFileSchema.Error> }) =>
      Effect.Effect<Transfer, BrowserFileSchema.Error, Scope.Scope>
  readonly executionFiles: (input: { resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease;
    action: SharedBrowserSchema.Action; current: Effect.Effect<void, BrowserFileSchema.Error> }) => Effect.Effect<{
      files: readonly { grant: SharedBrowserFileSchema.Grant; artifact: SharedBrowserFileSchema.Artifact }[]; transfer: Transfer
    }, BrowserFileSchema.Error, Scope.Scope>
  readonly finishAction: (actionID: string) => Effect.Effect<void, BrowserFileSchema.Error>
  readonly listFiles?: (input: { resourceID: string; scope: BrowserSchema.Scope; cursor?: string; limit?: number }) =>
    Effect.Effect<{ files: (typeof BrowserFileSchema.Summary.Type)[]; grants: BrowserFileSchema.GrantSummary[]; nextCursor: string | null }, BrowserFileSchema.Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/BrowserFileCapability") {}
