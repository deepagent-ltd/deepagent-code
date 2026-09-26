export * as CustomToolRejections from "./custom-tool-rejections"

import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"

// A rejected definition never reaches ApplicationTools.register, so keep this diagnostic beside
// the bridge and key it by the actual process-scoped ApplicationTools instance. The instance
// disposer removes its own count when a plugin reloads or its workspace closes.
const rejected = new WeakMap<ApplicationTools.Interface, Map<object, number>>()

export function count(applications: ApplicationTools.Interface) {
  return [...(rejected.get(applications)?.values() ?? [])].reduce((total, value) => total + value, 0)
}

export function track(applications: ApplicationTools.Interface, instance: object, value: number) {
  const instances = rejected.get(applications) ?? new Map<object, number>()
  instances.set(instance, value)
  rejected.set(applications, instances)
  return () => instances.delete(instance)
}
