export function createSidecarShutdown(input: {
  stop: () => void | Promise<void>
  clear: () => void
  report: (message: { type: "stopped" } | { type: "error"; error: { message: string } }) => void
  exit: (code: number) => void
}) {
  let stopped: Promise<void> | undefined
  const finish = (code: number) => {
    input.clear()
    try {
      input.report(code === 0 ? { type: "stopped" } : { type: "error", error: { message: "SIDECAR_SHUTDOWN_FAILED" } })
    } finally {
      input.exit(code)
    }
  }
  return () =>
    (stopped ??= Promise.resolve()
      .then(input.stop)
      .then(
        () => finish(0),
        () => finish(1),
      ))
}
