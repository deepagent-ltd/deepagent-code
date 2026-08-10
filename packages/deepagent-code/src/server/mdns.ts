import * as Log from "@deepagent-code/core/util/log"
import { Bonjour } from "bonjour-service"

const log = Log.create({ service: "mdns" })

export function publish(port: number, domain?: string) {
  let bonjour: Bonjour | undefined
  try {
    const instance = (bonjour = new Bonjour())
    const host = domain ?? "deepagent-code.local"
    const name = `deepagent-code-${port}`
    const service = instance.publish({
      name,
      type: "http",
      host,
      port,
      txt: { path: "/" },
    })

    service.on("up", () => {
      log.info("mDNS service published", { name, port })
    })

    service.on("error", (err) => {
      log.error("mDNS service error", { error: err })
    })

    let unpublished = false
    return {
      unpublish() {
        if (unpublished) return
        unpublished = true
        try {
          instance.unpublishAll()
        } catch (err) {
          log.error("mDNS unpublish failed", { error: err })
        }
        try {
          instance.destroy()
        } catch (err) {
          log.error("mDNS destroy failed", { error: err })
        }
        log.info("mDNS service unpublished")
      },
    }
  } catch (err) {
    log.error("mDNS publish failed", { error: err })
    try {
      bonjour?.destroy()
    } catch (destroyError) {
      log.error("mDNS destroy failed", { error: destroyError })
    }
    return { unpublish() {} }
  }
}

export * as MDNS from "./mdns"
