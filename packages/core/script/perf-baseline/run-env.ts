import * as os from "node:os"

const sh = (command: string[]) => {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  const text = new TextDecoder().decode(result.stdout).trim()
  return { code: result.exitCode, text }
}

export const bunVersion = () => Bun.version

export const machineInfo = () => {
  const cpu = sh(["sysctl", "-n", "machdep.cpu.brand_string"])
  return {
    hw_model: sh(["sysctl", "-n", "hw.model"]).text,
    cpu_brand: cpu.text,
    arch: process.arch,
    physical_cores: Number(sh(["sysctl", "-n", "hw.physicalcpu"]).text),
    logical_cores: Number(sh(["sysctl", "-n", "hw.ncpu"]).text),
    memory_bytes: Number(sh(["sysctl", "-n", "hw.memsize"]).text),
    // os.release() == Darwin kernel (uname -r); os.version() == kernel string (uname -v).
    // sw_vers gives the macOS product/build versions (ProductVersion / BuildVersion),
    // which live on a different numbering layer and must both be recorded explicitly.
    os_release: os.release(),
    os_version: os.version(),
    macos_product_version: sh(["sw_vers", "-productVersion"]).text,
    macos_build_version: sh(["sw_vers", "-buildVersion"]).text,
    platform: `${process.platform}`,
  }
}

/** Battery / power-supply snapshot so readers can judge thermal-Throttle risk on laptops. */
export const powerState = () => {
  const battery = sh(["pmset", "-g", "ps"])
  return { raw: battery.text, exit_code: battery.code }
}

export interface ProcessRow {
  readonly pcpu: string
  readonly pmem: string
  readonly command: string
}

/** One captured interference snapshot with its capture timestamp and run-wall-clock offset. */
export interface InterferenceSnapshotRecord {
  readonly captured_at: string
  readonly elapsed_ms: number
  readonly processes: readonly ProcessRow[]
}

/**
 * Top CPU consumers at sampling time. Recorded TWICE per run — a genuine start-of-run
 * snapshot taken in main() BEFORE any scenario runs, and a genuine end-of-run snapshot
 * taken when the manifest is built. The two captures are independent samples and are
 * never re-used for the other end; the noise discussion section of the report cites them.
 */
export const interferenceSnapshot = (): ProcessRow[] => {
  const ps = sh(["ps", "axo", "pcpu,pmem,comm", "-r"])
  const lines = ps.text.split("\n").slice(1)
  const rows = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trim().split(/\s+/))
    .map((parts) => ({ pcpu: parts[0], pmem: parts[1], command: parts.slice(2).join(" ") }))
    .filter((row) => !/^\/System\//.test(row.command))
    .slice(0, 15)
  return rows
}

/** Capture a timestamped interference snapshot at the given run-wall-clock offset (ms). */
export const captureInterference = (elapsedMs: number): InterferenceSnapshotRecord => ({
  captured_at: new Date().toISOString(),
  elapsed_ms: Math.round(elapsedMs),
  processes: interferenceSnapshot(),
})

export interface GitIdentity {
  readonly commit: string
  readonly tree: string
  readonly branch: string
  readonly dirty_paths: string[]
}

export const gitIdentity = (repoRoot: string): GitIdentity => ({
  commit: sh(["git", "-C", repoRoot, "rev-parse", "HEAD"]).text,
  tree: sh(["git", "-C", repoRoot, "rev-parse", "HEAD^{tree}"]).text,
  branch: sh(["git", "-C", repoRoot, "branch", "--show-current"]).text,
  dirty_paths: sh(["git", "-C", repoRoot, "status", "--porcelain"]).text.split("\n").filter((line) => line.length > 0),
})
