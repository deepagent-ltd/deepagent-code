import type { WslDistroProbe, WslDeepagentCodeCheck, WslServerItem } from "../../preload/types"

export function wslServerIdToRestart(servers: WslServerItem[], distro: string) {
  return servers.find((item) => item.config.distro === distro)?.config.id
}

export function clearWslDistroState(
  distroProbes: Record<string, WslDistroProbe>,
  deepagentCodeChecks: Record<string, WslDeepagentCodeCheck>,
  distro: string,
) {
  const nextDistroProbes = { ...distroProbes }
  const nextDeepagentCodeChecks = { ...deepagentCodeChecks }
  delete nextDistroProbes[distro]
  delete nextDeepagentCodeChecks[distro]
  return { distroProbes: nextDistroProbes, deepagentCodeChecks: nextDeepagentCodeChecks }
}

export function wslTerminalArgs(distro?: string | null) {
  return ["/c", "start", "", "wsl", ...(distro ? ["-d", distro] : [])]
}

export function requireWslIpcString(name: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Invalid ${name}`)
}
