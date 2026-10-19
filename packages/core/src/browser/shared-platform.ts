import type { SharedBrowserSchema } from "./shared-schema"
import type { SharedBrowserTuiSchema } from "./shared-tui-schema"

/** Trusted local UI bridge only; these methods are not a public HTTP authority. */
export type SharedBrowserView = {
  resource: SharedBrowserSchema.Resource
  elapsedMs?: number
  pendingTakeover?: SharedBrowserSchema.Takeover
  pendingClose?: SharedBrowserSchema.Close
  pendingOrigin?: SharedBrowserSchema.ApproveOrigin
}

export type SharedBrowserPlatform = {
  list(sessionID: string): Promise<SharedBrowserView[]>
  create(input: SharedBrowserSchema.Create): Promise<SharedBrowserView>
  takeover(input: SharedBrowserSchema.Takeover): Promise<SharedBrowserView>
  close(input: SharedBrowserSchema.Close): Promise<SharedBrowserView>
  approveOrigin?(input: SharedBrowserSchema.ApproveOrigin): Promise<SharedBrowserView>
  cancelOrigin?(input: SharedBrowserSchema.ApproveOrigin): Promise<{ view: SharedBrowserView; cancelled: boolean }>
  preview(input: {
    resourceID: string
    sessionID: string
    manualEpoch: number
  }): Promise<{ png?: string; observedAt?: number; manualEpoch: number }>
  stampInput(input: {
    sessionID: string
    inputID: string
    originalSubmissionID: string
    rawInput: string
  }): Promise<SharedBrowserSchema.InputStamp | undefined>
  sealInput(input: { stamp: SharedBrowserSchema.InputStamp; prompt: unknown }): Promise<SharedBrowserSchema.InputStamp>
  onState(callback: (state: SharedBrowserView) => void): () => void
  tuiPending(rootSessionID: string): Promise<SharedBrowserTuiSchema.View[]>
  tuiApprove(input: SharedBrowserTuiSchema.Approve): Promise<SharedBrowserTuiSchema.View>
  tuiDetach(input: SharedBrowserTuiSchema.Approve): Promise<SharedBrowserTuiSchema.View>
  onTuiState(callback: (state: SharedBrowserTuiSchema.View) => void): () => void
}

/** Private Desktop root bridge. A generation belongs to one live app document,
 * never to a managed website or a public HTTP caller. */
export type SharedBrowserRootResponse<Value> = { generation: string; value: Value }
export type SharedBrowserRootBridge = {
  register(): { generation: string }
  detach(generation: string): Promise<void>
  list(generation: string, sessionID: string): Promise<SharedBrowserRootResponse<SharedBrowserView[]>>
  create(
    generation: string,
    input: Parameters<SharedBrowserPlatform["create"]>[0],
  ): Promise<SharedBrowserRootResponse<SharedBrowserView>>
  takeover(
    generation: string,
    input: Parameters<SharedBrowserPlatform["takeover"]>[0],
  ): Promise<SharedBrowserRootResponse<SharedBrowserView>>
  close(
    generation: string,
    input: Parameters<SharedBrowserPlatform["close"]>[0],
  ): Promise<SharedBrowserRootResponse<SharedBrowserView>>
  approveOrigin?(
    generation: string,
    input: SharedBrowserSchema.ApproveOrigin,
  ): Promise<SharedBrowserRootResponse<SharedBrowserView>>
  cancelOrigin?(
    generation: string,
    input: SharedBrowserSchema.ApproveOrigin,
  ): Promise<SharedBrowserRootResponse<{ view: SharedBrowserView; cancelled: boolean }>>
  preview(
    generation: string,
    input: Parameters<SharedBrowserPlatform["preview"]>[0],
  ): Promise<SharedBrowserRootResponse<Awaited<ReturnType<SharedBrowserPlatform["preview"]>>>>
  stampInput(
    generation: string,
    input: Parameters<SharedBrowserPlatform["stampInput"]>[0],
  ): Promise<SharedBrowserRootResponse<SharedBrowserSchema.InputStamp | undefined>>
  sealInput(
    generation: string,
    input: Parameters<SharedBrowserPlatform["sealInput"]>[0],
  ): Promise<SharedBrowserRootResponse<SharedBrowserSchema.InputStamp>>
  onState(callback: (state: SharedBrowserRootResponse<SharedBrowserView>) => void): () => void
  tuiPending(
    generation: string,
    rootSessionID: string,
  ): Promise<SharedBrowserRootResponse<SharedBrowserTuiSchema.View[]>>
  tuiApprove(
    generation: string,
    input: SharedBrowserTuiSchema.Approve,
  ): Promise<SharedBrowserRootResponse<SharedBrowserTuiSchema.View>>
  tuiDetach(
    generation: string,
    input: SharedBrowserTuiSchema.Approve,
  ): Promise<SharedBrowserRootResponse<SharedBrowserTuiSchema.View>>
  onTuiState(callback: (state: SharedBrowserRootResponse<SharedBrowserTuiSchema.View>) => void): () => void
}
