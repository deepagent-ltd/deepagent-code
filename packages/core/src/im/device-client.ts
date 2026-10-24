export * as IMDeviceClient from "./device-client"

import { Option, Schema } from "effect"
import { IMDeviceSchema } from "./device.schema"

export type Transport = {
  client: {
    request<T>(options: {
      method: "GET" | "POST"
      url: string
      body?: unknown
      signal?: AbortSignal
      responseStyle: "fields"
      throwOnError: false
    }): Promise<{ data?: T; error?: unknown; response?: Response }>
  }
}

export class RequestError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code)
    this.name = "IMDeviceRequestError"
  }
}

/** Public device metadata and observations only; the Host owns every secret and retained request. */
export function create(input: { client: Transport; current(): boolean }) {
  const requireCurrent = () => {
    if (!input.current()) throw new RequestError("im_device_scope_changed", 409)
  }
  const read = async (options: Parameters<Transport["client"]["request"]>[0]) => {
    requireCurrent()
    const result = await input.client.client.request<unknown>(options)
    requireCurrent()
    if (result.error || result.data === undefined) {
      const detail =
        result.error && typeof result.error === "object" && "data" in result.error ? result.error.data : result.error
      const code =
        detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string"
          ? detail.code
          : "im_device_unavailable"
      throw new RequestError(code, result.response?.status)
    }
    return result.data
  }
  const migration = (value: unknown) => {
    const decoded = Schema.decodeUnknownOption(IMDeviceSchema.Migration)(value, { onExcessProperty: "error" })
    if (Option.isNone(decoded)) throw new RequestError("im_device_invalid_response", 503)
    return decoded.value
  }
  return {
    async info(signal?: AbortSignal) {
      const decoded = Schema.decodeUnknownOption(IMDeviceSchema.Info)(
        await read({
          method: "GET",
          url: "/api/v1/im/device/info",
          signal,
          responseStyle: "fields",
          throwOnError: false,
        }),
        { onExcessProperty: "error" },
      )
      if (Option.isNone(decoded)) throw new RequestError("im_device_invalid_response", 503)
      return decoded.value
    },
    async pending(signal?: AbortSignal) {
      const decoded = Schema.decodeUnknownOption(IMDeviceSchema.Pending)(
        await read({
          method: "GET",
          url: "/api/v1/im/device/migrations",
          signal,
          responseStyle: "fields",
          throwOnError: false,
        }),
        { onExcessProperty: "error" },
      )
      if (Option.isNone(decoded)) throw new RequestError("im_device_invalid_response", 503)
      return decoded.value.migration
    },
    async migrate(body: IMDeviceSchema.Migrate, signal?: AbortSignal) {
      Schema.decodeUnknownSync(IMDeviceSchema.Migrate)(body, { onExcessProperty: "error" })
      const value = migration(
        await read({
          method: "POST",
          url: "/api/v1/im/device/migrate",
          body,
          signal,
          responseStyle: "fields",
          throwOnError: false,
        }),
      )
      if (value.migrationID !== body.migrationID) throw new RequestError("im_device_target_changed", 409)
      return value
    },
    async status(migrationID: string, signal?: AbortSignal) {
      Schema.decodeUnknownSync(IMDeviceSchema.Migrate.fields.migrationID)(migrationID)
      const value = migration(
        await read({
          method: "GET",
          url: `/api/v1/im/device/migrations/${migrationID}`,
          signal,
          responseStyle: "fields",
          throwOnError: false,
        }),
      )
      if (value.migrationID !== migrationID) throw new RequestError("im_device_target_changed", 409)
      return value
    },
  }
}
