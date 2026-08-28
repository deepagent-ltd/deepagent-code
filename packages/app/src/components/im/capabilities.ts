// V4.0 §B3/§H3 — read the server's IM feature flags from /global/capabilities so the client can gate
// V4 UI (thread view, file upload) exactly where the routes fail-close. Mirrors panel-goal.api's
// fetchCapabilities: raw path (no SDK regen), tolerant of an older server that omits the fields
// (treated as disabled). All fields are OPTIONAL on the wire (see groups/global.ts GlobalCapabilities).

type RawSdkClient = {
  client: {
    request<TData>(options: { method: string; url: string }): Promise<{ data?: TData }>
  }
}

export type IMCapabilities = {
  im: boolean
  v4EventDrivenIm: boolean
  v4AgentPushEnabled: boolean
  v4ThreadEnabled: boolean
  v4FileUploadEnabled: boolean
}

type WireFeatures = {
  im?: boolean
  v4EventDrivenIm?: boolean
  v4AgentPushEnabled?: boolean
  v4ThreadEnabled?: boolean
  v4FileUploadEnabled?: boolean
}

export const fetchIMCapabilities = async (client: RawSdkClient): Promise<IMCapabilities> => {
  try {
    const response = await client.client.request<{ features?: WireFeatures }>({
      method: "GET",
      url: "/global/capabilities",
    })
    const f = response.data?.features ?? {}
    return {
      im: f.im ?? true,
      v4EventDrivenIm: f.v4EventDrivenIm ?? false,
      v4AgentPushEnabled: f.v4AgentPushEnabled ?? false,
      v4ThreadEnabled: f.v4ThreadEnabled ?? false,
      v4FileUploadEnabled: f.v4FileUploadEnabled ?? false,
    }
  } catch {
    // An older server (or a transient failure) ⇒ treat all V4 flags as disabled.
    return {
      im: true,
      v4EventDrivenIm: false,
      v4AgentPushEnabled: false,
      v4ThreadEnabled: false,
      v4FileUploadEnabled: false,
    }
  }
}
