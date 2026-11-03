export async function main() {
  await import("./work-source-lifecycle")
}

if (import.meta.main && !process.env.DAC_NATIVE_NODE_COHORT_ROOT) await main()
