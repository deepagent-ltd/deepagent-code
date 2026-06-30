import type { WslDeepagentCodeCheck, WslServerRuntime } from "./types"

export const wslRuntimeRetryable = (runtime: WslServerRuntime) =>
  runtime.kind === "failed" || runtime.kind === "stopped"

export async function enterWslDeepagentCodeStep(
  distro: string,
  probe: (distro: string) => Promise<unknown>,
  select: (step: "deepagent-code") => void,
) {
  await probe(distro)
  select("deepagent-code")
}

export function wslDeepagentCodeAction(check?: WslDeepagentCodeCheck) {
  if (!check) return
  if (!check.resolvedPath) return "Install DeepAgent Code"
  if (check.matchesDesktop === false) return "Update DeepAgent Code"
}
