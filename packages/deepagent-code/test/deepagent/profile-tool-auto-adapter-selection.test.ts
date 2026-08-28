import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { autoSelectAdapterId } from "../../src/tool/profile"

// P3A auto-adapter selection: env-var heuristics + explicit override.
// Tests the pure `autoSelectAdapterId` function — no Effect layers needed.

const ENV_KEYS = ["CUDA_VISIBLE_DEVICES", "ROCM_HOME", "HIP_VISIBLE_DEVICES", "VTUNE_PROFILING_DIR"]

// Save and restore process.env around each test so tests don't bleed.
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = savedEnv[k]
    }
  }
})

describe("P3A profile tool — adapter auto-selection", () => {
  describe("explicit override", () => {
    it("explicit adapter:'perf' overrides all env vars", () => {
      process.env["CUDA_VISIBLE_DEVICES"] = "0"
      process.env["ROCM_HOME"] = "/opt/rocm"
      process.env["VTUNE_PROFILING_DIR"] = "/opt/vtune"
      expect(autoSelectAdapterId("perf")).toBe("perf")
    })

    it("explicit adapter:'ncu' returns ncu regardless of env", () => {
      delete process.env["CUDA_VISIBLE_DEVICES"]
      expect(autoSelectAdapterId("ncu")).toBe("ncu")
    })

    it("explicit adapter:'vtune' returns vtune regardless of env", () => {
      delete process.env["VTUNE_PROFILING_DIR"]
      expect(autoSelectAdapterId("vtune")).toBe("vtune")
    })
  })

  describe("CUDA env heuristic", () => {
    it("CUDA_VISIBLE_DEVICES=0 → ncu", () => {
      process.env["CUDA_VISIBLE_DEVICES"] = "0"
      expect(autoSelectAdapterId()).toBe("ncu")
    })

    it("CUDA_VISIBLE_DEVICES='' (empty string, device present) → ncu", () => {
      process.env["CUDA_VISIBLE_DEVICES"] = ""
      expect(autoSelectAdapterId()).toBe("ncu")
    })
  })

  describe("ROCm env heuristic", () => {
    it("ROCM_HOME=/opt/rocm → rocprof", () => {
      process.env["ROCM_HOME"] = "/opt/rocm"
      expect(autoSelectAdapterId()).toBe("rocprof")
    })

    it("HIP_VISIBLE_DEVICES=0 → rocprof", () => {
      process.env["HIP_VISIBLE_DEVICES"] = "0"
      expect(autoSelectAdapterId()).toBe("rocprof")
    })
  })

  describe("VTune env heuristic", () => {
    it("VTUNE_PROFILING_DIR set → vtune", () => {
      process.env["VTUNE_PROFILING_DIR"] = "/opt/intel/vtune"
      expect(autoSelectAdapterId()).toBe("vtune")
    })
  })

  describe("no GPU env → perf fallback", () => {
    it("no env vars set → perf (unless vtune binary on PATH, which CI won't have)", () => {
      // No GPU env set. On CI, vtune won't be on PATH, so falls through to perf.
      // VTUNE_PROFILING_DIR cleared in beforeEach.
      const result = autoSelectAdapterId()
      // perf OR vtune (if vtune happens to be on the test machine's PATH).
      expect(["perf", "vtune"]).toContain(result)
    })
  })

  describe("CUDA takes priority over ROCm in env", () => {
    it("CUDA_VISIBLE_DEVICES + ROCM_HOME both set → ncu wins (CUDA checked first)", () => {
      process.env["CUDA_VISIBLE_DEVICES"] = "0"
      process.env["ROCM_HOME"] = "/opt/rocm"
      expect(autoSelectAdapterId()).toBe("ncu")
    })
  })
})
